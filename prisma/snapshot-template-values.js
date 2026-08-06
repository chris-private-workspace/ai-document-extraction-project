/**
 * @fileoverview 模板實例欄位值快照與前後對照（FIX-150 第一層防護）—— 容器內可執行版
 * @description
 *   🔴 唯讀 —— 只有 SELECT，不寫入資料庫（也不寫檔）。
 *
 *   用途：改動 template field mapping 前後各擷取一次模板欄位值，逐份文件逐欄位比對。
 *   重點在標示「改動前有值、改動後變空」的欄位 —— 那就是「修 A 打破 B」的訊號。
 *
 *   FIX-150 的回歸正是這樣發生的：2026-07-25 為了讓某一份文件的 DO fee 落地而改了映射
 *   來源，當場只重跑那一份、確認通過，但同一個目標欄位原本承載的 B/L fee 從此失去去處，
 *   橫跨另外四份文件無聲消失。有了前後對照，這種損失在改動當下就會現形。
 *
 *   ── 與本機版的差異 ──────────────────────────────────
 *   本機版靠 JSON 檔保存 before/after。容器內做不到：
 *     - `WEBSITES_ENABLE_APP_SERVICE_STORAGE=false` → `/home` 不持久，寫檔重啟即消失
 *     - 中間還夾著「重新匹配模板實例」這個要另外觸發的步驟，跨越了容器生命週期
 *   故本檔只做 `capture`，把快照印進 log；**`diff` 在本地跑**
 *   （`scripts/snapshot-template-values.js diff before.json after.json`，判準完全相同）。
 *
 *   標準流程：
 *     1. 改動前設 `RUN_TEMPLATE_SNAPSHOT=capture` → 從容器 log 取出 JSON 存成 before.json
 *     2. 改動 mapping + 重新匹配模板實例
 *     3. 再跑一次 → 取出 JSON 存成 after.json
 *     4. 本機 `node scripts/snapshot-template-values.js diff before.json after.json`
 *
 *   🔴 **務必用 `RECONCILE_COMPANY` 縮小範圍**。全庫快照可達數 MB，印進 log 會被截斷 ——
 *   截斷的 JSON 解析不出來，而「解析失敗」比「沒有安全網」更危險（誤以為做過對帳）。
 *   本檔在輸出前先估算大小，超過上限即**拒絕輸出並要求加過濾**，不會悄悄截斷。
 *
 *   模式（`RUN_TEMPLATE_SNAPSHOT`）：僅接受 `capture`。
 *   選用 env：`RECONCILE_COMPANY` —— 公司名稱關鍵字過濾。
 *
 *   🔴 比照 FIX-140：本旗標是單值非布林 —— **關閉方式是清空設定，設成 false 不會關閉**。
 *
 *   ⚠️ 改設定不會回溯既有的模板實例列，必須重新匹配後才擷取 after，否則對照無意義。
 *
 * @module prisma/snapshot-template-values
 * @since 2026-08-06（解除 runbook §17 的通案限制）
 * @lastModified 2026-08-06
 */
'use strict'

const { Client } = require('pg')

const MODE = process.env.RUN_TEMPLATE_SNAPSHOT
const VALID_MODES = ['capture']
const COMPANY_FILTER = process.env.RECONCILE_COMPANY || null

/** log 單段輸出上限。超過即拒絕輸出 —— 截斷的 JSON 比沒有安全網更危險。 */
const MAX_BYTES = 512 * 1024

const line = (s = '') => console.log(`[tpl-snapshot] ${s}`)

async function main() {
  if (!VALID_MODES.includes(MODE)) {
    line(`skipped: mode=${MODE} not recognised (expected capture; clear the app setting to disable)`)
    return
  }
  if (!process.env.DATABASE_URL) {
    line('skipped: DATABASE_URL 未設定')
    return
  }

  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  line(`connected — mode=${MODE}，唯讀`)

  // source_document_ids 為陣列（合併列可對應多份文件），以 ANY 展開成每文件一列。
  // DISTINCT ON (文件, 模板) 取最新一列 —— 改動後即使換了新實例也能與改動前對上。
  const params = []
  let where = ''
  if (COMPANY_FILTER) {
    params.push(`%${COMPANY_FILTER}%`)
    where = ' WHERE co.name ILIKE $1'
  }
  const res = await c.query(
    `SELECT DISTINCT ON (doc.id, dt.name)
            doc.id AS document_id, doc.file_name, co.name AS company,
            dt.name AS template_name, ti.name AS instance_name,
            tir.created_at, tir.field_values, tir.transform_diagnostics
       FROM template_instance_rows tir
       JOIN template_instances ti ON ti.id = tir.template_instance_id
       JOIN data_templates dt ON dt.id = ti.data_template_id
       JOIN documents doc ON doc.id = ANY(tir.source_document_ids)
       LEFT JOIN companies co ON co.id = doc.company_id${where}
      ORDER BY doc.id, dt.name, tir.created_at DESC`,
    params
  )

  const rows = {}
  for (const r of res.rows) {
    rows[`${r.document_id}|${r.template_name}`] = {
      file: r.file_name,
      company: r.company,
      template: r.template_name,
      instance: r.instance_name,
      rowCreatedAt: r.created_at.toISOString(),
      values: r.field_values || {},
      diagnostics: r.transform_diagnostics || null,
    }
  }

  const payload = {
    capturedAt: new Date().toISOString(),
    filter: COMPANY_FILTER,
    rowCount: Object.keys(rows).length,
    rows,
  }

  const companies = new Set(Object.values(rows).map((r) => r.company))
  line(`已擷取 ${payload.rowCount} 列（文件 × 模板），涵蓋 ${companies.size} 家公司`)
  if (COMPANY_FILTER) line(`公司篩選：${COMPANY_FILTER}`)

  if (payload.rowCount === 0) {
    // 分母為 0 時「沒有差異」是假綠燈 —— 明確標示
    line('🔴 擷取到 0 列 —— 這不是「沒有資料變動」，是沒有可對照的對象。')
    line('   請確認公司篩選是否過窄，或該環境是否真的有模板實例列。')
    await c.end()
    return
  }

  const json = JSON.stringify(payload)
  const bytes = Buffer.byteLength(json, 'utf8')
  line(`快照大小 ${(bytes / 1024).toFixed(1)} KB（上限 ${MAX_BYTES / 1024} KB）`)

  if (bytes > MAX_BYTES) {
    line('')
    line('🔴 快照超過 log 輸出上限，**拒絕輸出** —— 截斷的 JSON 解析不出來，')
    line('   而「解析失敗」比「沒有安全網」更危險（會誤以為對過帳）。')
    line(`   請設 RECONCILE_COMPANY 縮小範圍後重跑。目前涵蓋的公司：`)
    for (const co of [...companies].sort()) line(`     - ${co}`)
    await c.end()
    return
  }

  line('')
  line('--- SNAPSHOT JSON BEGIN ---（整段存成 before.json / after.json，於本機 diff）')
  console.log(json)
  line('--- SNAPSHOT JSON END ---')
  line('')
  line('本機比對：node scripts/snapshot-template-values.js diff before.json after.json')
  line('done')

  await c.end()
}

main().catch((e) => {
  console.error(`[tpl-snapshot] FATAL: ${e.message}`)
  process.exitCode = 0 // 非致命：不擋容器啟動
})
