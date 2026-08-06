/**
 * @fileoverview 費用落地對帳（FIX-150 第一層防護）—— 容器內可執行版
 * @description
 *   🔴 唯讀 —— 只有 SELECT，不寫入資料庫。
 *
 *   回答一個問題：**這張發票上提取到的費用，有多少沒有進到模板？**
 *
 *   判準與 `scripts/check-orphan-charge-keys.js` **逐字相同**（總額對帳）：
 *     A = 提取結果中「已定義為費用欄位」且有值的金額總和
 *     B = 該文件模板實例列上所有數值欄位的總和
 *   差額 A − B 即為未落地的金額。
 *
 *   ── 為何要有這個容器內版本 ────────────────────────────────
 *   runbook §17 立了一條通案限制：「凡規範要求先跑對帳才能改的設定，在移植對帳工具
 *   之前都不該送進 Azure」。原腳本在 `scripts/`，而 runner 映像不含該目錄與 tsx，
 *   安全網無法在容器內執行 —— 於是所有 mapping 類設定同步都被卡住。本檔解除該限制。
 *
 *   原腳本註解建議「上傳至 Kudu /home 再以 node 執行」—— **那條路行不通**。
 *   2026-08-06 實測：Kudu `/api/command` 跑在 sidecar，working directory `/app` 不存在，
 *   也拿不到 app 容器的 `node_modules/pg`。要讀 DB 只能做成 `prisma/*.js` + gated 旗標。
 *
 *   ── before/after 怎麼跨執行保存 ──────────────────────────
 *   `WEBSITES_ENABLE_APP_SERVICE_STORAGE=false`，容器的 `/home` **不持久**，
 *   寫檔重啟即消失。改為：
 *     1. 改動前跑一次 → 腳本把 baseline JSON 印進 log（區段以 BASELINE BEGIN/END 包住）
 *     2. 把該 JSON 設進 `RECONCILE_BASELINE`（findings 很小，塞得進 appsetting）
 *     3. 改動 + 重新匹配模板實例後再跑一次 → 腳本**在容器內完成前後比對**
 *
 *   模式（`RUN_ORPHAN_CHECK`）：僅接受 `inspect`。
 *   選用 env：
 *     `RECONCILE_COMPANY`  —— 公司名稱關鍵字過濾（縮小範圍，log 也較短）
 *     `RECONCILE_BASELINE` —— 前次的 baseline JSON，設了就做前後比對
 *     `RECONCILE_DOCS`     —— 設為 `true` 時逐份文件列出（預設只出公司彙總）
 *
 *   🔴 比照 FIX-140：本旗標是單值非布林 —— **關閉方式是清空設定，設成 false 不會關閉**。
 *
 *   ⚠️ 差額為負代表模板總額大於提取總額，通常是同一筆錢被兩條規則各算一次（重複計算）。
 *   ⚠️ 差額反映「模板實例列當下的內容」，不等於「映射規則現在是否正確」。實例列是快照，
 *      改設定不會回溯既有列 —— 比對前務必先重新匹配，否則會把過期快照誤讀為映射缺陷。
 *   ⚠️ 只計入 `field_definition_sets` 定義的費用欄位。發票通用欄位（invoice_date /
 *      total_amount / subtotal 等）本就不該進費用模板，納入會把日期當金額加總。
 *
 * @module prisma/check-orphan-charge-keys
 * @since 2026-08-06（解除 runbook §17 的通案限制）
 * @lastModified 2026-08-06
 */
'use strict'

const { Client } = require('pg')

const MODE = process.env.RUN_ORPHAN_CHECK
const VALID_MODES = ['inspect']
const COMPANY_FILTER = process.env.RECONCILE_COMPANY || null
const SHOW_DOCS = String(process.env.RECONCILE_DOCS || '').toLowerCase() === 'true'
const EPSILON = 0.01

const line = (s = '') => console.log(`[orphan-check] ${s}`)

/** 提取結果的欄位值可能是純量或 {value,...} 物件；非數字與 0 一律不計 */
function numericValue(raw) {
  let v = raw && typeof raw === 'object' ? raw.value : raw
  if (typeof v === 'string') v = parseFloat(v.replace(/,/g, ''))
  return typeof v === 'number' && isFinite(v) && v !== 0 ? v : null
}

