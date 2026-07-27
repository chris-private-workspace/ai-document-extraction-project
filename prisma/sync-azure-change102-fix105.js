/**
 * @fileoverview CHANGE-102 + FIX-105（Azure 端）：一次性 Azure DEV DB 同步
 *   1) CHANGE-102 Phase 4：extraction.model.stage1/2/3 正名為 gpt-5.4 key
 *      （stage1/3=gpt-5.4-mini、stage2=gpt-5.4-nano；行為零變，實際 deployment 不變）
 *   2) FIX-105：CEVA 公司重複清理 + 主檔正名（正名主力 + 刪 0 關聯孤兒鏈）
 *
 *   背景：本地已執行（PR #100）；Azure DB 為獨立實例、id 與本地不同，且本機
 *   無法直連私有 PG，故以 gated 容器腳本在 VNet 內執行。
 *
 *   設計（比照 update-stage3-prompt.js）：
 *   - 只依賴 pg；Azure PG 需 TLS
 *   - inspect：唯讀診斷（stage 配置 + CEVA 記錄 + 關聯），零寫入
 *   - write：交易；stage 正名（冪等）+ CEVA 治理（name-based，只刪確認 0 關聯孤兒）
 *   - 非致命（entrypoint || 處理）
 *
 *   由 docker-entrypoint.sh 的 RUN_AZURE_SYNC=inspect|write 觸發；完成後清空旗標。
 *
 * @module prisma/sync-azure-change102-fix105
 * @since CHANGE-102 / FIX-105 (2026-07-10)
 */
const { Client } = require('pg')

function resolveSsl() {
  const url = process.env.DATABASE_URL || ''
  if (/sslmode=require/i.test(url) || /\.postgres\.database\.azure\.com/i.test(url)) {
    return { rejectUnauthorized: false }
  }
  return false
}

const MODE = (process.env.RUN_AZURE_SYNC || '').trim()
const TARGET_CEVA_NAME = 'CEVA LOGISTICS (HONG KONG) LTD'
const CEVA_KEEP_ALIAS = ['CEVA Logistics']
const STAGE_RENAME = {
  'extraction.model.stage1': 'gpt-5.4-mini',
  'extraction.model.stage2': 'gpt-5.4-nano',
  'extraction.model.stage3': 'gpt-5.4-mini',
}

async function companyRefTables(client) {
  const r = await client.query(
    `select table_name from information_schema.columns
      where column_name='company_id' and table_schema='public' order by table_name`
  )
  return r.rows.map((x) => x.table_name)
}
async function formatRefTables(client) {
  const r = await client.query(
    `select table_name from information_schema.columns
      where column_name='document_format_id' and table_schema='public' order by table_name`
  )
  return r.rows.map((x) => x.table_name)
}
async function countCompanyRefs(client, tables, companyId, exclude = []) {
  let total = 0
  const detail = {}
  for (const t of tables) {
    if (exclude.includes(t)) continue
    const r = await client.query(`select count(*)::int c from "${t}" where company_id = $1`, [companyId])
    if (r.rows[0].c > 0) {
      detail[t] = r.rows[0].c
      total += r.rows[0].c
    }
  }
  return { total, detail }
}
async function countFormatRefs(client, tables, formatId) {
  let total = 0
  const detail = {}
  for (const t of tables) {
    const r = await client.query(`select count(*)::int c from "${t}" where document_format_id = $1`, [formatId])
    if (r.rows[0].c > 0) {
      detail[t] = r.rows[0].c
      total += r.rows[0].c
    }
  }
  return { total, detail }
}
async function loadCevas(client) {
  const r = await client.query(
    `select c.id, c.name, c.code, c.display_name, c.name_variants,
            (select count(*) from documents d where d.company_id = c.id)::int as docs,
            (select count(*) from template_field_mappings m where m.company_id = c.id)::int as mappings
       from companies c
      where c.name ilike '%ceva%'
      order by docs desc, mappings desc`
  )
  return r.rows
}

