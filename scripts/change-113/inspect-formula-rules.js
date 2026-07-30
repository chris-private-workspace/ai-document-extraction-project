/**
 * @fileoverview CHANGE-113：盤點專案既有 FORMULA 映射規則的寫法慣例（唯讀）
 * @description
 *   把 DHL 的 `freight` 改成 FORMULA 之前，先看既有 FORMULA 規則怎麼填
 *   `sourceField` 與 `transformParams` —— 同一份資料裡混用兩種寫法會讓後人難以判斷哪個是對的。
 *
 * @module scripts/change-113/inspect-formula-rules
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-30
 */
require('dotenv').config()
const { Client } = require('pg')

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  const out = []

  const { rows } = await client.query(
    `select m.name as config_name, c.name as company_name,
            r->>'sourceField' as src, r->>'targetField' as tgt,
            r->'transformParams' as params
       from template_field_mappings m
       left join companies c on c.id = m.company_id,
            jsonb_array_elements(m.mappings) r
      where r->>'transformType' = 'FORMULA' and m.is_active = true
      order by c.name
      limit 25`
  )

  out.push(`=== 既有 FORMULA 規則：${rows.length} 條（上限 25）===`)
  for (const r of rows) {
    out.push(`  [${r.company_name ?? 'GLOBAL'}] ${r.tgt}`)
    out.push(`      sourceField = ${JSON.stringify(r.src)}`)
    out.push(`      params      = ${JSON.stringify(r.params)}`)
  }

  await client.end()
  console.log(out.join('\n'))
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
