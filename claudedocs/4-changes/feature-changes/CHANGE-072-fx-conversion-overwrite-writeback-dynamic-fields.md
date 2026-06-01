# CHANGE-072: 匯率換算覆蓋寫回 + 動態 currency 欄位支援

> **日期**: 2026-06-01
> **狀態**: ✅ 已完成（程式碼；type-check / lint 通過。端到端 runtime 驗證待 THB 匯率資料 + 測試發票，見「實作完成記錄」）
> **優先級**: Medium
> **類型**: Feature
> **影響範圍**: V3.1 提取管線匯率換算器 / Stage 3 結果欄位 / 動態欄位（FieldDefinitionSet）/ 下游顯示與匯出（自動）
> **關聯**: CHANGE-071（FORMAT scope 條件式 FX）、CHANGE-032（FX 初版）、FIX-037（FX bug）、CHANGE-042（FieldDefinitionSet 動態欄位）、Epic 21（匯率）

---

## 變更背景

CHANGE-071 完成了「**何時換、換成什麼幣別、只換哪些來源幣別**」的設定層 + Stage 3 之後的**確定性後處理換算**。但實測資料流 trace 後發現兩個缺口，導致用戶看不到換算結果：

1. **動態 `fields` 沒被換算**：用戶為 17 間公司建立的 195 個 currency 費用欄位是 **CHANGE-042 動態欄位**（`Stage3ExtractionResult.fields: Record<string, FieldValue>`）。持久化**優先使用 `fields`**（`processing-result-persistence.service.ts` line 513-517），但現有換算器**只換** `standardFields.totalAmount/subtotal` + `lineItems` + `extraCharges`，**完全沒處理 `fields`** → 用戶真正的金額欄位根本不會被換算。

2. **換算值另存、下游看不到**：換算值只存在 `processing_queues.fxConversionResult`（JSON），**原始欄位不被覆蓋**。文件詳情、審核頁、Data Template 匯出讀的都是 `ExtractionResult.fieldMappings`/`stage3Result`，**不讀 `fxConversionResult`** → 換算了但畫面/匯出看不到。

### 用戶需求（已確認）

> 用戶上傳文件 → 該格式的「要求」是把金額換成指定幣別（例：泰銖 THB → 港元 HKD）→ **所得數據即換算後金額**。經討論確認採「**確定性換算 + 覆蓋寫回**」（非 LLM 在 Stage 3 prompt 內換算，以避開 LLM 算術精確度風險，並保留原值供審計）。

### 為何不採「Stage 3 prompt 注入由 LLM 換算」

用戶最初設想把匯率注入 Stage 3 prompt 讓 GPT 邊提取邊換。經評估，LLM 做「金額 × 匯率」的乘法**不保證精確**（財務數據誤差源，項目目標準確率 90-95% + 審計追溯 Epic 8）。改採確定性程式碼換算，精確且保留原值；覆蓋寫回後下游同樣自動可見。（用戶已選此方案。）

---

## 變更內容

### 變更項目 1：換算器擴充到動態 `fields`（currency 欄位）

`ExchangeRateConverterService` 除現有 `standardFields`/`lineItems`/`extraCharges`，**新增處理 `stage3Result.fields`**：

- 透過 `stage3Result.meta.fieldDefinitionSetId` 取得 FieldDefinitionSet，挑出 `dataType === 'currency'` 的欄位 `key`。
- 對 `stage3Result.fields[key]`（`FieldValue`，含 `.value`）做換算。
- `fields` 為 `Record<string, FieldValue>`、key 為 snake_case（如 `sea_freight`），與 FieldDefinitionEntry.key 對應。
- 無 FieldDefinitionSet（`fieldDefinitionSetId` 為 null）時，退回現有行為。

### 變更項目 2：覆蓋寫回（overwrite）

換算**成功**的欄位，直接覆蓋其值為換算後金額；`currency` 設為目標幣別；**原值保留在 `fxConversionResult`** 供審計：

