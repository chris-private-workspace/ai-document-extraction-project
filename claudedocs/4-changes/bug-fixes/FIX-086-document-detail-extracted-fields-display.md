# FIX-086: 文件詳情頁 Extracted Fields tab 顯示修正（複合 3 子 bug）

> **建立日期**: 2026-06-20
> **發現方式**: 用戶回報（Phase 1 交付前頁面檢視）+ 資料庫實機驗證
> **影響頁面/功能**: `/en/documents/[id]` 的 Extracted Fields tab
> **優先級**: 高
> **狀態**: 🚧 待修復

---

## 問題描述

在文件詳情頁 `/en/documents/[id]` 的 Extracted Fields tab，用戶於 Phase 1 交付前頁面檢視時發現三個相關但獨立的顯示問題。經程式碼追查與資料庫實機驗證後，確認皆為**顯示／資料準確度層**問題，**非**提取主鏈（Stage 3）漏抓資料。

### 資料流共識（修正方向的前提）

> 釐清此前提後，三個 bug 的根因與修法才能對齊，避免誤動 Azure DI 舊路徑。

- V3.1 為**現行預設提取路徑**，全程使用 GPT-5.2（Azure OpenAI），**不經過 Azure Document Intelligence**。
- Stage 3 欄位提取 (`stage-3-extraction.service.ts`) 只調用 `GptCallerService`。
- Azure DI 相關程式碼（`azure-di.service.ts`、`unified-processor/steps/azure-di-extraction.step.ts`）仍存在，但屬舊 unified-processor / V2 路徑，V3.1 主鏈**不經過**。
- 持久化 `processing-result-persistence.service.ts:520-525` 把 `stage3Result.fields` 存為 fieldMappings，每欄位結構為 `{ value, confidence }`，**不含 source 屬性**。
- 渲染鏈：`DocumentDetailTabs.tsx`（fields tab）→ `ExtractedFieldsPanel.tsx`（header 欄位 + line items）→ `FieldCard.tsx` / `LineItemsTable.tsx`。資料來自 `GET /api/documents/[id]?include=extractedFields`。

### 子問題總覽

| # | 問題 | 嚴重度 | 影響頁面 |
|---|------|--------|----------|
| BUG-1 | Extracted Fields 欄位被誤標「Azure DI」來源標籤（實際為 GPT-5.2 提取） | 高 | `/en/documents/[id]` Extracted Fields tab |
| BUG-2 | 用戶誤以為「只顯示 line items」；實為 header 欄位以原始 key 呈現 + 版面未與 line items 區隔 | 高 | `/en/documents/[id]` Extracted Fields tab |
| BUG-3 | line item 信心度被寫死 85，非 GPT 實際回傳信心度 | 中 | `/en/documents/[id]` Extracted Fields tab |

---

## 重現步驟

1. 開啟一個已完成提取（狀態 `MAPPING_COMPLETED`）的文件詳情頁，例如 `/en/documents/144651e4-c1fa-4ce7-985a-6d7cef7affa5`（檔名 `Fairate_RHEX260200_03186_signed.pdf`）。
2. 切換到 Extracted Fields tab。
3. 觀察現象：
   - **BUG-1**：每個欄位卡片右上角的來源標籤皆顯示藍底「Azure DI」，但此文件實際走 V3.1（GPT-5.2）提取。
   - **BUG-2**：header 欄位（如 `airline_document_charge`、`handling_charge`）以原始 key 字面呈現，未經友善 label／i18n；header 區與 line items 區視覺上難以區隔，造成「好像只有 line items」的誤解。
   - **BUG-3**：line items 每列信心度固定顯示為 85，與其他欄位的實際信心度落差明顯。

---

## 根本原因

### BUG-1：來源 fallback 預設值錯誤

- 來源標籤渲染：`src/components/features/document-preview/FieldCard.tsx:202-210`，文字取自 `FIELD_SOURCE_I18N_KEYS[field.source]`（`src/types/extracted-field.ts:39-44`），藍色樣式定義於 `FieldCard.tsx:79-80`（`case 'AZURE_DI'` → `bg-blue-100 text-blue-700`）。它是**欄位來源標籤**（藍底 "Azure DI"），**非**真正的 logo 圖片。
- 根因在 API：`src/app/api/documents/[id]/route.ts:90`
  ```ts
  const source = sourceMap[entry.source?.toLowerCase() ?? ''] ?? 'AZURE_DI'
  ```
  V3.1 持久化的 fields 物件結構為 `{ value, confidence }`，**無 `source` 屬性** → `entry.source` 為 `undefined` → 必然落入 `?? 'AZURE_DI'` 預設值 → 每個欄位都被貼上「Azure DI」標籤。
- `FieldCard.tsx` 的樣式映射本身正確（GPT_VISION/MANUAL/MAPPING 各有對應樣式），**不需動**。

