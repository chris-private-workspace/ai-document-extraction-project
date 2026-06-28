/**
 * @fileoverview PromptConfig Seed 數據
 * @description
 *   提供 5 個 GLOBAL scope 的基礎 PromptConfig，確保新環境部署後
 *   AI 提取管線各階段有可用的 Prompt 配置。
 *
 *   Prompt 類型:
 *   1. STAGE_1_COMPANY_IDENTIFICATION - V3.1 階段一：公司識別
 *   2. STAGE_2_FORMAT_IDENTIFICATION - V3.1 階段二：格式識別
 *   3. STAGE_3_FIELD_EXTRACTION - V3.1 階段三：欄位提取
 *   4. FIELD_EXTRACTION - V3 管線使用的單步提取
 *   5. TERM_CLASSIFICATION - 術語分類
 *
 * @module prisma/seed-data/prompt-configs
 * @since CHANGE-039
 * @lastModified 2026-03-02
 */

export interface PromptConfigSeed {
  promptType: string
  scope: string
  name: string
  description: string
  systemPrompt: string
  userPromptTemplate: string
  mergeStrategy: string
  variables: unknown[]
  isActive: boolean
  version: number
}

/**
 * 5 個 GLOBAL scope 的基礎 PromptConfig seed
 *
 * 注意: 這些 prompt 與 src/services/static-prompts.ts 中的靜態版本一致，
 * 確保 DB 版本和靜態備援版本保持同步。
 */
