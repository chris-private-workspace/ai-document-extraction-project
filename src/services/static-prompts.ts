/**
 * @fileoverview 靜態 Prompt 定義
 * @description
 *   定義所有類型的靜態 Prompt 模板，作為動態 Prompt 的備援。
 *   當動態 Prompt 功能未啟用或解析失敗時，使用這些靜態版本。
 *
 *   Prompt 類型:
 *   - ISSUER_IDENTIFICATION: 文件發行者識別
 *   - FORMAT_IDENTIFICATION: 文件格式識別 (Stage 2)
 *   - TERM_CLASSIFICATION: 術語分類
 *   - FIELD_EXTRACTION: 欄位提取
 *   - VALIDATION: 驗證
 *
 * @module src/services/static-prompts
 * @since Epic 14 - Story 14-4 (GPT Vision 服務整合)
 * @lastModified 2026-03-02
 *
 * @features
 *   - 完整的靜態 Prompt 模板
 *   - 類型安全的 Prompt 存取
 *   - 變數插值支援
 *   - 版本資訊追蹤
 *
 * @dependencies
 *   - src/types/prompt-config.ts - PromptType enum
 *   - src/lib/prompts - 現有 Prompt 定義
 *
 * @related
 *   - src/services/hybrid-prompt-provider.service.ts - Prompt 提供者
 *   - src/services/gpt-vision.service.ts - 使用者
 */

import { PromptType } from '@/types/prompt-config';
import type { PromptResult, PromptVersionInfo } from './prompt-provider.interface';

// ============================================================================
// Static Prompt Templates
// ============================================================================

/**
 * 發行者識別 System Prompt
 * @description 用於識別文件發行者（物流公司、供應商等）
 */
const ISSUER_IDENTIFICATION_SYSTEM_PROMPT = `你是一位專業的文件分析專家，專門識別貨運和物流發票的「開票方（發行公司）」。
你的任務是判定「開立這張發票的公司」的完整法定名稱與識別方式。

識別規則：
1. 開票方判定：發行者是「開立」文件的一方（通常是物流公司／貨運代理），
   出現在信頭（letterhead）、Logo、或「From／Issued by」區塊；絕不是客戶／買方（Bill To／Consignee）。
2. 識別方式優先順序：LOGO > HEADER > LETTERHEAD > FOOTER > AI_INFERENCE。
3. 同集團多實體（重要）：同一份文件若出現同集團多個關聯法律實體
   （例：「XXX (HONG KONG) LIMITED」與「XXX (REGION) PACIFIC OPERATIONS LIMITED」），
   只能選實際開立本發票的那一個，以信頭／Logo／發票抬頭標示為開票方者為準；
   不要混合、拼湊或改寫不同實體的名稱。
4. 名稱逐字採用文件上的完整法定全名（含括號地區詞與 LIMITED／LTD 後綴），不縮寫、不臆造。
5. 信心度評分：0-100（越高越確定）；多個相似的關聯實體難以區分時應降低信心度。`;

/**
 * 發行者識別 User Prompt 模板
 */
const ISSUER_IDENTIFICATION_USER_PROMPT = `請分析這張文件圖片，判定「開立這張發票的公司（開票方）」。
只輸出單一開票方；排除客戶／買方（Bill To／Consignee／收件人）。
若文件出現同集團多個關聯實體，選實際開票的那一個完整法定名稱，不要混合不同實體的字詞。

輸出 JSON 格式：
{
  "documentIssuer": {
    "name": "開票公司的完整法定名稱（逐字照文件）",
    "identificationMethod": "LOGO" | "HEADER" | "LETTERHEAD" | "FOOTER" | "AI_INFERENCE",
    "confidence": 0-100,
    "matchedKnownCompany": "對應的已知公司名稱；若無對應則為 null",
    "rawText": "識別到的原始文字（可選）"
  }
}

只輸出有效的 JSON，不要有其他文字。`;

