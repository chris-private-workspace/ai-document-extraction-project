/**
 * @fileoverview FIX-130（Azure DEV 存量設定修正，一次性）：修正 template field mapping
 *   公式中「引用不存在 key」的存量錯誤 + 補齊欄位定義集 aliases。
 *
 *   背景：FIX-126~129 修的是機制；本腳本修現存資料。多條 mapping 公式引用了
 *   不存在的欄位定義 key（後綴 _charge 贅字 / 拼字 / 單複數 / 底線差異），該項
 *   永遠取不到值。完整清單見 FIX-128 的全面掃描（10 組 mapping、29 條規則）。
 *
 *   涵蓋範圍（FIX-130 交付方式 b —— 規則明確、不需業務判斷的部分）：
 *   - 項目 1：aliases 補齊（SBS INTERNATIONAL 三條）+ CEVA 過泛 alias 查核（報告）
 *   - 項目 2：公式死 key 修正（rename / remove，含替換後去重）
 *   - 項目 3：公式重複來源 —— 刻意不改。FIX-127 已在 Stage 3 清除重複金額
 *     （翻倍根因在機制層解決）；公式多項屬容錯設計，刪除會失去不同版面的兜底。
 *     dry-run 報告會列出這 3 條供人工裁決（見 FIX-130 §3）。
 *   - 不涵蓋：項目 4（公司歸屬）、項目 5（缺欄位定義）—— 需使用者逐案決定。
 *
 *   防呆設計（與 FIX-113 / FIX-120 原則一致 —— 絕不猜測改值）：
 *   - 每條修正執行前驗證現值符合預期（DIRECT 驗 sourceField；FORMULA 驗死 key 存在
 *     於公式中），不符即跳過並報告，不硬改
 *   - FORMULA 僅處理「純 {key} + {key} 加總」形式；含其他運算符的公式一律跳過報告
 *   - rename 目標 key 必須存在於該公司的欄位定義集，否則跳過
 *   - CEVA / DSV / Redlines 的死 key 無法從留存資料確定對應 → REPORT_ONLY，
 *     列出現值與該公司 defset key 清單，供使用者決定後再擴充本表
 *
 *   由 RUN_CONFIG_CORRECTIONS=dryrun|write 控制。dryrun 只 SELECT + 印修正計畫
 *   （含每筆 before/after）；write 才寫入（交易原子性，任何錯誤 ROLLBACK）。
 *   ⚠️ **不接入 entrypoint**（一次性、避免部署誤觸）；經 ad-hoc 執行（Kudu /home
 *   或容器內），先 dryrun 經人工核對後才 write（FIX-130 驗收標準）。
 *
 * @module prisma/apply-config-corrections
 * @since FIX-130 (2026-07-22)
 * @lastModified 2026-07-22
 */

/* eslint-disable no-console */

let Client
try {
  ;({ Client } = require('pg'))
} catch {
  // Kudu /home 執行時使用 q 系列預裝的 pg（node14 相容版）
  ;({ Client } = require('/home/node_modules/pg'))
}

function resolveSsl() {
  const url = process.env.DATABASE_URL || ''
  if (/sslmode=require/i.test(url) || /\.postgres\.database\.azure\.com/i.test(url)) {
    return { rejectUnauthorized: false }
  }
  return false
}

// ============================================================
// 修正表（依據：FIX-128 全面掃描 + q2 留存的 Azure defset 現值，2026-07-22）
// ============================================================

/**
 * mapping 公式 / sourceField 的死 key 修正。
 * - renames: { 死key: 實際key }（同時作用於 sourceField 與 FORMULA 公式；替換後重複自動去重）
 * - removes: [key]（該公司 defset 無任何對應概念，從公式移除該項）
 * - note: 供 dry-run 核對時的提示（低信心項必註明）
 */
