# FIX-049: Seed 與 Static Prompts 中 Stage 2 Prompt 內容錯誤 + 信心度範圍不一致

> **狀態**: ✅ 已完成

## 問題描述

**發現日期**: 2026-03-02
**影響範圍**: V3.1 三階段提取管線（Prompt 數據源）
**嚴重程度**: 高
**狀態**: ✅ 已完成

### 症狀

1. **Stage 2 Prompt 內容完全錯誤**：Seed Data 和 Static Prompts 中的 `STAGE_2_FORMAT_IDENTIFICATION` Prompt 實際包含的是「欄位提取」內容，而非「格式識別」
2. **信心度範圍不一致**：部分 Prompt 使用 `0-1` 範圍，但代碼解析邏輯期望 `0-100` 範圍

---

## 根本原因分析

### 問題 1：Stage 2 Prompt 內容錯誤

**根因**：CHANGE-025 開發 V3.1 三階段功能時，Stage 2 的 Prompt 直接複用了 `FIELD_EXTRACTION` 的內容，而未撰寫專用的格式識別 Prompt。

**受影響文件**：

| 文件 | 行號 | 問題 |
|------|------|------|
| `src/services/static-prompts.ts` | 249-253 | `STAGE_2_FORMAT_IDENTIFICATION` → 映射到 `FIELD_EXTRACTION_SYSTEM_PROMPT` |
| `prisma/seed-data/prompt-configs.ts` | 77-136 | Stage 2 seed 內容是完整的欄位提取 Prompt |

**具體代碼**：

```typescript
// static-prompts.ts (第 249-253 行) — ❌ 錯誤
[PromptType.STAGE_2_FORMAT_IDENTIFICATION]: {
  systemPrompt: FIELD_EXTRACTION_SYSTEM_PROMPT,   // ❌ 用了欄位提取 Prompt
  userPrompt: FIELD_EXTRACTION_USER_PROMPT,         // ❌ 用了欄位提取 Prompt
  version: '1.0.0',
},
```

```typescript
// seed-data/prompt-configs.ts (第 82-96 行) — ❌ 錯誤
{
  promptType: 'STAGE_2_FORMAT_IDENTIFICATION',
  systemPrompt: `你是一位專業的發票數據提取專家。
你的任務是從貨運和物流發票圖片中提取結構化數據。
// ❌ 這是欄位提取的內容，不是格式識別
提取規則：
1. 發票基本資訊：發票號碼、日期、到期日
...`,
}
```

**對比：硬編碼的 Stage 2 Prompt 是正確的**（`stage-2-format.service.ts` 第 333-347 行）：
```typescript
// ✅ 正確的格式識別 Prompt
system: `You are an invoice format identification specialist.
Your task is to identify the format/template of this invoice.
...
Response format (JSON):
{
  "formatName": "string",
  "confidence": number (0-100),
  "matchedKnownFormat": "string | null",
  "formatCharacteristics": [...]
}`
```

### 問題 2：信心度範圍不一致

**標準**：所有三個 Stage 的解析代碼都使用 `0-100` 範圍。

| 位置 | Prompt 類型 | 當前範圍 | 正確範圍 | 狀態 |
|------|------------|---------|---------|------|
| `static-prompts.ts` | FIELD_EXTRACTION | 0-1 | 0-100 | ❌ 錯誤 |
| `static-prompts.ts` | STAGE_2 (=FIELD_EXTRACTION) | 0-1 | 0-100 | ❌ 錯誤 |
| `static-prompts.ts` | STAGE_3 (=FIELD_EXTRACTION) | 0-1 | 0-100 | ❌ 錯誤 |
| `static-prompts.ts` | ISSUER_IDENTIFICATION | 0-100 | 0-100 | ✅ 正確 |
| `static-prompts.ts` | TERM_CLASSIFICATION | 0-100 | 0-100 | ✅ 正確 |
| `static-prompts.ts` | VALIDATION | 0-100 | 0-100 | ✅ 正確 |
| Seed: Stage 1 | STAGE_1_COMPANY_IDENTIFICATION | 0-100 | 0-100 | ✅ 正確 |
| Seed: Stage 2 | STAGE_2_FORMAT_IDENTIFICATION | 0-1 | 0-100 | ❌ 錯誤 |
| Seed: Stage 3 | STAGE_3_FIELD_EXTRACTION | 0-1 | 0-100 | ❌ 錯誤 |
| Seed: FIELD_EXTRACTION | FIELD_EXTRACTION | 0-1 | 0-100 | ❌ 錯誤 |
| Seed: TERM_CLASSIFICATION | TERM_CLASSIFICATION | 0-100 | 0-100 | ✅ 正確 |
| 硬編碼: Stage 1 | buildCompanyIdentificationPrompt | 0-100 | 0-100 | ✅ 正確 |
| 硬編碼: Stage 2 | buildFormatIdentificationPrompt | 0-100 | 0-100 | ✅ 正確 |
| 硬編碼: Stage 3 | buildExtractionPrompt | 0-100 | 0-100 | ✅ 正確 |

