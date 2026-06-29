/**
 * @fileoverview FIX-095（Azure 端）：一次性更新已部署 DB 的 Stage 3 / 欄位提取 GLOBAL
 *   PromptConfig 的 user_prompt_template。
 *
 *   背景：Stage 3 由 stage-3-extraction.service.ts 的 loadPromptConfigHierarchical()
 *   從 DB 的 prompt_configs（FORMAT > COMPANY > GLOBAL）讀取 prompt；Azure 的 GLOBAL
 *   記錄來自本地 DB 同步匯入，**重新部署不會更新它**（essential seed 不 seed
 *   PromptConfig）。FIX-095 的程式碼（SYSTEM 注入 + 回填容錯）隨映像生效，但舊版
 *   userPromptTemplate 仍要求 GPT 輸出 { success, confidence, invoiceData } 包裹格式，
 *   與 SYSTEM 指定的 { fields, lineItems, overallConfidence } 互斥 → 信心度非確定。
 *   本 script 把該 2 筆 GLOBAL 記錄的 user_prompt_template 改為 FIX-095 新版。
 *
 *   設計重點（比照 grant-global-admin.js / apply-schema-drift.js）：
 *   - 只依賴 `pg`（已包含在 standalone runtime），不需 Prisma CLI / tsx
 *   - Azure PostgreSQL 需 TLS：偵測 sslmode=require 或 azure host 時啟用
 *   - 冪等：只更新 user_prompt_template 與新版不同者（is distinct from）；已是新版則 0 筆
 *   - 參數化查詢防注入；非致命（由 entrypoint 包 || 處理）
 *
 *   ⚠️ NEW_USER_PROMPT_TEMPLATE 必須與 scripts/fix-095-update-stage3-prompt.ts 及
 *      prisma/seed-data/prompt-configs.ts 的對應 userPromptTemplate **逐字一致**。
 *
 *   由 docker-entrypoint.sh 的 RUN_STAGE3_PROMPT_FIX=true 觸發；補完後把旗標設回 false。
 *   本地環境改用 `npm run db seed`（seed.ts 會 update 既有記錄）或 tsx 版腳本。
 *
 * @module prisma/update-stage3-prompt
 * @since FIX-095 (2026-06-29)
 * @lastModified 2026-06-29
 */
const { Client } = require('pg')

function resolveSsl() {
  const url = process.env.DATABASE_URL || ''
  if (/sslmode=require/i.test(url) || /\.postgres\.database\.azure\.com/i.test(url)) {
    return { rejectUnauthorized: false }
  }
  return false
}

// FIX-095 新版 userPromptTemplate（須與 scripts/fix-095-update-stage3-prompt.ts 及
// prisma/seed-data/prompt-configs.ts 的對應 userPromptTemplate 逐字一致）。
const NEW_USER_PROMPT_TEMPLATE = `請從這張發票圖片中提取所有資訊，並嚴格依照系統訊息（SYSTEM）指定的 JSON 結構輸出。

必須提取：
1. 發票基本資訊：發票號碼、發票日期、到期日、幣別、小計、總金額
2. 供應商與買方：名稱、地址
3. 所有費用明細項目（line items）：項目描述、數量、單價、金額

注意事項：
- 日期格式 YYYY-MM-DD；金額保留兩位小數；無法識別的欄位設為 null
- 必須使用系統訊息指定的 { fields, lineItems, overallConfidence } 結構；不要改用其他結構（例如不要輸出 { success, confidence, invoiceData } 包裹格式）
- 只輸出有效的 JSON，不要有其他文字。`

// 目標：GLOBAL scope 的這兩個 promptType（與 stage-3 的 extractionPromptTypes 一致）
const TARGET_PROMPT_TYPES = ['STAGE_3_FIELD_EXTRACTION', 'FIELD_EXTRACTION']

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[stage3-prompt] DATABASE_URL not set — cannot continue')
    process.exit(1)
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveSsl(),
    connectionTimeoutMillis: 30000,
  })

  await client.connect()
  try {
    // 參數化查詢防注入；enum 欄位以 ::text 比較避免型別轉換歧義。
    // is distinct from → 冪等：已是新版者不計入更新。updated_at 一併刷新（對齊 Prisma @updatedAt）。
    const res = await client.query(
      `update prompt_configs
         set user_prompt_template = $1, updated_at = now()
       where prompt_type::text = any($2)
         and scope::text = 'GLOBAL'
         and user_prompt_template is distinct from $1`,
      [NEW_USER_PROMPT_TEMPLATE, TARGET_PROMPT_TYPES]
    )
    console.log(
      `[stage3-prompt] done — ${res.rowCount} GLOBAL prompt(s) updated to FIX-095 template ` +
        `(0 = already up to date)`
    )
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('[stage3-prompt] FAILED:', e.message)
  process.exit(1)
})
