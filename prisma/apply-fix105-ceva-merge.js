/**
 * @fileoverview FIX-105（Azure 端，破壞性一次性）：把 Azure DEV 的 5 筆重複 CEVA 公司
 *   合併進 canonical 主檔並正名，完整轉移文件與提取結果（補足 company.service.mergeCompanies
 *   漏轉 extraction_results 等表的缺口）。
 *
 *   背景：Azure DEV 的 Stage 1 公司識別因 OCR 名稱飄移 + normalize 漏抓 + findFirst 無 orderBy
 *   （見 CHANGE-103 根因），累積 8 筆 CEVA（6 ACTIVE）。文件被識別到簡稱而非全名。2026-07-16
 *   唯讀盤點確認引用分佈後，使用者拍板：5 筆 source 全併入 canonical、保留 canonical 既有
 *   field_definition_set（含 FIX-110 aliases）。
 *
 *   Canonical（target）= 0d02b680（MANUAL、138 docs、有 FIX-110 alias set），正名為
 *   「CEVA LOGISTICS (HONG KONG) LTD」（對齊本地 FIX-105）。
 *
 *   ⚠️ 破壞性：轉移文件 + extraction_results 等，並把 source 標 MERGED。**不接入 entrypoint**，
 *   僅經 Kudu ad-hoc 執行；先 dryrun 再 write。交易原子性（BEGIN/COMMIT，失敗 ROLLBACK）。
 *
 *   轉移策略：
 *   - **轉移**：所有含 company_id 的表，EXCEPT 下列「保留在來源」清單（避免與 canonical 既有衝突）。
 *     實務上非零者僅 documents / extraction_results（+ mapping_rules 等目前為 0，一併轉移求穩健）。
 *   - **保留在來源（合併後成 MERGED、inert，不轉移）**：field_definition_sets、
 *     template_field_mappings、document_formats。canonical 保留自己那套；source 的變 inert
 *     （MERGED 公司永不被 resolveCompanyId 命中、其 field def set 永不被 loadFieldDefinitionSet 載入）。
 *
 *   由 RUN_FIX105_CEVA_MERGE=dryrun|write 控制。dryrun 只 SELECT + 印計劃；write 才寫入。
 *
 * @module prisma/apply-fix105-ceva-merge
 * @since FIX-105 (2026-07-16, Azure sync)
 * @lastModified 2026-07-16
 */
const { Client } = require('pg')

function resolveSsl() {
  const url = process.env.DATABASE_URL || ''
  if (/sslmode=require/i.test(url) || /\.postgres\.database\.azure\.com/i.test(url)) {
    return { rejectUnauthorized: false }
  }
  return false
}

const TARGET = '0d02b680-165b-4cfd-8c1b-7ebfa6da8424'
const TARGET_NAME = 'CEVA LOGISTICS (HONG KONG) LTD'
// 使用者 2026-07-16 拍板：5 筆全併入（含 RICHASIA / RICON 兩筆疑似他名者）
const SOURCES = [
  '7448b7c5-9ca0-4d34-af58-80180b94caa3', // CEVA LOGISTICS (HONG KONG) LIMITED（CEVA Logistics）— 51 docs
  'ee91a1cf-7cdf-4af5-8586-21ad91090dd6', // CEVA Logistics Hong Kong Limited — 2 docs
  '866c5aa5-d4ea-4cc7-8293-33c722b7fa86', // CEVA Logistics (RICHASIA) PACIFIC OPERATIONS LIMITED — 1 doc
  'e1841c20-37fb-4ccc-9bbd-eb63cadff14f', // CEVA LOGISTICS (香港) KONG LITTD — 1 doc
  'c55b4d07-4c35-462c-b34b-9e35724b919c', // RICON ASIA PACIFIC OPERATIONS LIMITED（CEVA LOGISTICS）— 1 doc
]
// 保留在來源、不轉移（避免與 canonical 既有的一套衝突/重複）
const KEEP_UNDER_SOURCE = new Set([
  'field_definition_sets',
  'template_field_mappings',
  'document_formats',
])

async function getTransferTables(client) {
  const cols = await client.query(
    `select table_name from information_schema.columns
      where column_name='company_id' and table_schema='public' order by table_name`
  )
  return cols.rows.map((r) => r.table_name).filter((t) => !KEEP_UNDER_SOURCE.has(t))
}

