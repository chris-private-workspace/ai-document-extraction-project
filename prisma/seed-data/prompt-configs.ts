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
 * 注意: 這些 prompt 原則上與 src/services/static-prompts.ts 中的靜態版本保持同步。
 *
 * ⚠️ FIX-115 起 STAGE_2_FORMAT_IDENTIFICATION 為例外，兩者**刻意不同**：
 *    本檔的 Stage 2 使用 `${knownFormats}` / `${companyName}` 變數，由
 *    stage-2-format.service.ts 經 replaceVariables（`${}` 語法）注入；
 *    而 static-prompts.ts 服務的是 legacy gpt-vision 路徑（HybridPromptProvider），
 *    其 interpolatePrompt 用的是 `{{}}` 語法且不提供這些變數 —— 若把變數複製過去
 *    只會把佔位符原樣送進 prompt。兩者用途不同，不應強行同步。
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
    systemPrompt: `你是一位專業的文件分析專家，專門識別貨運和物流發票的「開票方（發行公司）」。
你的任務是判定「開立這張發票的公司」的完整法定名稱與識別方式。

識別規則：
1. 開票方判定：發行者是「開立」文件的一方（通常是物流公司／貨運代理／forwarder），
   出現在信頭（letterhead）、Logo、或「From／Issued by／Remit to」區塊；
   絕不是客戶／買方（Bill To／Customer／Consignee／收件人）。
2. 識別方式優先順序：LOGO > HEADER > LETTERHEAD > FOOTER > AI_INFERENCE。
3. 同集團多實體（重要）：大型物流集團常在同一份文件出現多個關聯法律實體
   （例：「XXX (HONG KONG) LIMITED」與「XXX (REGION) PACIFIC OPERATIONS LIMITED」）。
   只能選「實際開立本發票的那一個法律實體」，以信頭／Logo／發票抬頭最顯著、標示為開票方者為準；
   不要把不同關聯實體的字詞混合、拼湊或改寫成新的名稱。
4. 名稱逐字採用文件印出的「完整法定全名」（含括號地區詞與 LIMITED／LTD 等後綴），不縮寫、不翻譯、不臆造。
5. 對照已知公司列表：User 訊息會提供系統已知公司清單。若開票方對應清單中某一家，
   matchedKnownCompany 逐字回填該清單名稱；無對應則設為 null。
6. 信心度評分：0-100（越高越確定）；若多個相似的關聯實體難以區分，應降低信心度以觸發人工審核。`,
    userPromptTemplate: `請分析這張文件圖片，判定「開立這張發票的公司（開票方）」。

系統已知公司列表（若下方為空，直接從文件識別）：
\${knownCompanies}

注意：
- 只輸出單一開票方；排除客戶／買方（Bill To／Consignee／收件人）。
- 若文件出現同集團多個關聯實體，選實際開票的那一個完整法定名稱，不要混合不同實體的字詞。
- 開票方若對應上方已知公司列表中的某一家，matchedKnownCompany 逐字回填該公司名稱；否則為 null。

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

只輸出有效的 JSON，不要有其他文字。`,
    mergeStrategy: 'OVERRIDE',
    variables: [],
    isActive: true,
    version: 2,
  },

  // ============================================================================
  // 2. STAGE_2_FORMAT_IDENTIFICATION - V3.1 階段二：格式識別
  // FIX-049: 重寫為正確的格式識別內容（原本錯誤地使用了欄位提取 Prompt）
  // FIX-115: 引入 ${knownFormats} / ${companyName} 變數。原本 prompt 宣稱
  //          「如果提供了已知格式列表，優先嘗試匹配」卻從未引用該變數，
  //          GPT 因此看不到清單、matchedKnownFormat 恆為 null，一律落入 JIT
  //          並撞唯一鍵沿用該公司唯一格式 —— 多格式辨識實質失效。
  // FIX-121: 排他性規則（第 2 點）限縮為「結構性特徵」，並說明標註為可變／條件性的
  //          內容不符時不構成排除理由 —— 否則含頁次、幣別等可變值的 keyword 會在
  //          多頁發票、非 HKD 帳單等情境被當成「特徵不存在」而誤排除正確格式。
  //          ⚠️ 刻意只加一個子句、不新增段落：FIX-119 曾以整段但書 + 移除具體範例
  //          實作，導致 gpt-5.4-nano + imageDetailMode "low" 失去辨識錨點、準確度
  //          明顯下降而回滾。具體範例字串是弱模型的錨點，必須保留。
  // ============================================================================
  {
    promptType: 'STAGE_2_FORMAT_IDENTIFICATION',
    scope: 'GLOBAL',
    name: 'V3.1 Stage 2 - Format Identification',
    description: 'V3.1 提取管線階段二：識別文件格式模板，用於匹配格式模板和載入對應配置',
    systemPrompt: `你是一位專業的文件格式識別專家，專門分析 \${companyName} 的貨運與物流發票版面格式。
你的任務是判斷這張文件屬於下列「已知格式」中的哪一種。

已知格式清單（格式名稱: 該格式的辨識特徵；若下方為空，代表此公司尚無已知格式）：
\${knownFormats}

判斷方式：
1. 逐一比對上列每個格式的辨識特徵，看哪一個與文件圖片最吻合。
2. 特徵具有排他性：若某格式的結構性特徵明確不存在於文件中（例如清單說「左上角有 QR code」但文件沒有），就排除該格式。
   但特徵中標明「可變」「條件性」的部分（頁次、幣別、金額、位數等）不符時，不構成排除理由 —— 括號內的數值僅為範例。
3. 優先依據版面結構與獨有欄位判斷，而非公司名稱或 Logo
   （同一間公司的不同版面都會有相同 Logo，不具鑑別力）。
4. 若清單為空，或所有已知格式都明顯不吻合，則視為新格式。

回傳規則（非常重要）：
- 若判定吻合某個已知格式，matchedKnownFormat 必須**逐字複製**該格式名稱
  （冒號前的完整字串，含括號與標點），不可改寫、不可翻譯、不可截短。
- 同時把 formatName 也填成同一個字串。
- 若為新格式，matchedKnownFormat 填 null，並在 formatName 給一個描述性名稱、
  在 formatCharacteristics 詳細列出版面特徵（信頭位置、表格結構、日期/金額格式、
  文件編號格式、浮水印或標誌性元素）供日後識別。
- 信心度 0-100，反映你對此判斷的確定程度。`,
    userPromptTemplate: `請分析這張文件圖片，比對已知格式清單，判斷它屬於哪一個格式。

輸出 JSON 格式：
{
  "formatName": "格式名稱（若匹配已知格式，須與清單中的名稱完全一致）",
  "confidence": 0-100,
  "matchedKnownFormat": "匹配到的已知格式名稱（逐字複製），若無匹配則為 null",
  "formatCharacteristics": [
    "你在文件中實際觀察到、且用來做此判斷的特徵"
  ]
}

只輸出有效的 JSON，不要有其他文字。`,
    mergeStrategy: 'OVERRIDE',
    variables: [],
    isActive: true,
    version: 4,
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
