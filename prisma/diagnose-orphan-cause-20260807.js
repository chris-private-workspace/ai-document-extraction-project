/**
 * @fileoverview 漏接金額的成因分類（FIX-160 修法前的判別工具）—— 容器內可執行版
 * @description
 *   🔴 唯讀 —— 只有 SELECT，不寫入資料庫。
 *
 *   `check-orphan-charge-keys.js` 回答「漏了多少錢」，本腳本回答「**為什麼**漏」。
 *   兩者的 A / B 定義**逐字相同**，否則數字對不上：
 *     A = 提取結果中「key 在該公司自己的 field_definition_sets 內」且為非零數值的金額
 *     B = 該文件模板實例列上、屬於該模板 `dataType === 'number'` 欄位的值總和
 *
 *   ── 為什麼需要這支 ────────────────────────────────────────
 *   FIX-160（提取到了卻沒有規則引用）與 FIX-161（規則引用了卻取不到值）是**反方向**的
 *   同一枚硬幣。`transform_diagnostics` 只記錄後者，對前者是**盲的** —— 所以光看診斷欄位
 *   無法判斷漏接屬於哪一種，而兩者的處置完全相反（補 mapping vs 不處理 vs 補定義集）。
 *
 *   本腳本對每個「計入 A 的 key」判斷它有沒有被任何規則引用，把漏接金額拆成：
 *     [1] 無規則引用      —— FIX-160 的形態，補 mapping 才會落地
 *     [2] 有規則但目標欄位非數值 —— 落到了 targetField，但不計入 B（模板欄位型別問題）
 *     [3] 有規則且目標為數值欄位 —— 規則存在，未落地另有原因（欄位互搶／FORMULA 合併／
 *                                 實例列過期），屬 FIX-150 形態，需逐案看
 *
 *   🔴 [3] 是**待查類**，不是結論。本腳本不試圖區分互搶與過期快照 —— 那需要逐列重算，
 *      且實例列是快照（改設定不回溯），過期本身就會造成假陽性。
 *
 *   模式（`RUN_ORPHAN_CAUSE`）：僅接受 `inspect`。
 *   選用 env：
 *     `RECONCILE_COMPANY` —— 公司名稱關鍵字過濾
 *     `RECONCILE_DOCS`    —— `true` 時逐份文件列出（預設只出彙總）
 *
 *   🔴 比照 FIX-140：本旗標是單值非布林 —— **關閉方式是清空設定，設成 false 不會關閉**。
 *
 *   ⚠️ 本機執行時 `DATABASE_URL` 需指向本機（port 5433）；容器內由旗標觸發。
 *
 * @module prisma/diagnose-orphan-cause-20260807
 * @since 2026-08-07（FIX-160 成因判別）
 * @lastModified 2026-08-07
 */
'use strict'

const { Client } = require('pg')

const MODE = process.env.RUN_ORPHAN_CAUSE
const VALID_MODES = ['inspect']
const COMPANY_FILTER = process.env.RECONCILE_COMPANY || null
const SHOW_DOCS = String(process.env.RECONCILE_DOCS || '').toLowerCase() === 'true'
const EPSILON = 0.01

const line = (s = '') => console.log(`[orphan-cause] ${s}`)

/** 與 check-orphan-charge-keys.js 逐字相同：非數字與 0 一律不計 */
function numericValue(raw) {
  let v = raw && typeof raw === 'object' ? raw.value : raw
  if (typeof v === 'string') v = parseFloat(v.replace(/,/g, ''))
  return typeof v === 'number' && isFinite(v) && v !== 0 ? v : null
}

/** 取出一條 mapping 規則實際引用的所有 sourceField（DIRECT 取 sourceField，FORMULA 取 {..} 內的 key） */
function referencedKeys(rule) {
  const keys = []
  if (rule.sourceField) keys.push(rule.sourceField)
  const formula = rule.transformParams && rule.transformParams.formula
  if (formula) for (const m of formula.match(/\{(\w+)\}/g) || []) keys.push(m.slice(1, -1))
  return keys
}

