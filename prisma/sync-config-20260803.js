/**
 * @fileoverview 2026-08-03 設定同步：把僅存在於本機的設定變更套用到目標環境（三模式 gated）
 * @description
 *   `a1eba1e`（線上映像 `dev-fix147r3`）到 `52d2184` 之間累積的變更中，有一部分
 *   **不隨映像走** —— 它們是資料庫裡的設定。程式碼上線不會改變這些行為，必須另外套用。
 *
 *   為何不能直接搬 `scripts/` 下的原始腳本：
 *     1. runner 映像不含 `scripts/` 與 tsx（見 memory feedback_azure_runner_excludes_scripts_tsx）
 *     2. 那些腳本寫死**本地主鍵**（公司 / 模板 / 欄位集 id 各環境獨立產生）
 *   因此改以**名稱 / code / 內容錨點**查找，並放在 `prisma/`（Dockerfile 整包 COPY）。
 *
 *   五個步驟（各自獨立，任一前置缺失只跳過該步、不影響其他步）：
 *     1. FIX-154 — GLOBAL Stage 3 prompt 移除 description 幣別註記
 *     2. FIX-156 — DHL COMPANY prompt 補上 subtotal 定義
 *     3. FIX-158 一 — RIL（SBS）`handling_at_origin` 改 FORMULA，兩個 key 都接
 *     4. FIX-158 二 — CEVA LTD 欄位定義集補 4 個欄位
 *     5. CHANGE-115 — LLM 型錄（provider / model / stage 指派）切到 gpt-5.6-luna
 *
 *   模式（`RUN_CONFIG_SYNC_20260803`）：
 *     inspect — 唯讀，只印目標環境現況
 *     dryrun  — 印每一步「將要改什麼」，不寫入
 *     write   — 實際寫入（冪等，已達目標狀態則 0 筆）
 *
 *   🔴 **容器內沒有可保留的檔案系統**，因此不寫快照檔，改為在寫入前把**變更前的值
 *   完整印進 log** —— Log Analytics 的 `AppServiceConsoleLogs` 即是還原依據
 *   （本專案這幾張表都沒有版本歷史 / rollback）。
 *
 *   🔴 **不含 FIX-150**（VAT 獨立成欄、NEHK bl_fee alias 收窄）。兩個原因：
 *     (a) CLAUDE.md §不可逆資料操作紀律要求改 mapping 前後各跑一次
 *         `scripts/check-orphan-charge-keys.js` + `scripts/snapshot-template-values.js`
 *         對帳，而該目錄不在 runner 映像內 —— 安全網無法執行
 *     (b) FIX-150 本身狀態為 🚧 進行中（待重新匹配實例驗收）
 *
 * @module prisma/sync-config-20260803
 * @since 2026-08-03 Azure DEV 同步批次
 * @lastModified 2026-08-03
 */
const { Client } = require('pg')

const MODE = process.env.RUN_CONFIG_SYNC_20260803
const VALID_MODES = ['inspect', 'dryrun', 'write']

// ============================================================================
// 步驟 1：FIX-154 — GLOBAL Stage 3 prompt 的 Currency Rule
// ============================================================================

/**
 * 完整比對原句，找不到即跳過 —— 內容可能已被改過，不盲目套用。
 * 以「內容含有此句」為選取條件，比對照本地主鍵可靠（各環境 id 不同）。
 */
const F154_OLD =
  '- If a given line has no HKD amount, then fall back to the original-currency amount and note the original currency in the "description".'
const F154_NEW =
  '- If a given line has no HKD amount, then fall back to the original-currency amount.'

// ============================================================================
// 步驟 2：FIX-156 — DHL COMPANY prompt 的 subtotal 定義
// ============================================================================

/** 這筆的 id 是 change113-dhl-setup.js 寫死的字面值，各環境一致 */
const F156_CONFIG_ID = 'change113-dhl-stage3-001'
const F156_SYSTEM_ANCHOR = '## General'
const F156_SYSTEM_ADDITION = `## Amount summary

- subtotal: the sum of ALL charges you emitted as line items, including fuel
  surcharges, before tax. It must equal the total of your lineItems[].amount.
- The instruction to ignore "Service Sub Total" applies to LINE ITEMS only. It does
  not mean fields.subtotal should be left empty, nor computed from a subset of the
  charges (for example freight without fuel surcharge).

`
const F156_MARKER = '## Amount summary'
const F156_USER_OLD =
  '1. Invoice basics: invoice number, invoice date, currency, total amount'