function parseBaseline() {
  const raw = process.env.RECONCILE_BASELINE
  if (!raw || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.findings)) {
      line('⚠️ RECONCILE_BASELINE 解析成功但缺少 findings 陣列 —— 略過比對')
      return null
    }
    return parsed
  } catch (e) {
    // 不靜默吞掉 —— 設了卻解析失敗，代表使用者以為有安全網但其實沒有
    line(`🔴 RECONCILE_BASELINE 解析失敗，**本次沒有前後比對**：${e.message}`)
    return null
  }
}

async function collect(c) {
  // 模板的數值欄位清單 —— 只有這些才計入 B（排除 shipment_number 等字串欄位）
  const numericFields = new Map()
  const templates = await c.query('SELECT id, fields FROM data_templates')
  for (const t of templates.rows) {
    numericFields.set(
      t.id,
      new Set((t.fields || []).filter((f) => f.dataType === 'number').map((f) => f.name))
    )
  }

  const defKeys = new Map()
  const defs = await c.query('SELECT company_id, fields FROM field_definition_sets')
  for (const row of defs.rows) {
    if (!defKeys.has(row.company_id)) defKeys.set(row.company_id, new Map())
    const m = defKeys.get(row.company_id)
    for (const f of row.fields || []) if (f.key) m.set(f.key, f.label || f.key)
  }

  // 每份文件在每個模板的最新一列
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

  const byCompany = new Map()
  const docFindings = []
  let scanned = 0
  let noTemplateRow = 0
  let noDefinition = 0

  for (const doc of extractions.rows) {
    if (
      COMPANY_FILTER &&
      !(doc.company || '').toLowerCase().includes(COMPANY_FILTER.toLowerCase())
    ) {
      continue
    }
    const defined = defKeys.get(doc.company_id)
    if (!defined) {
      noDefinition += 1
      continue
    }
    const docRows = rowsByDoc.get(doc.document_id) || []
    if (!docRows.length) {
      noTemplateRow += 1
      continue // 尚未加入任何實例，無從判定
    }
    scanned += 1

    // A：提取到的費用總額
    const charges = []
    for (const [key, raw] of Object.entries(doc.field_mappings || {})) {
      if (!defined.has(key)) continue
      const v = numericValue(raw)
      if (v !== null) charges.push({ key, label: defined.get(key), amount: v })
    }
    if (!charges.length) continue
    const extractedTotal = charges.reduce((s, ch) => s + ch.amount, 0)

    // B：每個模板各自算，取差額絕對值最小者 —— 一份文件可能同時落在多個模板
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
      if (!best || Math.abs(diff) < Math.abs(best.diff)) best = { diff, templateSum: sum, values }
    }
    if (!best) continue
    if (Math.abs(best.diff) < EPSILON) continue // 完全對上

    const suspects = charges
      .filter((ch) => !best.values.some((v) => Math.abs(v - ch.amount) < EPSILON))
      .map((ch) => ({ ...ch, exact: Math.abs(ch.amount - best.diff) < EPSILON }))
      .sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0) || b.amount - a.amount)

    docFindings.push({
      file: doc.file_name,
      company: doc.company,
      extractedTotal,
      templateSum: best.templateSum,
      diff: best.diff,
      suspects: suspects.slice(0, 5),
    })

    const key = doc.company
    if (!byCompany.has(key)) {
      byCompany.set(key, { company: key, docs: 0, missing: 0, duplicated: 0, keys: new Map() })
    }
    const cs = byCompany.get(key)
    cs.docs += 1
    if (best.diff > 0) cs.missing += best.diff
    else cs.duplicated += -best.diff
    for (const s of suspects.filter((x) => x.exact)) {
      const k = cs.keys.get(s.key) || { key: s.key, label: s.label, docs: 0, amount: 0 }
      k.docs += 1
      k.amount += s.amount
      cs.keys.set(s.key, k)
    }
  }

  const findings = [...byCompany.values()]
    .map((c2) => ({ ...c2, keys: [...c2.keys.values()].sort((a, b) => b.amount - a.amount) }))
    .sort((a, b) => b.missing - a.missing)

  return { findings, docFindings, scanned, noTemplateRow, noDefinition }
}

