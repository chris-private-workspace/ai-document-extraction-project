/**
 * @fileoverview FIX-159 移植到 Azure DEV：拆分 Toll 泰國 / 香港跨國實體（三模式 gated）
 * @description
 *   `normalizeCompanyName` 移除括號及其內容，使 `(Thailand)` 與 `(Hong Kong)` 正規化後字串相等，
 *   兩個法律實體被併成同一筆公司記錄。2026-08-06 於 Azure DEV 實測確認：
 *   `Toll Global Forwarder Limited` 底下 86 份文件中有 **35 份是香港發票**。
 *
 *   修法沿用 FIX-159 選定的**方案 B：資料層拆分** —— 不動正規化規則（會波及 CEVA / DHL 的
 *   正常歸併），改為兩個實體各自寫精確 `nameVariants`，在 `resolveCompanyId` 的
 *   **Step 2a（精確比對，早於 2b 的正規化相等）**完成分流。
 *
 *   🔴 **本機的 variants 清單不足以涵蓋 Azure**。Azure 有兩種本機從未出現的中英混排印法
 *   （`拓領環球貨運(香港)有限公司` / `拓環球貨運(香港)有限公司`，共 6 份）。
 *   本檔的清單以**目標環境實測到的原文**為準，本機推導項另行標示。
 *
 *   🔴 **必須同時補泰國側 variants**。FIX-159 第一次 write 只建香港記錄，造成泰國回歸：
 *   既有記錄名是 `Forwar**der**`、發票印的是 `Forwar**ding**`，正規化後不相等 ——
 *   泰國文件本來就沒有 Step 2b 可走（靠 Step 3 相似度勉強命中）；新香港記錄一出現，
 *   2b 恰好命中它，於是搶在 Step 3 之前把泰國文件截走。Azure 的泰國記錄 `nameVariants`
 *   目前是 **0 項**，風險完全相同。
 *
 *   模式（`RUN_TOLL_SPLIT_20260806`）：
 *     inspect — 唯讀，印現況與將要處理的範圍
 *     dryrun  — 唯讀，印每一步將改什麼（含完整前置值）
 *     write   — 實際寫入
 *
 *   §不可逆資料操作紀律 的五項措施：
 *     1. 前置快照 —— 🔴 容器內沒有可保留的檔案系統，改為把變更前的值**完整印進 log**
 *                    （Log Analytics 的 `AppServiceConsoleLogs` 即是唯一還原依據）
 *     2. 單一交易 —— BEGIN / COMMIT，任一步失敗即 ROLLBACK
 *     3. 數量閘   —— 每筆 rowCount !== 預期即拋錯中止
 *     4. 樂觀鎖   —— UPDATE 帶 `updated_at = 讀取當下值`
 *     5. 冪等     —— 已達目標狀態則跳過，重跑不產生副作用
 *
 *   ⚠️ **本腳本只做拆分**。依 FIX-159 §拆分後的設定缺口，拆完後新實體是一個**沒有
 *   欄位定義集、沒有映射**的空殼。完整程序為：拆 → 建欄位定義集 → 重新提取 → 建映射 →
 *   重跑匹配。後三步涉及 mapping 寫入，受 runbook §17 的通案限制（對帳工具未移植進映像）。
 *
 * @module prisma/split-toll-hk-20260806
 * @since 2026-08-06 FIX-159 Azure 移植
 * @lastModified 2026-08-06
 */
const { Client } = require('pg')

const MODE = process.env.RUN_TOLL_SPLIT_20260806
const VALID_MODES = ['inspect', 'dryrun', 'write']

/** 既有記錄（泰國側）—— 以名稱錨定，各環境主鍵不同 */
const EXISTING_NAME = 'Toll Global Forwarder Limited'
/** 新建記錄（香港側） */
const HK_NAME = 'Toll Global Forwarding (Hong Kong) Ltd'

/**
 * 香港側 variants。
 * [實測] = 2026-08-06 於 Azure DEV 的 stage_1 發票原文中確實出現過
 * [推導] = 依縮寫慣例補，本庫尚無發票用過（FIX-159 已記為已知限制）
 */