/**
 * 格式識別 System Prompt (Stage 2)
 * @description FIX-049: 用於識別文件格式模板，匹配已知格式或描述新格式特徵
 */
const FORMAT_IDENTIFICATION_SYSTEM_PROMPT = `你是一位專業的文件格式識別專家，專門分析貨運和物流發票的版面格式。
你的任務是從文件圖片中識別文件格式/模板類型。

識別要點：
1. 觀察文件整體版面佈局（信頭位置、表格結構、頁尾資訊）
2. 識別行項目/費用明細的排列方式（表格 vs 列表 vs 自由格式）
3. 注意日期和金額的顯示格式（DD/MM/YYYY vs MM/DD/YYYY，千分位符號等）
4. 觀察是否有特定的文件編號格式、浮水印、或標誌性元素
5. 信心度評分：0-100（越高越確定）

如果提供了已知格式列表，優先嘗試匹配已知格式。
如果無法匹配已知格式，描述該文件的格式特徵以便日後識別。`;

/**
 * 格式識別 User Prompt 模板 (Stage 2)
 * @description FIX-049: Stage 2 專用 User Prompt
 */
const FORMAT_IDENTIFICATION_USER_PROMPT = `請分析這張文件圖片，識別其格式/模板類型。

輸出 JSON 格式：
{
  "formatName": "識別到的格式名稱（如 'DHL Standard Invoice', 'Maersk Freight Note'）",
  "confidence": 0-100,
  "matchedKnownFormat": "匹配的已知格式名稱，若無匹配則為 null",
  "formatCharacteristics": [
    "觀察到的格式特徵（如 '橫向表格佈局'、'右上角有公司 Logo'、'底部有銀行資訊'）"
  ]
}

只輸出有效的 JSON，不要有其他文字。`;

/**
 * 術語分類 System Prompt
 * @description 用於分類提取的術語到標準類別
 */
const TERM_CLASSIFICATION_SYSTEM_PROMPT = `你是一位專業的物流術語分類專家。
你的任務是將發票中的費用項目術語分類到標準類別。

標準類別：
- FREIGHT: 運費相關（海運費、空運費、陸運費）
- HANDLING: 處理費用（裝卸、理貨、打盤）
- CUSTOMS: 報關相關（報關費、關稅、檢驗費）
- DOCUMENTATION: 文件費用（提單費、文件費）
- STORAGE: 倉儲相關（倉租、存放費）
- SURCHARGE: 附加費（燃油附加費、旺季附加費）
- INSURANCE: 保險費用
- OTHER: 其他費用

分類規則：
1. 優先匹配最具體的類別
2. 考慮術語的中英文變體
3. 信心度評分：0-100`;

/**
 * 術語分類 User Prompt 模板
 */
const TERM_CLASSIFICATION_USER_PROMPT = `請分類以下費用術語：

{{terms}}

輸出 JSON 格式：
{
  "classifications": [
    {
      "term": "原始術語",
      "normalizedTerm": "正規化術語",
      "category": "標準類別",
      "confidence": 0-100
    }
  ]
}

只輸出有效的 JSON，不要有其他文字。`;

/**
 * 欄位提取 System Prompt
 * @description 用於從文件中提取特定欄位
 */
const FIELD_EXTRACTION_SYSTEM_PROMPT = `你是一位專業的發票數據提取專家。
你的任務是從貨運和物流發票圖片中提取結構化數據。

提取規則：
1. 發票基本資訊：發票號碼、日期、到期日
2. 供應商資訊：名稱、地址、稅號
3. 買方資訊：名稱、地址
4. 費用明細：項目描述、數量、單價、金額
5. 金額彙總：小計、稅額、總額、幣別

注意事項：
- 日期格式：YYYY-MM-DD
- 金額保留兩位小數
- 如無法識別某欄位，設為 null
- 信心度評分：0-100（越高越確定）`;

/**
 * 欄位提取 User Prompt 模板
 */