const F156_USER_NEW =
  '1. Invoice basics: invoice number, invoice date, currency, subtotal, total amount'

// ============================================================================
// 步驟 3：FIX-158 一 — RIL（SBS）handling_at_origin 雙 key
// ============================================================================

const F158A_MAPPING_NAME_LIKE = '%SBS INTERNATIONAL LOGISTICS%'
const F158A_TEMPLATE_NAME_LIKE = '%Inbound%'
const F158A_TARGET_FIELD = 'handling_at_origin'
const F158A_FORMULA =
  '{air_local_charge_usa_origin} + {air_local_charge_in_usa_origin_charge}'

// ============================================================================
// 步驟 4：FIX-158 二 — CEVA LTD 欄位定義集
// ============================================================================

const F158B_COMPANY_NAME = 'CEVA LOGISTICS (HONG KONG) LTD'

/**
 * 四個欄位。aliases 依「X at Destination」書寫模式推導 ——
 * `destination_gate_fee` 與 `destination_truck_servicing_fee` 全庫無實例，
 * 依據較弱（已記入 known-discrepancies.md 第 13 條）。
 */
const F158B_FIELDS = [
  {
    key: 'destination_truck_servicing_fee',
    label: 'Destination Truck Servicing Fee',
    aliases: ['Truck Servicing Fee at Destination'],
    category: 'charges',
    dataType: 'currency',
    required: false,
    fieldType: 'lineItem',
  },
  {
    key: 'emergency_fuel_surcharge',
    label: 'Emergency Fuel Surcharge',
    aliases: ['EBS', 'Emergency Bunker Surcharge', 'Emergency Fuel Surcharge at Destination'],
    category: 'charges',
    dataType: 'currency',
    required: false,
    fieldType: 'lineItem',
  },
  {
    key: 'destination_gate_fee',
    label: 'Destination Gate Fee',
    aliases: ['Gate Fee at Destination', 'Gate Charge at Destination', 'Gate Charge'],
    category: 'charges',
    dataType: 'currency',
    required: false,
    fieldType: 'lineItem',
  },
  {
    key: 'destination_cfs_charges',
    label: 'Destination CFS Charges',
    aliases: [
      'CFS Charges at Destination',
      'CFS Charges',
      'Container Freight Station Charge at Destination',
    ],
    category: 'charges',
    dataType: 'currency',
    required: false,
    fieldType: 'lineItem',
  },
]

// ============================================================================
// 步驟 5：CHANGE-115 — LLM 型錄
// ============================================================================

const C115_PROVIDER_NAME = 'Azure OpenAI (default)'
const C115_API_VERSION = '2024-12-01-preview'
const C115_MODEL_KEY = 'gpt-5.6-luna'
const C115_MODEL_LABEL = 'GPT-5.6 Luna（單一主力）'
/** 與 src/lib/constants/llm-models.ts 的 capability + buildCapability() 逐項對齊 */
const C115_CAPABILITY = {
  maxTokens: 8192,
  supportsTemperature: false,
  defaultImageDetail: 'auto',
  supportsJsonSchema: true,
  supportsVision: true,
  deploymentEnvVar: 'AZURE_OPENAI_LUNA_DEPLOYMENT_NAME',
  defaultDeploymentName: 'gpt-5.6-luna',
}
const C115_STAGE_KEYS = [
  'extraction.model.stage1',
  'extraction.model.stage2',
  'extraction.model.stage3',
]

// ============================================================================
// 共用
// ============================================================================

const log = (s) => console.log(`[config-sync] ${s}`)
const sub = (s) => console.log(`[config-sync]     ${s}`)

/** 印出變更前的值 —— 容器無持久檔案系統，log 即是唯一還原依據 */
function printBefore(label, value) {
  console.log(`[config-sync] === 變更前（還原依據）：${label} ===`)
  console.log(
    typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  )
  console.log('[config-sync] === 變更前結束 ===')
}

