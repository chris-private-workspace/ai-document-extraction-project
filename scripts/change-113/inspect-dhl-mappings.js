/**
 * @fileoverview CHANGE-113：DHL 在 Logistics Cost Inbound 模板下的映射盤點（唯讀）
 * @description
 *   回答「燃油附加費現在落到哪個模板欄位」。映射規則存在 `template_field_mappings.mappings`
 *   的 JSON 陣列裡（非資料表欄位），需展開才看得到 sourceField → targetField。
 *
 * @module scripts/change-113/inspect-dhl-mappings
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-29
 */
require('dotenv').config()
const { Client } = require('pg')

const TEMPLATE_ID = 'cmrbi0ktk033201o3rivrxb6h' // Logistics Cost - Inbound Template (Full List)
const DHL_COMPANY_ID = 'eedf4065-653b-4fd0-8bfb-f71c78bb2ae5'

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  const out = []

  const configs = await client.query(
    `select id, name, scope, company_id, is_active, priority,
            jsonb_array_length(mappings) as rule_count
       from template_field_mappings
      where data_template_id = $1
        and (company_id = $2 or company_id is null)
      order by priority desc`,
    [TEMPLATE_ID, DHL_COMPANY_ID]
  )
  out.push(`=== DHL 可用的映射配置：${configs.rows.length} 份 ===`)
  for (const c of configs.rows) {
    out.push(
      `  ${c.name} | scope=${c.scope} company=${c.company_id ? 'DHL' : 'null'} active=${c.is_active} 規則=${c.rule_count}`
    )
  }

  const rules = await client.query(
    `select m.scope, r->>'sourceField' as src, r->>'targetField' as tgt,
            r->>'transformType' as ttype, r->'transformParams' as params
       from template_field_mappings m, jsonb_array_elements(m.mappings) r
      where m.data_template_id = $1
        and (m.company_id = $2 or m.company_id is null)
        and m.is_active = true
      order by r->>'targetField'`,
    [TEMPLATE_ID, DHL_COMPANY_ID]
  )
  out.push(`\n=== 生效中的映射規則：${rules.rows.length} 條 ===`)
  for (const r of rules.rows) {
    out.push(
      `  ${String(r.tgt).padEnd(28)} <- ${String(r.src).padEnd(32)} [${r.ttype}] ${r.params ? JSON.stringify(r.params) : ''}`
    )
  }

  const cols = await client.query(
    `select f->>'name' as name, f->>'label' as label
       from data_templates t, jsonb_array_elements(t.fields) f
      where t.id = $1
        and (f->>'name' ilike '%fuel%' or f->>'label' ilike '%fuel%'
             or f->>'name' ilike '%surcharge%' or f->>'name' ilike '%freight%'
             or f->>'name' ilike '%other%')`,
    [TEMPLATE_ID]
  )
  out.push(`\n=== 模板中 燃油/運費/其他 相關欄位 ===`)
  for (const c of cols.rows) out.push(`  ${c.name} | ${c.label}`)

  const defs = await client.query(
    `select d->>'key' as key, d->>'label' as label, d->>'fieldType' as ftype
       from field_definition_sets s, jsonb_array_elements(s.fields) d
      where s.company_id = $1
      order by d->>'key'`,
    [DHL_COMPANY_ID]
  )
  out.push(`\n=== DHL 欄位定義集：${defs.rows.length} 欄 ===`)
  for (const d of defs.rows) out.push(`  ${d.key} | ${d.label} | ${d.ftype}`)

  await client.end()
  console.log(out.join('\n'))
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
