/**
 * @fileoverview FIX-113（存量孤兒資料回填，破壞性一次性）：把過往經 admin 合併 UI
 *   （autoMergeCompanies，FIX-112 前什麼都不轉）孤兒化的關聯資料，從 MERGED 副公司
 *   重指到其鏈末端的 canonical 公司。
 *
 *   背景：FIX-112 已修正 autoMergeCompanies / mergeCompanies 的程式碼缺口（未來合併會轉移
 *   documents + extraction_results + mapping_rules）。但 FIX-112 之前經 admin 合併過的公司，
 *   其副公司仍被設為 MERGED、關聯資料卻未轉移 → documents / extraction_results 仍指向 MERGED
 *   副公司 → COMPANY 級 template 映射因 companyId 不相等而失效（見 memory
 *   company_dup_breaks_company_mapping）。本腳本補回填。
 *
 *   對象發現：所有 status='MERGED' 且 merged_into_id 非空的公司（source）；每個 source 沿
 *   merged_into_id 鏈解析到「末端 canonical」（第一個非 MERGED 的公司，含環路保護）。
 *
 *   轉移策略（與 FIX-112 / confirmCompanyMerge 一致）：
 *   - **自動轉移（CORE）**：documents、extraction_results、mapping_rules。
 *   - **回報但不自動轉（KEEP，MERGED 後 inert）**：field_definition_sets、template_field_mappings、
 *     document_formats（canonical 保留自己那套；避免唯一約束衝突/重複定義）。
 *   - **回報但不自動轉（OTHER）**：其餘任何含 company_id 的表若仍有孤兒列，DRYRUN 會列出，
 *     供人工評估（不隱藏、不靜默略過）。
 *
 *   由 RUN_FIX113_ORPHAN_BACKFILL=dryrun|write 控制。dryrun 只 SELECT + 印計劃；write 才寫入。
 *   ⚠️ **不接入 entrypoint**（破壞性一次性、避免部署誤觸）；經 ad-hoc 執行，先 dryrun 再 write。
 *   交易原子性（BEGIN/COMMIT，任何錯誤 ROLLBACK）。
 *
 * @module prisma/apply-fix113-orphan-backfill
 * @since FIX-113 (2026-07-16)
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

// 自動轉移（與 FIX-112 / confirmCompanyMerge 一致）
const CORE_TABLES = ['documents', 'extraction_results', 'mapping_rules']
// 刻意留在 source（MERGED 後 inert，不轉移；避免與 canonical 既有衝突）
const KEEP_UNDER_SOURCE = new Set([
  'field_definition_sets',
  'template_field_mappings',
  'document_formats',
])

/**
 * 沿 merged_into_id 鏈解析末端 canonical。
 * @returns { targetId, note } targetId 為 null 表示無法安全解析（末端仍 MERGED / 環路 / 缺失）
 */
function resolveTerminal(sourceId, byId) {
  const visited = new Set()
  let cur = byId[sourceId]
  let hops = 0
  while (cur && cur.merged_into_id) {
    if (visited.has(cur.id)) return { targetId: null, note: 'cycle' }
    visited.add(cur.id)
    const next = byId[cur.merged_into_id]
    if (!next) return { targetId: null, note: `target-missing(${cur.merged_into_id})` }
    if (next.status !== 'MERGED') return { targetId: next.id, note: hops > 0 ? `chain(${hops + 1})` : 'direct' }
    cur = next
    hops += 1
    if (hops > 50) return { targetId: null, note: 'too-deep' }
  }
  return { targetId: null, note: 'no-merged-target' }
}

async function listCompanyIdTables(client) {
  const cols = await client.query(
    `select table_name from information_schema.columns
      where column_name='company_id' and table_schema='public' order by table_name`
  )
  return cols.rows.map((r) => r.table_name)
}

