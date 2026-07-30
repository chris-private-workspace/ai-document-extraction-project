/**
 * @fileoverview CHANGE-113：移除 DHL Stage 3 Prompt 中的真實號碼範例
 * @description
 *   **問題**：原 prompt 用真實號碼當範例
 *   （groupKey 寫 `"RCIM-25-0111", "RCIM/25/0246"`、groupSourceRef 寫 `"8365573366"`）。
 *   2026-07-29 端到端實測顯示 GPT 會直接**複製範例值**而非讀取圖像 ——
 *   第一組回 `RCIM-25-0111`（碰巧與該頁相符）、第二組回 `RCIM/25/0246`
 *   （該號碼屬於另一份文件，這份文件上根本沒有）。
 *
 *   範例值一旦是合法格式的真實資料，就會成為模型的預設答案 —— 尤其在
 *   目標文字是小字、手寫或需旋轉閱讀時，複製範例比看圖「容易」。
 *
 *   **修法**：改成描述格式而不給具體值，並明確要求從影像讀取。
 *
 *   預設 dry-run；實際寫入需帶 `APPLY=true`。寫入前存快照。
 *
 * @module scripts/change-113/fix-dhl-prompt-examples
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-29
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

const PROMPT_ID = 'change113-dhl-stage3-001'

const OLD_BLOCK = `- groupSourceRef: the Air Waybill Number printed at the start of that table row (e.g. "8365573366").
- groupKey: the customer reference number annotated on that row - usually handwritten or typed inside a coloured box placed next to the row (e.g. "RCIM-25-0111", "RCIM/25/0246"). Copy it EXACTLY as shown, including whatever separators it uses.`

const NEW_BLOCK = `- groupSourceRef: the Air Waybill Number printed at the start of that table row. It is a 10-digit number.
- groupKey: the customer reference number annotated on that row - usually handwritten or typed inside a coloured box placed next to the row. Its shape is four letters, then a two-digit year, then a four-digit serial, joined by hyphens or slashes. Copy it EXACTLY as it appears ON THIS PAGE, including whatever separators it uses.

CRITICAL: read both values off the image in front of you. This prompt deliberately shows no sample reference numbers - if you find yourself writing a value you did not read from this page, stop and re-read the row. A wrong groupKey silently attributes money to the wrong shipment.`

async function main() {
  const apply = process.env.APPLY === 'true'
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  const { rows } = await client.query(
    `select id, name, system_prompt, version from prompt_configs where id = $1`,
    [PROMPT_ID]
  )
  if (rows.length === 0) {
    throw new Error(`找不到 prompt config ${PROMPT_ID}`)
  }

  const config = rows[0]
  const current = config.system_prompt

  if (current.includes(NEW_BLOCK)) {
    console.log('已是修正後的版本 — 不做任何變更（冪等）')
    await client.end()
    return
  }

  if (!current.includes(OLD_BLOCK)) {
    throw new Error(
      '找不到預期的原文區塊 — prompt 可能已被改過。已中止，未做任何變更。'
    )
  }

  const next = current.replace(OLD_BLOCK, NEW_BLOCK)

  console.log(`Prompt：${config.name} (v${config.version})`)
  console.log('\n--- 移除 ---\n' + OLD_BLOCK)
  console.log('\n--- 換成 ---\n' + NEW_BLOCK)

  if (!apply) {
    console.log('\n[dry-run] 未寫入。要實際套用請帶 APPLY=true')
    await client.end()
    return
  }

  const snapshotDir = path.join(__dirname, 'snapshots')
  fs.mkdirSync(snapshotDir, { recursive: true })
  const snapshotPath = path.join(snapshotDir, `prompt-${PROMPT_ID}.before.json`)
  fs.writeFileSync(
    snapshotPath,
    JSON.stringify({ id: config.id, version: config.version, systemPrompt: current }, null, 2)
  )
  console.log(`\n快照已寫入：${snapshotPath}`)

  const result = await client.query(
    `update prompt_configs
        set system_prompt = $2, version = version + 1, updated_at = now()
      where id = $1`,
    [PROMPT_ID, next]
  )
  if (result.rowCount !== 1) {
    throw new Error(`預期更新 1 筆，實際 ${result.rowCount} 筆 — 已中止`)
  }
  console.log('\n✅ 已寫入（1 筆）')

  await client.end()
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