const HK_VARIANTS = [
  'Toll Global Forwarding (Hong Kong) Ltd', // [實測] 29 份
  'Toll Global Forwarding (Hong Kong) Ltd 拓領環球貨運(香港)有限公司', // [實測] 4 份 — 本機沒有
  'Toll Global Forwarding (Hong Kong) Ltd 拓環球貨運(香港)有限公司', // [實測] 2 份 — 本機沒有
  'Toll Global Forwarding (Hong Kong) Limited', // [推導]
  'Toll Global Forwarding (HK) Ltd', // [推導]
  'Toll Global Forwarding (HK) Limited', // [推導]
]

/** 泰國側 variants —— 補在既有記錄上，使泰國文件也在 Step 2a 命中 */
const TH_VARIANTS = [
  'Toll Global Forwarding (Thailand) Limited', // [實測] 51 份
  'Toll Global Forwarding (Thailand) Ltd', // [推導]
]

/** 地區判定 —— 用地區詞而非列舉字串，才涵蓋未列舉的印法 */
const isHK = (s) => /hong\s*kong|\(\s*HK\s*\)|香港/i.test(s || '')
const isTH = (s) => /thailand|泰國/i.test(s || '')

const line = (s = '') => console.log(`[toll-split] ${s}`)
const hr = (t) => {
  console.log('')
  console.log(`[toll-split] ${'='.repeat(88)}`)
  console.log(`[toll-split] ${t}`)
  console.log(`[toll-split] ${'='.repeat(88)}`)
}

/** 措施 3：數量閘 —— 別只看「有沒有錯」，每筆都要對數 */
function gate(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`數量閘失敗【${label}】：預期 ${expected}，實際 ${actual}`)
  }
  line(`   ✓ ${label}：${actual} 筆`)
}

async function loadState(c) {
  const existing = await c.query(
    `SELECT id, name, status, coalesce(name_variants, '{}') AS nv, updated_at
       FROM companies WHERE name = $1`,
    [EXISTING_NAME]
  )
  const hk = await c.query(
    `SELECT id, name, status, coalesce(name_variants, '{}') AS nv, updated_at
       FROM companies WHERE name = $1`,
    [HK_NAME]
  )

  // 所有掛在 Toll 相關記錄底下、可解析出發票原文的提取結果
  const scopeIds = [
    ...existing.rows.map((r) => r.id),
    ...hk.rows.map((r) => r.id),
  ]
  const docs = scopeIds.length
    ? await c.query(
        `SELECT d.id AS doc_id, d.file_name, e.id AS ext_id, e.company_id AS current_company_id,
                ((e.stage_1_ai_details::jsonb ->> 'response')::jsonb
                   -> 'documentIssuer' ->> 'name') AS issuer
           FROM extraction_results e
           JOIN documents d ON d.id = e.document_id
          WHERE e.company_id = ANY($1::text[])
            AND left(trim(e.stage_1_ai_details::jsonb ->> 'response'), 1) = '{'
          ORDER BY e.created_at`,
        [scopeIds]
      )
    : { rows: [] }

  return {
    existing: existing.rows[0] || null,
    hk: hk.rows[0] || null,
    docs: docs.rows,
  }
}

/** 依發票原文算出每份文件「應該」歸到哪個實體，並找出目前歸錯的 */
function planReassign(state, hkId) {
  const misgrouped = []
  const ambiguous = []
  for (const d of state.docs) {
    const hkHit = isHK(d.issuer)
    const thHit = isTH(d.issuer)
    if (hkHit === thHit) {
      ambiguous.push(d) // 兩者皆中或皆不中 —— 不猜
      continue
    }
    const expected = hkHit ? hkId : state.existing.id
    if (expected && d.current_company_id !== expected) {
      misgrouped.push({ ...d, expected_company_id: expected, target: hkHit ? 'HK' : 'TH' })
    }
  }
  return { misgrouped, ambiguous }
}