### BUG-2：header 欄位以原始 key 呈現 + 版面未區隔（顯示面，非資料面）

- `ExtractedFieldsPanel.tsx` 設計上**同時**渲染 header 欄位（`FieldCard` 列表，222-262 行）與 line items（264-275 行），並**非**只有 line items。
- 守衛條件：`DocumentDetailTabs.tsx:196`
  ```tsx
  {document.extractedFields && document.extractedFields.length > 0
    ? <ExtractedFieldsPanel/>
    : <空狀態/>}
  ```
  當 header 欄位為空陣列時，整個面板（含 line items 區）都不渲染。
- 顯示弱點：API `route.ts:93-95` 設定 `displayName: fieldName`（直接用原始 key，如 `invoice_number`），未做 i18n／友善 label 轉換。
- **資料庫實機驗證**（文件 `144651e4-c1fa-4ce7-985a-6d7cef7affa5`，狀態 `MAPPING_COMPLETED`）：`stage_3_result->'fields'` 為 object，含 **6 個 header 欄位**（`airline_document_charge`、`container_field_station_charge`、`customs_electronic_data_charge`、`handling_charge`、`terminal_charge`、`x_ray_screening_charge`）＋ 6 個 lineItems。
  → **確認非資料面問題**（Stage 3 有正確提取 header 欄位）。根因為顯示面：header 欄位以原始 key 呈現、版面未與 line items 區隔，使用戶誤判。

### BUG-3：line item 信心度被寫死 85

- `src/services/extraction-v3/stages/stage-3-extraction.service.ts:1224`，`convertRawLineItems` 把每個 line item 的 `confidence` 固定為 `85`，並非 GPT 實際回傳的 per-item 信心度。
- Stage 3 output schema 本身已含 `confidence` 欄位（約第 615 行），GPT 回傳中可取得真實信心度。
- line items 的來源對應於 Stage 3 本身**正確**（`route.ts:224-234` 從 `stage3Result.lineItems` 取，`LineItemsTable.tsx` 用 `inferColumns` 動態推斷欄位），僅信心度數值被覆寫。
- 附帶觀察：同檔 `stage-3-extraction.service.ts:987` 對 header 欄位的 fallback 亦寫死 `confidence: 85`（當 GPT 回傳該欄位非 `{value, ...}` 物件結構時），可一併評估是否納入修法範圍（見 BUG-3 修復方案備註）。

---

## 解決方案

### BUG-1 修復：來源 fallback 改為 GPT-5.2 路徑語意

**主方案（最小改動）**：`src/app/api/documents/[id]/route.ts:81-90` 的 fallback 由 `'AZURE_DI'` 改為 `'GPT_VISION'`（V3.1 主鏈實際來源）。

```ts
// 修改前
const source = sourceMap[entry.source?.toLowerCase() ?? ''] ?? 'AZURE_DI'
// 修改後（V3.1 主鏈不經 Azure DI，預設應反映 GPT 提取）
const source = sourceMap[entry.source?.toLowerCase() ?? ''] ?? 'GPT_VISION'
```

> 進階方案（可選，視 Phase 排程）：依 `extractionVersion` 判定來源（V3/V3.1 → GPT_VISION；舊 unified-processor → 維持 Azure DI 語意），避免日後舊路徑文件被反向誤標。

**可選根治（更上游，超出本 FIX 主範圍）**：於 `stage-3-extraction.service.ts` 寫入 fields 時帶上 `source`，或於 `processing-result-persistence.service.ts` 持久化時補 `source` 屬性，使下游不依賴 fallback。此項若採用需評估 schema／既有資料相容性，建議獨立評估後再決定，**不在本 FIX 強制範圍**。

> `FieldCard.tsx` 樣式映射正確，**不需修改**。

### BUG-2 修復：header 欄位友善 label + 版面區隔 + 守衛放寬

1. **友善 label（接 i18n）**：將 `route.ts` 的 `displayName` 由原始 `fieldName` 改用欄位定義 label／i18n 對應，使 header 欄位顯示為人類可讀名稱。
2. **版面區隔**：在 `ExtractedFieldsPanel.tsx` 強化 header 欄位區與 line items 區的視覺區隔（如分區標題、分隔線、區塊標籤），消除「只有 line items」的誤判。
3. **守衛放寬（可選）**：`DocumentDetailTabs.tsx:196` 由「`extractedFields` 有值才渲染」放寬為「`extractedFields` 或 lineItems 任一有值即渲染面板」，避免 header 欄位為空時連 line items 都被隱藏。

> ⚠️ **H5（i18n）約束**：`displayName` 接 i18n、以及若新增任何來源標籤／分區標題等使用者可見文字 → **必須**同步更新三語言（`messages/en/`、`messages/zh-TW/`、`messages/zh-CN/`）並執行 `npm run i18n:check`。若沿用既有欄位定義 label（資料層既有翻譯）則依實際情況評估。

