/**
 * @fileoverview CHANGE-113 階段二：為 DHL 欄位定義集補上燃油附加費欄位
 * @description
 *   DHL 的每個 shipment 都由「標準快遞費 + 燃油附加費」構成，但欄位定義集只有
 *   express_worldwide_doc / express_worldwide_nondoc 兩欄。缺了燃油欄位，
 *   `backfillLineItemCharges` 無處安放 FUEL SURCHARGE 這筆金額 —— 組層級費用
 *   湊不出文件上印的小計（317.42 / 2962.58）。
 *
 *   預設為 dry-run，只顯示將要寫入的內容。實際寫入需帶 `APPLY=true`。
 *   寫入前會把原始 fields JSON 存成快照，可據以還原。
 *
 * @module scripts/change-113/add-dhl-fuel-surcharge-field
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-29
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

const SET_ID = 'aba35edd-fe26-4b46-bb18-01bd2594b157' // DHL Express - 自訂費用欄位集
const NEW_FIELD = {
  key: 'fuel_surcharge',
  label: 'Fuel Surcharge',
  category: 'charges',
  dataType: 'currency',
  required: false,
  aliases: ['FUEL SURCHARGE', 'FUEL SURCHARGES'],
  fieldType: 'lineItem',
}

async function main() {
  const apply = process.env.APPLY === 'true'
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  const { rows } = await client.query(
    `select id, name, fields from field_definition_sets where id = $1`,
    [SET_ID]
  )
  if (rows.length === 0) {
    throw new Error(`找不到欄位定義集 ${SET_ID}`)
  }

  const set = rows[0]
  const fields = Array.isArray(set.fields) ? set.fields : []

  console.log(`欄位定義集：${set.name}`)
  console.log(`現有欄位 ${fields.length} 個：${fields.map((f) => f.key).join(', ')}`)

  if (fields.some((f) => f.key === NEW_FIELD.key)) {
    console.log(`\n${NEW_FIELD.key} 已存在 — 不做任何變更（冪等）`)
    await client.end()
    return
  }

  const next = [...fields, NEW_FIELD]
  console.log(`\n將加入欄位：\n${JSON.stringify(NEW_FIELD, null, 2)}`)
  console.log(`\n加入後共 ${next.length} 個欄位`)

  if (!apply) {
    console.log('\n[dry-run] 未寫入。要實際套用請帶 APPLY=true')
    await client.end()
    return
  }

  // 寫入前存快照 —— 這個欄位集沒有版本歷史，改壞了只能靠快照還原
  const snapshotDir = path.join(__dirname, 'snapshots')
  fs.mkdirSync(snapshotDir, { recursive: true })
  const snapshotPath = path.join(snapshotDir, `field-def-set-${SET_ID}.before.json`)
  fs.writeFileSync(snapshotPath, JSON.stringify({ id: set.id, name: set.name, fields }, null, 2))
  console.log(`\n快照已寫入：${snapshotPath}`)

  const result = await client.query(
    `update field_definition_sets
        set fields = $2::jsonb, version = version + 1, updated_at = now()
      where id = $1`,
    [SET_ID, JSON.stringify(next)]
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
