/**
 * @fileoverview 2026-08-06 Azure 設定落差診斷（唯讀，不寫入任何資料）
 * @description
 *   本機在 FIX-159 ~ FIX-169 期間做了一批**只存在於資料庫的設定變更**，它們不隨映像走。
 *   在決定要不要把這些設定同步到目標環境之前，必須先知道目標環境的**實際現況** ——
 *   而不是拿本機狀態去推論（見 memory `feedback_code_shows_possible_data_shows_actual`）。
 *
 *   為何要進 `prisma/` 而非 `scripts/`：runner 映像只 COPY `prisma/` 與
 *   `scripts/docker-entrypoint.sh`，不含 `scripts/` 其餘檔案與 tsx；且本機無法直連
 *   私有 PG（私有端點只在 VNet 內可達），任何查詢只能在容器啟動時於 VNet 內執行。
 *
 *   六個區塊（皆唯讀，任一區塊失敗不影響其餘）：
 *     1. 基準計數 —— 先證明查詢真的掃到資料（每項都印分母）
 *     2. 實體歸屬對帳 —— 通案偵測「同一公司記錄底下出現多種發票原文」（FIX-159 判定法）
 *     3. Toll 專項 —— 公司記錄 / nameVariants / 文件歸屬
 *     4. RICOH 專項 —— 重複公司與其可用映射規則數
 *     5. 欄位定義集現況 —— 各公司有哪些、各含幾個欄位
 *     6. 孤兒 key 對帳 —— mapping 引用了但欄位定義集未定義的 key（FIX-161 判定法）
 *
 *   模式（`RUN_CONFIG_DIAGNOSE_20260806`）：僅接受 `inspect`。
 *   🔴 本旗標是非布林三態外的單值旗標 —— **關閉方式是清空設定，設成 false 不會關閉**
 *   （比照 FIX-140；值無法辨識時印出 skip 訊息並跳過）。
 *
 * @module prisma/diagnose-config-20260806
 * @since 2026-08-06 Azure DEV 同步前診斷
 * @lastModified 2026-08-06
 */
const { Client } = require('pg')

const MODE = process.env.RUN_CONFIG_DIAGNOSE_20260806
const VALID_MODES = ['inspect']

const line = (s = '') => console.log(`[diagnose] ${s}`)
const hr = (t) => {
  console.log('')
  console.log(`[diagnose] ${'='.repeat(88)}`)
  console.log(`[diagnose] ${t}`)
  console.log(`[diagnose] ${'='.repeat(88)}`)
}

/** 從 mappings JSON 收集所有被引用的來源 key（sourceField + FORMULA 內的 {key}） */
function collectSourceKeys(mappings) {
  const keys = new Set()
  if (!Array.isArray(mappings)) return keys
  for (const m of mappings) {
    if (m && typeof m.sourceField === 'string' && m.sourceField.trim()) {
      keys.add(m.sourceField.trim())
    }
    const formula = m && m.transformParams && m.transformParams.formula
    if (typeof formula === 'string') {
      for (const match of formula.matchAll(/\{([^}]+)\}/g)) {
        const k = match[1].trim()
        if (k) keys.add(k)
      }
    }
  }
  return keys
}

/** 從 field_definition_sets.fields JSON 收集已定義的 key */
function collectDefinedKeys(fields) {
  const keys = new Set()
  if (!Array.isArray(fields)) return keys
  for (const f of fields) {
    if (f && typeof f.key === 'string' && f.key.trim()) keys.add(f.key.trim())
  }
  return keys
}

async function section1Baseline(c) {
  hr('1  基準計數（證明查詢掃到資料 —— 任一項為 0 需先確認是真的沒有，而非查錯表）')
  const q = async (label, sql) => {
    const r = await c.query(sql)
    line(`${label.padEnd(46)} ${String(r.rows[0].n).padStart(6)}`)
  }
  await q('companies', 'select count(*) n from companies')
  await q('  其中 status = ACTIVE', "select count(*) n from companies where status = 'ACTIVE'")
  await q('  其中 status = PENDING', "select count(*) n from companies where status = 'PENDING'")
  await q('documents', 'select count(*) n from documents')
  await q('extraction_results', 'select count(*) n from extraction_results')
  await q(
    '  其中 stage_1_ai_details.response 可解析',
    "select count(*) n from extraction_results where left(trim(stage_1_ai_details::jsonb ->> 'response'), 1) = '{'"
  )
  await q('field_definition_sets', 'select count(*) n from field_definition_sets')
  await q('template_field_mappings', 'select count(*) n from template_field_mappings')
  await q('data_templates', 'select count(*) n from data_templates')
  await q('template_instance_rows', 'select count(*) n from template_instance_rows')
}