async function main() {
  if (!VALID_MODES.includes(MODE)) {
    line(`模式 ${JSON.stringify(MODE)} 不在 ${VALID_MODES.join('|')} 內 —— 不執行`)
    return
  }

  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  line(`connected . mode=${MODE}${COMPANY_FILTER ? ` . company~${COMPANY_FILTER}` : ''}`)

  // --- 模板的數值欄位（決定什麼計入 B） ---
  const numericFields = new Map()
  const templates = await c.query('SELECT id, fields FROM data_templates')
  for (const t of templates.rows) {
    numericFields.set(
      t.id,
      new Set((t.fields || []).filter((f) => f.dataType === 'number').map((f) => f.name))
    )
  }

  // --- 各公司自己的欄位定義集（決定什麼計入 A） ---
  const defKeys = new Map()
  const defs = await c.query('SELECT company_id, fields FROM field_definition_sets')
  for (const row of defs.rows) {
    if (!defKeys.has(row.company_id)) defKeys.set(row.company_id, new Map())
    const m = defKeys.get(row.company_id)
    for (const f of row.fields || []) if (f.key) m.set(f.key, f.label || f.key)
  }

  // --- 規則引用的 sourceField：company_id -> data_template_id -> Map(key -> [targetField]) ---
  const refByCompanyTpl = new Map()
  const maps = await c.query(
    'SELECT company_id, data_template_id, mappings FROM template_field_mappings'
  )
  for (const row of maps.rows) {
    const ck = row.company_id || '__GLOBAL__'
    if (!refByCompanyTpl.has(ck)) refByCompanyTpl.set(ck, new Map())
    const byTpl = refByCompanyTpl.get(ck)
    if (!byTpl.has(row.data_template_id)) byTpl.set(row.data_template_id, new Map())
    const m = byTpl.get(row.data_template_id)
    for (const rule of row.mappings || []) {
      for (const k of referencedKeys(rule)) {
        if (!m.has(k)) m.set(k, [])
        m.get(k).push(rule.targetField)
      }
    }
  }

  // --- 每份文件在每個模板的最新一列（與對帳腳本相同的 DISTINCT ON） ---
  const rowsByDoc = new Map()
  const instRows = await c.query(
    `SELECT DISTINCT ON (doc.id, ti.data_template_id)
            doc.id AS document_id, ti.data_template_id, tir.field_values
       FROM template_instance_rows tir
       JOIN template_instances ti ON ti.id = tir.template_instance_id
       JOIN documents doc ON doc.id = ANY(tir.source_document_ids)
      ORDER BY doc.id, ti.data_template_id, tir.created_at DESC`
  )
  for (const row of instRows.rows) {
    if (!rowsByDoc.has(row.document_id)) rowsByDoc.set(row.document_id, [])
    rowsByDoc
      .get(row.document_id)
      .push({ templateId: row.data_template_id, values: row.field_values || {} })
  }

  const extractions = await c.query(
    `SELECT DISTINCT ON (er.document_id)
            er.document_id, d.file_name, d.company_id, co.name AS company, er.field_mappings
       FROM extraction_results er
       JOIN documents d ON d.id = er.document_id
       LEFT JOIN companies co ON co.id = d.company_id
      WHERE er.field_mappings IS NOT NULL AND d.company_id IS NOT NULL
      ORDER BY er.document_id, er.created_at DESC`
  )

  // --- 逐份判別 ---
  const cause = {
    noRule: { amount: 0, keys: new Map() },
    ruleNonNumericTarget: { amount: 0, keys: new Map() },
    ruleButNotLanded: { amount: 0, keys: new Map() },
  }
  let scanned = 0
  let skippedNoDef = 0
  let skippedNoRow = 0
  let totalShortfall = 0
  const docLines = []

  for (const doc of extractions.rows) {
    if (
      COMPANY_FILTER &&
      !(doc.company || '').toLowerCase().includes(COMPANY_FILTER.toLowerCase())
    ) {
      continue
    }
    const defined = defKeys.get(doc.company_id)
    if (!defined) {
      skippedNoDef += 1
      continue
    }
    const docRows = rowsByDoc.get(doc.document_id) || []
    if (!docRows.length) {
      skippedNoRow += 1
      continue
    }
    scanned += 1

    // A
    const charges = []
    for (const [key, raw] of Object.entries(doc.field_mappings || {})) {
      if (!defined.has(key)) continue
      const v = numericValue(raw)
      if (v !== null) charges.push({ key, amount: v })
    }
    if (!charges.length) continue
    const extractedTotal = charges.reduce((s, ch) => s + ch.amount, 0)

    // B —— 與對帳腳本相同：多模板時取差額絕對值最小者
    let best = null
    for (const r of docRows) {
      const allowed = numericFields.get(r.templateId) || new Set()
      let sum = 0
      const values = []
      for (const [f, raw] of Object.entries(r.values)) {
        if (!allowed.has(f)) continue
        const n = numericValue(raw)
        if (n !== null) {
          sum += n
          values.push(n)
        }
      }
      const diff = extractedTotal - sum
      if (!best || Math.abs(diff) < Math.abs(best.diff)) {
        best = { diff, templateId: r.templateId, values, allowed }
      }
    }
    if (!best || Math.abs(best.diff) < EPSILON) continue // 完全對上，無漏接
    if (best.diff < 0) continue // 負差額 = 重複計算，不屬本腳本範圍

    totalShortfall += best.diff

    // 未落地的 key：金額沒有出現在該列的任何數值欄位裡
    const unlanded = charges.filter(
      (ch) => !best.values.some((v) => Math.abs(v - ch.amount) < EPSILON)
    )

    const ruleMapCompany =
      (refByCompanyTpl.get(doc.company_id) || new Map()).get(best.templateId) || new Map()
    const ruleMapGlobal =
      (refByCompanyTpl.get('__GLOBAL__') || new Map()).get(best.templateId) || new Map()

    const perDoc = []
    for (const ch of unlanded) {
      const targets = ruleMapCompany.get(ch.key) || ruleMapGlobal.get(ch.key) || null
      let bucket
      if (!targets || !targets.length) bucket = 'noRule'
      else if (!targets.some((t) => best.allowed.has(t))) bucket = 'ruleNonNumericTarget'
      else bucket = 'ruleButNotLanded'

      cause[bucket].amount += ch.amount
      const km = cause[bucket].keys
      if (!km.has(ch.key)) km.set(ch.key, { amount: 0, count: 0, targets: targets || [] })
      const e = km.get(ch.key)
      e.amount += ch.amount
      e.count += 1
      perDoc.push(`${ch.key}=${ch.amount} [${bucket}]`)
    }
    if (SHOW_DOCS && perDoc.length) {
      docLines.push(`${doc.company} | ${doc.file_name} | 差額 ${best.diff.toFixed(2)} | ${perDoc.join(', ')}`)
    }
  }

  // --- 輸出 ---
  line('')
  line('=== 涵蓋範圍（分母）===')
  line(`  參與判別的文件      ${scanned}`)
  line(`  略過：公司無定義集  ${skippedNoDef}`)
  line(`  略過：尚未進入實例  ${skippedNoRow}`)
  if (scanned === 0) {
    line('')
    line('🔴 沒有可判別的文件 —— 這不是「沒有漏接」，是沒有掃到任何對象。請檢查 RECONCILE_COMPANY。')
    await c.end()
    return
  }

  line('')
  line(`=== 漏接總額 ${totalShortfall.toFixed(2)} 的成因拆解 ===`)
  const buckets = [
    ['noRule', '[1] 無任何規則引用 —— FIX-160 形態，補 mapping 才會落地'],
    ['ruleNonNumericTarget', '[2] 有規則但 targetField 不是模板數值欄位 —— 不計入 B'],
    ['ruleButNotLanded', '[3] 有規則且目標為數值欄位 —— 待查（互搶／FORMULA 合併／快照過期）'],
  ]
  const classified = buckets.reduce((s, [k]) => s + cause[k].amount, 0)
  for (const [k, label] of buckets) {
    const pct = totalShortfall > 0 ? ((cause[k].amount / totalShortfall) * 100).toFixed(1) : '0.0'
    line('')
    line(`${label}`)
    line(`   金額 ${cause[k].amount.toFixed(2)}  （占 ${pct}%）  涉及 ${cause[k].keys.size} 種 key`)
    const top = [...cause[k].keys.entries()].sort((a, b) => b[1].amount - a[1].amount).slice(0, 12)
    for (const [key, e] of top) {
      const tg = e.targets.length ? ` → ${[...new Set(e.targets)].join('/')}` : ''
      line(`     ${e.amount.toFixed(2).padStart(12)}  ${String(e.count).padStart(4)} 筆  ${key}${tg}`)
    }
    if (cause[k].keys.size > top.length) line(`     …另有 ${cause[k].keys.size - top.length} 種未列出`)
  }

  const residual = totalShortfall - classified
  line('')
  line(`未歸類殘額 ${residual.toFixed(2)}`)
  if (Math.abs(residual) >= EPSILON) {
    line('  ⚠️ 非零 —— 差額中有一部分不是由「單一 key 未落地」構成，')
    line('     可能來自 FORMULA 部分落地或金額湊巧相等而被誤判為已落地。解讀時須留意。')
  }

  if (SHOW_DOCS) {
    line('')
    line('=== 逐份明細 ===')
    for (const l of docLines) line(`  ${l}`)
  }

  await c.end()
}

main().catch((e) => {
  line(`🔴 失敗：${e.message}`)
  process.exit(1)
})
