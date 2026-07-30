/**
 * @fileoverview CHANGE-113：傾印指定文件的 Stage 3 prompt 與回應（唯讀）
 * @description
 *   分組鍵讀錯時，要先分清楚是「候選清單注入錯了」還是「GPT 從正確清單裡挑錯」。
 *   兩者的修法完全不同，猜不得。
 *
 * @module scripts/change-113/dump-stage3-prompt
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-29
 */
require('dotenv').config()
const { Client } = require('pg')

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  const { rows } = await client.query(
    `select d.id, d.file_name, e.stage_3_ai_details as ai, e.stage_1_result as s1,
            e.stage_2_result as s2
       from documents d
       join extraction_results e on e.document_id = d.id
      where d.file_name ilike 'DHL_RCIM250111%'
      order by d.created_at desc
      limit 1`
  )

  if (rows.length === 0) {
    console.log('找不到文件')
    await client.end()
    return
  }

  const row = rows[0]
  const out = []
  out.push(`=== ${row.file_name} (${row.id}) ===`)
  out.push(`\n--- Stage 1 ---\n${JSON.stringify(row.s1, null, 2)}`)
  out.push(`\n--- Stage 2 ---\n${JSON.stringify(row.s2, null, 2)}`)

  const ai = row.ai || {}
  out.push(`\n--- Stage 3 model ---\n${ai.model}`)
  out.push(`\n--- Stage 3 PROMPT ---\n${ai.prompt ?? '(無)'}`)
  out.push(`\n--- Stage 3 RESPONSE ---\n${ai.response ?? '(無)'}`)

  await client.end()
  console.log(out.join('\n'))
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