const FIELD_EXTRACTION_USER_PROMPT = `請從這張發票圖片中提取所有資訊，並嚴格依照系統訊息（SYSTEM）指定的 JSON 結構輸出。

必須提取：
1. 發票基本資訊：發票號碼、發票日期、到期日、幣別、小計、總金額
2. 供應商與買方：名稱、地址
3. 所有費用明細項目（line items）：項目描述、數量、單價、金額

注意事項：
- 日期格式 YYYY-MM-DD；金額保留兩位小數；無法識別的欄位設為 null
- 必須使用系統訊息指定的 { fields, lineItems, overallConfidence } 結構；不要改用其他結構（例如不要輸出 { success, confidence, invoiceData } 包裹格式）
- 只輸出有效的 JSON，不要有其他文字。`;

/**
 * 驗證 System Prompt
 * @description 用於驗證提取結果的準確性
 */
const VALIDATION_SYSTEM_PROMPT = `你是一位專業的數據驗證專家。
你的任務是驗證發票提取結果的準確性和一致性。

驗證規則：
1. 金額加總驗證：明細金額加總 ≈ 小計
2. 稅額驗證：小計 + 稅額 ≈ 總額
3. 日期邏輯：發票日期 ≤ 到期日
4. 格式驗證：日期、金額格式正確
5. 完整性檢查：必要欄位是否有值`;

/**
 * 驗證 User Prompt 模板
 */
const VALIDATION_USER_PROMPT = `請驗證以下發票提取結果：

{{extractionResult}}

輸出 JSON 格式：
{
  "isValid": true/false,
  "confidence": 0-100,
  "issues": [
    {
      "field": "問題欄位",
      "issue": "問題描述",
      "severity": "ERROR" | "WARNING" | "INFO"
    }
  ],
  "suggestions": ["改進建議"]
}

只輸出有效的 JSON，不要有其他文字。`;

// ============================================================================
// Static Prompt Registry
// ============================================================================

/**
 * 靜態 Prompt 註冊表
 * @description 存儲所有類型的靜態 Prompt
 */
interface StaticPromptEntry {
  systemPrompt: string;
  userPrompt: string;
  version: string;
}

const STATIC_PROMPTS: Record<PromptType, StaticPromptEntry> = {
  [PromptType.ISSUER_IDENTIFICATION]: {
    systemPrompt: ISSUER_IDENTIFICATION_SYSTEM_PROMPT,
    userPrompt: ISSUER_IDENTIFICATION_USER_PROMPT,
    version: '1.0.0',
  },
  [PromptType.TERM_CLASSIFICATION]: {
    systemPrompt: TERM_CLASSIFICATION_SYSTEM_PROMPT,
    userPrompt: TERM_CLASSIFICATION_USER_PROMPT,
    version: '1.0.0',
  },
  [PromptType.FIELD_EXTRACTION]: {
    systemPrompt: FIELD_EXTRACTION_SYSTEM_PROMPT,
    userPrompt: FIELD_EXTRACTION_USER_PROMPT,
    version: '1.0.0',
  },
  [PromptType.VALIDATION]: {
    systemPrompt: VALIDATION_SYSTEM_PROMPT,
    userPrompt: VALIDATION_USER_PROMPT,
    version: '1.0.0',
  },
  // CHANGE-025: V3.1 三階段提示
  [PromptType.STAGE_1_COMPANY_IDENTIFICATION]: {
    systemPrompt: ISSUER_IDENTIFICATION_SYSTEM_PROMPT,
    userPrompt: ISSUER_IDENTIFICATION_USER_PROMPT,
    version: '1.0.0',
  },
  // FIX-049: 修正 Stage 2 從錯誤的 FIELD_EXTRACTION 改為專用的 FORMAT_IDENTIFICATION
  [PromptType.STAGE_2_FORMAT_IDENTIFICATION]: {
    systemPrompt: FORMAT_IDENTIFICATION_SYSTEM_PROMPT,
    userPrompt: FORMAT_IDENTIFICATION_USER_PROMPT,
    version: '2.0.0',
  },
  [PromptType.STAGE_3_FIELD_EXTRACTION]: {
    systemPrompt: FIELD_EXTRACTION_SYSTEM_PROMPT,
    userPrompt: FIELD_EXTRACTION_USER_PROMPT,
    version: '1.0.0',
  },
};