const MAPPING_FIXES = [
  {
    mapping: 'SBS - Logistics Cost - Inbound Template (Full List)',
    company: 'SBS',
    rules: [
      {
        target: 'handling',
        renames: {
          air_alfa_charge_dest_charge: 'air_alfa_charge_dest',
          air_import_service_fee_dest_charge: 'air_import_service_fee_dest',
        },
      },
      { target: 'freight', renames: { ocean_freight_non_nvocc: 'sea_ocean_freight_non_nvocc' } },
      { target: 'terminal_fees', renames: { air_terminal_charge_dest_charge: 'air_terminal_charge_dest' } },
      { target: 'cfs', renames: { air_cfs_charge_dest_charge: 'air_cfs_charge_dest' } },
      {
        target: 'docs_fee',
        renames: {
          air_airline_document_charge_dest_charge: 'air_airline_document_charge_dest',
          sea_document_b_l: 'sea_document_bl',
          air_delivery_order_dest_charge: 'air_delivery_order_dest',
          d_o_fee: 'do_fee',
        },
      },
      {
        target: 'pick_up_fee_at_origin',
        renames: {
          air_pick_up_charge_original_charge: 'air_pick_up_charge_origin',
          air_pick_up_charge_origin_charge: 'air_pick_up_charge_origin',
        },
        note: '兩個死 key 對應同一實際 key，替換後自動去重為單一項',
      },
      {
        target: 'terminal_fees_at_origin',
        renames: { air_local_charge_in_usa_origin_charge: 'air_local_charge_usa_origin' },
      },
      {
        target: 'delivery',
        renames: {
          air_delivery_charge_dest_charge: 'air_delivery_charge_dest',
          drayage: 'dryage_charge',
        },
        note: 'drayage→dryage_charge：defset 實際 key 拼字即為 dryage_charge（"Drayage Charge"）',
      },
      { target: 'gate_charge', renames: { air_gate_charge_dest_charge: 'air_gate_charge_dest' } },
      {
        target: 'handling_at_origin',
        renames: { air_local_charge_in_usa_origin_charge: 'air_local_charge_usa_origin' },
      },
      { target: 'others_delivery', renames: { pick_up_d_o_charge: 'pick_up_do_charge' } },
    ],
  },
  {
    mapping: 'SBS INTERNATIONAL LOGISTICS  - Logistics Cost - Inbound Template (Full List)',
    company: 'RICOH INTERNATIONAL LOGISTICS (HK) LTD.',
    rules: [
      {
        target: 'handling',
        renames: {
          air_alfa_charge_dest_charge: 'air_alfa_charge_dest',
          air_import_service_fee_dest_charge: 'air_import_service_fee_dest',
        },
      },
      { target: 'freight', renames: { ocean_freight_non_nvocc: 'sea_ocean_freight_non_nvocc' } },
      { target: 'cfs', renames: { air_cfs_charge_dest_charge: 'air_cfs_charge_dest' } },
      {
        target: 'docs_fee',
        renames: {
          air_airline_document_charge_dest_charge: 'air_airline_document_charge_dest',
          sea_document_b_l: 'sea_document_bl',
          air_delivery_order_dest_charge: 'air_delivery_order_dest',
          air_delivery_order_charge: 'air_delivery_order_dest',
          d_o_fee: 'do_fee',
        },
        note: '兩個 delivery order 死 key 對應同一實際 key，替換後自動去重',
      },
      {
        target: 'pick_up_fee_at_origin',
        renames: { air_pick_up_charge_original_charge: 'air_pick_up_charge_origin' },
      },
      { target: 'delivery', renames: { air_delivery_charge_dest_charge: 'air_delivery_charge_dest' } },
      { target: 'gate_charge', renames: { air_gate_charge_dest_charge: 'air_gate_charge_dest' } },
    ],
  },
  {
    mapping: 'SBS INTERNATIONAL LOGISTICS  - Logistics Cost - Outbound Template (Full List)',
    company: 'RICOH INTERNATIONAL LOGISTICS (HK) LTD.',
    rules: [
      {
        target: 'handling_charge',
        renames: {
          air_alfa_charge_dest_charge: 'air_alfa_charge_dest',
          air_import_service_fee_dest_charge: 'air_import_service_fee_dest',
        },
      },
    ],
  },
  {
    mapping: 'Toll Global Forwarder Limited - Logistics Cost - Inbound Template (Full List)',
    company: 'Toll Global Forwarder Limited',
    rules: [
      {
        target: 'terminal_fees_at_origin',
        renames: { terminal_handling_charges_origin: 'terminal_handling_charge_origin' },
        note: '複數 charges → 實際 key 為單數 charge（FIX-126 的單複數歸一不作用於公式 key 對照）',
      },
      {
        target: 'thc',
        renames: { terminal_handling_charges_destination: 'terminal_handling_charge_destination' },
        note: '複數→單數；若公式已含單數項，替換後自動去重',
      },
    ],
  },
  {
    mapping: 'Toll Global Forwarder Limited - Logistics Cost - Outbound Template (Full List)',
    company: 'Toll Global Forwarder Limited',
    rules: [
      {
        target: 'handling_charge',
        renames: { handling_fee_incl_p_u: 'handling_fee_origin_incl_pu' },
        note: '⚠️ 較低信心：依 "(INCL P/U)" 語意對應 handling_fee_origin_incl_pu，核對時請確認',
      },
      {
        target: 'thc',
        renames: { terminal_handling_charges_origin: 'terminal_handling_charge_origin' },
        removes: ['terminal_handling_charge'],
        note:
          '裸 terminal_handling_charge 在 Toll defset 無對應（只有 _origin/_destination）→ 移除；' +
          '⚠️ 公式中的 terminal_handling_charge_destination 出現在 Outbound 語意可疑，本次保留，請於核對時裁決（FIX-130 §3）',
      },
      {
        target: 'all_in_rate',
        renames: {
          handling_fee_origin_incl_p_u: 'handling_fee_origin_incl_pu',
          origin_chage_incl_pick_up: 'origin_charge_incl_pick_up',
        },
        note: 'p_u→pu、chage→charge 拼字修正',
      },
    ],
  },
  {
    mapping: 'Nippon Express Logistics - Logistics Cost - Inbound Template (Full List)',
    company: 'Nippon Express Logistics',
    rules: [
      {
        target: 'car_park_fee',
        renames: { o_gate_i_o_or_parking_chg: 'o_gate_io_or_parking_chg' },
        note: 'I&O 縮寫的底線差異（實際 key 為 io 連寫）',
      },
    ],
  },
  {
    mapping: 'Nippon Express Logistics (Nippon Express) - Logistics Cost - Inbound Template (Full List)',
    company: 'NIPPON EXPRESS (HK) CO., LTD.（NIPPON EXPRESS）',
    rules: [
      {
        target: 'terminal_fees_at_origin',
        removes: ['terminal_handling_charge'],
        note: '該公司 defset（6 keys）無此 key，THC 由 thc 承接（其 label "T.H.C"）→ 移除死項',
      },
    ],
  },
]

