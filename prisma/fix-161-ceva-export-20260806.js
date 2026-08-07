/**
 * @fileoverview FIX-161 移植到 Azure DEV：CEVA export 的 sourceField 誤填為 targetField 名
 * @description
 *   `template_field_mappings` 的規則引用了某個 `sourceField`，但該 key **不在該公司自己的
 *   `field_definition_sets` 裡**。Stage 3 不會產出這個 key，規則永遠取不到值，`targetField` 恆為空。
 *
 *   本機根因（FIX-161 §已修正）：CEVA 的 Outbound mapping 把 sourceField 寫成了
 *   **Inbound 的 targetField 名**：
 *     cfs_charge  ← cfs           （應為 destination_cfs_charges）
 *     gate_charge ← gate_charge   （應為 destination_gate_fee）
 *   同公司 Inbound 的寫法就是正解，不是憑名稱猜測。
 *
 *   🔴 **只處理 2 條規則，不是診斷報的 6 個 key**。`prisma/diagnose-config-20260806.js`
 *   區塊 6 對這筆 mapping 報了 6 個未定義 key，但逐條追查後（FIX-161 §逐條追查）：
 *     - `_ref_number`        系統欄位，非費用 key —— 誤報
 *     - `awb_fee`            FORMULA 中另有 `origin_document_processing_fee` 有值（本機 22/31 列）—— 誤報
 *     - `pick_up_at_origin`  真缺陷，但要修得**新增欄位定義**，aliases 會進 Stage 3 prompt —— 本機亦未修，待決策
 *     - `x_ray`              同上
 *     - `cfs` / `gate_charge` 真缺陷且同公司 Inbound 有正解 —— **本檔處理這兩條**
 *
 *   🔴 **兩家 CEVA，只動其中一家**。本機同時存在：
 *     - `CEVA LOGISTICS (HONG KONG) LTD`（定義集 21 key，無 cfs/gate_charge，有 destination_*）← 目標
 *     - `CEVA LOGISTICS (HONG KONG) LIMITED（CEVA Logistics）`（定義集含 cfs/gate_charge）← **不動**
 *   後者的 sourceField 在它自己的定義集裡是有效的，改了反而會壞掉。
 *
 *   🔴 **不照抄本機，逐項驗證目標環境**。FIX-158 已證實兩環境的欄位定義集可能不同步
 *   （Azure 該公司定義集為 26 key、本機 22 key）。write 前會檢查：
 *     (a) 目標 key（destination_cfs_charges / destination_gate_fee）確實在該公司定義集內
 *     (b) 現值（cfs / gate_charge）確實**不在**該公司定義集內
 *   任一不符即中止 —— 代表該環境的情況與本機不同，不可套用。
 *
 *   模式（`RUN_FIX161_CEVA_20260806`）：inspect | dryrun | write
 *
 *   §不可逆資料操作紀律：前置快照印進 log（容器無可保留檔案系統）、單一交易、
 *   數量閘、樂觀鎖（`updated_at`）、冪等。
 *
 *   ⚠️ 改 mapping **不會回溯既有的模板實例列**。write 後需重新匹配才會反映，
 *   且必須用 `RUN_ORPHAN_CHECK` + `RECONCILE_BASELINE` 做前後對帳（見 runbook §20）。
 *
 * @module prisma/fix-161-ceva-export-20260806
 * @since 2026-08-06 FIX-161 Azure 移植
 * @lastModified 2026-08-06
 */
'use strict'

const { Client } = require('pg')

const MODE = process.env.RUN_FIX161_CEVA_20260806
const VALID_MODES = ['inspect', 'dryrun', 'write']

/** 🔴 精確全名比對 —— 另一家 CEVA 的 sourceField 是有效的，絕不可一併改到 */
const TARGET_COMPANY = 'CEVA LOGISTICS (HONG KONG) LTD'
/** 目標模板：Outbound 的 Full List 版 */
const TEMPLATE_MUST_INCLUDE = ['Outbound', 'Full List']

/** 待修的兩條規則：以 (targetField, 現有 sourceField) 雙重錨定，避免改錯 */
const RULES = [
  {
    targetField: 'cfs_charge',
    from: 'cfs',
    to: 'destination_cfs_charges',
    reason: '同公司 Inbound 的 cfs ← destination_cfs_charges 即為正解',
  },
  {
    targetField: 'gate_charge',
    from: 'gate_charge',
    to: 'destination_gate_fee',
    reason: '同公司 Inbound 的 gate_charge ← destination_gate_fee 即為正解',
  },
]