async function main() {
  const mode = (process.env.RUN_FIX113_ORPHAN_BACKFILL || '').toLowerCase()
  if (mode !== 'dryrun' && mode !== 'write') {
    console.error('[fix113] set RUN_FIX113_ORPHAN_BACKFILL=dryrun|write')
    process.exit(1)
  }
  if (!process.env.DATABASE_URL) {
    console.error('[fix113] DATABASE_URL not set')
    process.exit(1)
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveSsl(),
    connectionTimeoutMillis: 30000,
  })
  await client.connect()
  try {
    // 1. 載入所有公司（用於鏈解析）；companies 表規模小
    const all = await client.query(
      `select id, name, status::text as status, merged_into_id from companies`
    )
    const byId = {}
    for (const r of all.rows) byId[r.id] = r

    // 2. 發現 source：status=MERGED 且能解析到非 MERGED 末端
    const mergedCompanies = all.rows.filter((r) => r.status === 'MERGED' && r.merged_into_id)
    const resolvable = [] // { source, targetId, note }
    const unresolved = [] // { source, note }
    for (const s of mergedCompanies) {
      const { targetId, note } = resolveTerminal(s.id, byId)
      if (targetId) resolvable.push({ source: s, targetId, note })
      else unresolved.push({ source: s, note })
    }

    const sourceIds = resolvable.map((r) => r.source.id)

    console.log(`[fix113] mode=${mode}`)
    console.log(`[fix113] MERGED companies with merged_into_id: ${mergedCompanies.length}`)
    console.log(`[fix113] resolvable to a canonical target: ${resolvable.length}`)
    console.log(`[fix113] unresolvable (skipped): ${unresolved.length}`)
    for (const u of unresolved) {
      console.log(`  ! SKIP ${u.source.id} "${u.source.name}" — ${u.note}`)
    }

    if (sourceIds.length === 0) {
      console.log('[fix113] no resolvable MERGED sources — nothing to backfill.')
      return
    }

    // 3. 盤點 CORE 表孤兒列（每表 + 每 source→target）
    console.log(`[fix113] --- CORE tables (WILL transfer): ${CORE_TABLES.join(', ')} ---`)
    const coreCounts = {} // table -> total
    for (const t of CORE_TABLES) {
      const q = await client.query(
        `select count(*)::int as n from "${t}" where company_id = any($1)`,
        [sourceIds]
      )
      coreCounts[t] = q.rows[0].n
      console.log(`  ${t}: ${q.rows[0].n}`)
    }
    const coreGrand = Object.values(coreCounts).reduce((a, b) => a + b, 0)
    console.log(`[fix113] CORE total rows to transfer: ${coreGrand}`)

    // 每個有孤兒資料的 source 的細目（只印非零者）
    console.log('[fix113] per-source breakdown (non-zero CORE only):')
    for (const { source, targetId, note } of resolvable) {
      let subtotal = 0
      const parts = []
      for (const t of CORE_TABLES) {
        const q = await client.query(
          `select count(*)::int as n from "${t}" where company_id = $1`,
          [source.id]
        )
        if (q.rows[0].n > 0) {
          parts.push(`${t}=${q.rows[0].n}`)
          subtotal += q.rows[0].n
        }
      }
      if (subtotal > 0) {
        const tgt = byId[targetId]
        console.log(
          `  ${source.id} "${source.name}" -> ${targetId} "${tgt ? tgt.name : '?'}" [${note}] : ${parts.join(', ')}`
        )
      }
    }

    // 4. 盤點 KEEP + OTHER 表孤兒列（回報但不自動轉）
    const allCidTables = await listCompanyIdTables(client)
    const otherTables = allCidTables.filter(
      (t) => !CORE_TABLES.includes(t) && !KEEP_UNDER_SOURCE.has(t)
    )
    console.log('[fix113] --- KEEP tables (inert under MERGED, NOT transferred) ---')
    for (const t of KEEP_UNDER_SOURCE) {
      if (!allCidTables.includes(t)) continue
      const q = await client.query(
        `select count(*)::int as n from "${t}" where company_id = any($1)`,
        [sourceIds]
      )
      if (q.rows[0].n > 0) console.log(`  ${t}: ${q.rows[0].n} (kept, inert)`)
    }
    console.log('[fix113] --- OTHER company_id tables with orphan rows (NOT auto-transferred — review) ---')
    let otherFlagged = 0
    for (const t of otherTables) {
      const q = await client.query(
        `select count(*)::int as n from "${t}" where company_id = any($1)`,
        [sourceIds]
      )
      if (q.rows[0].n > 0) {
        console.log(`  ! ${t}: ${q.rows[0].n}`)
        otherFlagged += 1
      }
    }
    if (otherFlagged === 0) console.log('  (none)')

    if (mode === 'dryrun') {
      console.log('[fix113] DRY-RUN only — no writes performed.')
      return
    }

    // 5. WRITE（交易原子性）：僅轉移 CORE 表，每 source→其解析 target
    await client.query('BEGIN')
    try {
      let moved = 0
      for (const { source, targetId } of resolvable) {
        for (const t of CORE_TABLES) {
          const r = await client.query(
            `update "${t}" set company_id = $1 where company_id = $2`,
            [targetId, source.id]
          )
          if (r.rowCount) moved += r.rowCount
        }
      }
      await client.query('COMMIT')
      console.log(`[fix113] WRITE done — transferred ${moved} CORE rows across ${resolvable.length} source(s).`)
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    }

    // 6. read-back 驗證：CORE 表不應再有列指向任何已處理的 MERGED source
    console.log('[fix113] read-back (residual CORE rows still on MERGED sources, expect 0):')
    let residual = 0
    for (const t of CORE_TABLES) {
      const q = await client.query(
        `select count(*)::int as n from "${t}" where company_id = any($1)`,
        [sourceIds]
      )
      console.log(`  ${t}: ${q.rows[0].n}`)
      residual += q.rows[0].n
    }
    console.log(`[fix113] residual total: ${residual} (expect 0)`)
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('[fix113] FAILED:', e.message)
  process.exit(1)
})
