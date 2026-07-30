/**
 * @fileoverview CHANGE-113 階段二：檢查 DHL 文件的提取結果（唯讀）
 * @description
 *   端到端驗證的觀察窗：文件狀態、Stage 3 是否產出 lineItemGroups、
 *   每組的 groupKey / 費用欄位 / 行項目金額。
 *
 * @module scripts/change-113/check-dhl-extraction
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-29
 */
require('dotenv').config()
const { Client } = require('pg')

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  const out = []

  const { rows } = await client.query(
    `select d.id, d.file_name, d.status, d.company_id, c.name as company_name,
            d.created_at,
            e.stage_3_result as s3,
            e.reference_number_match as ref_match,
            e.field_mappings as field_mappings
       from documents d
       left join extraction_results e on e.document_id = d.id
       left join companies c on c.id = d.company_id
      where d.file_name ilike 'DHL_RCIM250111%'
      order by d.created_at desc
      limit 3`
  )

  if (rows.length === 0) {
    out.push('找不到 DHL_RCIM250111 相關文件')
  }

  for (const row of rows) {
    out.push(`\n=== ${row.file_name} ===`)
    out.push(`documentId : ${row.id}`)
    out.push(`status     : ${row.status}`)
    out.push(`company    : ${row.company_name} (${row.company_id})`)
    out.push(`uploadedAt : ${row.created_at.toISOString()}`)

    const s3 = row.s3
    if (!s3) {
      out.push('stage3Result: (無)')
      continue
    }

    const lineItems = Array.isArray(s3.lineItems) ? s3.lineItems : []
    out.push(`lineItems  : ${lineItems.length} 筆`)
    for (const item of lineItems) {
      out.push(
        `   ${item.description} | classifiedAs=${item.classifiedAs} | amount=${item.amount} | groupKey=${item.groupKey} | groupSourceRef=${item.groupSourceRef}`
      )
    }

    const groups = Array.isArray(s3.lineItemGroups) ? s3.lineItemGroups : null
    if (!groups) {
      out.push('lineItemGroups: (無 — 未分組或未經階段二程式碼處理)')
    } else {
      out.push(`lineItemGroups: ${groups.length} 組`)
      for (const group of groups) {
        const sum = Object.values(group.fields || {}).reduce(
          (acc, f) => acc + (typeof f?.value === 'number' ? f.value : 0),
          0
        )
        out.push(`   -- groupKey=${group.groupKey}  sourceRefs=${JSON.stringify(group.sourceRefs)}`)
        for (const [key, field] of Object.entries(group.fields || {})) {
          out.push(`      ${key} = ${field?.value}  (source=${field?.source})`)
        }
        out.push(`      組內費用合計 = ${sum.toFixed(2)}`)
        out.push(`      行項目 ${group.lineItems?.length ?? 0} 筆`)
      }
    }

    // 文件層級費用欄位（模板層 PIVOT 模式的取值來源）
    const fields = s3.fields || {}
    const chargeKeys = Object.keys(fields).filter((k) =>
      ['express_worldwide_doc', 'express_worldwide_nondoc', 'fuel_surcharge'].includes(k)
    )
    if (chargeKeys.length > 0) {
      out.push('文件層級費用欄位:')
      for (const key of chargeKeys) {
        out.push(`   ${key} = ${fields[key]?.value}`)
      }
    }

    const refMatch = row.ref_match
    if (refMatch?.matches?.length) {
      out.push(
        `refMatch   : ${refMatch.matches.map((m) => `${m.referenceNumber}(${m.type})`).join(', ')}`
      )
    } else {
      out.push('refMatch   : (無)')
    }
  }

  await client.end()
  console.log(out.join('\n'))
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