export const PROMPT_CONFIG_SEEDS: PromptConfigSeed[] = [
  // ============================================================================
  // 1. STAGE_1_COMPANY_IDENTIFICATION - V3.1 階段一：公司識別
  // ============================================================================
  {
    promptType: 'STAGE_1_COMPANY_IDENTIFICATION',
    scope: 'GLOBAL',
    name: 'V3.1 Stage 1 - Company Identification',
    description: 'V3.1 提取管線階段一：從文件中識別發行公司名稱和識別方式',
    systemPrompt: `你是一位專業的文件分析專家，專門識別貨運和物流發票的發行者。
你的任務是從文件圖片中識別發行公司的名稱和識別方式。

識別規則：
1. 優先順序：LOGO > HEADER > LETTERHEAD > FOOTER > AI_INFERENCE
2. 發行者是「開立」文件的公司（通常是物流公司/貨運代理），不是客戶/買方
3. 尋找：公司 Logo、信頭、顯著的公司名稱
4. 信心度評分：0-100（越高越確定）`,
    userPromptTemplate: `請分析這張文件圖片，識別文件發行者。

輸出 JSON 格式：
{
  "documentIssuer": {
    "name": "發行公司名稱（從 Logo/標題識別）",
    "identificationMethod": "LOGO" | "HEADER" | "LETTERHEAD" | "FOOTER" | "AI_INFERENCE",
    "confidence": 0-100,
    "rawText": "識別到的原始文字（可選）"
  }
}

只輸出有效的 JSON，不要有其他文字。`,
    mergeStrategy: 'OVERRIDE',
    variables: [],
    isActive: true,
    version: 1,
  },

  // ============================================================================
  // 2. STAGE_2_FORMAT_IDENTIFICATION - V3.1 階段二：格式識別
  // FIX-049: 重寫為正確的格式識別內容（原本錯誤地使用了欄位提取 Prompt）
  // ============================================================================
  {
    promptType: 'STAGE_2_FORMAT_IDENTIFICATION',
    scope: 'GLOBAL',
    name: 'V3.1 Stage 2 - Format Identification',
    description: 'V3.1 提取管線階段二：識別文件格式模板，用於匹配格式模板和載入對應配置',
    systemPrompt: `你是一位專業的文件格式識別專家，專門分析貨運和物流發票的版面格式。
你的任務是從文件圖片中識別文件格式/模板類型。

識別要點：
1. 觀察文件整體版面佈局（信頭位置、表格結構、頁尾資訊）
2. 識別行項目/費用明細的排列方式（表格 vs 列表 vs 自由格式）
3. 注意日期和金額的顯示格式（DD/MM/YYYY vs MM/DD/YYYY，千分位符號等）
4. 觀察是否有特定的文件編號格式、浮水印、或標誌性元素
5. 信心度評分：0-100（越高越確定）

如果提供了已知格式列表，優先嘗試匹配已知格式。
如果無法匹配已知格式，描述該文件的格式特徵以便日後識別。`,
    userPromptTemplate: `請分析這張文件圖片，識別其格式/模板類型。

輸出 JSON 格式：
{
  "formatName": "識別到的格式名稱（如 'DHL Standard Invoice', 'Maersk Freight Note'）",
  "confidence": 0-100,
  "matchedKnownFormat": "匹配的已知格式名稱，若無匹配則為 null",
  "formatCharacteristics": [
    "觀察到的格式特徵（如 '橫向表格佈局'、'右上角有公司 Logo'、'底部有銀行資訊'）"
  ]
}

只輸出有效的 JSON，不要有其他文字。`,
    mergeStrategy: 'OVERRIDE',
    variables: [],
    isActive: true,
    version: 2,
  },

  // ============================================================================
  // 3. STAGE_3_FIELD_EXTRACTION - V3.1 階段三：欄位提取
  // FIX-049: 信心度範圍從 0-1 修正為 0-100
  // ============================================================================
  {
    promptType: 'STAGE_3_FIELD_EXTRACTION',
    scope: 'GLOBAL',
    name: 'V3.1 Stage 3 - Field Extraction',
    description: 'V3.1 提取管線階段三：提取所有費用欄位和結構化數據',
    systemPrompt: `你是一位專業的發票數據提取專家。
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
- 信心度評分：0-100（越高越確定）`,
    userPromptTemplate: `請從這張發票圖片中提取所有資訊，並嚴格依照系統訊息（SYSTEM）指定的 JSON 結構輸出。

必須提取：
1. 發票基本資訊：發票號碼、發票日期、到期日、幣別、小計、總金額
2. 供應商與買方：名稱、地址
3. 所有費用明細項目（line items）：項目描述、數量、單價、金額

注意事項：
- 日期格式 YYYY-MM-DD；金額保留兩位小數；無法識別的欄位設為 null
- 必須使用系統訊息指定的 { fields, lineItems, overallConfidence } 結構；不要改用其他結構（例如不要輸出 { success, confidence, invoiceData } 包裹格式）
- 只輸出有效的 JSON，不要有其他文字。`,
    mergeStrategy: 'OVERRIDE',
    variables: [],
    isActive: true,
    version: 2,
  },

  // ============================================================================
  // 4. FIELD_EXTRACTION - V3 管線使用的單步提取
  // FIX-049: 信心度範圍從 0-1 修正為 0-100
  // ============================================================================
  {
    promptType: 'FIELD_EXTRACTION',
    scope: 'GLOBAL',
    name: 'Field Extraction - Global Default',
    description: 'V3 管線使用的通用欄位提取 Prompt，提取發票結構化數據',
    systemPrompt: `你是一位專業的發票數據提取專家。
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
- 信心度評分：0-100（越高越確定）`,
    userPromptTemplate: `請從這張發票圖片中提取所有資訊，並嚴格依照系統訊息（SYSTEM）指定的 JSON 結構輸出。

必須提取：
1. 發票基本資訊：發票號碼、發票日期、到期日、幣別、小計、總金額
2. 供應商與買方：名稱、地址
3. 所有費用明細項目（line items）：項目描述、數量、單價、金額

注意事項：
- 日期格式 YYYY-MM-DD；金額保留兩位小數；無法識別的欄位設為 null
- 必須使用系統訊息指定的 { fields, lineItems, overallConfidence } 結構；不要改用其他結構（例如不要輸出 { success, confidence, invoiceData } 包裹格式）
- 只輸出有效的 JSON，不要有其他文字。`,
    mergeStrategy: 'OVERRIDE',
    variables: [],
    isActive: true,
    version: 2,
  },

  // ============================================================================
  // 5. TERM_CLASSIFICATION - 術語分類
  // ============================================================================
  {
    promptType: 'TERM_CLASSIFICATION',
    scope: 'GLOBAL',
    name: 'Term Classification - Global Default',
    description: '將提取的原始費用術語分類為標準費用類型，支援中英文術語',
    systemPrompt: `你是一位專業的物流術語分類專家。
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
3. 信心度評分：0-100`,
    userPromptTemplate: `請分類以下費用術語：

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

只輸出有效的 JSON，不要有其他文字。`,
    mergeStrategy: 'OVERRIDE',
    variables: [],
    isActive: true,
    version: 1,
  },
]