/** 數量閘：非預期列數即拋錯，讓交易回滾 */
function gate(rowCount, expected, what) {
  if (rowCount !== expected) {
    throw new Error(
      `數量閘失敗（${what}）：影響 ${rowCount} 列，預期 ${expected} —— 交易回滾`
    )
  }
}

// ============================================================================
// 步驟 1：FIX-154
// ============================================================================

async function step1(client) {
  log('步驟 1/5 — FIX-154：GLOBAL Stage 3 prompt 的幣別註記')

  const { rows } = await client.query(
    `SELECT id, name, prompt_type::text AS prompt_type, version, updated_at
       FROM prompt_configs
      WHERE scope::text = 'GLOBAL'
        AND is_active = true
        AND system_prompt LIKE '%' || $1 || '%'`,
    [F154_OLD]
  )

  if (rows.length === 0) {
    sub('沒有任何 GLOBAL prompt 含該原句 —— 已是目標狀態或內容已改，跳過')
    return { changed: 0 }
  }
  sub(`命中 ${rows.length} 筆：`)
  for (const r of rows) {
    sub(`  ${r.id}  ${r.name}  (${r.prompt_type}, v${r.version})`)
  }

  if (MODE === 'inspect') return { changed: 0 }

  if (MODE === 'dryrun') {
    sub('將把該句替換為（移除 description 註記要求）：')
    sub(`  ${F154_NEW}`)
    return { changed: 0 }
  }

  let changed = 0
  for (const r of rows) {
    const { rows: cur } = await client.query(
      'SELECT system_prompt FROM prompt_configs WHERE id = $1',
      [r.id]
    )
    printBefore(`prompt_configs ${r.id} system_prompt`, cur[0].system_prompt)

    await client.query('BEGIN')
    try {
      const res = await client.query(
        `UPDATE prompt_configs
            SET system_prompt = replace(system_prompt, $1, $2),
                version = version + 1,
                updated_at = NOW()
          WHERE id = $3 AND updated_at = $4`,
        [F154_OLD, F154_NEW, r.id, r.updated_at]
      )
      gate(res.rowCount, 1, `FIX-154 ${r.id}`)
      await client.query('COMMIT')
      changed++
      sub(`  ✅ ${r.id} 已更新（v${r.version} → v${r.version + 1}）`)
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    }
  }
  return { changed }
}

// ============================================================================
// 步驟 2：FIX-156
// ============================================================================