async function section2Attribution(c) {
  hr('2  實體歸屬對帳（通案）—— 同一公司記錄底下出現多種發票原文')
  const r = await c.query(`
    SELECT c.name AS company,
           ((e.stage_1_ai_details::jsonb ->> 'response')::jsonb
              -> 'documentIssuer' ->> 'name') AS issuer,
           count(*) AS n
      FROM extraction_results e
      JOIN companies c ON c.id = e.company_id
     WHERE left(trim(e.stage_1_ai_details::jsonb ->> 'response'), 1) = '{'
     GROUP BY 1, 2
     ORDER BY 1, 3 DESC`)

  const byCompany = new Map()
  for (const row of r.rows) {
    if (!row.issuer) continue
    if (!byCompany.has(row.company)) byCompany.set(row.company, [])
    byCompany.get(row.company).push(row)
  }
  line(`可對帳的 (公司 × 原文) 組合   ${r.rows.length}`)
  line(`涵蓋公司記錄                  ${byCompany.size}`)
  line('')

  const multi = [...byCompany.entries()].filter(([, rows]) => rows.length > 1)
  line(`🔴 底下出現多種發票原文的公司  ${multi.length}`)
  for (const [company, rows] of multi) {
    line(`  ${company}`)
    for (const row of rows) line(`      ${String(row.n).padStart(4)}  ${row.issuer}`)
  }
  if (multi.length === 0) line('  （無 —— 每個公司記錄底下的發票原文都只有一種）')
  line('')
  line('⚠️ 判讀：多種原文**不等於**誤歸。三種情況要分開看：')
  line('   (a) 大小寫 / 標點差異（CO., LTD. vs CO.,LTD.）→ 正常，同一實體的印法飄移')
  line('   (b) OCR 誤讀（RICOH → RUIH / RITCH）→ 提取品質問題，不是歸屬問題')
  line('   (c) 🔴 地區詞不同（(Thailand) vs (Hong Kong)）→ 這才是 FIX-159 型的跨國實體誤歸')
  line('   只有 (c) 需要拆分公司記錄。')
}

async function section3Toll(c) {
  hr('3  Toll 專項（FIX-159 的目標）')
  const comps = await c.query(
    `SELECT id, name, status, coalesce(name_variants, '{}') AS nv
       FROM companies WHERE name ILIKE '%toll%' ORDER BY name`
  )
  line(`Toll 相關公司記錄  ${comps.rows.length}`)
  for (const co of comps.rows) {
    line('')
    line(`  ${co.name}`)
    line(`    id=${co.id}  status=${co.status}`)
    line(`    nameVariants (${co.nv.length})`)
    for (const v of co.nv) line(`      - ${v}`)
    const docs = await c.query(
      `SELECT count(*) n FROM documents WHERE company_id = $1`, [co.id]
    )
    const iss = await c.query(
      `SELECT ((e.stage_1_ai_details::jsonb ->> 'response')::jsonb
                 -> 'documentIssuer' ->> 'name') AS issuer, count(*) n
         FROM extraction_results e
        WHERE e.company_id = $1
          AND left(trim(e.stage_1_ai_details::jsonb ->> 'response'), 1) = '{'
        GROUP BY 1 ORDER BY 2 DESC`, [co.id]
    )
    line(`    文件數 ${docs.rows[0].n}，可對帳提取 ${iss.rows.length} 種原文`)
    for (const row of iss.rows) line(`      ${String(row.n).padStart(4)}  ${row.issuer}`)
  }
}

async function section4Ricoh(c) {
  hr('4  RICOH 專項（重複公司與可用映射規則）')
  const comps = await c.query(
    `SELECT id, name, status, suspected_duplicate_of_id, merged_into_id
       FROM companies WHERE name ILIKE '%ricoh%' ORDER BY name`
  )
  line(`RICOH 相關公司記錄  ${comps.rows.length}`)
  for (const co of comps.rows) {
    const maps = await c.query(
      `SELECT count(*) n FROM template_field_mappings WHERE company_id = $1`, [co.id]
    )
    const docs = await c.query(`SELECT count(*) n FROM documents WHERE company_id = $1`, [co.id])
    line('')
    line(`  ${co.name}`)
    line(`    id=${co.id}  status=${co.status}`)
    line(`    suspectedDuplicateOf=${co.suspected_duplicate_of_id || '—'}  mergedInto=${co.merged_into_id || '—'}`)
    line(`    template_field_mappings 筆數 ${maps.rows[0].n}   文件數 ${docs.rows[0].n}`)
  }
}

