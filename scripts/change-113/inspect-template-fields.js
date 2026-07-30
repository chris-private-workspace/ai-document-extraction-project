/**
 * @fileoverview CHANGE-113 階段二：Logistics Cost Inbound 模板欄位盤點（唯讀）
 * @description
 *   決定燃油附加費該映射到哪個目標欄位前，先看模板實際有哪些欄位。
 *
 * @module scripts/change-113/inspect-template-fields
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-29
 */
require('dotenv').config()
const { Client } = require('pg')

const TEMPLATE_ID = 'cmrbi0ktk033201o3rivrxb6h' // Logistics Cost - Inbound Template (Full List)

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  const out = []

  const rows = await client.query(
    `select f->>'name' as name, f->>'label' as label, f->>'dataType' as data_type,
            f->>'isRequired' as required, f->>'order' as ord
       from data_templates t, jsonb_array_elements(t.fields) f
      where t.id = $1
      order by (f->>'order')::int`,
    [TEMPLATE_ID]
  )

  out.push(`=== Logistics Cost - Inbound Template (Full List) 共 ${rows.rows.length} 欄 ===`)
  for (const r of rows.rows) {
    out.push(`${String(r.ord).padStart(3)}  ${r.name}  | ${r.label} | ${r.data_type} | required=${r.required}`)
  }

  await client.end()
  console.log(out.join('\n'))
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