const line = (s = '') => console.log(`[fix161-ceva] ${s}`)
const hr = (t) => {
  console.log('')
  console.log(`[fix161-ceva] ${'='.repeat(88)}`)
  console.log(`[fix161-ceva] ${t}`)
  console.log(`[fix161-ceva] ${'='.repeat(88)}`)
}

function gate(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`數量閘失敗【${label}】：預期 ${expected}，實際 ${actual}`)
  }
  line(`   ✓ ${label}：${actual} 筆`)
}

async function loadState(c) {
  const company = await c.query(`SELECT id, name FROM companies WHERE name = $1`, [TARGET_COMPANY])
  if (!company.rows.length) return { company: null }

  const companyId = company.rows[0].id

  const defs = await c.query(
    `SELECT id, name, fields FROM field_definition_sets WHERE company_id = $1 AND is_active = true`,
    [companyId]
  )
  const definedKeys = new Set()
  for (const d of defs.rows) {
    for (const f of d.fields || []) if (f.key) definedKeys.add(f.key)
  }

  const maps = await c.query(
    `SELECT m.id, m.name, m.mappings, m.updated_at, t.name AS template
       FROM template_field_mappings m
       LEFT JOIN data_templates t ON t.id = m.data_template_id
      WHERE m.company_id = $1
      ORDER BY t.name`,
    [companyId]
  )

  const target = maps.rows.filter((m) =>
    TEMPLATE_MUST_INCLUDE.every((tok) => (m.template || '').includes(tok))
  )

  return { company: company.rows[0], defs: defs.rows, definedKeys, maps: maps.rows, target }
}

/** 回傳需要改的規則清單（冪等：已是目標值則不列入） */
function planChanges(mapping) {
  const plan = []
  const skipped = []
  for (const spec of RULES) {
    const rule = (mapping.mappings || []).find((g) => g.targetField === spec.targetField)
    if (!rule) {
      skipped.push({ ...spec, why: '找不到該 targetField 的規則' })
      continue
    }
    if (rule.sourceField === spec.to) {
      skipped.push({ ...spec, why: '已是目標值（冪等跳過）', ruleId: rule.id })
      continue
    }
    if (rule.sourceField !== spec.from) {
      skipped.push({
        ...spec,
        why: `現值為「${rule.sourceField}」，既非現況也非目標 —— 不動，需人工確認`,
        ruleId: rule.id,
      })
      continue
    }
    plan.push({ ...spec, ruleId: rule.id, transformType: rule.transformType })
  }
  return { plan, skipped }
}