async function inspect(client) {
  console.log('=== [azure-sync] INSPECT (唯讀) ===')
  const stage = await client.query(
    `select key, value from system_configs where key like 'extraction.model.stage%' order by key`
  )
  console.log('--- stage 配置現值 ---')
  stage.rows.forEach((x) => console.log(`  ${x.key} = ${x.value}`))

  const cevas = await loadCevas(client)
  console.log(`--- CEVA 公司（${cevas.length} 筆，docs 由多到少）---`)
  const cTables = await companyRefTables(client)
  const fTables = await formatRefTables(client)
  for (const c of cevas) {
    const refs = await countCompanyRefs(client, cTables, c.id, ['document_formats'])
    const fmts = await client.query(`select id, name from document_formats where company_id = $1`, [c.id])
    console.log(`  id=${c.id} name="${c.name}" code=${JSON.stringify(c.code)} display="${c.display_name}"`)
    console.log(`     name_variants=${JSON.stringify(c.name_variants)}`)
    console.log(`     docs=${c.docs} mappings=${c.mappings} 其他關聯(排除format)=${refs.total} ${JSON.stringify(refs.detail)}`)
    console.log(`     document_formats=${fmts.rowCount}`)
    for (const f of fmts.rows) {
      const fr = await countFormatRefs(client, fTables, f.id)
      console.log(`        format id=${f.id} name="${f.name}" 引用=${fr.total} ${JSON.stringify(fr.detail)}`)
    }
  }
  console.log('=== [azure-sync] INSPECT 完成，零寫入 ===')
}

async function write(client) {
  console.log('=== [azure-sync] WRITE (交易) ===')
  await client.query('begin')
  try {
    // 1) CHANGE-102：stage 正名（冪等）
    for (const [key, val] of Object.entries(STAGE_RENAME)) {
      const r = await client.query(
        `update system_configs set value=$1, updated_at=now()
          where key=$2 and value is distinct from $1`,
        [val, key]
      )
      console.log(`  [stage] ${key} -> ${val} (${r.rowCount} updated)`)
    }

    // 2) FIX-105：CEVA 治理
    const cevas = await loadCevas(client)
    if (cevas.length === 0) {
      console.log('  [ceva] 無 CEVA 公司，略過')
    } else {
      const primary = cevas[0]
      console.log(`  [ceva] 主力 = id=${primary.id} "${primary.name}" (docs=${primary.docs} mappings=${primary.mappings})`)
      const up = await client.query(
        `update companies
            set name=$1, display_name=$1, name_variants=$2, updated_at=now()
          where id=$3
            and (name is distinct from $1 or display_name is distinct from $1 or name_variants is distinct from $2::text[])`,
        [TARGET_CEVA_NAME, CEVA_KEEP_ALIAS, primary.id]
      )
      console.log(`  [ceva] 主力正名 (${up.rowCount} updated)`)

      const cTables = await companyRefTables(client)
      const fTables = await formatRefTables(client)
      for (const c of cevas.slice(1)) {
        const refs = await countCompanyRefs(client, cTables, c.id, ['document_formats'])
        if (refs.total > 0) {
          console.log(`  [ceva] 跳過 id=${c.id} "${c.name}"：有其他關聯 ${JSON.stringify(refs.detail)}（需人工處理）`)
          continue
        }
        const fmts = await client.query(`select id, name from document_formats where company_id=$1`, [c.id])
        let blocked = false
        for (const f of fmts.rows) {
          const fr = await countFormatRefs(client, fTables, f.id)
          if (fr.total > 0) {
            console.log(`  [ceva] 跳過 id=${c.id}：其 format ${f.id} 有引用 ${JSON.stringify(fr.detail)}`)
            blocked = true
            break
          }
        }
        if (blocked) continue
        if (fmts.rowCount > 0) {
          await client.query(`delete from document_formats where id = any($1)`, [fmts.rows.map((f) => f.id)])
          console.log(`  [ceva] 刪孤兒 format ${fmts.rowCount} 筆（company ${c.id}）`)
        }
        await client.query(`delete from companies where id=$1`, [c.id])
        console.log(`  [ceva] 刪孤兒公司 id=${c.id} "${c.name}"`)
      }
    }

    await client.query('commit')
    console.log('=== [azure-sync] WRITE 完成（committed）===')
  } catch (e) {
    await client.query('rollback')
    console.error('=== [azure-sync] WRITE 失敗，已 rollback:', e.message)
    throw e
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[azure-sync] DATABASE_URL not set — cannot continue')
    process.exit(1)
  }
  if (MODE !== 'inspect' && MODE !== 'write') {
    console.error(`[azure-sync] RUN_AZURE_SYNC must be inspect|write (got "${MODE}")`)
    process.exit(1)
  }
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveSsl(),
    connectionTimeoutMillis: 30000,
  })
  await client.connect()
  try {
    if (MODE === 'inspect') await inspect(client)
    else await write(client)
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('[azure-sync] FAILED:', e.message)
  process.exit(1)
})