function diffVariants(current, wanted) {
  const have = new Set((current || []).map((v) => v.toLowerCase()))
  return wanted.filter((v) => !have.has(v.toLowerCase()))
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

  const state = await loadState(c)

  // ---------------------------------------------------------------- 現況
  hr('1  現況')
  if (!state.existing) {
    line(`🔴 找不到既有記錄「${EXISTING_NAME}」—— 中止，不猜測目標`)
    await c.end()
    return
  }
  line(`既有記錄  ${state.existing.name}`)
  line(`  id=${state.existing.id}  status=${state.existing.status}`)
  line(`  nameVariants (${state.existing.nv.length})`)
  for (const v of state.existing.nv) line(`    - ${v}`)
  line('')
  line(`香港記錄  ${state.hk ? state.hk.name : '（不存在，將建立）'}`)
  if (state.hk) {
    line(`  id=${state.hk.id}  status=${state.hk.status}`)
    line(`  nameVariants (${state.hk.nv.length})`)
    for (const v of state.hk.nv) line(`    - ${v}`)
  }

  line('')
  line(`可對帳提取結果  ${state.docs.length}`)
  const byIssuer = new Map()
  for (const d of state.docs) {
    const k = `${d.current_company_id === state.existing.id ? 'TH記錄' : 'HK記錄'} ⟵ ${d.issuer}`
    byIssuer.set(k, (byIssuer.get(k) || 0) + 1)
  }
  for (const [k, n] of [...byIssuer.entries()].sort((a, b) => b[1] - a[1])) {
    line(`  ${String(n).padStart(4)}  ${k}`)
  }

  // ---------------------------------------------------------------- 計畫
  hr('2  計畫')
  const needCreate = !state.hk
  const hkId = state.hk ? state.hk.id : null
  const missingHk = state.hk ? diffVariants(state.hk.nv, HK_VARIANTS) : HK_VARIANTS
  const missingTh = diffVariants(state.existing.nv, TH_VARIANTS)

  line(`建立香港記錄        ${needCreate ? '是' : '否（已存在，冪等跳過）'}`)
  line(`香港 variants 待補   ${missingHk.length}`)
  for (const v of missingHk) line(`    + ${v}`)
  line(`泰國 variants 待補   ${missingTh.length}`)
  for (const v of missingTh) line(`    + ${v}`)

  // 建立前無法得知 hkId，改用哨兵字串代表「新記錄」
  const plan = planReassign(state, hkId || '__NEW_HK__')
  line('')
  line(`需重新歸屬          ${plan.misgrouped.length}`)
  const toHK = plan.misgrouped.filter((m) => m.target === 'HK')
  const toTH = plan.misgrouped.filter((m) => m.target === 'TH')
  line(`  → 香港記錄        ${toHK.length}`)
  line(`  → 既有（泰國）    ${toTH.length}`)
  line(`地區無法判定（跳過） ${plan.ambiguous.length}`)
  for (const a of plan.ambiguous) line(`    ? ${a.file_name}  issuer=${a.issuer}`)

  if (MODE === 'inspect') {
    line('')
    line('inspect 結束 —— 未寫入任何資料。下一步：改 mode=dryrun')
    await c.end()
    return
  }

  // ---------------------------------------------------------------- 措施 1：前置快照
  hr('3  前置快照（🔴 容器內無可保留檔案系統 —— 這段 log 是唯一還原依據）')
  line('--- SNAPSHOT BEGIN ---')
  console.log(
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        mode: MODE,
        existing: state.existing,
        hk: state.hk,
        willReassign: plan.misgrouped.map((m) => ({
          doc_id: m.doc_id,
          ext_id: m.ext_id,
          file_name: m.file_name,
          issuer: m.issuer,
          from_company_id: m.current_company_id,
          to: m.target,
        })),
      },
      null,
      1
    )
  )
  line('--- SNAPSHOT END ---')

  if (MODE === 'dryrun') {
    hr('4  dryrun —— 以上為將要改動的完整前置值，未寫入任何資料')
    line('下一步：改 mode=write')
    await c.end()
    return
  }

  // ---------------------------------------------------------------- write
  hr('4  write（措施 2：單一交易）')
  await c.query('BEGIN')
  try {
    let finalHkId = hkId

    if (needCreate) {
      const creator = await c.query(`SELECT created_by_id FROM companies WHERE name = $1`, [
        EXISTING_NAME,
      ])
      if (!creator.rows.length) throw new Error('取不到既有記錄的 created_by_id')

      const ins = await c.query(
        `INSERT INTO companies
           (id, name, display_name, code, type, status, source,
            name_variants, priority, default_confidence,
            created_by_id, created_at, updated_at)
         VALUES
           (gen_random_uuid()::text, $1, $1, NULL, 'FORWARDER', 'ACTIVE', 'MANUAL',
            $2::text[], 0, 0.8, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING id`,
        [HK_NAME, HK_VARIANTS, creator.rows[0].created_by_id]
      )
      gate(ins.rowCount, 1, '新增香港公司')
      finalHkId = ins.rows[0].id
      line(`   ✅ 已建立 ${HK_NAME} → ${finalHkId}`)
    } else if (missingHk.length) {
      // 措施 4：樂觀鎖
      const upd = await c.query(
        `UPDATE companies
            SET name_variants = (
                  SELECT array_agg(DISTINCT v)
                    FROM unnest(coalesce(name_variants, '{}'::text[]) || $2::text[]) AS v
                ),
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND updated_at = $3`,
        [state.hk.id, missingHk, state.hk.updated_at]
      )
      gate(upd.rowCount, 1, '補香港 nameVariants（樂觀鎖）')
    }

    if (missingTh.length) {
      // 措施 4：樂觀鎖
      const updTh = await c.query(
        `UPDATE companies
            SET name_variants = (
                  SELECT array_agg(DISTINCT v)
                    FROM unnest(coalesce(name_variants, '{}'::text[]) || $2::text[]) AS v
                ),
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND updated_at = $3`,
        [state.existing.id, missingTh, state.existing.updated_at]
      )
      gate(updTh.rowCount, 1, '補泰國 nameVariants（樂觀鎖）')
    }

    // 建立後才知道真實 hkId，重新計算歸屬計畫
    const finalPlan = planReassign(state, finalHkId)
    const byTarget = new Map()
    for (const m of finalPlan.misgrouped) {
      if (!byTarget.has(m.expected_company_id)) {
        byTarget.set(m.expected_company_id, { docIds: [], extIds: [] })
      }
      byTarget.get(m.expected_company_id).docIds.push(m.doc_id)
      byTarget.get(m.expected_company_id).extIds.push(m.ext_id)
    }

    for (const [targetId, g] of byTarget) {
      const label = targetId === finalHkId ? HK_NAME : EXISTING_NAME
      const u1 = await c.query(
        `UPDATE documents SET company_id = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ANY($2::text[])`,
        [targetId, g.docIds]
      )
      gate(u1.rowCount, g.docIds.length, `documents 重新歸屬 → ${label}`)

      const u2 = await c.query(
        `UPDATE extraction_results SET company_id = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ANY($2::text[])`,
        [targetId, g.extIds]
      )
      gate(u2.rowCount, g.extIds.length, `extraction_results 重新歸屬 → ${label}`)
    }

    await c.query('COMMIT')
    line('')
    line('✅ COMMIT —— 交易已提交')
  } catch (e) {
    await c.query('ROLLBACK')
    line('')
    line(`🔴 ROLLBACK —— ${e.message}`)
    line('   資料未變更。請依上方 SNAPSHOT 區段確認現況後再處理。')
    await c.end()
    return
  }

  // ---------------------------------------------------------------- 事後對帳
  hr('5  事後對帳（重新讀取，證明結果）')
  const after = await loadState(c)
  for (const co of [after.existing, after.hk].filter(Boolean)) {
    line('')
    line(`  ${co.name}`)
    line(`    nameVariants (${co.nv.length})`)
    for (const v of co.nv) line(`      - ${v}`)
    const iss = new Map()
    for (const d of after.docs.filter((d) => d.current_company_id === co.id)) {
      iss.set(d.issuer, (iss.get(d.issuer) || 0) + 1)
    }
    line(`    可對帳提取 ${[...iss.values()].reduce((a, b) => a + b, 0)} 筆／${iss.size} 種原文`)
    for (const [k, n] of [...iss.entries()].sort((a, b) => b[1] - a[1])) {
      line(`      ${String(n).padStart(4)}  ${k}`)
    }
  }

  const residual = planReassign(after, after.hk ? after.hk.id : null).misgrouped
  line('')
  line(`殘餘待修正  ${residual.length}${residual.length === 0 ? '  ✅ 一對一' : '  🔴 仍有誤歸'}`)
  for (const r of residual) line(`    ${r.file_name}  issuer=${r.issuer}  → 應為 ${r.target}`)

  line('')
  line('⚠️ 拆分只完成第一步。新實體目前**沒有欄位定義集、沒有映射** ——')
  line('   完整程序為：拆 → 建欄位定義集 → 重新提取 → 建映射 → 重跑匹配（見 FIX-159 §拆分後的設定缺口）。')
  line('')
  line('done')
  await c.end()
}

main().catch((e) => {
  console.error(`[toll-split] FATAL: ${e.message}`)
  process.exitCode = 0 // 非致命：不擋容器啟動
})
