/**
 * @fileoverview CHANGE-109 一次性回填：把 extraction_results.field_mappings JSON 內的
 *   invoice_number 抄到新增的 invoice_number 欄位。
 *
 *   為何需要回填：新欄位只在「之後的提取」被寫入（processing-result-persistence），
 *   既有資料一律為 null。而「同一發票是否有更新的文件記錄」這個偵測，目標正是**存量**
 *   實例 —— 不回填等於功能對存量靜默無效。
 *
 *   設計重點（比照 apply-schema-drift.js）：
 *   - 只依賴 `pg`（standalone runtime 已含），不需 Prisma CLI / tsx。Azure runner 映像
 *     不含 scripts/ 與 tsx，故一次性 DB 腳本必須放 prisma/*.js（見 FIX-095 前例）
 *   - Azure PostgreSQL 需 TLS：偵測 sslmode=require 或 azure host 時啟用
 *   - **預設 dry-run**：只有 RUN_INVOICE_NUMBER_BACKFILL=true 才寫入
 *   - 冪等：只更新 invoice_number IS NULL 的列 → 重跑第二次應為 0 筆
 *   - 分批：避免單一巨大 UPDATE 長時間佔用交易（FIX-132 的連線池耗盡教訓）
 *
 *   由 docker-entrypoint.sh 的 RUN_INVOICE_NUMBER_BACKFILL 觸發；跑完把旗標設回 false。
 *
 * @module prisma/backfill-invoice-number
 * @since CHANGE-109 (2026-07-27)
 * @lastModified 2026-07-27
 */
const { Client } = require('pg')

/** 提取結果中發票號的欄位鍵。與 src/constants/standard-fields.ts 的 STANDARD_FIELDS 一致。 */
const INVOICE_NUMBER_KEY = 'invoice_number'

/** 每批處理筆數。分批而非單一 UPDATE，避免長交易（見 FIX-132）。 */
const BATCH_SIZE = 500

function resolveSsl() {
  const url = process.env.DATABASE_URL || ''
  if (/sslmode=require/i.test(url) || /\.postgres\.database\.azure\.com/i.test(url)) {
    return { rejectUnauthorized: false }
  }
  return false
}

/**
 * 從 field_mappings JSON 取出發票號。
 *
 * field_mappings 形狀為 Record<targetField, { value, rawValue, confidence, ... }>
 * （見 processing-result-persistence.service.ts 的 convertMappedFieldsToJson）。
 * 僅取 value；空字串 / 非字串 / 缺鍵一律回 null（不參與同發票比對）。
 */
function extractInvoiceNumber(fieldMappings) {
  if (!fieldMappings || typeof fieldMappings !== 'object') return null
  const entry = fieldMappings[INVOICE_NUMBER_KEY]
  if (entry == null) return null
  // 正常形狀是 { value: ... }；但歷史資料可能直接存純值，兩者都接受
  const raw = typeof entry === 'object' && !Array.isArray(entry) ? entry.value : entry
  if (raw == null) return null
  const text = String(raw).trim()
  return text.length > 0 ? text : null
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[backfill-invoice] DATABASE_URL not set — cannot continue')
    process.exit(1)
  }

  const apply = process.env.RUN_INVOICE_NUMBER_BACKFILL === 'true'
  console.log(
    `[backfill-invoice] mode=${apply ? 'APPLY' : 'DRY-RUN'} ` +
      `(set RUN_INVOICE_NUMBER_BACKFILL=true to write)`,
  )

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveSsl(),
  })
  await client.connect()

  try {
    // 前置：欄位必須存在（由 apply-schema-drift.js 的 CHANGE-109 條目建立）
    const colCheck = await client.query(
      `select 1 from information_schema.columns
        where table_name = 'extraction_results' and column_name = 'invoice_number'`,
    )
    if (colCheck.rowCount === 0) {
      console.error(
        '[backfill-invoice] column extraction_results.invoice_number does not exist — ' +
          'run apply-schema-drift.js (RUN_SCHEMA_DRIFT_FIX=true) first',
      )
      process.exit(1)
    }

    const totalRes = await client.query(
      `select count(*)::int as n from "extraction_results" where "invoice_number" is null`,
    )
    const candidates = totalRes.rows[0].n
    console.log(`[backfill-invoice] rows with null invoice_number: ${candidates}`)

    let scanned = 0
    let filled = 0
    let noInvoice = 0
    let lastId = ''

    // 以 id 遞增游標分批掃描（穩定、不受 UPDATE 影響）
    for (;;) {
      const batch = await client.query(
        `select "id", "field_mappings"
           from "extraction_results"
          where "invoice_number" is null and "id" > $1
          order by "id"
          limit $2`,
        [lastId, BATCH_SIZE],
      )
      if (batch.rowCount === 0) break

      const updates = []
      for (const row of batch.rows) {
        scanned++
        lastId = row.id
        const invoice = extractInvoiceNumber(row.field_mappings)
        if (invoice === null) {
          noInvoice++
          continue
        }
        updates.push([row.id, invoice])
      }

      if (apply && updates.length > 0) {
        // 單批一個交易；每筆 update by primary key
        await client.query('BEGIN')
        try {
          for (const [id, invoice] of updates) {
            await client.query(
              `update "extraction_results" set "invoice_number" = $2 where "id" = $1`,
              [id, invoice],
            )
          }
          await client.query('COMMIT')
        } catch (err) {
          await client.query('ROLLBACK')
          throw err
        }
      }
      filled += updates.length

      console.log(
        `[backfill-invoice] batch done — scanned=${scanned} ` +
          `wouldFill=${filled} noInvoiceNumber=${noInvoice}`,
      )
    }

    console.log(
      `[backfill-invoice] ${apply ? 'filled' : 'would fill'} ${filled} row(s); ` +
        `${noInvoice} row(s) have no usable ${INVOICE_NUMBER_KEY} (left null, excluded from matching)`,
    )

    if (apply) {
      const after = await client.query(
        `select count(*)::int as n from "extraction_results" where "invoice_number" is not null`,
      )
      console.log(`[backfill-invoice] rows with invoice_number now: ${after.rows[0].n}`)
    } else {
      console.log('[backfill-invoice] DRY-RUN — no rows were modified')
    }
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error('[backfill-invoice] failed:', err.message)
  process.exit(1)
})