/**
 * REPORT_ONLY：死 key 無法從留存資料確定對應（該公司 defset 現值未取得）。
 * dryrun / write 都只列出規則現值 + 該公司 defset key 清單，不做任何修改。
 */
const REPORT_ONLY = [
  {
    mapping: 'CEVA - inport to logistics template mapping (Full List)',
    company: 'CEVA LOGISTICS (HONG KONG) LTD',
    deadKeys: ['freight_charges'],
    target: 'freight',
  },
  {
    mapping: 'DSV Air & Sea Ltd. - Logistics Cost - Outbound Template (Full List)',
    company: 'DSV Air & Sea Ltd.',
    deadKeys: ['b_l_bill_of_lading'],
    target: 'document_fee',
  },
  {
    mapping: 'Redlines Shipping & Logistics - Logistics Cost - Outbound Template (Full List)',
    company: 'Redlines Shipping & Logistics',
    deadKeys: ['b_l_charges'],
    target: 'document_fee',
  },
]

/**
 * 欄位定義集 aliases 補齊（FIX-130 §1，依真實文件原文）。
 * 以 company name + scope=COMPANY 定位欄位集，逐 key 合併 aliases（不重複、不覆蓋既有）。
 */
const ALIAS_ADDITIONS = [
  {
    company: 'RICOH INTERNATIONAL LOGISTICS (HK) LTD.',
    additions: {
      air_delivery_order_dest: ['(AIR) DELIVERY ORDER CHARGE DEST CHARGE', '(AIR) DELIVERY ORDER CHARGE'],
      sea_thc: ['(SEA) THC (DEST)'],
      air_pick_up_charge_origin: ['(AIR) PICK UP CHARGE ORIGIN CHARGE'],
    },
  },
]