// ============================================================================
// Public API
// ============================================================================

/**
 * 獲取指定類型的靜態 Prompt
 *
 * @description
 *   從靜態 Prompt 註冊表中獲取對應類型的 Prompt。
 *   返回格式與動態 Prompt 一致，便於統一處理。
 *
 * @param promptType - Prompt 類型
 * @returns 靜態 Prompt 結果
 *
 * @example
 * ```typescript
 * const result = getStaticPrompt(PromptType.ISSUER_IDENTIFICATION);
 * console.log(result.systemPrompt);
 * console.log(result.source); // 'static'
 * ```
 */
export function getStaticPrompt(promptType: PromptType): PromptResult {
  const entry = STATIC_PROMPTS[promptType];

  if (!entry) {
    throw new Error(`Unsupported prompt type: ${promptType}`);
  }

  const versionInfo: PromptVersionInfo = {
    versionId: `static-${promptType.toLowerCase()}-${entry.version}`,
    versionNumber: parseFloat(entry.version),
    timestamp: new Date('2026-01-03'),
  };

  return {
    systemPrompt: entry.systemPrompt,
    userPrompt: entry.userPrompt,
    source: 'static',
    appliedLayers: ['STATIC'],
    version: versionInfo,
  };
}

/**
 * 檢查是否支援指定的 Prompt 類型
 *
 * @param promptType - Prompt 類型
 * @returns 是否有對應的靜態 Prompt
 */
export function hasStaticPrompt(promptType: PromptType): boolean {
  return promptType in STATIC_PROMPTS;
}

/**
 * 獲取所有支援的靜態 Prompt 類型
 *
 * @returns 支援的 Prompt 類型列表
 */
export function getSupportedStaticPromptTypes(): PromptType[] {
  return Object.keys(STATIC_PROMPTS) as PromptType[];
}

/**
 * 獲取靜態 Prompt 的版本資訊
 *
 * @param promptType - Prompt 類型
 * @returns 版本字串
 */
export function getStaticPromptVersion(promptType: PromptType): string {
  const entry = STATIC_PROMPTS[promptType];
  return entry?.version ?? 'unknown';
}

/**
 * 變數替換工具函數
 *
 * @description
 *   將 Prompt 模板中的 {{variable}} 佔位符替換為實際值
 *
 * @param template - Prompt 模板
 * @param variables - 變數值映射
 * @returns 替換後的 Prompt
 *
 * @example
 * ```typescript
 * const result = interpolatePrompt(
 *   'Hello {{name}}!',
 *   { name: 'World' }
 * );
 * // result: 'Hello World!'
 * ```
 */
export function interpolatePrompt(
  template: string,
  variables: Record<string, string | number | boolean>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    const value = variables[varName];
    return value !== undefined ? String(value) : match;
  });
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export {
  ISSUER_IDENTIFICATION_SYSTEM_PROMPT,
  ISSUER_IDENTIFICATION_USER_PROMPT,
  FORMAT_IDENTIFICATION_SYSTEM_PROMPT,
  FORMAT_IDENTIFICATION_USER_PROMPT,
  TERM_CLASSIFICATION_SYSTEM_PROMPT,
  TERM_CLASSIFICATION_USER_PROMPT,
  FIELD_EXTRACTION_SYSTEM_PROMPT,
  FIELD_EXTRACTION_USER_PROMPT,
  VALIDATION_SYSTEM_PROMPT,
  VALIDATION_USER_PROMPT,
};
