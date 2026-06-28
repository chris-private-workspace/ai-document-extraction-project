/**
 * @fileoverview FIX-095: 一次性更新已部署 DB 的 Stage 3 / 欄位提取 PromptConfig
 * @description
 *   將 GLOBAL scope 的 STAGE_3_FIELD_EXTRACTION 與 FIELD_EXTRACTION 兩筆
 *   PromptConfig 的 userPromptTemplate 更新為 FIX-095 的新版：移除與 SYSTEM
 *   注入格式互斥的 invoiceData 包裹範本，改為自然語言 + 指向系統訊息指定的
 *   { fields, lineItems, overallConfidence } 結構，消除 GPT 輸出格式非確定性。
 *
 *   ⚠️ 只更新 userPromptTemplate，不動 systemPrompt 或其他欄位。
 *   ⚠️ 僅 update 既有記錄，不 create（找不到記錄會警告並略過）。
 *   ⚠️ 純 prompt 文字更新，完全不碰 line item 提取邏輯。
 *   ⚠️ 內容必須與 prisma/seed-data/prompt-configs.ts 的對應 userPromptTemplate 保持同步。
 *
 * @module scripts/fix-095-update-stage3-prompt
 * @since FIX-095 (2026-06-28)
 *
 * 為何需要此腳本：Azure 容器啟動的 seed-prod-essential.ts 不 seed PromptConfig，
 *   Azure 現用 prompt 來自本地 DB 同步匯入，重新部署不會更新它；本地則可改用
 *   `npm run db seed`（seed.ts 會 update 既有記錄）。此腳本提供一個與環境無關、
 *   可在 Azure VNet 內直接執行的安全更新方式。
 *
 * 執行方式（gated；未帶 --confirm 一律 DRY-RUN，只預覽不寫入）：
 *   預覽：  npx tsx scripts/fix-095-update-stage3-prompt.ts
 *   執行：  npx tsx scripts/fix-095-update-stage3-prompt.ts --confirm
 *   （DATABASE_URL 指向目標環境的 DB；Azure 須在能連到私有 PG 的 VNet 內執行）
 */

import 'dotenv/config'
import { PrismaClient, PromptType, PromptScope } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

const CONFIRM = process.argv.includes('--confirm')
const DRY_RUN = !CONFIRM // 預設安全：未明確 --confirm 即 dry-run

// FIX-095 新版 userPromptTemplate（須與 prisma/seed-data/prompt-configs.ts 同步）
const NEW_USER_PROMPT_TEMPLATE = `請從這張發票圖片中提取所有資訊，並嚴格依照系統訊息（SYSTEM）指定的 JSON 結構輸出。

必須提取：
1. 發票基本資訊：發票號碼、發票日期、到期日、幣別、小計、總金額
2. 供應商與買方：名稱、地址
3. 所有費用明細項目（line items）：項目描述、數量、單價、金額

注意事項：
- 日期格式 YYYY-MM-DD；金額保留兩位小數；無法識別的欄位設為 null
- 必須使用系統訊息指定的 { fields, lineItems, overallConfidence } 結構；不要改用其他結構（例如不要輸出 { success, confidence, invoiceData } 包裹格式）
- 只輸出有效的 JSON，不要有其他文字。`

const TARGET_PROMPT_TYPES = [
  'STAGE_3_FIELD_EXTRACTION',
  'FIELD_EXTRACTION',
] as const

async function main(): Promise<void> {
  console.log('\n=== FIX-095 更新 Stage 3 / Field Extraction PromptConfig ===')
  console.log(`模式：${DRY_RUN ? 'DRY-RUN（預覽，不寫入）' : 'CONFIRM（實際寫入）'}\n`)

  let updated = 0
  for (const promptType of TARGET_PROMPT_TYPES) {
    const existing = await prisma.promptConfig.findFirst({
      where: {
        promptType: promptType as PromptType,
        scope: PromptScope.GLOBAL,
      },
    })

    if (!existing) {
      console.log(`  ⚠️  找不到 GLOBAL / ${promptType} 的 PromptConfig，略過`)
      continue
    }

    if (existing.userPromptTemplate === NEW_USER_PROMPT_TEMPLATE) {
      console.log(`  ✅ ${promptType} 已是新版，無需更新`)
      continue
    }

    const oldPreview = (existing.userPromptTemplate || '')
      .slice(0, 60)
      .replace(/\n/g, ' ')
    console.log(`  📝 ${promptType} (id=${existing.id})`)
    console.log(`     舊 userPromptTemplate 前 60 字：${oldPreview}...`)

    if (DRY_RUN) {
      console.log(
        `     [DRY-RUN] 將更新為新版（${NEW_USER_PROMPT_TEMPLATE.length} 字），未寫入`
      )
      continue
    }

    await prisma.promptConfig.update({
      where: { id: existing.id },
      data: { userPromptTemplate: NEW_USER_PROMPT_TEMPLATE },
    })
    console.log('     ✅ 已更新')
    updated++
  }

  console.log(
    `\n完成。${DRY_RUN ? '（DRY-RUN，未實際寫入；加 --confirm 才會寫入）' : `實際更新 ${updated} 筆`}\n`
  )
}

main()
  .catch((e) => {
    console.error('FIX-095 prompt 更新失敗：', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
