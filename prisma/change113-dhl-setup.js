/**
 * @fileoverview CHANGE-113：Azure 環境的 DHL 多 shipment 設定（三模式 gated）
 * @description
 *   CHANGE-113 的程式碼隨映像上線，但**讓它真正生效的五項設定都在資料庫裡**，
 *   不隨映像走。這支腳本把那五項在目標環境冪等套上。
 *
 *   為何不能直接搬本地腳本：`scripts/change-113/*` 全部寫死**本地主鍵**
 *   （公司 / 模板 / 欄位集 / 映射的 id 各環境獨立產生），且 runner 映像不含
 *   `scripts/` 與 tsx（見 memory feedback_azure_runner_excludes_scripts_tsx）。
 *   因此改以**名稱與 code 查找**，並放在 `prisma/` 以進入映像。
 *
 *   五個步驟（各自獨立，任一前置缺失只跳過該步、不影響其他步）：
 *     1. 解析 DHL 公司（code='DHL'）
 *     2. 欄位定義集補 `fuel_surcharge`
 *     3. Stage 3 prompt（不存在則建立；存在則校正真實號碼範例）
 *     4. 模板映射：`fuel_surcharge_at_origin ← fuel_surcharge`、`freight` 改 FORMULA
 *     5. 模板 `line_item_mode` 設為 GROUP
 *
 *   模式（`RUN_CHANGE113_DHL_SETUP`）：
 *     inspect — 唯讀，只印目標環境現況
 *     dryrun  — 印每一步「將要改什麼」，不寫入
 *     write   — 實際寫入（冪等，已達目標狀態則 0 筆）
 *
 *   🔴 **容器內沒有可保留的檔案系統**，因此不寫快照檔，改為在寫入前把
 *   **變更前的值完整印進 log** —— Log Analytics 的 `AppServiceConsoleLogs`
 *   即是還原依據（本專案這幾張表都沒有版本歷史 / rollback）。
 *
 * @module prisma/change113-dhl-setup
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-30
 */
const { Client } = require('pg')

// ============================================================================
// 常數（以名稱 / code 查找，不用本地主鍵）
// ============================================================================

const MODE = process.env.RUN_CHANGE113_DHL_SETUP
const VALID_MODES = ['inspect', 'dryrun', 'write']

const COMPANY_CODE = 'DHL';
const TEMPLATE_NAME = 'Logistics Cost - Inbound Template (Full List)';

/** 步驟 2：要補進 DHL 欄位定義集的燃油欄位 */
const FUEL_FIELD = {
  key: 'fuel_surcharge',
  label: 'Fuel Surcharge',
  aliases: ['FUEL SURCHARGE', 'FUEL SURCHARGES'],
  category: 'charges',
  dataType: 'currency',
  required: false,
  fieldType: 'lineItem',
};