async function step2(client) {
  log('步驟 2/5 — FIX-156：DHL COMPANY prompt 的 subtotal 定義')

  const { rows } = await client.query(
    `SELECT p.id, p.name, p.scope::text AS scope, p.merge_strategy::text AS merge_strategy,
            p.version, p.updated_at, p.system_prompt, p.user_prompt_template,
            c.name AS company_name, c.code AS company_code
       FROM prompt_configs p
       LEFT JOIN companies c ON c.id = p.company_id
      WHERE p.id = $1`,
    [F156_CONFIG_ID]
  )

  if (rows.length === 0) {
    sub(`找不到 prompt config ${F156_CONFIG_ID} —— 該環境未套用 CHANGE-113，跳過`)
    return { changed: 0 }
  }

  const cfg = rows[0]
  sub(`${cfg.id}  ${cfg.name}`)
  sub(`  scope=${cfg.scope}  mergeStrategy=${cfg.merge_strategy}  v${cfg.version}`)
  sub(`  公司：${cfg.company_name ?? '(無)'}  code=${cfg.company_code ?? '-'}`)

  // 身分驗證：確認是掛在 DHL 的那一筆，而非被改掛到其他公司
  if (cfg.scope !== 'COMPANY') {
    sub(`  🔴 scope 為 ${cfg.scope}（預期 COMPANY）—— 跳過，需人工確認`)
    return { changed: 0 }
  }
  if (cfg.company_code !== 'DHL') {
    sub(`  🔴 公司 code 為 ${cfg.company_code}（預期 DHL）—— 跳過，需人工確認`)
    return { changed: 0 }
  }

  const curSystem = cfg.system_prompt ?? ''
  const curUser = cfg.user_prompt_template ?? ''

  if (curSystem.includes(F156_MARKER)) {
    sub('  已含 Amount summary 段落 —— 已是目標狀態，跳過')
    return { changed: 0 }
  }

  // 字串層數量閘：兩個錨點各須恰好一次
  const anchorCount = curSystem.split(F156_SYSTEM_ANCHOR).length - 1
  if (anchorCount !== 1) {
    sub(`  🔴 systemPrompt 錨點 "${F156_SYSTEM_ANCHOR}" 出現 ${anchorCount} 次（預期 1）—— 跳過`)
    return { changed: 0 }
  }
  const userCount = curUser.split(F156_USER_OLD).length - 1
  if (userCount !== 1) {
    sub(`  🔴 userPromptTemplate 原句出現 ${userCount} 次（預期 1）—— 跳過`)
    return { changed: 0 }
  }

  const newSystem = curSystem.replace(
    F156_SYSTEM_ANCHOR,
    F156_SYSTEM_ADDITION + F156_SYSTEM_ANCHOR
  )
  const newUser = curUser.replace(F156_USER_OLD, F156_USER_NEW)

  if (MODE === 'inspect') return { changed: 0 }

  sub(`  將於 "${F156_SYSTEM_ANCHOR}" 前插入 Amount summary（${curSystem.length} → ${newSystem.length} 字元）`)
  sub(`  userPromptTemplate 補上 subtotal`)
  if (MODE === 'dryrun') return { changed: 0 }

  printBefore(`prompt_configs ${cfg.id} system_prompt`, curSystem)
  printBefore(`prompt_configs ${cfg.id} user_prompt_template`, curUser)

  await client.query('BEGIN')
  try {
    const res = await client.query(
      `UPDATE prompt_configs
          SET system_prompt = $1, user_prompt_template = $2,
              version = version + 1, updated_at = NOW()
        WHERE id = $3 AND updated_at = $4`,
      [newSystem, newUser, cfg.id, cfg.updated_at]
    )
    gate(res.rowCount, 1, 'FIX-156')
    await client.query('COMMIT')
    sub(`  ✅ 已更新（v${cfg.version} → v${cfg.version + 1}）`)
    return { changed: 1 }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  }
}

// ============================================================================
// 步驟 3：FIX-158 一
// ============================================================================

async function step3(client) {
  log('步驟 3/5 — FIX-158 一：RIL（SBS）handling_at_origin 雙 key FORMULA')

  const { rows } = await client.query(
    `SELECT m.id, m.name, m.mappings, m.updated_at, t.name AS template_name
       FROM template_field_mappings m
       JOIN data_templates t ON t.id = m.data_template_id
      WHERE m.is_active = true
        AND m.name LIKE $1
        AND t.name LIKE $2`,
    [F158A_MAPPING_NAME_LIKE, F158A_TEMPLATE_NAME_LIKE]
  )

  if (rows.length === 0) {
    sub('找不到 SBS INTERNATIONAL LOGISTICS 的 Inbound 映射 —— 跳過')
    return { changed: 0 }
  }
  if (rows.length > 1) {
    sub(`🔴 命中 ${rows.length} 筆映射（預期 1）—— 跳過，需人工確認：`)
    for (const r of rows) sub(`  ${r.id}  ${r.name}`)
    return { changed: 0 }
  }

  const m = rows[0]
  const mappings = Array.isArray(m.mappings) ? m.mappings : []
  sub(`${m.id}  ${m.name}`)
  sub(`  模板：${m.template_name}   規則數 ${mappings.length}`)

  const idx = mappings.findIndex((r) => r && r.targetField === F158A_TARGET_FIELD)
  if (idx === -1) {
    sub(`  找不到 targetField=${F158A_TARGET_FIELD} 的規則 —— 跳過`)
    return { changed: 0 }
  }

  const rule = mappings[idx]
  sub(`  現況：[${rule.transformType}] ${rule.sourceField}` +
      (rule.transformParams && rule.transformParams.formula
        ? ` formula=${rule.transformParams.formula}`
        : ''))

  const already =
    rule.transformType === 'FORMULA' &&
    rule.transformParams &&
    rule.transformParams.formula === F158A_FORMULA
  if (already) {
    sub('  已是目標狀態，跳過')
    return { changed: 0 }
  }

  if (MODE === 'inspect') return { changed: 0 }

  sub(`  將改為：[FORMULA] ${F158A_FORMULA}`)
  sub('  （只增加可接受的來源 key，不移除任何 key —— 不會讓既有費用失去去處）')
  if (MODE === 'dryrun') return { changed: 0 }

  printBefore(`template_field_mappings ${m.id} 規則 ${rule.id}`, rule)

  const next = mappings.slice()
  next[idx] = Object.assign({}, rule, {
    transformType: 'FORMULA',
    transformParams: Object.assign({}, rule.transformParams || {}, {
      formula: F158A_FORMULA,
    }),
  })

  await client.query('BEGIN')
  try {
    const res = await client.query(
      `UPDATE template_field_mappings
          SET mappings = $1::jsonb, updated_at = NOW()
        WHERE id = $2 AND updated_at = $3`,
      [JSON.stringify(next), m.id, m.updated_at]
    )
    gate(res.rowCount, 1, 'FIX-158 一')
    await client.query('COMMIT')
    sub('  ✅ 已更新')
    return { changed: 1 }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  }
}