| 結構 | 覆蓋 |
|------|------|
| `stage3Result.fields[key].value` | = `convertedAmount`（currency 欄位） |
| `stage3Result.standardFields.totalAmount.value` / `subtotal.value` | = `convertedAmount` |
| `stage3Result.standardFields.currency.value` | = `targetCurrency` |
| `stage3Result.lineItems[i].amount` | = `convertedAmount` |
| `stage3Result.extraCharges[i].amount` | = `convertedAmount`；`extraCharges[i].currency` = `targetCurrency` |

> 換算**失敗/略過**（無匯率、來源幣別不符 `fxSourceCurrencies` 過濾）→ **不覆蓋**，保留原值。

### 變更項目 3：來源幣別偵測確認

換算器目前從 `standardFields.currency?.value` 取來源幣別。需確認動態欄位文件此值有被填；若無，需補來源（規劃時驗證，見「待釐清項」）。

---

## 技術設計

### 已確認的資料流（trace 結論）

| 環節 | 檔案 | 結論 |
|------|------|------|
| 持久化 | `processing-result-persistence.service.ts` `persistV3_1ProcessingResult`（line 496-744；513-517 優先 `fields`） | `fields`/`standardFields` → `ExtractionResult.fieldMappings`；完整 → `ExtractionResult.stage3Result`；換算 → `fxConversionResult`（分開） |
| 管線輸出 | `extraction-v3.service.ts`（FX 約 line 488-535；存儲 line ~683） | 換算器收 `stage3Result`，目前**不改**它；`fxConversionResult` 與 `stage3Result` 分開存 |
| 文件詳情 | `app/api/documents/[id]/route.ts`（line ~214-242） | 讀 `fieldMappings`（fallback `stage3Result`），**不讀** `fxConversionResult` |
| Data Template 匯出 | `template-export.service.ts`（line ~110-200）+ `template-instance.service.ts` | `TemplateInstanceRow.fieldValues` 從 `fieldMappings`/`stage3Result` 快照建立 |
| 信心度 | `confidence-v3-1.service.ts`（FIELD_COMPLETENESS） | 數非 null 欄位；覆蓋成非 null 值 → **不受影響**；`overallConfidence` 為 GPT 自評，不變 |

→ **覆蓋 `stage3Result` 的欄位（含 `fields`）即足以讓詳情 / 審核 / 匯出自動顯示換算值**，無需改顯示層。

### 修改範圍

| 檔案 | 變更內容 | 實作狀態 |
|------|----------|----------|
| `src/services/extraction-v3/stages/exchange-rate-converter.service.ts` | (1) `convert()` 加 `companyId?`/`formatId?` 參數；(2) 新增 `convertDynamicFieldsCached`：載入合併 FieldDefinitionSet → 篩 `dataType==='currency'` → 換算並**覆蓋** `fields[key].value`；(3) `convertStandardFieldsCached`/`convertLineItemsCached`/`convertExtraChargesCached` 加**覆蓋寫回**（原本只記 `conversions[]`）；(4) 主幣別已換算時覆蓋 `standardFields.currency.value` 為目標幣別；(5) **就地 mutate** `stage3Result` | ✅ 完成 |
| `src/services/field-definition-set.service.ts` | 新增 `getMergedResolvedFields(companyId, formatId)`：3 層合併（GLOBAL→COMPANY→FORMAT）回傳完整欄位定義，與 stage-3 提取語意一致（用於判定 currency 動態欄位 key） | ✅ 完成（新增） |
| `src/services/extraction-v3/extraction-v3.service.ts` | FX 步驟傳入 `companyId`（Stage 1）/`formatId`（Stage 2）給 `converter.convert()`；就地 mutate 後的 `stage3Result` 經輸出 `result`（引用）→ persistence 自動帶覆蓋值 | ✅ 完成 |
| ~~`src/types/extraction-v3.types.ts`~~ | **不修改**（依待釐清項 3：行項不另加原值欄位，審計已在 `fxConversionResult`） | ❌ 未改 |

> 顯示層（詳情 / 審核 / 匯出 / 信心度）**不需修改** —— 覆蓋後自動帶值（已 trace 確認）。

### FieldDefinitionSet 載入策略（已定：A，實作時精修）