async function section5FieldDefs(c) {
  hr('5  欄位定義集現況')
  const r = await c.query(`
    SELECT f.id, f.name, f.scope, f.is_active, f.company_id,
           coalesce(c.name, '（無公司 / 全域）') AS company,
           jsonb_array_length(coalesce(f.fields::jsonb, '[]'::jsonb)) AS field_count
      FROM field_definition_sets f
      LEFT JOIN companies c ON c.id = f.company_id
     ORDER BY company, f.name`)
  line(`欄位定義集  ${r.rows.length}`)
  for (const row of r.rows) {
    line(`  ${String(row.field_count).padStart(4)} 欄  [${row.scope}${row.is_active ? '' : ' /停用'}]  ${row.company}`)
    line(`         ${row.name}`)
  }
}

async function section6OrphanKeys(c) {
  hr('6  孤兒 key 對帳（mapping 引用了但欄位定義集未定義的 key —— FIX-161 判定法）')

  const maps = await c.query(`
    SELECT m.id, m.name, m.company_id, m.mappings,
           coalesce(c.name, '（無公司）') AS company,
           coalesce(t.name, '（無模板）') AS template
      FROM template_field_mappings m
      LEFT JOIN companies c ON c.id = m.company_id
      LEFT JOIN data_templates t ON t.id = m.data_template_id
     ORDER BY company, template`)

  const defs = await c.query(
    `SELECT company_id, fields FROM field_definition_sets WHERE is_active = true`
  )
  const definedByCompany = new Map()
  const globalDefined = new Set()
  for (const d of defs.rows) {
    const keys = collectDefinedKeys(d.fields)
    if (d.company_id) {
      if (!definedByCompany.has(d.company_id)) definedByCompany.set(d.company_id, new Set())
      for (const k of keys) definedByCompany.get(d.company_id).add(k)
    } else {
      for (const k of keys) globalDefined.add(k)
    }
  }

  line(`template_field_mappings 筆數      ${maps.rows.length}`)
  line(`啟用中的欄位定義集                ${defs.rows.length}`)
  line(`  其中全域定義的 key 數            ${globalDefined.size}`)
  line(`  有公司專屬定義的公司數           ${definedByCompany.size}`)
  line('')

  let totalRefs = 0
  let totalOrphans = 0
  for (const m of maps.rows) {
    const refs = collectSourceKeys(m.mappings)
    totalRefs += refs.size
    const defined = new Set([
      ...globalDefined,
      ...(m.company_id ? definedByCompany.get(m.company_id) || [] : []),
    ])
    const orphans = [...refs].filter((k) => !defined.has(k))
    totalOrphans += orphans.length
    const mark = orphans.length > 0 ? '🔴' : '  '
    line(
      `${mark} ${m.company.slice(0, 40).padEnd(42)} ${m.template.slice(0, 30).padEnd(32)} 引用 ${String(refs.size).padStart(3)}  未定義 ${String(orphans.length).padStart(3)}`
    )
    for (const k of orphans) line(`        未定義: ${k}`)
  }
  line('')
  line(`合計：引用 key ${totalRefs}，其中未定義 ${totalOrphans}`)
  line('⚠️ 「未定義」不等於「壞掉」—— 該 key 可能由全域標準欄位提供，或本來就無此費用。')
  line('   本區塊只標示需人工確認的對象，不作判定。')
}

async function main() {
  if (!VALID_MODES.includes(MODE)) {
    line(`skipped: mode=${MODE} not recognised (expected inspect; clear the app setting to disable)`)
    return
  }
  if (!process.env.DATABASE_URL) {
    line('skipped: DATABASE_URL 未設定')
    return
  }

  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  line(`connected — mode=${MODE}, 唯讀，不會寫入任何資料`)

  const sections = [
    ['1 基準計數', section1Baseline],
    ['2 實體歸屬對帳', section2Attribution],
    ['3 Toll 專項', section3Toll],
    ['4 RICOH 專項', section4Ricoh],
    ['5 欄位定義集', section5FieldDefs],
    ['6 孤兒 key 對帳', section6OrphanKeys],
  ]
  for (const [label, fn] of sections) {
    try {
      await fn(c)
    } catch (e) {
      line(`ERR 區塊 ${label} 失敗（不影響其餘區塊）: ${e.message}`)
    }
  }

  await c.end()
  console.log('')
  line('done — 唯讀診斷結束，未寫入任何資料')
}

main().catch((e) => {
  console.error(`[diagnose] FATAL: ${e.message}`)
  process.exitCode = 0 // 非致命：不擋容器啟動
})