/** 步驟 3：DHL Stage 3 prompt（已移除真實號碼範例 —— 見下方警語） */
const PROMPT = {
  id: 'change113-dhl-stage3-001',
  name: 'DHL Express - Stage 3 (multi-shipment detail table)',
  description: 'CHANGE-113: 一份 DHL 發票對應多個 shipment，需逐列提取並記錄分組鍵',
  promptType: 'STAGE_3_FIELD_EXTRACTION',
  scope: 'COMPANY',
  // 🔴 這段刻意不含任何真實參考號碼。實測（2026-07-29）prompt 一旦提供合法格式的
  // 真實號碼當範例，GPT 會**複製範例**而非讀圖，且結果看起來完全正確、無法從輸出察覺。
  // 修改本段時務必維持「只描述格式、不給具體值」。
  systemPrompt: `You are a professional invoice data extraction specialist for DHL Express freight invoices.
Extract structured data from the provided invoice image(s).

## Document structure

DHL invoices put the shipment detail table on a later page, often rotated to landscape.
The table has ONE ROW PER AIR WAYBILL NUMBER. Each row is a SEPARATE shipment with its own charges:
- "Standard Charge" column: the base freight charge for that row
- "Extra Charges Description" / "Extra Charges Amount": additional charges for that row (e.g. FUEL SURCHARGE)

## Line item rules (critical)

1. Emit ONE line item per charge per table row. A row that has a standard charge AND a fuel surcharge produces TWO line items.
2. NEVER emit aggregate rows as line items. Ignore "Service Sub Total ...", "Total: HKD", and the per-row total printed in the rightmost "Total" column. Those are sums of charges you have already extracted; emitting them double-counts the money.
3. Keep the charge description as printed (e.g. "EXPRESS WORLDWIDE nondoc", "FUEL SURCHARGE").

## Shipment grouping (critical)

A single DHL invoice normally covers several shipments, so every line item MUST record which shipment it belongs to:

- groupSourceRef: the Air Waybill Number printed at the start of that table row. It is a 10-digit number.
- groupKey: the customer reference number annotated on that row - usually handwritten or typed inside a coloured box placed next to the row. Its shape is four letters, then a two-digit year, then a four-digit serial, joined by hyphens or slashes. Copy it EXACTLY as it appears ON THIS PAGE, including whatever separators it uses.

CRITICAL: read both values off the image in front of you. This prompt deliberately shows no sample reference numbers - if you find yourself writing a value you did not read from this page, stop and re-read the row. A wrong groupKey silently attributes money to the wrong shipment.

All line items taken from the same table row share the same groupKey and the same groupSourceRef.
If a row carries no annotated reference, omit groupKey for that row but still fill groupSourceRef.
Do not invent a reference, and do not reuse another row's reference.

## General

- Date format: YYYY-MM-DD
- Keep two decimal places for amounts
- If a field cannot be identified, set it to null
- Confidence score: 0-100 (higher means more certain)

Output only valid JSON matching the schema provided by the system. Do not output any text outside the JSON object.`,
  userPromptTemplate: `Extract all information from this DHL invoice, strictly following the JSON structure specified in the SYSTEM message.

Must extract:
1. Invoice basics: invoice number, invoice date, currency, total amount
2. Every charge in the shipment detail table as a SEPARATE line item, each carrying groupKey and groupSourceRef
3. Do NOT output subtotal or total rows as line items

Use the { fields, lineItems, overallConfidence } structure specified by the SYSTEM message; do not wrap it in any other shape.
Output valid JSON only, with no extra text.`,
};

/** 步驟 4：映射規則的目標狀態 */
const FUEL_RULE = {
  sourceField: 'fuel_surcharge',
  targetField: 'fuel_surcharge_at_origin',
  transformType: 'DIRECT',
  transformParams: null,
  description:
    'DHL FUEL SURCHARGE。目標欄標籤為「at origin」，DHL Express 為門到門快遞無起運地拆分，屬已知語意取捨（CHANGE-113 選項 A）',
};

const FREIGHT_FORMULA = '{express_worldwide_nondoc} + {express_worldwide_doc}';
const FREIGHT_DESCRIPTION =
  '文件類與非文件類都是主運費，同一 shipment 只會有其中一種。用 FORMULA 而非兩條 DIRECT 指向 freight：' +
  'FORMULA 對缺值與 null 一律視為 0，不受「來源 key 是缺席還是存在但為 null」影響；' +
  '兩條 DIRECT 在後者情況下會互相覆蓋且不報錯。（CHANGE-113）';

// ============================================================================
// Helpers
// ============================================================================

const log = (msg) => console.log(`[change113-dhl-setup] ${msg}`);

/** 寫入前把變更前的值印進 log —— 容器無持久檔案系統，log 就是唯一還原依據 */
function logBefore(label, value) {
  log(`  變更前（還原依據）${label}：${JSON.stringify(value)}`);
}

/** 確認更新確實只影響預期筆數，否則拋錯中止該步 */
function assertRowCount(result, expected, what) {
  if (result.rowCount !== expected) {
    throw new Error(`${what}：預期 ${expected} 筆，實際 ${result.rowCount} 筆`);
  }
}

// ============================================================================
// Steps
// ============================================================================