/**
 * CEVA 過泛 alias 修正（FIX-130 §1 尾）：origin THC 的無方向 alias 曾致跨方向誤配
 * （FIX-126 已在代碼層以方向閘擋掉，此處清理資料層錯置 + 給 destination 行正確去處）。
 * 執行時先驗證 Azure 現值確實如此（本地曾核實，Azure 需查核）；key 不存在則跳過報告。
 */
const CEVA_ALIAS_FIX = {
  company: 'CEVA LOGISTICS (HONG KONG) LTD',
  removeAlias: { key: 'origin_thc_terminal_handling_charge', alias: 'Terminal Handling Charge' },
  addAlias: { key: 'destination_thc_terminal_handling_charge', aliases: ['Terminal Handling Charge at Destination'] },
}

/** FIX-130 §3：刻意不改的公式（FIX-127 已解翻倍根因），列出供人工裁決 */
const SECTION3_REVIEW = [
  { mapping: 'SBS INTERNATIONAL LOGISTICS  - Logistics Cost - Inbound Template (Full List)', target: 'thc' },
  { mapping: 'Toll Global Forwarder Limited - Logistics Cost - Inbound Template (Full List)', target: 'docs_fee' },
  { mapping: 'Toll Global Forwarder Limited - Logistics Cost - Outbound Template (Full List)', target: 'thc' },
]

// ============================================================
// 公式處理（僅純 {key} 加總形式；其他一律跳過）
// ============================================================

/** 解析公式為 key 陣列；非「純 {key} + {key}」形式回傳 null（保守跳過） */
function parseAdditiveFormula(formula) {
  if (typeof formula !== 'string' || formula.trim() === '') return null
  const rest = formula.replace(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, '')
  if (/[^+\s]/.test(rest)) return null
  const tokens = formula.match(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g) || []
  return tokens.map((t) => t.slice(1, -1))
}

/** 應用 renames / removes 並去重（保序）；回傳新 key 陣列 */
function transformKeys(keys, renames, removes) {
  const removeSet = new Set(removes || [])
  const out = []
  for (const k of keys) {
    if (removeSet.has(k)) continue
    const next = (renames && renames[k]) || k
    if (!out.includes(next)) out.push(next)
  }
  return out
}

// ============================================================
// 主流程
// ============================================================

async function loadDefsetKeys(client, companyName) {
  const res = await client.query(
    `select f.id, f.name, f.fields
       from field_definition_sets f
       join companies c on c.id = f.company_id
      where f.scope = 'COMPANY' and c.name = $1`,
    [companyName]
  )
  const keys = new Set()
  for (const row of res.rows) {
    const fields = Array.isArray(row.fields) ? row.fields : []
    for (const f of fields) if (f && f.key) keys.add(f.key)
  }
  return { keys, sets: res.rows }
}