- **A（自足，採用）**：換算器自行載入 FieldDefinitionSet，篩 `dataType==='currency'` 得 currency 欄位 key。不改 stage 輸出 contract。
- **B（複用，不採用）**：需 Stage 3 將 currency 欄位 key 附加進 `stage3Result`（改變 stage 輸出 contract + 多層 plumbing）。

#### ⚠️ 實作時發現並修正（P0）

原規劃寫「以 `meta.fieldDefinitionSetId` 載入」，實作時 trace 發現兩點需修正：

1. **欄位名**：`fieldDefinitionSetId` 是 `Stage3ExtractionResult` 的**直接屬性**（非 `meta.fieldDefinitionSetId`；後者是 `ExtractedFieldsV4` 的）。
2. **單一 setId 載入不足**：`stage3Result.fieldDefinitionSetId` 只存「**最具體那一層**」（FORMAT > COMPANY > GLOBAL）的 set id。但 stage-3 實際提取用的是 **3 層合併**（`loadFieldDefinitionSet`：GLOBAL base → COMPANY override → FORMAT override），`stage3Result.fields` 的 key 來自合併集。若只 `findUnique(最具體 setId)`，會**漏掉其他層定義的 currency 欄位** → 漏轉。
   - 另注意：既有公開函式 `getResolvedFields` 也只回傳「最具體層」（不合併），同樣不適用。
3. **修正方案**：新增 `getMergedResolvedFields(companyId, formatId)`（與 stage-3 同款 3 層合併），換算器改以 **companyId + formatId** 載入合併集（caller `extraction-v3.service` 已持有 Stage 1 companyId / Stage 2 formatId，直接傳入）。仍屬策略 A（換算器自足、不改 stage contract），只是載入鍵由「單一 setId」改為「companyId+formatId 合併」，更正確。

---

## 設計決策

1. **確定性換算 + 覆蓋寫回，非 LLM 換算** —— 精確、保留原值（`fxConversionResult`），下游零顯示改動。
2. **覆蓋語意**：欄位值直接變目標幣別金額（用戶「數據即換算後金額」）；原值入 `fxConversionResult` 審計。
3. **動態 currency 欄位以 FieldDefinitionSet `dataType==='currency'` 判定** —— `fields` 本身不帶 dataType，須靠定義集。
4. **就地 mutate vs 回傳新物件**：傾向換算器**就地修改** `stage3Result`（呼叫端已持有同一物件，後續 persistence 自然拿到覆蓋版）；保持回傳 `fxConversionResult` 不變。需確認 `threeStageResult.stage3` 後續無被深拷貝。
5. **失敗不覆蓋** —— 無匯率 / 來源幣別被 `fxSourceCurrencies` 過濾掉 → 保留原值，避免污染。

---

## 影響範圍評估

### 文件影響清單

| 文件路徑 | 類型 | 說明 |
|----------|------|------|
| `src/services/extraction-v3/stages/exchange-rate-converter.service.ts` | 🔧 修改 | 動態欄位換算 + 覆蓋寫回 + FieldDefinitionSet 載入 |
| `src/services/extraction-v3/extraction-v3.service.ts` | 🔧 修改（小） | 確保覆蓋版 stage3Result 流向 persistence |
| `src/types/extraction-v3.types.ts` | 🔧 修改（可選） | lineItem/extraCharge 原值欄位（如採保留原值） |

### 向後兼容性

- 無 FieldDefinitionSet 的文件 → 退回現有 standardFields/lineItems/extraCharges 換算行為。
- 未啟用 FX（`fxConversionEnabled=false`）→ 完全不覆蓋，行為不變。
- **既有已處理文件 / 已建立的 TemplateInstance 不會回溯更新**（僅對新處理生效）。
- `fxConversionResult` 結構不變（仍存原值/換算值）。

---

## 實施計劃（分階段）