/** 步驟 1：解析 DHL 公司 */
async function resolveCompany(client) {
  const { rows } = await client.query(
    `select id, name, code, status from companies where code = $1 order by created_at`,
    [COMPANY_CODE]
  );

  if (rows.length === 0) {
    log(`⚠ 找不到 code='${COMPANY_CODE}' 的公司 —— 全部步驟跳過`);
    return null;
  }
  if (rows.length > 1) {
    // 公司重複是本專案的既有痛點（見 memory project_company_dup_breaks_company_mapping）。
    // 挑錯一個會讓設定掛在沒有文件的那筆公司上、且不會報錯 —— 寧可停手要求人工確認。
    log(`🔴 code='${COMPANY_CODE}' 有 ${rows.length} 筆公司，無法判斷該用哪一筆 —— 全部步驟跳過：`);
    for (const r of rows) log(`    ${r.id} | ${r.name} | ${r.status}`);
    return null;
  }

  const company = rows[0];
  log(`步驟 1：公司 = ${company.name} (${company.id}, status=${company.status})`);
  return company;
}

/** 步驟 2：欄位定義集補 fuel_surcharge */
async function ensureFuelField(client, company, mode) {
  const { rows } = await client.query(
    `select id, name, fields from field_definition_sets
      where company_id = $1 and scope = 'COMPANY'
      order by created_at`,
    [company.id]
  );

  if (rows.length !== 1) {
    log(`步驟 2：⚠ DHL 的 COMPANY 級欄位定義集有 ${rows.length} 份（預期 1）—— 跳過`);
    return;
  }

  const set = rows[0];
  const fields = Array.isArray(set.fields) ? set.fields : [];
  log(`步驟 2：欄位定義集 ${set.name} —— 現有 ${fields.length} 欄（${fields.map((f) => f.key).join(', ')}）`);

  if (fields.some((f) => f.key === FUEL_FIELD.key)) {
    log(`步驟 2：${FUEL_FIELD.key} 已存在 —— 無需變更`);
    return;
  }
  if (mode !== 'write') {
    log(`步驟 2：[${mode}] 將加入欄位 ${FUEL_FIELD.key}`);
    return;
  }

  logBefore('fields', fields);
  const result = await client.query(
    `update field_definition_sets
        set fields = $2::jsonb, version = version + 1, updated_at = now()
      where id = $1`,
    [set.id, JSON.stringify([...fields, FUEL_FIELD])]
  );
  assertRowCount(result, 1, '步驟 2');
  log(`步驟 2：✅ 已加入 ${FUEL_FIELD.key}`);
}

