/**
 * @fileoverview CHANGE-113：以交易回滾實測 prompt INSERT 語句（不留痕跡）
 * @description
 *   `prisma/change113-dhl-setup.js` 的步驟 3 有兩條分支：prompt 已存在（UPDATE）
 *   與不存在（INSERT）。本地永遠走 UPDATE，Azure 首次部署則走 INSERT ——
 *   也就是說**上線時才第一次執行那段 SQL**。欄位清單漏一個 NOT NULL 就會失敗，
 *   而那時只能看容器 log 猜。
 *
 *   做法：BEGIN → 刪掉本地既有的同範圍 prompt → 執行同一條 INSERT →
 *   驗證寫入結果 → ROLLBACK。本地資料完全不變。
 *
 * @module scripts/change-113/probe-prompt-insert
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-30
 */
require('dotenv').config()
const { Client } = require('pg')

const COMPANY_CODE = 'DHL'
const PROMPT_TYPE = 'STAGE_3_FIELD_EXTRACTION'

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  try {
    await client.query('begin')

    const company = await client.query(`select id, name from companies where code = $1`, [
      COMPANY_CODE,
    ])
    if (company.rows.length !== 1) throw new Error(`預期 1 間 DHL 公司，實際 ${company.rows.length}`)
    const companyId = company.rows[0].id
    console.log(`公司：${company.rows[0].name} (${companyId})`)

    const removed = await client.query(
      `delete from prompt_configs
        where prompt_type = $1 and scope = 'COMPANY'
          and company_id = $2 and document_format_id is null`,
      [PROMPT_TYPE, companyId]
    )
    console.log(`交易內先刪除既有同範圍 prompt：${removed.rowCount} 筆`)

    // 與 prisma/change113-dhl-setup.js 步驟 3 完全相同的 INSERT
    const inserted = await client.query(
      `insert into prompt_configs
         (id, prompt_type, scope, name, description, company_id, document_format_id,
          system_prompt, user_prompt_template, merge_strategy, variables,
          is_active, version, created_at, updated_at)
       values ($1, $2, 'COMPANY', $3, $4, $5, null, $6, $7, 'OVERRIDE', '[]'::jsonb,
               true, 1, now(), now())`,
      [
        'change113-dhl-stage3-001',
        PROMPT_TYPE,
        'DHL Express - Stage 3 (multi-shipment detail table)',
        'CHANGE-113 probe',
        companyId,
        'PROBE system prompt',
        'PROBE user prompt',
      ]
    )
    console.log(`INSERT 成功：${inserted.rowCount} 筆`)

    const check = await client.query(
      `select id, prompt_type, scope, is_active, version, merge_strategy,
              created_at is not null as has_created, updated_at is not null as has_updated
         from prompt_configs where id = $1`,
      ['change113-dhl-stage3-001']
    )
    console.log(`寫入結果：${JSON.stringify(check.rows[0])}`)

    await client.query('rollback')
    console.log('\n✅ 已 ROLLBACK —— 本地資料未變更')

    const after = await client.query(
      `select count(*)::int as n from prompt_configs
        where prompt_type = $1 and scope = 'COMPANY' and company_id = $2`,
      [PROMPT_TYPE, companyId]
    )
    console.log(`回滾後同範圍 prompt 筆數：${after.rows[0].n}（應為 1）`)
  } catch (err) {
    await client.query('rollback').catch(() => undefined)
    throw err
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(`🔴 ${err.message}`)
  process.exit(1)
})