// ============================================================================
// 步驟 4：FIX-158 二
// ============================================================================

async function step4(client) {
  log('步驟 4/5 — FIX-158 二：CEVA LTD 欄位定義集補 4 個欄位')

  const { rows } = await client.query(
    `SELECT s.id, s.name, s.fields, s.version, s.updated_at, c.name AS company_name
       FROM field_definition_sets s
       JOIN companies c ON c.id = s.company_id
      WHERE c.name = $1`,
    [F158B_COMPANY_NAME]
  )

  if (rows.length === 0) {
    sub(`找不到公司「${F158B_COMPANY_NAME}」的欄位定義集 —— 跳過`)
    sub('（該環境的 CEVA 公司命名可能不同，需人工確認後另行處理）')
    return { changed: 0 }
  }
  if (rows.length > 1) {
    sub(`🔴 命中 ${rows.length} 個欄位集（預期 1）—— 跳過，需人工確認`)
    return { changed: 0 }
  }

  const s = rows[0]
  const fields = Array.isArray(s.fields) ? s.fields : []
  sub(`${s.id}  ${s.name}   現有 ${fields.length} 欄`)

  const byKey = new Map(fields.map((f) => [f && f.key, f]))

  /**
   * 🔴 冪等判斷必須看 aliases，不能只看 key 是否存在。
   *
   *   2026-08-03 inspect 實測：Azure 早就有這四個欄位定義（本地反而缺，是
   *   CHANGE-108 那次 azure-to-local 同步的殘缺），但 **aliases 全部為空**，
   *   label 也是從 key 自動衍生的 sentence case。
   *   只比對 key 會把「有欄位但沒 aliases」誤判為已達目標狀態 ——
   *   而 aliases 正是 FIX-158 要補的東西（沒有它模型只能靠 label 猜）。
   *
   *   合併策略：**只增不減**。既有 aliases 一律保留，只補上缺的；
   *   label 不動（各環境可能有各自的顯示慣例，且非比對依據）。
   */
  const toAdd = [] //  欄位不存在 → 整筆新增
  const toMerge = [] // 欄位存在但 aliases 缺 → 只補 aliases

  for (const want of F158B_FIELDS) {
    const cur = byKey.get(want.key)
    if (!cur) {
      toAdd.push(want)
      sub(`  待新增   ${want.key}`)
      continue
    }
    const curAliases = Array.isArray(cur.aliases) ? cur.aliases : []
    const lower = new Set(curAliases.map((a) => String(a).toLowerCase()))
    const missingAliases = want.aliases.filter((a) => !lower.has(a.toLowerCase()))
    if (missingAliases.length === 0) {
      sub(`  已完備   ${want.key}  aliases=[${curAliases.join(' | ')}]`)
    } else {
      toMerge.push({ key: want.key, add: missingAliases })
      sub(`  待補別名 ${want.key}`)
      sub(`             現有 aliases=[${curAliases.join(' | ') || '(空)'}]  label="${cur.label}"`)
      sub(`             將補   [${missingAliases.join(' | ')}]`)
    }
  }

  if (toAdd.length === 0 && toMerge.length === 0) {
    sub('  四個欄位與其 aliases 皆已完備 —— 已是目標狀態，跳過')
    return { changed: 0 }
  }
  if (MODE === 'inspect') return { changed: 0 }

  sub(`  將新增 ${toAdd.length} 欄、補 ${toMerge.length} 欄的 aliases（皆為 additive，不移除任何既有值）`)
  if (MODE === 'dryrun') return { changed: 0 }

  printBefore(`field_definition_sets ${s.id} fields`, fields)

  const mergeByKey = new Map(toMerge.map((m) => [m.key, m.add]))
  const next = fields
    .map((f) => {
      const add = f && mergeByKey.get(f.key)
      if (!add) return f
      const curAliases = Array.isArray(f.aliases) ? f.aliases : []
      return Object.assign({}, f, { aliases: curAliases.concat(add) })
    })
    .concat(toAdd)
  await client.query('BEGIN')
  try {
    const res = await client.query(
      `UPDATE field_definition_sets
          SET fields = $1::jsonb, version = version + 1, updated_at = NOW()
        WHERE id = $2 AND updated_at = $3`,
      [JSON.stringify(next), s.id, s.updated_at]
    )
    gate(res.rowCount, 1, 'FIX-158 二')
    await client.query('COMMIT')
    sub(`  ✅ 新增 ${toAdd.length} 欄、補 ${toMerge.length} 欄 aliases（${fields.length} → ${next.length} 欄）`)
    return { changed: toAdd.length + toMerge.length }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  }
}