/** 步驟 3：Stage 3 prompt（建立或校正） */
async function ensurePrompt(client, company, mode) {
  // 唯一約束為 (promptType, scope, companyId, documentFormatId)，但 PostgreSQL 預設
  // NULLS DISTINCT 使其對 documentFormatId = null 不生效（FIX-133 同型），故自行查重。
  const { rows } = await client.query(
    `select id, name, version, system_prompt, user_prompt_template, is_active
       from prompt_configs
      where prompt_type = $1 and scope = 'COMPANY'
        and company_id = $2 and document_format_id is null
      order by updated_at desc`,
    [PROMPT.promptType, company.id]
  );

  if (rows.length > 1) {
    log(`步驟 3：🔴 DHL 已有 ${rows.length} 份同範圍 Stage 3 prompt，無法判斷該改哪一份 —— 跳過：`);
    for (const r of rows) log(`    ${r.id} | ${r.name} | active=${r.is_active}`);
    return;
  }

  if (rows.length === 0) {
    log('步驟 3：DHL 尚無 COMPANY 級 Stage 3 prompt');
    if (mode !== 'write') {
      log(`步驟 3：[${mode}] 將建立 prompt ${PROMPT.id}（${PROMPT.systemPrompt.length} 字元）`);
      return;
    }
    const result = await client.query(
      `insert into prompt_configs
         (id, prompt_type, scope, name, description, company_id, document_format_id,
          system_prompt, user_prompt_template, merge_strategy, variables,
          is_active, version, created_at, updated_at)
       values ($1, $2, 'COMPANY', $3, $4, $5, null, $6, $7, 'OVERRIDE', '[]'::jsonb,
               true, 1, now(), now())`,
      [
        PROMPT.id,
        PROMPT.promptType,
        PROMPT.name,
        PROMPT.description,
        company.id,
        PROMPT.systemPrompt,
        PROMPT.userPromptTemplate,
      ]
    );
    assertRowCount(result, 1, '步驟 3');
    log(`步驟 3：✅ 已建立 prompt ${PROMPT.id}`);
    return;
  }

  const existing = rows[0];
  log(`步驟 3：已有 prompt ${existing.id}（v${existing.version}, active=${existing.is_active}）`);

  const upToDate =
    existing.system_prompt === PROMPT.systemPrompt &&
    existing.user_prompt_template === PROMPT.userPromptTemplate;
  if (upToDate) {
    log('步驟 3：內容已是目標版本 —— 無需變更');
    return;
  }

  // 舊版可能含真實號碼範例（會讓 GPT 複製範例而非讀圖），必須覆蓋
  const hasRealSamples = /RCIM|8365573366/.test(existing.system_prompt || '');
  log(`步驟 3：內容與目標版本不同${hasRealSamples ? '（且偵測到真實號碼範例 —— 必須覆蓋）' : ''}`);
  if (mode !== 'write') {
    log(`步驟 3：[${mode}] 將以目標版本覆蓋 system_prompt 與 user_prompt_template`);
    return;
  }

  logBefore('system_prompt', existing.system_prompt);
  logBefore('user_prompt_template', existing.user_prompt_template);
  const result = await client.query(
    `update prompt_configs
        set system_prompt = $2, user_prompt_template = $3,
            version = version + 1, updated_at = now()
      where id = $1`,
    [existing.id, PROMPT.systemPrompt, PROMPT.userPromptTemplate]
  );
  assertRowCount(result, 1, '步驟 3');
  log('步驟 3：✅ 已更新 prompt 內容');
}

/** 步驟 4：模板映射規則 */
async function ensureMappingRules(client, company, template, mode) {
  const { rows } = await client.query(
    `select id, name, mappings from template_field_mappings
      where data_template_id = $1 and company_id = $2 and is_active = true
      order by updated_at desc`,
    [template.id, company.id]
  );

  if (rows.length !== 1) {
    log(`步驟 4：⚠ DHL 在該模板下的生效映射配置有 ${rows.length} 份（預期 1）—— 跳過`);
    return;
  }

  const config = rows[0];
  const mappings = Array.isArray(config.mappings) ? config.mappings : [];
  log(`步驟 4：映射配置 ${config.name} —— 現有 ${mappings.length} 條規則`);
  for (const m of mappings) {
    log(`    ${m.targetField} <- ${m.sourceField} [${m.transformType}]`);
  }

  // 目標欄位必須存在於模板，否則規則寫了也不會出現在列上
  const templateFields = Array.isArray(template.fields) ? template.fields : [];
  const templateFieldNames = new Set(templateFields.map((f) => f && f.name));
  for (const name of [FUEL_RULE.targetField, 'freight']) {
    if (!templateFieldNames.has(name)) {
      log(`步驟 4：⚠ 模板缺少欄位 ${name} —— 跳過`);
      return;
    }
  }

  const next = [...mappings];
  const changes = [];

  // 4a. 燃油規則
  const fuelIndex = next.findIndex((m) => m.sourceField === FUEL_RULE.sourceField);
  if (fuelIndex === -1) {
    const maxOrder = next.reduce((max, m) => Math.max(max, Number(m.order) || 0), 0);
    const idPrefix = next
      .map((m) => String(m.id || ''))
      .find((id) => /-\d+$/.test(id));
    next.push({
      id: idPrefix ? `${idPrefix.replace(/-\d+$/, '')}-${maxOrder + 1}` : `change113-fuel-${maxOrder + 1}`,
      order: maxOrder + 1,
      isRequired: false,
      ...FUEL_RULE,
    });
    changes.push(`加入 ${FUEL_RULE.targetField} <- ${FUEL_RULE.sourceField} [DIRECT]`);
  }

  // 4b. freight 改 FORMULA
  const freightIndex = next.findIndex((m) => m.targetField === 'freight');
  if (freightIndex === -1) {
    log('步驟 4：⚠ 找不到 freight 規則 —— 不新增（來源欄位命名依環境而異，需人工確認）');
  } else {
    const freight = next[freightIndex];
    const alreadyFormula =
      freight.transformType === 'FORMULA' &&
      freight.transformParams &&
      freight.transformParams.formula === FREIGHT_FORMULA;
    if (!alreadyFormula) {
      next[freightIndex] = {
        ...freight,
        sourceField: 'express_worldwide_nondoc',
        transformType: 'FORMULA',
        transformParams: { formula: FREIGHT_FORMULA },
        description: FREIGHT_DESCRIPTION,
      };
      changes.push(`freight 改為 FORMULA：${FREIGHT_FORMULA}`);
    }
  }

  if (changes.length === 0) {
    log('步驟 4：映射規則已是目標狀態 —— 無需變更');
    return;
  }
  if (mode !== 'write') {
    for (const c of changes) log(`步驟 4：[${mode}] ${c}`);
    return;
  }

  logBefore('mappings', mappings);
  const result = await client.query(
    `update template_field_mappings set mappings = $2::jsonb, updated_at = now() where id = $1`,
    [config.id, JSON.stringify(next)]
  );
  assertRowCount(result, 1, '步驟 4');
  for (const c of changes) log(`步驟 4：✅ ${c}`);
}