async function main() {
  if (!VALID_MODES.includes(MODE)) {
    line(`skipped: mode=${MODE} not recognised (expected inspect|dryrun|write; clear the app setting to disable)`)
    return
  }
  if (!process.env.DATABASE_URL) {
    line('skipped: DATABASE_URL 未設定')
    return
  }

  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  line(`connected — mode=${MODE}`)

  const st = await loadState(c)

  hr('1  現況')
  if (!st.company) {
    line(`🔴 找不到公司「${TARGET_COMPANY}」（精確全名比對）—— 中止，不猜測目標`)
    await c.end()
    return
  }
  line(`公司  ${st.company.name}`)
  line(`  id=${st.company.id}`)
  line(`欄位定義集 ${st.defs.length} 組，合計 ${st.definedKeys.size} 個 key`)
  line('')
  line(`該公司的 template_field_mappings ${st.maps.length} 筆：`)
  for (const m of st.maps) line(`  - ${m.template}  (${m.id})`)
  line('')
  line(`符合「${TEMPLATE_MUST_INCLUDE.join(' + ')}」的目標 ${st.target.length} 筆`)

  if (st.target.length !== 1) {
    line(`🔴 目標不是恰好 1 筆 —— 中止。0 筆代表該環境沒有這個模板；多筆代表命名有歧義，`)
    line('   兩者都不該由腳本自行決定改哪一個。')
    await c.end()
    return
  }

  const mapping = st.target[0]
  line('')
  line(`目標 mapping  ${mapping.name}`)
  line(`  id=${mapping.id}  updated_at=${mapping.updated_at && mapping.updated_at.toISOString()}`)
  line(`  規則 ${(mapping.mappings || []).length} 條：`)
  for (const g of mapping.mappings || []) {
    const f = g.transformParams && g.transformParams.formula
    const src = f ? f : g.sourceField
    const undef =
      !f && g.sourceField && !st.definedKeys.has(g.sourceField) ? '   🔴 來源不在定義集' : ''
    line(`      [${g.transformType}] ${g.targetField} ← ${src}${undef}`)
  }

  // ------------------------------------------------------------ 前置驗證
  hr('2  前置驗證（不照抄本機，逐項確認本環境）')
  let blocked = false
  for (const spec of RULES) {
    const toOk = st.definedKeys.has(spec.to)
    const fromAbsent = !st.definedKeys.has(spec.from)
    line(`  ${spec.targetField}`)
    line(`    目標 key「${spec.to}」在定義集內        ${toOk ? '✅' : '🔴 否'}`)
    line(`    現值 key「${spec.from}」不在定義集內     ${fromAbsent ? '✅' : '🔴 否（它是有效的，不該改）'}`)
    if (!toOk || !fromAbsent) blocked = true
  }
  if (blocked) {
    line('')
    line('🔴 前置驗證未過 —— 本環境的情況與本機不同，**中止**，不套用本機的變更。')
    line('   （FIX-158 已證實兩環境的欄位定義集可能不同步）')
    await c.end()
    return
  }

  // ------------------------------------------------------------ 計畫
  hr('3  計畫')
  const { plan, skipped } = planChanges(mapping)
  line(`將修改 ${plan.length} 條，跳過 ${skipped.length} 條`)
  for (const p of plan) {
    line(`  ✏️ [${p.transformType}] ${p.targetField}：${p.from} → ${p.to}`)
    line(`      理由：${p.reason}`)
    line(`      ruleId=${p.ruleId}`)
  }
  for (const s of skipped) {
    line(`  ⏭️ ${s.targetField}：${s.why}${s.ruleId ? `  (ruleId=${s.ruleId})` : ''}`)
  }

  if (!plan.length) {
    line('')
    line('沒有需要修改的規則 —— 已達目標狀態（冪等）或情況不符。結束。')
    await c.end()
    return
  }

  if (MODE === 'inspect') {
    line('')
    line('inspect 結束 —— 未寫入任何資料。下一步：改 mode=dryrun')
    await c.end()
    return
  }

  // ------------------------------------------------------------ 前置快照
  hr('4  前置快照（🔴 容器內無可保留檔案系統 —— 這段 log 是唯一還原依據）')
  line('--- SNAPSHOT BEGIN ---')
  console.log(
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        mode: MODE,
        companyId: st.company.id,
        mappingId: mapping.id,
        mappingName: mapping.name,
        template: mapping.template,
        updated_at: mapping.updated_at,
        mappingsBefore: mapping.mappings,
      },
      null,
      1
    )
  )
  line('--- SNAPSHOT END ---')

  if (MODE === 'dryrun') {
    hr('5  dryrun —— 以上為變更前的完整規則陣列，未寫入任何資料')
    line('下一步：改 mode=write')
    await c.end()
    return
  }

  // ------------------------------------------------------------ write
  hr('5  write（單一交易）')
  await c.query('BEGIN')
  try {
    const next = (mapping.mappings || []).map((g) => {
      const hit = plan.find((p) => p.ruleId === g.id)
      return hit ? { ...g, sourceField: hit.to } : g
    })

    // 樂觀鎖：updated_at 必須與讀取當下相同
    const upd = await c.query(
      `UPDATE template_field_mappings
          SET mappings = $2::jsonb, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND updated_at = $3`,
      [mapping.id, JSON.stringify(next), mapping.updated_at]
    )
    gate(upd.rowCount, 1, 'template_field_mappings 更新（樂觀鎖）')

    await c.query('COMMIT')
    line('')
    line('✅ COMMIT —— 交易已提交')
  } catch (e) {
    await c.query('ROLLBACK')
    line('')
    line(`🔴 ROLLBACK —— ${e.message}`)
    line('   資料未變更。')
    await c.end()
    return
  }

  // ------------------------------------------------------------ 事後對帳
  hr('6  事後對帳（重新讀取，證明結果）')
  const after = await loadState(c)
  const m2 = after.target[0]
  for (const g of m2.mappings || []) {
    const f = g.transformParams && g.transformParams.formula
    const src = f ? f : g.sourceField
    const mark = RULES.some((r) => r.targetField === g.targetField) ? ' ←' : ''
    line(`  [${g.transformType}] ${g.targetField} ← ${src}${mark}`)
  }
  const residual = planChanges(m2).plan
  line('')
  line(`殘餘待修  ${residual.length}${residual.length === 0 ? '  ✅' : '  🔴'}`)

  line('')
  line('⚠️ 改 mapping **不會回溯既有的模板實例列** —— 需重新匹配後才會反映。')
  line('   接著必須跑 RUN_ORPHAN_CHECK + RECONCILE_BASELINE 做前後對帳（runbook §20），')
  line('   確認漏接金額**下降**且沒有其他欄位變空。')
  line('')
  line('done')
  await c.end()
}

main().catch((e) => {
  console.error(`[fix161-ceva] FATAL: ${e.message}`)
  process.exitCode = 0 // 非致命：不擋容器啟動
})