// ============================================================================
// 步驟 5：CHANGE-115
// ============================================================================

async function step5(client) {
  log('步驟 5/5 — CHANGE-115：LLM 型錄切到 gpt-5.6-luna')

  // Epic 23 三張表在部分環境不存在（需 RUN_SCHEMA_DRIFT_FIX=true 建立）
  const { rows: tbl } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('llm_providers','llm_models','stage_model_assignments')`
  )
  if (tbl.length < 3) {
    sub(`Epic 23 表只有 ${tbl.length}/3 張存在 —— 跳過`)
    sub('（需先以 RUN_SCHEMA_DRIFT_FIX=true 建立這三張表）')
    return { changed: 0 }
  }

  const { rows: provs } = await client.query(
    'SELECT id, name, base_url, api_version, updated_at FROM llm_providers WHERE name = $1',
    [C115_PROVIDER_NAME]
  )
  if (provs.length > 1) {
    sub(`找到 ${provs.length} 個 provider「${C115_PROVIDER_NAME}」（預期 0 或 1）—— 跳過，需人工確認`)
    return { changed: 0 }
  }

  const wantBaseUrl = process.env.AZURE_OPENAI_ENDPOINT || null

  /**
   * provider 不存在時建立。
   *
   *   Epic 23 三張表由 apply-schema-drift.js 建立，**建出來是空的**（essential seed
   *   不 seed 它們）。空型錄本身不會壞掉 —— `getStageModel` 找不到指派會落到
   *   `DEFAULT_STAGE_MODELS`（＝luna），行為正確；但後台 /admin/model-settings
   *   會是空的，且與本地型錄不一致。故此處補建。
   *
   *   `api_key_enc` 留空：執行期的金鑰來自 `AZURE_OPENAI_API_KEY` 環境變數
   *   （CHANGE-100 起所有模型共用同一組 endpoint + key），Story 23.2 的加密憑證
   *   路徑尚未接上。此處不寫入任何機密。
   */
  if (provs.length === 0) {
    sub(`provider「${C115_PROVIDER_NAME}」不存在（Epic 23 表剛建立、內容為空）`)
    sub(`  將建立：providerType=AZURE_OPENAI  baseUrl=${wantBaseUrl}  apiVersion=${C115_API_VERSION}`)
    sub('  （不寫入任何金鑰 —— 執行期金鑰仍取自 AZURE_OPENAI_API_KEY 環境變數）')
    if (MODE === 'inspect' || MODE === 'dryrun') return { changed: 0 }

    await client.query('BEGIN')
    try {
      const r = await client.query(
        `INSERT INTO llm_providers
           (id, name, provider_type, base_url, api_version, is_encrypted, key_version,
            is_enabled, is_default, allow_sensitive_data, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'AZURE_OPENAI', $2, $3, true, 1, true, true, false, NOW(), NOW())
         RETURNING id`,
        [C115_PROVIDER_NAME, wantBaseUrl, C115_API_VERSION]
      )
      gate(r.rowCount, 1, 'provider.create')
      const newProvId = r.rows[0].id

      const m = await client.query(
        `INSERT INTO llm_models (id, provider_id, model_key, label, capability, is_enabled, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, true, NOW(), NOW())
         RETURNING id`,
        [newProvId, C115_MODEL_KEY, C115_MODEL_LABEL, JSON.stringify(C115_CAPABILITY)]
      )
      gate(m.rowCount, 1, 'model.create')
      const newModelId = m.rows[0].id

      let n = 2
      for (const k of C115_STAGE_KEYS) {
        const a = await client.query(
          `INSERT INTO stage_model_assignments (id, stage_key, llm_model_id, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())
           ON CONFLICT (stage_key)
           DO UPDATE SET llm_model_id = EXCLUDED.llm_model_id, updated_at = NOW()`,
          [k, newModelId]
        )
        gate(a.rowCount, 1, `assignment ${k}`)
        n++
      }

      await client.query('COMMIT')
      sub(`  ✅ 已建立 provider + 模型 ${C115_MODEL_KEY} + 三個 stage 指派（共 ${n} 項）`)
      return { changed: n }
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    }
  }

  const prov = provs[0]
  sub(`provider ${prov.id}   baseUrl=${prov.base_url}`)
  sub(`  目標 baseUrl（取自本環境 AZURE_OPENAI_ENDPOINT）=${wantBaseUrl}`)

  const { rows: models } = await client.query(
    'SELECT id, model_key, label, is_enabled, updated_at FROM llm_models WHERE provider_id = $1 ORDER BY model_key',
    [prov.id]
  )
  sub(`  現有模型 ${models.length} 筆：`)
  for (const m of models) {
    sub(`    ${m.model_key}  enabled=${m.is_enabled}`)
  }

  const { rows: asg } = await client.query(
    `SELECT a.stage_key, a.llm_model_id, m.model_key
       FROM stage_model_assignments a
       LEFT JOIN llm_models m ON m.id = a.llm_model_id
      WHERE a.stage_key = ANY($1)`,
    [C115_STAGE_KEYS]
  )
  sub('  現有 stage 指派：')
  for (const k of C115_STAGE_KEYS) {
    const a = asg.find((x) => x.stage_key === k)
    sub(`    ${k} → ${a ? (a.model_key ?? '(模型不存在)') : '(未指派)'}`)
  }

  const luna = models.find((m) => m.model_key === C115_MODEL_KEY)
  const staleEnabled = models.filter(
    (m) => m.model_key !== C115_MODEL_KEY && m.is_enabled
  )
  const asgNeedsChange = C115_STAGE_KEYS.filter((k) => {
    const a = asg.find((x) => x.stage_key === k)
    return !a || a.model_key !== C115_MODEL_KEY
  })
  const baseUrlNeedsChange = wantBaseUrl !== null && prov.base_url !== wantBaseUrl

  const nothingToDo =
    luna && luna.is_enabled && staleEnabled.length === 0 &&
    asgNeedsChange.length === 0 && !baseUrlNeedsChange
  if (nothingToDo) {
    sub('  已是目標狀態，跳過')
    return { changed: 0 }
  }

  if (MODE === 'inspect') return { changed: 0 }

  sub('  待執行：')
  if (baseUrlNeedsChange) sub(`    provider.baseUrl → ${wantBaseUrl}`)
  if (!luna) sub(`    建立模型 ${C115_MODEL_KEY}`)
  else if (!luna.is_enabled) sub(`    啟用模型 ${C115_MODEL_KEY}`)
  for (const k of asgNeedsChange) sub(`    ${k} → ${C115_MODEL_KEY}`)
  for (const m of staleEnabled) sub(`    停用舊模型 ${m.model_key}`)
  if (MODE === 'dryrun') return { changed: 0 }

  printBefore('llm_providers / llm_models / stage_model_assignments', {
    provider: { id: prov.id, base_url: prov.base_url, api_version: prov.api_version },
    models: models.map((m) => ({ model_key: m.model_key, is_enabled: m.is_enabled })),
    assignments: asg.map((a) => ({ stage_key: a.stage_key, model_key: a.model_key })),
  })

  let changed = 0
  await client.query('BEGIN')
  try {
    if (baseUrlNeedsChange) {
      const r = await client.query(
        'UPDATE llm_providers SET base_url = $1, updated_at = NOW() WHERE id = $2 AND updated_at = $3',
        [wantBaseUrl, prov.id, prov.updated_at]
      )
      gate(r.rowCount, 1, 'provider.baseUrl')
      changed++
    }

    // 模型：不存在則建立，存在但停用則啟用；capability 一律對齊白名單
    let lunaId = luna ? luna.id : null
    if (!luna) {
      const r = await client.query(
        `INSERT INTO llm_models (id, provider_id, model_key, label, capability, is_enabled, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, true, NOW(), NOW())
         RETURNING id`,
        [prov.id, C115_MODEL_KEY, C115_MODEL_LABEL, JSON.stringify(C115_CAPABILITY)]
      )
      gate(r.rowCount, 1, 'model.create')
      lunaId = r.rows[0].id
      changed++
    } else {
      const r = await client.query(
        `UPDATE llm_models SET label = $1, capability = $2::jsonb, is_enabled = true, updated_at = NOW()
          WHERE id = $3 AND updated_at = $4`,
        [C115_MODEL_LABEL, JSON.stringify(C115_CAPABILITY), luna.id, luna.updated_at]
      )
      gate(r.rowCount, 1, 'model.update')
      changed++
    }

    // 指派：先指到 luna，再停用舊模型 —— 避免任何時點出現「指派指著已停用模型」
    for (const k of asgNeedsChange) {
      const r = await client.query(
        `INSERT INTO stage_model_assignments (id, stage_key, llm_model_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())
         ON CONFLICT (stage_key)
         DO UPDATE SET llm_model_id = EXCLUDED.llm_model_id, updated_at = NOW()`,
        [k, lunaId]
      )
      gate(r.rowCount, 1, `assignment ${k}`)
      changed++
    }

    for (const m of staleEnabled) {
      const r = await client.query(
        'UPDATE llm_models SET is_enabled = false, updated_at = NOW() WHERE id = $1 AND updated_at = $2',
        [m.id, m.updated_at]
      )
      gate(r.rowCount, 1, `model.disable ${m.model_key}`)
      changed++
    }

    await client.query('COMMIT')
    sub(`  ✅ 已套用 ${changed} 項`)
    return { changed }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  }
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  if (!VALID_MODES.includes(MODE)) {
    log(`skipped: mode=${MODE} not recognised (expected ${VALID_MODES.join('|')}; clear the app setting to disable)`)
    return
  }

  log(`=== 2026-08-03 設定同步 — 模式: ${MODE} ===`)
  if (MODE === 'write') {
    log('🔴 write 模式：以下 log 含變更前的完整值，是本次唯一的還原依據')
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 30000,
  })
  await client.connect()

  const steps = [step1, step2, step3, step4, step5]
  const results = []
  let failed = 0

  try {
    for (const step of steps) {
      try {
        const r = await step(client)
        results.push(r.changed)
      } catch (e) {
        failed++
        results.push('ERR')
        log(`🔴 步驟失敗（不影響其餘步驟）：${e && e.message ? e.message : e}`)
      }
      console.log('')
    }
  } finally {
    await client.end()
  }

  log(`=== 完成 — 模式 ${MODE}，各步驟變更數 [${results.join(', ')}]，失敗 ${failed} 步 ===`)
  if (MODE !== 'write') {
    log('（本模式未做任何寫入）')
  }
}

main().catch((e) => {
  console.error('[config-sync] FAILED:', e && e.message ? e.message : e)
  process.exitCode = 1
})
