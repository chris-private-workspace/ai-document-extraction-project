/**
 * @fileoverview CHANGE-113：匯出 Azure 設定腳本所需的來源資料（唯讀）
 * @description
 *   四項 DHL 設定要搬到 Azure，但**本地 ID 在 Azure 不成立** —— 公司、模板、
 *   欄位定義集、prompt 的主鍵都是各環境獨立產生的。Azure 腳本必須以**名稱**查找，
 *   因此這裡把「名稱」與「內容」一併匯出，供撰寫該腳本時嵌入正確的字面值。
 *
 *   輸出為 JSON（stdout）。
 *
 * @module scripts/change-113/dump-azure-setup-source
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-30
 */
require('dotenv').config()
const { Client } = require('pg')

const PROMPT_ID = 'change113-dhl-stage3-001'
const TEMPLATE_ID = 'cmrbi0ktk033201o3rivrxb6h'
const DHL_COMPANY_ID = 'eedf4065-653b-4fd0-8bfb-f71c78bb2ae5'
const FIELD_SET_ID = 'aba35edd-fe26-4b46-bb18-01bd2594b157'

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  const out = {}

  const prompt = await client.query(
    `select id, name, description, prompt_type, scope, company_id, document_format_id,
            system_prompt, user_prompt_template, is_active, version, merge_strategy
       from prompt_configs where id = $1`,
    [PROMPT_ID]
  )
  out.promptConfig = prompt.rows[0] ?? null

  const company = await client.query(
    `select id, name, code, status from companies where id = $1`,
    [DHL_COMPANY_ID]
  )
  out.company = company.rows[0] ?? null

  const template = await client.query(
    `select id, name, scope, company_id, is_system, line_item_mode
       from data_templates where id = $1`,
    [TEMPLATE_ID]
  )
  out.template = template.rows[0] ?? null

  const fieldSet = await client.query(
    `select id, name, scope, company_id, document_format_id, fields
       from field_definition_sets where id = $1`,
    [FIELD_SET_ID]
  )
  out.fieldDefinitionSet = fieldSet.rows[0] ?? null

  const mapping = await client.query(
    `select id, name, scope, company_id, document_format_id, mappings, priority, is_active
       from template_field_mappings
      where data_template_id = $1 and company_id = $2 and is_active = true`,
    [TEMPLATE_ID, DHL_COMPANY_ID]
  )
  out.templateFieldMapping = mapping.rows[0] ?? null

  // Azure 的 DHL 公司可能名稱不同或有重複 —— 一併列出所有名稱含 DHL 者供比對
  const dhlLike = await client.query(
    `select id, name, code, status from companies where name ilike '%DHL%' order by name`
  )
  out.dhlLikeCompanies = dhlLike.rows

  await client.end()
  console.log(JSON.stringify(out, null, 2))
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
