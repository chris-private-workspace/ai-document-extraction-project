/**
 * @fileoverview CHANGE-113：為 DHL 補上燃油附加費的模板映射規則
 * @description
 *   DHL 的映射配置原本只有 2 條規則（`freight ← express_worldwide_nondoc`、
 *   `shipment_number ← _ref_number`），提取出來的 `fuel_surcharge` 沒有任何規則接，
 *   於是 69.92 / 652.58 這兩筆金額落空 —— 模板列的金額是 247.50 而非發票上的 317.42。
 *
 *   使用者 2026-07-29 決定採選項 A：映到 `fuel_surcharge_at_origin`。
 *   理由是保留兩個獨立金額比欄位標籤精準更重要（該欄標籤寫「at origin」，
 *   與 DHL Express 門到門快遞的語意不完全吻合，屬已知取捨）。
 *
 *   預設 dry-run，只顯示既有規則與將要加入的內容。實際寫入需帶 `APPLY=true`。
 *   寫入前把原始 mappings JSON 存成快照 —— 此表無版本歷史，改壞了只能靠快照還原。
 *
 * @module scripts/change-113/add-dhl-fuel-mapping
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-29
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Client } = require('pg')
const { resolveSnapshotPath } = require('./snapshot-path')

const TEMPLATE_ID = 'cmrbi0ktk033201o3rivrxb6h' // Logistics Cost - Inbound Template (Full List)
const DHL_COMPANY_ID = 'eedf4065-653b-4fd0-8bfb-f71c78bb2ae5'

const SOURCE_FIELD = 'fuel_surcharge'
const TARGET_FIELD = 'fuel_surcharge_at_origin'

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
  console.log(`現有規則 ${mappings.length} 條：`)
  console.log(JSON.stringify(mappings, null, 2))

  if (mappings.some((m) => m.sourceField === SOURCE_FIELD)) {
    console.log(`\n${SOURCE_FIELD} 已有映射規則 — 不做任何變更（冪等）`)
    await client.end()
    return
  }

  // 目標欄位必須真的存在於模板，否則寫進去也不會出現在列上
  const { rows: cols } = await client.query(
    `select 1
       from data_templates t, jsonb_array_elements(t.fields) f
      where t.id = $1 and f->>'name' = $2`,
    [TEMPLATE_ID, TARGET_FIELD]
  )
  if (cols.length === 0) {
    throw new Error(`模板中找不到欄位 ${TARGET_FIELD} — 已中止`)
  }

  const maxOrder = mappings.reduce((max, m) => Math.max(max, Number(m.order) || 0), 0)

  // 沿用既有 id 慣例（實測為 `<companyId 前 8 碼>-i-<序號>`），而非另起 UUID ——
  // 同一份配置內混用兩種 id 格式，日後看的人得先判斷哪個是哪個
  const idPrefix = mappings
    .map((m) => String(m.id ?? ''))
    .find((id) => /-\d+$/.test(id))
    ?.replace(/-\d+$/, '')

  const newRule = {
    id: idPrefix ? `${idPrefix}-${maxOrder + 1}` : crypto.randomUUID(),
    order: maxOrder + 1,
    isRequired: false,
    description:
      'DHL FUEL SURCHARGE。目標欄標籤為「at origin」，DHL Express 為門到門快遞無起運地拆分，屬已知語意取捨（CHANGE-113 選項 A，使用者 2026-07-29 決定）',
    sourceField: SOURCE_FIELD,
    targetField: TARGET_FIELD,
    transformType: 'DIRECT',
    transformParams: null,
  }

  const next = [...mappings, newRule]
  console.log(`\n將加入規則：\n${JSON.stringify(newRule, null, 2)}`)
  console.log(`\n加入後共 ${next.length} 條規則`)

  if (!apply) {
    console.log('\n[dry-run] 未寫入。要實際套用請帶 APPLY=true')
    await client.end()
    return
  }

  const snapshotPath = resolveSnapshotPath(
    path.join(__dirname, 'snapshots'),
    `template-field-mapping-${config.id}.before.json`
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