| 階段 | 內容 | 驗證 |
|------|------|------|
| **P0 驗證資料流假設** | 確認 (a) 動態欄位文件 `standardFields.currency` 有值；(b) `threeStageResult.stage3` 後續未被深拷貝（就地 mutate 有效）；(c) orchestrator 是否已持 FieldDefinitionSet（決定載入策略 A/B） | 讀碼 + 一次實測 |
| **P1 換算器覆蓋寫回** | standardFields/lineItems/extraCharges 改為覆蓋 + currency 設目標 | 單元/煙霧：欄位值變換算後 |
| **P2 動態 fields 換算** | 載入 FieldDefinitionSet → currency 欄位換算 + 覆蓋 | THB 動態 currency 欄位 → HKD |
| **P3 管線整合** | 確保 persistence 拿到覆蓋版 stage3Result | 端到端 |
| **P4 收尾** | type-check / lint / i18n（本變更預期無 i18n） | 全綠 |

---

## 風險評估

| 風險 | 等級 | 緩解 |
|------|------|------|
| 來源幣別 `standardFields.currency` 未填 → 換算略過 | 中 | P0 驗證；必要時從 `fields`/config 補來源幣別 |
| 就地 mutate 後 stage3Result 被別處深拷貝 → 覆蓋遺失 | 中 | P0 驗證流向；必要時改回傳新物件 |
| 同一金額在 `fields` 與 `standardFields` 重複 → 重複換算 | 低 | 以 `fields`（持久化主來源）為準；standardFields 換算僅影響 stage3Result JSON 副本，不影響 fieldMappings 顯示 |
| 覆蓋污染原值（換算錯誤時） | 低 | 失敗不覆蓋 + 原值留 `fxConversionResult` |
| FIELD_COMPLETENESS 受影響 | 低 | 覆蓋為非 null → count 不變 |

---

## 回滾計劃

- 純程式邏輯變更，無 schema/migration。
- 覆蓋邏輯可由 PipelineConfig `fxConversionEnabled` 關閉即停（事實回滾）。
- 各階段獨立 commit，可逐步 revert。

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | 動態 currency 欄位換算 | THB 文件之 `fields` 中 `dataType='currency'` 欄位 → 值變 HKD | High |
| 2 | 覆蓋寫回下游可見 | 文件詳情 / Data Template 匯出顯示換算後 HKD 金額（無顯示層改動） | High |
| 3 | 原值保留 | `fxConversionResult` 仍含原 THB 金額（審計可查） | High |
| 4 | currency 欄位 | 顯示目標幣別 HKD | Medium |
| 5 | 失敗不覆蓋 | 無匯率 / 來源幣別被過濾 → 保留原值 | High |
| 6 | 信心度不受影響 | 覆蓋後 `overallConfidence` / FIELD_COMPLETENESS 不降 | Medium |
| 7 | 品質閘 | type-check / lint 通過 | High |

---

## 測試場景

| # | 場景 | 步驟 | 預期 |
|---|------|------|------|
| 1 | 動態 currency 欄位 THB→HKD | 公司+格式有 FieldDefinitionSet（currency 欄位）+ FORMAT FX config（target HKD, sources THB）→ 上傳 THB 發票 | `fields` 之 currency 欄位值變 HKD，詳情/匯出顯示 HKD |
| 2 | 原值審計 | 同上 | `fxConversionResult` 含原 THB 值 + 匯率 |
| 3 | 非目標來源幣別 | 同 config，上傳 USD 發票（sources=THB） | 不覆蓋，仍顯示 USD |
| 4 | 無匯率 | 上傳幣別無對應匯率的文件 | 不覆蓋，記 warning |
| 5 | 無 FieldDefinitionSet | 純 standardFields 文件 | 退回 standardFields/lineItems 換算 + 覆蓋 |
| 6 | 信心度 | 對比覆蓋前後 | 信心度不降 |

---

## 待釐清項（已解決 — 2026-06-01 用戶確認）

1. **來源幣別來源** ✅：文件正常含幣別單位 → 優先取 `standardFields.currency.value`（標準提取欄位）。**P0 實測驗證**動態欄位文件此值是否穩定填入；若不足，再補 fallback（從 `fields` 之幣別欄位或 config 指定）。先以 primary 實作。
2. **FieldDefinitionSet 載入策略** ✅：採 **A（換算器自足載入 by `meta.fieldDefinitionSetId`）** —— 自足、不改 stage contract、PK 查詢成本可忽略。
3. **行項保留原值欄位** ✅：**不另加**。標準審計已在 `fxConversionResult`。