function report(r) {
  line(`對帳 ${r.scanned} 份文件` + (COMPANY_FILTER ? `（公司篩選：${COMPANY_FILTER}）` : ''))
  line(`  尚未加入任何模板實例，無從判定  ${r.noTemplateRow}`)
  line(`  公司無欄位定義集，無從判定      ${r.noDefinition}`)
  line('')

  if (r.scanned === 0) {
    // 分母為 0 時「沒有問題」是假綠燈 —— 明確標示
    line('🔴 掃到 0 份文件 —— 這不是「沒有漏接」，是沒有可對帳的對象。')
    line('   請確認公司篩選是否過窄，或該環境是否真的有模板實例列。')
    return
  }
  if (!r.findings.length) {
    line('✅ 所有文件的費用總額都與模板總額吻合，沒有漏接。')
    return
  }

  line('=== 費用未落地（提取總額 − 模板總額）===')
  let totalMissing = 0
  let totalDup = 0
  for (const f of r.findings) {
    totalMissing += f.missing
    totalDup += f.duplicated
    line('')
    line(
      `  ${f.company}   ${f.docs} 份有差額` +
        (f.missing > EPSILON ? `   🔴 漏 ${f.missing.toFixed(2)}` : '') +
        (f.duplicated > EPSILON ? `   ⚠️ 多算 ${f.duplicated.toFixed(2)}` : '')
    )
    for (const k of f.keys) {
      line(`     可定位：${k.key} "${k.label}"   ${k.docs} 份 / ${k.amount.toFixed(2)}`)
    }
  }
  line('')
  line(`=== 合計：漏 ${totalMissing.toFixed(2)}、多算 ${totalDup.toFixed(2)} ===`)
  line('（「可定位」為金額恰等於該份差額的欄位；其餘差額多為多筆合成，需逐份檢視）')

  if (SHOW_DOCS) {
    line('')
    line('=== 逐份文件 ===')
    for (const d of r.docFindings
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
      .slice(0, 40)) {
      line(
        `  ${d.file}  [${d.company}]  提取=${d.extractedTotal.toFixed(2)} ` +
          `模板=${d.templateSum.toFixed(2)} 差額=${d.diff.toFixed(2)}`
      )
      if (d.suspects.length) {
        line(
          '     嫌疑：' +
            d.suspects.map((s) => `${s.key}=${s.amount}${s.exact ? ' ←恰等於差額' : ''}`).join(', ')
        )
      }
    }
  }
}

function compareWithBaseline(current, base) {
  const before = new Map((base.findings || []).map((f) => [f.company, f]))
  const after = new Map(current.map((f) => [f.company, f]))

  line('')
  line(`=== 與基線比對（${base.capturedAt || '未記時間'}）===`)
  const worsened = []
  const improved = []
  for (const [company, a] of after) {
    const b = before.get(company)
    const was = b ? b.missing : 0
    if (a.missing - was > EPSILON) worsened.push({ company, was, now: a.missing })
    else if (was - a.missing > EPSILON) improved.push({ company, was, now: a.missing })
  }
  for (const [company, b] of before) {
    if (!after.has(company) && b.missing > EPSILON) {
      improved.push({ company, was: b.missing, now: 0 })
    }
  }

  if (worsened.length) {
    line('')
    line('🔴 漏接金額增加 —— 本次改動打破了既有映射：')
    for (const w of worsened) line(`   ${w.company}  ${w.was.toFixed(2)} → ${w.now.toFixed(2)}`)
  }
  if (improved.length) {
    line('')
    line('✅ 漏接金額減少：')
    for (const i of improved) line(`   ${i.company}  ${i.was.toFixed(2)} → ${i.now.toFixed(2)}`)
  }
  if (!worsened.length && !improved.length) {
    line('  漏接金額與基線一致，本次改動未造成新的漏接。')
  }
  return worsened.length > 0
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
  line(`connected — mode=${MODE}，唯讀，不會寫入任何資料`)

  const result = await collect(c)
  report(result)

  const baseline = parseBaseline()
  let broke = false
  if (baseline) broke = compareWithBaseline(result.findings, baseline)
  else {
    line('')
    line('ℹ️ 未設 RECONCILE_BASELINE —— 本次為單點檢視，沒有前後比對。')
  }

  // baseline 供下一次比對用。findings 只有公司層級彙總，量小，可安全印。
  line('')
  line('--- BASELINE JSON BEGIN ---（複製整段設進 RECONCILE_BASELINE，改動後再跑一次即可前後比對）')
  console.log(
    JSON.stringify({
      capturedAt: new Date().toISOString(),
      filter: COMPANY_FILTER,
      findings: result.findings,
    })
  )
  line('--- BASELINE JSON END ---')

  line('')
  line(broke ? '🔴 done — 偵測到漏接增加，請勿繼續後續寫入' : 'done')
  await c.end()
}

main().catch((e) => {
  console.error(`[orphan-check] FATAL: ${e.message}`)
  process.exitCode = 0 // 非致命：不擋容器啟動
})