### BUG-3 修復：讀取 GPT 實際 per-item 信心度

`convertRawLineItems`（`stage-3-extraction.service.ts:1207-1228`）改為讀取 GPT 回傳的 per-item `confidence`，取代寫死的 `85`：

```ts
// 修改前
confidence: 85,
// 修改後（讀 GPT 回傳值，無值時退回合理 fallback）
confidence: (rawItem.confidence as number) ?? <fallback>,
```

> 備註：`stage-3-extraction.service.ts:987` 的 header 欄位 fallback 同樣寫死 `85`，僅在 GPT 回傳非標準物件結構時觸發。可評估是否一併修正（採與本 BUG-3 一致的取值策略），或維持現狀。建議先確認 GPT 實際回傳結構後再決定，避免過度擴大改動範圍（Karpathy §1.3 外科手術式修改）。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `src/app/api/documents/[id]/route.ts` | BUG-1：來源 fallback `'AZURE_DI'` → `'GPT_VISION'`（line 90）；BUG-2：`displayName` 由原始 key 改用 i18n／欄位定義 label（line 93-95） |
| `src/components/features/document/detail/DocumentDetailTabs.tsx` | BUG-2（可選）：守衛 line 196 放寬為 extractedFields 或 lineItems 任一有值即渲染面板 |
| `src/components/features/document-preview/ExtractedFieldsPanel.tsx` | BUG-2：強化 header 欄位區與 line items 區的視覺區隔 |
| `src/services/extraction-v3/stages/stage-3-extraction.service.ts` | BUG-3：`convertRawLineItems`（line 1224）改讀 GPT per-item confidence；（可選）line 987 header fallback 一併評估 |
| `messages/{en,zh-TW,zh-CN}/*.json` | BUG-2：如新增使用者可見文字（分區標題／label），三語言同步 |

> 上表為依分析預填，修復完成後須更新為實際修改的檔案。

---

## 修復優先級與順序建議

| 順序 | Bug | 優先級 | 理由 |
|------|-----|--------|------|
| 1 | BUG-1 | 高 | 明確的顯示 bug、根因單一、主方案僅一行 fallback 修改，風險最低、見效最快 |
| 2 | BUG-2 | 高 | 顯示／UX 問題，已資料庫實機定性（非資料面）；涉及 i18n（H5）與版面調整，工作量稍大但價值高 |
| 3 | BUG-3 | 中 | 資料準確度改善（信心度顯示真實值），需先確認 GPT 回傳結構，不阻塞前兩項交付 |

**建議順序**：BUG-1 → BUG-2 → BUG-3。BUG-1 可獨立先行交付（單行低風險）；BUG-2 與 i18n 同步綁定；BUG-3 需驗證 GPT 回傳結構後再動，避免擴大範圍。

---

## Hard Constraint 檢查

| 約束 | 是否觸發 | 說明 |
|------|----------|------|
| H1（架構／三層映射／信心度路由／schema） | ❌ 不觸發 | 不改三層映射、不改信心度路由邏輯、不改 Prisma schema；BUG-3 僅修正信心度**取值來源**（讀真實值取代寫死常數），非改路由閾值或權重 |
| H5（i18n／硬編碼） | ⚠️ 可能觸發 | BUG-2 `displayName` 接 i18n、若新增使用者可見文字（分區標題等）→ 必須三語言同步 + `npm run i18n:check` |

---

## 測試驗證

修復完成後需驗證：

- [ ] **BUG-1**：開啟 V3.1 提取文件（如 `144651e4-...`），Extracted Fields tab 欄位來源標籤不再顯示「Azure DI」，改為反映 GPT 提取的來源標籤（樣式正確、非藍底 Azure DI）。
- [ ] **BUG-2-a**：header 欄位以友善 label 顯示（非原始 key 如 `airline_document_charge`）。
- [ ] **BUG-2-b**：header 欄位區與 line items 區視覺上明確區隔，不再讓人誤判「只有 line items」。
- [ ] **BUG-2-c**（若採守衛放寬）：header 欄位為空但有 line items 時，面板仍正常渲染 line items。
- [ ] **BUG-3**：line items 信心度顯示 GPT 實際回傳值（不再全為 85）；無回傳值時退回合理 fallback。
- [ ] `npm run type-check` 通過。
- [ ] `npm run lint` 無 warning。
- [ ] 若涉及 i18n：`npm run i18n:check` 通過、三語言同步、瀏覽器無 IntlError。
- [ ] 回歸：舊 unified-processor 路徑文件（若有）來源標籤未被反向誤標（視 BUG-1 是否採進階方案）。

---

*文件建立日期: 2026-06-20*
*最後更新: 2026-06-20*