---

## 實作完成記錄（2026-06-01）

### P0 驗證結論（程式碼 trace 確認）

| 假設 | 結論 | 依據 |
|------|------|------|
| (a) 來源幣別讀 `standardFields.currency.value` | ✅ 採用 primary；既有 FX 已依賴此值 | converter line 75；runtime 資料本 session 無 THB 測試發票，無法實跑（見下方 caveat） |
| (b) 就地 mutate 有效（會傳到下游） | ✅ 確認 | FX 在 `processFileV3_1` 內先跑；輸出 `result.{fields,standardFields,lineItems}` 為引用（extraction-v3.service line 632-661）；unified-processor line 482-485 雖淺拷貝，但共享被 mutate 的**巢狀** FieldValue/LineItem 物件 → 覆蓋值保留 |
| (c) FieldDefinitionSet 載入 | ✅ 改用 companyId+formatId 3 層合併（見「載入策略 P0 修正」） | stage-3 `loadFieldDefinitionSet` 合併語意 |
| 持久化以 `fields` 為主 | ✅ 覆蓋 `fields[k].value` → `ExtractionResult.fieldMappings` → 詳情/匯出顯示 | persistence line 513-517 |
| 信心度不受影響 | ✅ `mappedFields` 算非 null（line 524-529）、`FIELD_COMPLETENESS` 只看 standardFields 必填非 null（confidence-v3-1 line 308-322）；覆蓋成非 null 不減分 | — |

### 實際改動檔案（3 個）

1. `src/services/field-definition-set.service.ts` — 新增 `getMergedResolvedFields(companyId, formatId)`（3 層合併）。
2. `src/services/extraction-v3/stages/exchange-rate-converter.service.ts` — `convert()` 加 companyId/formatId；3 個既有換算方法加覆蓋寫回；新增 `convertDynamicFieldsCached`；覆蓋 `currency` 為目標幣別；header `@features`/`@lastModified` 更新。
3. `src/services/extraction-v3/extraction-v3.service.ts` — `converter.convert()` 傳入 companyId（Stage 1）/formatId（Stage 2）。

> `src/types/extraction-v3.types.ts` 依待釐清項 3 **未改**（行項不另加原值欄位）。

### 品質閘

- `npm run type-check`：本次 3 個檔案**零錯誤**（既有錯誤僅 `CityDetailPanel.tsx` recharts 型別 + `batch-processor-parallel.test.ts` 缺 @types/jest，均 pre-existing 無關）。
- `npx eslint`（3 檔）：本次改動**零問題**；`extraction-v3.service.ts` 既有 9 warning（未使用 import + console）為 pre-existing，依外科手術原則不動。
- i18n：本變更為後端服務、無 UI 字串 → 無需同步。

### ⚠️ Runtime 端到端驗證 caveat（誠實揭露）

程式邏輯與資料流已由 type-check + 完整 trace 驗證，但**尚未跑過真實 THB→HKD 文件**，原因：

1. `exchange_rates` 目前**無 THB 匯率資料**（只有 USD↔{AUD,CNY,EUR,GBP,HKD,JPY,SGD,TWD}）→ 缺 THB 對 HKD 的匯率，換算會走 fallback（warn/skip，不覆蓋）。
2. 本 session 無對應公司 × 格式 + currency 動態欄位的 THB 測試發票。

→ 待補 THB 匯率資料 + 測試發票後，依「測試場景」表跑 E2E 確認 driver。**程式碼層已可用**，功能由 PipelineConfig `fxConversionEnabled` + FORMAT scope 條件驅動（CHANGE-071）。

---

## E2E 測試與後續修正（2026-06-01，真實發票 + 真實管線）

用戶選擇完整 E2E。以真實發票 `CARGO LINK_HEX240655B_09047.pdf` 上傳 → V3.1 全管線（GPT 三階段 + FX）驗證。

