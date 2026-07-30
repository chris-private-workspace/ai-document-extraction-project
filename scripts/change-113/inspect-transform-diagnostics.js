/**
 * @fileoverview CHANGE-113：盤點全庫模板列的轉換診斷分佈（唯讀，建立對照組）
 * @description
 *   DHL 改用 FORMULA 後每列出現 `⚠ 轉換診斷：{"freight":["express_worldwide_doc"]}`。
 *   要判斷這是「我引入的新問題」還是「FORMULA 慣例的既有常態」，必須先看
 *   **其他公司的列本來長什麼樣** —— 沒有對照組就只能猜。
 *
 * @module scripts/change-113/inspect-transform-diagnostics
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-30
 */
require('dotenv').config()
const { Client } = require('pg')

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  const out = []

  const summary = await client.query(
    `select count(*) as total,
            count(*) filter (where transform_diagnostics is not null) as with_diag
       from template_instance_rows`
  )
  const s = summary.rows[0]
  out.push(`=== 全庫模板列：${s.total} 列，其中 ${s.with_diag} 列帶轉換診斷 ===`)

  const byCompany = await client.query(
    `select coalesce(c.name, '(無公司)') as company,
            count(*) as rows,
            count(*) filter (where r.transform_diagnostics is not null) as with_diag
       from template_instance_rows r
       left join documents d on d.id = r.source_document_ids[1]
       left join companies c on c.id = d.company_id
      group by 1
      order by with_diag desc, rows desc
      limit 15`
  )
  out.push(`\n=== 依公司（前 15）===`)
  for (const r of byCompany.rows) {
    out.push(`  ${String(r.company).padEnd(45)} 列=${String(r.rows).padStart(4)} 帶診斷=${r.with_diag}`)
  }

  const samples = await client.query(
    `select coalesce(c.name, '(無公司)') as company, r.transform_diagnostics as diag
       from template_instance_rows r
       left join documents d on d.id = r.source_document_ids[1]
       left join companies c on c.id = d.company_id
      where r.transform_diagnostics is not null
      order by c.name
      limit 12`
  )
  out.push(`\n=== 診斷內容樣本 ===`)
  for (const r of samples.rows) {
    out.push(`  [${r.company}] ${JSON.stringify(r.diag)}`)
  }

  await client.end()
  console.log(out.join('\n'))
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
