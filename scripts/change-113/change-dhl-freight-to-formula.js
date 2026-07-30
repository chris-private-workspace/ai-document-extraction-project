/**
 * @fileoverview CHANGE-113：把 DHL 的 freight 映射改為 FORMULA，涵蓋兩種服務類型
 * @description
 *   DHL 欄位定義集有兩個主運費欄位 —— `express_worldwide_nondoc`（非文件類）與
 *   `express_worldwide_doc`（文件類）。原本只映射了前者，文件類運件的金額落空。
 *
 *   **為何用 FORMULA 而非兩條 DIRECT 指向同一個 freight**：`transformFields` 按
 *   `order` 依序套用，同一目標欄位後者覆蓋前者，跳過條件只有 `undefined`；
 *   `DirectTransform` 原值回傳，因此結果取決於來源 key 是「缺席」還是「存在但為 null」：
 *     - 缺席  → `sourceFields[key]` 為 undefined → 被跳過 → 安全
 *     - 為 null → 通過判斷 → **覆蓋掉已寫入的金額**，且不會報錯
 *   兩者差異取決於提取結果如何持久化（實測本文件的 `express_worldwide_doc` 在
 *   `stage_3_result` 是 null、在 `mappedFields` 則是缺席），是不該依賴的細節。
 *
 *   FORMULA 不受此影響：`formula.transform.ts:351` 對 null 與 undefined 一律視為 0，
 *   兩種發票都算得對（非文件類 `247.5 + 0`、文件類 `0 + 金額`）。
 *   這也是專案既有 25 條「多來源 → 單欄」規則一致採用的寫法。
 *
 *   寫法沿用專案既有 25 條 FORMULA 規則的慣例：`sourceField` 填公式中第一個欄位。
 *
 *   使用者 2026-07-30 核准。預設 dry-run，實際寫入需帶 `APPLY=true`。
 *
 * @module scripts/change-113/change-dhl-freight-to-formula
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-30
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')
const { resolveSnapshotPath } = require('./snapshot-path')

const TEMPLATE_ID = 'cmrbi0ktk033201o3rivrxb6h' // Logistics Cost - Inbound Template (Full List)
const DHL_COMPANY_ID = 'eedf4065-653b-4fd0-8bfb-f71c78bb2ae5'

const TARGET_FIELD = 'freight'
const PRIMARY_SOURCE = 'express_worldwide_nondoc'
const SECOND_SOURCE = 'express_worldwide_doc'
const FORMULA = `{${PRIMARY_SOURCE}} + {${SECOND_SOURCE}}`

async function main() {
  const apply = process.env.APPLY === 'true'
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  const { rows } = await client.query(
    `select id, name, mappings
       from template_field_mappings
      where data_template_id = $1 and company_id = $2 and is_active = true`,
    [TEMPLATE_ID, DHL_COMPANY_ID]
  )
  if (rows.length !== 1) {
    throw new Error(`預期 1 份生效中的 DHL 映射配置，實際 ${rows.length} 份 — 已中止`)
  }

  const config = rows[0]
  const mappings = Array.isArray(config.mappings) ? config.mappings : []

  console.log(`映射配置：${config.name}`)
  console.log(`現有規則 ${mappings.length} 條`)

  const index = mappings.findIndex((m) => m.targetField === TARGET_FIELD)
  if (index === -1) {
    throw new Error(`找不到 targetField = ${TARGET_FIELD} 的規則 — 已中止`)
  }

  const current = mappings[index]
  console.log(`\n現有 ${TARGET_FIELD} 規則：\n${JSON.stringify(current, null, 2)}`)

  const desiredDescription =
    '文件類與非文件類都是主運費，同一 shipment 只會有其中一種。' +
    '用 FORMULA 而非兩條 DIRECT 指向 freight：FORMULA 對缺值與 null 一律視為 0，' +
    '不受「來源 key 是缺席還是存在但為 null」影響；兩條 DIRECT 在後者情況下會互相覆蓋且不報錯。' +
    '（CHANGE-113，使用者 2026-07-30 核准）'

  // 冪等比對的是「是否已達目標狀態」，而非只看 transformType ——
  // 只看型別的話，公式或說明後續修正就再也套不進去
  if (
    current.transformType === 'FORMULA' &&
    current.transformParams?.formula === FORMULA &&
    current.description === desiredDescription
  ) {
    console.log(`\n${TARGET_FIELD} 已是目標狀態 — 不做任何變更（冪等）`)
    await client.end()
    return
  }

  // 兩個來源欄位都必須存在於 DHL 欄位定義集，否則公式恆為 0
  const { rows: defs } = await client.query(
    `select d->>'key' as key
       from field_definition_sets s, jsonb_array_elements(s.fields) d
      where s.company_id = $1`,
    [DHL_COMPANY_ID]
  )
  const keys = new Set(defs.map((d) => d.key))
  for (const source of [PRIMARY_SOURCE, SECOND_SOURCE]) {
    if (!keys.has(source)) {
      throw new Error(`DHL 欄位定義集缺少 ${source} — 已中止`)
    }
  }

  const nextRule = {
    ...current,
    sourceField: PRIMARY_SOURCE,
    transformType: 'FORMULA',
    transformParams: { formula: FORMULA },
    description: desiredDescription,
  }

  const next = [...mappings]
  next[index] = nextRule
  console.log(`\n將改為：\n${JSON.stringify(nextRule, null, 2)}`)

  if (!apply) {
    console.log('\n[dry-run] 未寫入。要實際套用請帶 APPLY=true')
    await client.end()
    return
  }

  const snapshotPath = resolveSnapshotPath(
    path.join(__dirname, 'snapshots'),
    `template-field-mapping-${config.id}.before-formula.json`
  )
  fs.writeFileSync(
    snapshotPath,
    JSON.stringify({ id: config.id, name: config.name, mappings }, null, 2)
  )
  console.log(`\n快照已寫入：${snapshotPath}`)

  const result = await client.query(
    `update template_field_mappings
        set mappings = $2::jsonb, updated_at = now()
      where id = $1`,
    [config.id, JSON.stringify(next)]
  )
  if (result.rowCount !== 1) {
    throw new Error(`預期更新 1 筆，實際 ${result.rowCount} 筆 — 已中止`)
  }
  console.log(`\n✅ 已寫入（1 筆）`)

  await client.end()
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