async function main() {
  const mode = (process.env.RUN_CONFIG_CORRECTIONS || '').toLowerCase()
  if (mode !== 'dryrun' && mode !== 'write') {
    console.log('RUN_CONFIG_CORRECTIONS 未設為 dryrun|write，不執行。')
    return
  }
  const write = mode === 'write'
  console.log(`=== FIX-130 存量設定修正（${write ? 'WRITE 寫入' : 'DRYRUN 只讀'}）===`)

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveSsl(),
    connectionTimeoutMillis: 20000,
  })
  await client.connect()

  let applied = 0
  let skipped = 0

  try {
    if (write) await client.query('BEGIN')

    // ---------- A. mapping 死 key 修正 ----------
    console.log('\n===== A. mapping 公式死 key 修正 =====')
    for (const fix of MAPPING_FIXES) {
      const res = await client.query(
        `select m.id, m.name, m.mappings, c.name as company_name
           from template_field_mappings m
           left join companies c on c.id = m.company_id
          where m.name = $1`,
        [fix.mapping]
      )
      if (res.rows.length !== 1) {
        console.log(`\n⚠️  [跳過] mapping「${fix.mapping}」找到 ${res.rows.length} 筆（預期 1）`)
        skipped += fix.rules.length
        continue
      }
      const row = res.rows[0]
      if (row.company_name !== fix.company) {
        console.log(`\n⚠️  [跳過] 「${fix.mapping}」公司=「${row.company_name}」與預期「${fix.company}」不符`)
        skipped += fix.rules.length
        continue
      }
      const { keys: defsetKeys } = await loadDefsetKeys(client, fix.company)
      const rules = Array.isArray(row.mappings) ? row.mappings : []
      let changed = false
      console.log(`\n■ ${fix.mapping}（公司=${row.company_name}，defset keys=${defsetKeys.size}）`)

      for (const ruleFix of fix.rules) {
        const rule = rules.find((r) => r && r.targetField === ruleFix.target)
        if (!rule) {
          console.log(`  ⚠️ [跳過] 找不到 targetField=${ruleFix.target} 的規則`)
          skipped++
          continue
        }
        // rename 目標 key 必須存在於 defset
        const badTargets = Object.values(ruleFix.renames || {}).filter((k) => !defsetKeys.has(k))
        if (badTargets.length > 0) {
          console.log(`  ⚠️ [跳過] ${ruleFix.target}：rename 目標 key 不在 defset：${badTargets.join(', ')}`)
          skipped++
          continue
        }

        if (rule.transformType === 'DIRECT') {
          const from = Object.keys(ruleFix.renames || {})
          if (from.length !== 1 || (ruleFix.removes || []).length > 0) {
            console.log(`  ⚠️ [跳過] ${ruleFix.target}：DIRECT 規則僅支援單一 rename`)
            skipped++
            continue
          }
          if (rule.sourceField !== from[0]) {
            console.log(
              `  ⚠️ [跳過] ${ruleFix.target}：sourceField 現值「${rule.sourceField}」≠ 預期死 key「${from[0]}」`
            )
            skipped++
            continue
          }
          const to = ruleFix.renames[from[0]]
          console.log(`  ✏️  ${ruleFix.target} [DIRECT] sourceField: ${rule.sourceField} → ${to}`)
          if (ruleFix.note) console.log(`      note: ${ruleFix.note}`)
          rule.sourceField = to
          changed = true
          applied++
        } else if (rule.transformType === 'FORMULA') {
          const formula = rule.transformParams && rule.transformParams.formula
          const keys = parseAdditiveFormula(formula)
          if (!keys) {
            console.log(`  ⚠️ [跳過] ${ruleFix.target}：公式非純加總形式，不自動修改：${formula}`)
            skipped++
            continue
          }
          const deadInFormula = [
            ...Object.keys(ruleFix.renames || {}),
            ...(ruleFix.removes || []),
          ].filter((k) => keys.includes(k))
          if (deadInFormula.length === 0) {
            console.log(`  ⚠️ [跳過] ${ruleFix.target}：公式現值不含預期死 key（可能已修過）：${formula}`)
            skipped++
            continue
          }
          const newKeys = transformKeys(keys, ruleFix.renames, ruleFix.removes)
          if (newKeys.length === 0) {
            console.log(`  ⚠️ [跳過] ${ruleFix.target}：修正後公式為空，不動`)
            skipped++
            continue
          }
          const newFormula = newKeys.map((k) => `{${k}}`).join(' + ')
          console.log(`  ✏️  ${ruleFix.target} [FORMULA]`)
          console.log(`      before: ${formula}`)
          console.log(`      after : ${newFormula}`)
          if (ruleFix.note) console.log(`      note: ${ruleFix.note}`)
          rule.transformParams = { ...rule.transformParams, formula: newFormula }
          // sourceField 若也是死 key，一併對齊
          if (ruleFix.renames && ruleFix.renames[rule.sourceField]) {
            console.log(`      sourceField: ${rule.sourceField} → ${ruleFix.renames[rule.sourceField]}`)
            rule.sourceField = ruleFix.renames[rule.sourceField]
          } else if ((ruleFix.removes || []).includes(rule.sourceField)) {
            console.log(`      sourceField: ${rule.sourceField} → ${newKeys[0]}（原值為被移除的死 key）`)
            rule.sourceField = newKeys[0]
          }
          changed = true
          applied++
        } else {
          console.log(`  ⚠️ [跳過] ${ruleFix.target}：transformType=${rule.transformType} 不支援`)
          skipped++
        }
      }

      if (changed && write) {
        await client.query(
          `update template_field_mappings set mappings = $1, updated_at = now() where id = $2`,
          [JSON.stringify(rules), row.id]
        )
        console.log(`  💾 已寫入 mapping ${row.id}`)
      }
    }

    // ---------- B. aliases 補齊 ----------
    console.log('\n===== B. 欄位定義集 aliases 補齊 =====')
    for (const item of ALIAS_ADDITIONS) {
      const { sets } = await loadDefsetKeys(client, item.company)
      if (sets.length === 0) {
        console.log(`⚠️  [跳過] 公司「${item.company}」無 COMPANY scope 欄位定義集`)
        skipped += Object.keys(item.additions).length
        continue
      }
      for (const set of sets) {
        const fields = Array.isArray(set.fields) ? set.fields : []
        let changed = false
        console.log(`\n■ ${set.name}（公司=${item.company}）`)
        for (const [key, add] of Object.entries(item.additions)) {
          const field = fields.find((f) => f && f.key === key)
          if (!field) {
            console.log(`  ⚠️ [跳過] 欄位 key=${key} 不存在於此欄位集`)
            continue
          }
          const existing = Array.isArray(field.aliases) ? field.aliases : []
          const toAdd = add.filter((a) => !existing.includes(a))
          if (toAdd.length === 0) {
            console.log(`  ✓ ${key}：aliases 已含全部建議值，無需變更`)
            continue
          }
          console.log(`  ✏️  ${key}: aliases ${JSON.stringify(existing)} → ${JSON.stringify([...existing, ...toAdd])}`)
          field.aliases = [...existing, ...toAdd]
          changed = true
          applied++
        }
        if (changed && write) {
          await client.query(`update field_definition_sets set fields = $1, updated_at = now() where id = $2`, [
            JSON.stringify(fields),
            set.id,
          ])
          console.log(`  💾 已寫入欄位集 ${set.id}`)
        }
      }
    }

    // ---------- C. CEVA 過泛 alias 修正 ----------
    console.log('\n===== C. CEVA 過泛 alias 修正（origin THC 無方向 alias）=====')
    {
      const { sets } = await loadDefsetKeys(client, CEVA_ALIAS_FIX.company)
      if (sets.length === 0) {
        console.log(`⚠️  [跳過] 公司「${CEVA_ALIAS_FIX.company}」無 COMPANY scope 欄位定義集`)
        skipped++
      }
      for (const set of sets) {
        const fields = Array.isArray(set.fields) ? set.fields : []
        let changed = false
        console.log(`\n■ ${set.name}`)
        const rm = CEVA_ALIAS_FIX.removeAlias
        const rmField = fields.find((f) => f && f.key === rm.key)
        if (!rmField) {
          console.log(`  ⚠️ [跳過] 欄位 key=${rm.key} 不存在於此欄位集`)
        } else {
          const existing = Array.isArray(rmField.aliases) ? rmField.aliases : []
          if (!existing.includes(rm.alias)) {
            console.log(`  ✓ ${rm.key}：aliases 現值 ${JSON.stringify(existing)} 不含「${rm.alias}」，無需移除`)
          } else {
            console.log(`  ✏️  ${rm.key}: 移除無方向 alias「${rm.alias}」（曾致跨方向誤配，見 FIX-126）`)
            rmField.aliases = existing.filter((a) => a !== rm.alias)
            changed = true
            applied++
          }
        }
        const ad = CEVA_ALIAS_FIX.addAlias
        const adField = fields.find((f) => f && f.key === ad.key)
        if (!adField) {
          console.log(`  ⚠️ [跳過] 欄位 key=${ad.key} 不存在於此欄位集（destination 行將維持「寧可不填」）`)
        } else {
          const existing = Array.isArray(adField.aliases) ? adField.aliases : []
          const toAdd = ad.aliases.filter((a) => !existing.includes(a))
          if (toAdd.length === 0) {
            console.log(`  ✓ ${ad.key}：aliases 已含建議值`)
          } else {
            console.log(`  ✏️  ${ad.key}: aliases 加入 ${JSON.stringify(toAdd)}`)
            adField.aliases = [...existing, ...toAdd]
            changed = true
            applied++
          }
        }
        if (changed && write) {
          await client.query(`update field_definition_sets set fields = $1, updated_at = now() where id = $2`, [
            JSON.stringify(fields),
            set.id,
          ])
          console.log(`  💾 已寫入欄位集 ${set.id}`)
        }
      }
    }

    // ---------- D. REPORT_ONLY（需使用者決定）----------
    console.log('\n===== D. 死 key 無法自動判定（NEEDS_DECISION，僅報告）=====')
    for (const item of REPORT_ONLY) {
      const res = await client.query(
        `select m.id, m.mappings, c.name as company_name
           from template_field_mappings m
           left join companies c on c.id = m.company_id
          where m.name = $1`,
        [item.mapping]
      )
      console.log(`\n■ ${item.mapping}`)
      if (res.rows.length !== 1) {
        console.log(`  ⚠️ 找到 ${res.rows.length} 筆（預期 1）`)
        continue
      }
      const rules = Array.isArray(res.rows[0].mappings) ? res.rows[0].mappings : []
      const rule = rules.find((r) => r && r.targetField === item.target)
      if (rule) {
        console.log(`  規則現值: ${item.target} ← ${rule.sourceField} [${rule.transformType}]`)
        if (rule.transformParams && rule.transformParams.formula) {
          console.log(`  公式: ${rule.transformParams.formula}`)
        }
      }
      console.log(`  死 key: ${item.deadKeys.join(', ')}`)
      const { keys } = await loadDefsetKeys(client, item.company)
      console.log(`  該公司 defset keys（${keys.size}）: ${[...keys].sort().join(', ') || '（無）'}`)
      console.log(`  → 請使用者決定對應後，將修正加入 MAPPING_FIXES 再跑一次`)
    }

    // ---------- E. §3 公式多來源項（刻意不改，列出裁決）----------
    console.log('\n===== E. FIX-130 §3 公式多來源項（FIX-127 已解翻倍根因，本腳本不改）=====')
    for (const item of SECTION3_REVIEW) {
      const res = await client.query(`select mappings from template_field_mappings where name = $1`, [item.mapping])
      if (res.rows.length !== 1) continue
      const rules = Array.isArray(res.rows[0].mappings) ? res.rows[0].mappings : []
      const rule = rules.find((r) => r && r.targetField === item.target)
      if (rule && rule.transformParams && rule.transformParams.formula) {
        console.log(`  ${item.mapping} :: ${item.target} = ${rule.transformParams.formula}`)
      }
    }
    console.log('  → 若使用者裁決要刪多餘項，另行加入 MAPPING_FIXES（removes）')

    if (write) {
      await client.query('COMMIT')
      console.log(`\n✅ WRITE 完成：套用 ${applied} 筆修正、跳過 ${skipped} 筆`)
    } else {
      console.log(`\n✅ DRYRUN 完成：可套用 ${applied} 筆修正、跳過 ${skipped} 筆（未寫入）`)
    }
  } catch (e) {
    if (write) {
      try {
        await client.query('ROLLBACK')
        console.error('❌ 發生錯誤，已 ROLLBACK')
      } catch {}
    }
    throw e
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('ERR ' + (e && e.message ? e.message : e))
  process.exit(1)
})