---

## 修復方案

### 修改文件清單

| # | 文件 | 修改內容 |
|---|------|----------|
| 1 | `src/services/static-prompts.ts` | 新增 Stage 2 專用 Prompt 常數 + 修正映射 + 信心度 0-1→0-100 |
| 2 | `prisma/seed-data/prompt-configs.ts` | 重寫 Stage 2 seed 內容 + 信心度 0-1→0-100 |

### 修復 1: `src/services/static-prompts.ts`

#### 1a. 新增 Stage 2 格式識別 Prompt 常數

```typescript
/**
 * 格式識別 System Prompt (Stage 2)
 * @description 用於識別文件格式模板，匹配已知格式或描述新格式特徵
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
```

#### 1b. 修正 Static Prompt Registry 映射

```typescript
// 修復前 (第 249-253 行)
[PromptType.STAGE_2_FORMAT_IDENTIFICATION]: {
  systemPrompt: FIELD_EXTRACTION_SYSTEM_PROMPT,
  userPrompt: FIELD_EXTRACTION_USER_PROMPT,
  version: '1.0.0',
},

// 修復後
[PromptType.STAGE_2_FORMAT_IDENTIFICATION]: {
  systemPrompt: FORMAT_IDENTIFICATION_SYSTEM_PROMPT,
  userPrompt: FORMAT_IDENTIFICATION_USER_PROMPT,
  version: '2.0.0',
},
```

#### 1c. 修正 FIELD_EXTRACTION 信心度範圍

```typescript
// 修復前 (第 130 行)
- 信心度評分：0-1（越高越確定）

// 修復後
- 信心度評分：0-100（越高越確定）
```

```typescript
// 修復前 (第 140 行)
"confidence": 0.0-1.0,

// 修復後
"confidence": 0-100,
```

#### 1d. 導出新常數

```typescript
export {
  // ...existing exports...
  FORMAT_IDENTIFICATION_SYSTEM_PROMPT,
  FORMAT_IDENTIFICATION_USER_PROMPT,
};
```

### 修復 2: `prisma/seed-data/prompt-configs.ts`

#### 2a. 重寫 Stage 2 Seed Prompt（完全替換第 77-136 行）

```typescript
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
```

#### 2b. 修正 Stage 3 Seed 信心度範圍（第 160 行）

```typescript
// 修復前
- 信心度評分：0-1（越高越確定）
// 修復後
- 信心度評分：0-100（越高越確定）
```

```typescript
// 修復前 (userPromptTemplate)
"confidence": 0.0-1.0,
// 修復後
"confidence": 0-100,
```

#### 2c. 修正 FIELD_EXTRACTION Seed 信心度範圍（第 224 行）

同上修改。

---

## 影響分析

### 影響範圍

| 場景 | 影響 | 嚴重性 |
|------|------|--------|
| 硬編碼 Prompt（無 PromptConfig） | **不受影響** — 硬編碼版本是正確的 | 無 |
| 使用 Seed PromptConfig 的部署 | Stage 2 行為完全偏離（執行欄位提取而非格式識別） | 🔴 高 |
| 使用 Static Prompt 備援 | Stage 2 備援也是錯誤的 | 🔴 高 |
| 信心度計算 | 0-1 值會被當作 1%（而非 100%），導致信心度極低 | 🟡 中 |

### 安全線

目前系統**大部分情況使用硬編碼 Prompt**（因為多數部署未手動建立 PromptConfig），所以實際影響有限。但一旦用戶通過 UI 建立 PromptConfig 或執行 seed 後使用 PromptConfig，就會觸發此 bug。

---

## 測試驗證

### 驗證方式

1. 確認 `static-prompts.ts` 中所有 Prompt 的信心度範圍統一為 0-100
2. 確認 Seed Stage 2 Prompt 包含格式識別相關關鍵字（而非欄位提取）
3. 搜索代碼中所有 `0-1` 或 `0.0-1.0` 的信心度引用，確保全部改為 0-100
4. 執行 `npx prisma db seed`（在測試環境），確認 seed 成功
5. TypeScript 類型檢查通過：`npm run type-check`

### 回歸風險

- 低：修改僅涉及 Prompt 文字內容和 seed 數據，不涉及邏輯代碼
- Stage 1 解析代碼已支援兩種響應結構（嵌套 + 平面），不受影響
- Stage 2 解析代碼期望 `formatName` 等字段，修正後的 Prompt 輸出格式與此一致

---

## 相關

- **CHANGE-025**: V3.1 三階段架構（Stage 2 Prompt 最初在此引入）
- **CHANGE-053**: 增強 Stage 2 硬編碼 Prompt 詳細程度（本 FIX 的姊妹變更）
- `src/services/extraction-v3/stages/stage-2-format.service.ts` — 不需修改（硬編碼版本正確）

---

**建立者**: Claude AI
**建立日期**: 2026-03-02
