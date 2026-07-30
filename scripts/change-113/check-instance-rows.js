/**
 * @fileoverview CHANGE-113 階段二：檢查模板實例的列（唯讀）
 * @description
 *   端到端驗收的最後一關：GROUP 模式下一份 DHL 發票是否展開成兩列、
 *   每列的 shipment_number 與費用金額是否各自正確。
 *
 * @module scripts/change-113/check-instance-rows
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-29
 */
require('dotenv').config()
const { Client } = require('pg')

const INSTANCE_ID = process.argv[2]

async function main() {
  if (!INSTANCE_ID) throw new Error('用法：node check-instance-rows.js <instanceId>')

  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  const inst = await client.query(
    `select i.id, i.name, i.status, t.name as template_name, t.line_item_mode
       from template_instances i
       join data_templates t on t.id = i.data_template_id
      where i.id = $1`,
    [INSTANCE_ID]
  )
  const out = []
  if (inst.rows.length === 0) {
    console.log('找不到實例')
    await client.end()
    return
  }
  const meta = inst.rows[0]
  out.push(`實例：${meta.name}`)
  out.push(`模板：${meta.template_name}  分列模式=${meta.line_item_mode}  狀態=${meta.status}`)

  const rows = await client.query(
    `select row_index, row_key, status, source_document_ids, field_values, transform_diagnostics
       from template_instance_rows
      where template_instance_id = $1
      order by row_index`,
    [INSTANCE_ID]
  )

  out.push(`\n共 ${rows.rows.length} 列`)
  for (const row of rows.rows) {
    const values = row.field_values || {}
    const nonEmpty = Object.entries(values).filter(
      ([, v]) => v !== null && v !== undefined && v !== ''
    )
    out.push(`\n--- 第 ${row.row_index} 列  rowKey=${row.row_key}  status=${row.status}`)
    out.push(`    來源文件 ${row.source_document_ids.length} 份`)
    for (const [key, value] of nonEmpty) {
      out.push(`    ${key} = ${JSON.stringify(value)}`)
    }
    if (row.transform_diagnostics) {
      out.push(`    ⚠ 轉換診斷：${JSON.stringify(row.transform_diagnostics)}`)
    }
  }

  await client.end()
  console.log(out.join('\n'))
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