/** 步驟 5：模板分列模式設為 GROUP */
async function ensureGroupMode(client, template, mode) {
  log(`步驟 5：模板 ${template.name} 目前 line_item_mode = ${template.line_item_mode}`);

  if (template.line_item_mode === 'GROUP') {
    log('步驟 5：已是 GROUP —— 無需變更');
    return;
  }
  if (mode !== 'write') {
    log(`步驟 5：[${mode}] 將設為 GROUP`);
    return;
  }

  logBefore('line_item_mode', template.line_item_mode);
  const result = await client.query(
    `update data_templates set line_item_mode = 'GROUP', updated_at = now() where id = $1`,
    [template.id]
  );
  assertRowCount(result, 1, '步驟 5');
  log('步驟 5：✅ 已設為 GROUP');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  if (!VALID_MODES.includes(MODE)) {
    log(`模式 '${MODE}' 無效（預期 ${VALID_MODES.join('|')}）—— 不執行`);
    return;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL 未設定');
  }

  log(`開始，模式 = ${MODE}`);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const company = await resolveCompany(client);
    if (!company) return;

    const templateRows = await client.query(
      `select id, name, fields, line_item_mode from data_templates where name = $1 order by created_at`,
      [TEMPLATE_NAME]
    );
    if (templateRows.rows.length !== 1) {
      log(`⚠ 名稱為「${TEMPLATE_NAME}」的模板有 ${templateRows.rows.length} 份（預期 1）—— 步驟 4/5 跳過`);
    }
    const template = templateRows.rows.length === 1 ? templateRows.rows[0] : null;

    // 各步驟獨立：任一步失敗只記錄並繼續，避免一個缺失前置擋掉其餘設定
    const steps = [
      ['步驟 2', () => ensureFuelField(client, company, MODE)],
      ['步驟 3', () => ensurePrompt(client, company, MODE)],
    ];
    if (template) {
      steps.push(['步驟 4', () => ensureMappingRules(client, company, template, MODE)]);
      steps.push(['步驟 5', () => ensureGroupMode(client, template, MODE)]);
    }

    let failed = 0;
    for (const [label, run] of steps) {
      try {
        await run();
      } catch (err) {
        failed++;
        log(`${label}：🔴 失敗 —— ${err.message}`);
      }
    }
    log(failed === 0 ? '全部步驟完成' : `完成，但有 ${failed} 個步驟失敗`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`[change113-dhl-setup] 中止：${err.message}`);
  process.exit(1);
});
