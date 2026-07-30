/**
 * @fileoverview CHANGE-113 階段二：DHL 本地設定盤點（唯讀）
 * @description
 *   端到端驗證前先看清楚現況：公司、欄位定義集、模板、映射規則、已上傳文件，
 *   以及提取結果裡有沒有 lineItemGroups。
 *
 *   純唯讀，不寫入任何資料。輸出寫檔後以 Read 工具檢視。
 *
 * @module scripts/change-113/inspect-dhl-setup
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-29
 */
require('dotenv').config()
const { Client } = require('pg')

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set')
    process.exit(1)
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  const out = []
  const section = (title) => out.push(`\n=== ${title} ===`)

  // 1. 公司
  section('公司（名稱含 DHL）')
  const companies = await client.query(
    `select id, name, status from companies where name ilike '%DHL%' order by name`
  )
  for (const row of companies.rows) {
    out.push(`${row.id}  ${row.name}  status=${row.status}`)
  }
  const companyIds = companies.rows.map((r) => r.id)

  // 2. 欄位定義集
  section('欄位定義集')
  const sets = await client.query(
    `select id, name, scope, company_id, document_format_id, is_active,
            jsonb_array_length(fields) as field_count
       from field_definition_sets
      where company_id = any($1::text[])
      order by name`,
    [companyIds]
  )
  for (const row of sets.rows) {
    out.push(
      `${row.id}  ${row.name}  scope=${row.scope}  active=${row.is_active}  欄位數=${row.field_count}`
    )
  }

  section('欄位定義集內的欄位')
  for (const set of sets.rows) {
    const detail = await client.query(
      `select f->>'key' as key, f->>'label' as label, f->>'fieldType' as field_type,
              f->>'dataType' as data_type, f->'aliases' as aliases
         from field_definition_sets s, jsonb_array_elements(s.fields) f
        where s.id = $1`,
      [set.id]
    )
    out.push(`-- ${set.name} (${set.id})`)
    for (const f of detail.rows) {
      out.push(
        `   ${f.key}  | label=${f.label} | type=${f.field_type} | data=${f.data_type} | aliases=${JSON.stringify(f.aliases)}`
      )
    }
  }

  // 3. 資料模板
  section('資料模板（GLOBAL + DHL COMPANY）')
  const templates = await client.query(
    `select id, name, scope, company_id, line_item_mode, is_active,
            jsonb_array_length(fields) as field_count
       from data_templates
      where company_id = any($1::text[]) or scope = 'GLOBAL'
      order by scope, name`,
    [companyIds]
  )
  for (const row of templates.rows) {
    out.push(
      `${row.id}  ${row.name}  scope=${row.scope}  company=${row.company_id}  mode=${row.line_item_mode}  active=${row.is_active}  欄位數=${row.field_count}`
    )
  }

  // 4. 模板欄位映射
  section('模板欄位映射（DHL）')
  const mappings = await client.query(
    `select m.id, m.name, m.scope, m.data_template_id, m.company_id, m.is_active,
            t.name as template_name, m.mappings as rules
       from template_field_mappings m
       left join data_templates t on t.id = m.data_template_id
      where m.company_id = any($1::text[])
      order by t.name, m.name`,
    [companyIds]
  )
  for (const row of mappings.rows) {
    out.push(
      `${row.id}  ${row.name}  模板=${row.template_name}  scope=${row.scope}  active=${row.is_active}`
    )
    const rules = Array.isArray(row.rules) ? row.rules : []
    for (const rule of rules) {
      out.push(
        `   ${rule.sourceField} -> ${rule.targetField}  [${rule.transformType}] ${
          rule.transformParams ? JSON.stringify(rule.transformParams) : ''
        }`
      )
    }
  }

  // 5. 文件與提取結果
  section('DHL 文件與提取結果')
  const docs = await client.query(
    `select d.id, d.file_name, d.status, d.company_id, d.created_at,
            e.id as extraction_id,
            (e.stage_3_result is not null) as has_stage3,
            jsonb_array_length(coalesce(e.stage_3_result->'lineItems', '[]'::jsonb)) as line_item_count,
            jsonb_array_length(coalesce(e.stage_3_result->'lineItemGroups', '[]'::jsonb)) as group_count,
            (e.reference_number_match is not null) as has_ref_match
       from documents d
       left join extraction_results e on e.document_id = d.id
      where d.company_id = any($1::text[]) or d.file_name ilike '%DHL%'
      order by d.created_at desc
      limit 30`,
    [companyIds]
  )
  for (const row of docs.rows) {
    out.push(
      `${row.id}  ${row.file_name}  status=${row.status}  stage3=${row.has_stage3}  lineItems=${row.line_item_count}  groups=${row.group_count}  refMatch=${row.has_ref_match}`
    )
  }

  // 6. 模板實例
  section('模板實例（DHL 相關）')
  const instances = await client.query(
    `select i.id, i.name, i.status, i.data_template_id, t.name as template_name,
            t.line_item_mode, count(r.id) as row_count
       from template_instances i
       left join data_templates t on t.id = i.data_template_id
       left join template_instance_rows r on r.template_instance_id = i.id
      group by i.id, i.name, i.status, i.data_template_id, t.name, t.line_item_mode
      order by i.created_at desc
      limit 15`
  )
  for (const row of instances.rows) {
    out.push(
      `${row.id}  ${row.name}  status=${row.status}  模板=${row.template_name}  mode=${row.line_item_mode}  列數=${row.row_count}`
    )
  }

  // 7. DHL Stage 3 Prompt
  section('DHL Stage 3 Prompt')
  const prompts = await client.query(
    `select id, name, scope, company_id, prompt_type, is_active, merge_strategy as merge_mode
       from prompt_configs
      where company_id = any($1::text[])
      order by prompt_type`,
    [companyIds]
  )
  for (const row of prompts.rows) {
    out.push(
      `${row.id}  ${row.name}  type=${row.prompt_type}  scope=${row.scope}  merge=${row.merge_mode}  active=${row.is_active}`
    )
  }

  await client.end()
  console.log(out.join('\n'))
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