function computeMergedVariants(target, sources) {
  return [
    ...new Set([
      ...(target.name_variants || []),
      target.name,
      ...sources.flatMap((s) => [s.name, ...(s.name_variants || [])]),
    ]),
  ].filter((v) => v && v !== TARGET_NAME)
}

async function main() {
  const mode = (process.env.RUN_FIX105_CEVA_MERGE || '').toLowerCase()
  if (mode !== 'dryrun' && mode !== 'write') {
    console.error('[fix105] set RUN_FIX105_CEVA_MERGE=dryrun|write')
    process.exit(1)
  }
  if (!process.env.DATABASE_URL) {
    console.error('[fix105] DATABASE_URL not set')
    process.exit(1)
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveSsl(),
    connectionTimeoutMillis: 30000,
  })
  await client.connect()
  try {
    // 驗證 target + sources 皆存在
    const chk = await client.query(
      `select id, name, status::text as status, name_variants from companies where id = any($1)`,
      [[TARGET, ...SOURCES]]
    )
    const byId = {}
    for (const r of chk.rows) byId[r.id] = r
    if (!byId[TARGET]) {
      console.error(`[fix105] ABORT: target ${TARGET} not found`)
      return
    }
    const missing = SOURCES.filter((s) => !byId[s])
    if (missing.length) {
      console.error(`[fix105] ABORT: source(s) not found: ${missing.join(', ')}`)
      return
    }

    const transferTables = await getTransferTables(client)
    const mergedVariants = computeMergedVariants(byId[TARGET], SOURCES.map((s) => byId[s]))

    console.log(`[fix105] mode=${mode}`)
    console.log(`[fix105] target ${TARGET} "${byId[TARGET].name}" -> rename "${TARGET_NAME}"`)
    console.log(`[fix105] sources (${SOURCES.length}):`)
    for (const s of SOURCES) console.log(`  - ${s} "${byId[s].name}" [${byId[s].status}]`)

    console.log(`[fix105] transfer rows (source->target), non-zero only:`)
    let grand = 0
    for (const t of transferTables) {
      const q = await client.query(
        `select count(*)::int as n from "${t}" where company_id = any($1)`,
        [SOURCES]
      )
      const n = q.rows[0].n
      if (n > 0) {
        console.log(`  ${t}: ${n}`)
        grand += n
      }
    }
    console.log(`[fix105] total rows to transfer: ${grand}`)
    console.log(`[fix105] kept under source (inert, NOT moved): ${[...KEEP_UNDER_SOURCE].join(', ')}`)
    console.log(`[fix105] target name_variants after merge (${mergedVariants.length}):`)
    console.log('  ' + JSON.stringify(mergedVariants))

    if (mode === 'dryrun') {
      console.log('[fix105] DRY-RUN only — no writes performed.')
      return
    }

    // WRITE（交易原子性）
    await client.query('BEGIN')
    try {
      let moved = 0
      for (const t of transferTables) {
        const r = await client.query(
          `update "${t}" set company_id = $1 where company_id = any($2)`,
          [TARGET, SOURCES]
        )
        if (r.rowCount) {
          console.log(`  moved ${r.rowCount} in ${t}`)
          moved += r.rowCount
        }
      }
      // 正名 canonical + 合併 variants
      await client.query(
        `update companies set name=$1, display_name=$1, name_variants=$2, updated_at=now() where id=$3`,
        [TARGET_NAME, mergedVariants, TARGET]
      )
      // sources -> MERGED
      const m = await client.query(
        `update companies set status='MERGED', merged_into_id=$1, updated_at=now()
          where id = any($2) and status <> 'MERGED'`,
        [TARGET, SOURCES]
      )
      await client.query('COMMIT')
      console.log(
        `[fix105] WRITE done — transferred ${moved} rows; marked ${m.rowCount} source(s) MERGED; target renamed.`
      )
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    }

    // read-back 驗證
    const rb = await client.query(
      `select id, name, status::text as status, merged_into_id from companies where id = any($1) order by status, name`,
      [[TARGET, ...SOURCES]]
    )
    console.log('[fix105] read-back:')
    for (const r of rb.rows) console.log('  ' + JSON.stringify(r))
    const active = await client.query(
      `select count(*)::int as n from companies where name ilike '%ceva%' and status='ACTIVE'`
    )
    console.log(`[fix105] active CEVA-name companies now: ${active.rows[0].n} (expect 1)`)
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('[fix105] FAILED:', e.message)
  process.exit(1)
})