### 測試設置
- 公司：CARGO LINK LOGISTICS（`1ee2d6e3…`），FX 設定 COMPANY scope、target USD、sources [HKD]。
- 匯率：補一筆 **2024 年** HKD→USD（原本只有 2026 年；發票日期 2024-09-16，FIX-037 後 `convert()` 依發票年份查匯率，年份不符會略過 → 第一次跑沒換成功，補 2024 匯率後成功）。

### ✅ 驗證結果
| 項目 | 結果 |
|------|------|
| Stage 1 公司識別 | 正確識別 Cargo Link → 命中 FX 設定 |
| `currency` | HKD → USD（覆蓋）|
| `total_amount`（動態）| 5475 → 700.13（單次）|
| 6 個 lineItems | 各自單次換算（63.94 / 345.27 / 1.92 / 138.11 / 12.79 / 138.11）|
| 下游可見 | `field_mappings` 已是換算值 |
| 審計原值 | `fx_conversion_result` 保留 `totalAmount: 5475→700.13` 等原值 |

### 🐞 測試抓到的 Bug 1：雙重換算（已修）
`standardFields.totalAmount` 與動態 `fields.total_amount` 在 stage-3 是**同一個 FieldValue 物件（別名）**，被 standardFields 與動態兩條路徑各換一次 → 5475→700.13→**89.53**（錯）。
- **修法**：`exchange-rate-converter.service.ts` 在 `convert()` 建立 `Set<FieldValue>`，跨 `convertStandardFieldsCached` / `convertDynamicFieldsCached` 共享，以**物件身分去重**，每個 FieldValue 只換一次（審計也不重複）。
- **重驗**：89.53 → 700.13（正確單次）。

### ⚠️ 測試抓到的 Gap 1：審計原值未持久化（已修，納入 CHANGE-072）
`process`/`upload` 路由用 legacy `persistProcessingResult`，原本**不存 `fxConversionResult`**，而 unified processor 的 result 也未帶 FX 資料 → 覆蓋寫回後原值在 DB 遺失（違反「原值可審計」前提）。
- **修法（3 檔）**：
  1. `src/types/unified-processor.ts`：result interface 加 `exchangeRateConversion?: ExchangeRateConversionResult`。
  2. `src/services/unified-processor/unified-document-processor.service.ts`：`buildResult` 帶上 `v3Result.exchangeRateConversion`。
  3. `src/services/processing-result-persistence.service.ts`：`persistProcessingResult` 的 upsert（create + update）存 `fxConversionResult`。
- **重驗**：`extraction_results.fx_conversion_result` 已持久化（enabled、HKD→USD、8 筆 conversions 含原值）。

### 🔜 Gap 2（另立 CHANGE）：來源幣別 fallback
有 currency 動態欄位但無幣別代碼欄位的公司（如 Fairate），`standardFields.currency` 為空 → FX 略過。需「由 PipelineConfig 指定來源幣別」的增強。**已另立 CHANGE-073**（屬新功能，且為真實 THB→HKD 場景關鍵）。

### 最終改動檔案（CHANGE-072 全部）
| 檔案 | 內容 |
|------|------|
| `field-definition-set.service.ts` | 新增 `getMergedResolvedFields`（3 層合併）|
| `extraction-v3/stages/exchange-rate-converter.service.ts` | 動態欄位換算 + 覆蓋寫回 + 物件身分去重 |
| `extraction-v3/extraction-v3.service.ts` | 傳入 companyId / formatId |
| `types/unified-processor.ts` | result 加 `exchangeRateConversion` |
| `unified-processor/unified-document-processor.service.ts` | buildResult 帶上 FX 結果 |
| `processing-result-persistence.service.ts` | 持久化 `fxConversionResult` 審計 |

### 測試暫存物（dev DB，待清理）
- FX PipelineConfig `cmpvahtkw…`（Cargo Link）
- 匯率 `chg072-hkd-usd-2024`
- 上傳文件 `b551ef8c…`（值已換算）

---

*文件建立日期: 2026-06-01*
*最後更新: 2026-06-01*
*狀態: ✅ 已完成 — type-check / lint 通過；真實發票 E2E 驗證通過（含 2 個測試發現的修正）；來源幣別 fallback 另立 CHANGE-073*
