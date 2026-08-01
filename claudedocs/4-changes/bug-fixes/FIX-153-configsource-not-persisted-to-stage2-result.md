# FIX-153: `configSource` 從未寫入 `stage_2_result` —— 「配置由 LLM 推斷 → 降級」無從判斷

> **建立日期**: 2026-08-01
> **發現方式**: FIX-148 影響評估時，發現 802 份提取結果的 `stage_2_result` **全部**沒有 `configSource` key
> **影響範圍**: `src/types/extraction-v3.types.ts`、`src/services/extraction-v3/extraction-v3.service.ts`、`src/services/unified-processor/unified-document-processor.service.ts`
> **優先級**: 中（不影響金額或提取正確性；但使 FIX-148 的降級條件之一無從評估，也無法事後稽核「這份文件當時用了哪種配置」）
> **狀態**: ✅ 已實作（2026-08-01，本地 `type-check` / `lint` / `test` 452 通過零回歸；⏳ 待部署 Azure DEV 後以資料驗證）
> **相關**: [FIX-148](FIX-148-v31-pipeline-discards-routing-decision.md)（本 FIX 是其「先補資料再評估」路徑的前置）、FIX-092 / FIX-146 / FIX-147 / CHANGE-113（同型的逐層漏接）

---

## 問題

`applyRoutingStrategy` 的降級條件之一是「配置由 LLM 推斷」：

```typescript
// confidence-v3-1.service.ts:443
const shouldDowngradeByConfig = stage2Result.configSource === 'LLM_INFERRED';
```

但 `extraction_results.stage_2_result` 裡**沒有這個欄位**。

**查證（Azure DEV，2026-08-01）**：802 份有路由結果的文件，`stage_2_result` 缺 `configSource` 者 **802 / 802（100%）**。實際的 key 只有四個：`formatId`、`formatName`、`confidence`、`isNewFormat`。

後果：

| 影響 | 說明 |
|---|---|
| FIX-148 影響評估不完整 | 三個「降一級」條件中的一個**無法量化**，其結論只能表述為「真實衝擊 ≥ 已算出的數字」 |
| 無法事後稽核 | 查不到某份文件當時究竟用了公司特定配置、統一配置，還是 LLM 自行推斷 |
| 型別誤導 | `unified-processor.ts:554` 宣告了 `configSource?: string`，讀型別會以為資料有 |

> 這**不影響**目前的線上行為 —— 該降級條件本來就因 FIX-148 而未生效。修好後也不會自己開始降級，除非 FIX-148 一併啟用。

---

## 根本原因：三層構造點都沒帶這個欄位

值在 Stage 2 產生（`stage-2-format.service.ts:199` `configSource: formatConfig.source`），但往上傳的路上逐層被丟掉：

| # | 位置 | 構造的物件 | 狀況 |
|---|---|---|---|
| 1 | `extraction-v3.types.ts:229` | `FormatIdentificationResultV3` | 型別**根本沒有**這個欄位 |
| 2 | `extraction-v3.service.ts:726` | `formatIdentification` | 只挑了 4 個欄位 |
| 3 | `unified-document-processor.service.ts:506` | `stage2Result` | 同樣只挑 4 個（上游本來也沒有） |

第 1 層沒有欄位 → 第 2、3 層即使想填也填不了。三層都要補才會進資料庫。

### 🔴 修復時的陷阱：頂層的 `configSource` 是**另一個**值

`extraction-v3.service.ts:700-702` 輸出的頂層 `configSource` 已被映射成另一套詞彙：

```typescript
const configSource = threeStageResult.stage2?.configSource || 'LLM_INFERRED';  // 原始值
return {
  configSource: configSource === 'COMPANY_SPECIFIC' ? 'FORMAT'
    : configSource === 'UNIVERSAL' ? 'GLOBAL'
    : 'DEFAULT',                                                                // ← 映射後
```

| | 型別 | 值域 |
|---|---|---|
| Stage 2 原始值 | `FormatConfigSource` | `COMPANY_SPECIFIC` / `UNIVERSAL` / `LLM_INFERRED` |
| 頂層輸出 | `ConfigSourceType` | `FORMAT` / `GLOBAL` / `DEFAULT` |

`generateRoutingDecision` 比對的是 **`=== 'LLM_INFERRED'`**（原始值）。若圖方便把頂層那個已映射的值填進 `stage2Result`，比對永遠不成立 —— 缺陷從「查不到」變成「靜默不觸發」，更難發現。

兩個修改點都已加註解標明此事。

---

## 修復

三層各補一處，全部取 **Stage 2 的原始值**：

1. **`extraction-v3.types.ts`** —— `FormatIdentificationResultV3` 新增 `configSource?: FormatConfigSource`（可選：V3 單階段路徑無 Stage 2，且舊資料不具此欄位）
2. **`extraction-v3.service.ts:726`** —— `configSource: threeStageResult.stage2?.configSource`
3. **`unified-document-processor.service.ts:506`** —— `configSource: result.formatIdentification.configSource`

`unified-processor.ts:554` 的 `configSource?: string` **未收緊**為 `FormatConfigSource`：那會牽動其他既有使用者，超出本 FIX 範圍。以註解防止誤填。

### 未一併處理：`stage1Result` / `stage2Result` 的 `success`

同樣的漏接也發生在 `success`（`Stage1CompanyResult` / `Stage2FormatResult` 都有，但兩個構造點都沒帶），使「Stage 失敗 → 強制 FULL_REVIEW」同樣無從評估。

**本次不處理**，因為 Stage 失敗的文件多半不會留下 `extraction_results`，實際影響應該極小。列為已知缺口，需要時另立 FIX。

---

## 驗收標準

- [x] `type-check` / `lint` 通過
- [x] 既有測試零回歸（452 passed / 2 skipped）
- [ ] ⏳ 部署 Azure DEV 後，新提取的 `stage_2_result` **含** `configSource`，且值屬於 `COMPANY_SPECIFIC` / `UNIVERSAL` / `LLM_INFERRED`（**不可**是 `FORMAT` / `GLOBAL` / `DEFAULT` —— 那代表填錯成映射後的值）
- [ ] ⏳ 以新資料重跑 FIX-148 影響評估，補上「配置由 LLM 推斷」這項的量化結果
- [ ] ⏳ 更新 `claudedocs/reference/data-semantic-breakpoints.md` 第 2 條：`configSource` 由「從未寫入」改為「FIX-153 起有值」，並登記斷點日期（以 Azure 部署日為準）

### 為何不寫單元測試

這類缺陷的本質是「鏈上某一環構造物件時漏帶欄位」。要用單元測試抓到，得 mock 整條 Stage 2 → V3 → UnifiedProcessor 的鏈，而 mock 本身就在宣告「應該有哪些欄位」—— 測試會與被測代碼同義反覆，漏接照樣通過。

FIX-148 §教訓已記過同源的事：**單元測試綠燈不代表整條鏈通**（FIX-147 的 28 個測試全過，而真實管線根本沒用到被測的函式）。

因此驗收放在**資料層**：部署後查實際寫入的 JSON。這是唯一能證明鏈通了的證據。

---

## 相關

- FIX-148 — 本 FIX 是其「先補 `configSource` 再評估」路徑的前置；完成後該 FIX 的評估才算完整
- FIX-092（`referenceNumberMatch`）、CHANGE-113（`lineItemGroups`）、FIX-146（step `data`）、FIX-147（`lineItemTotalReconciliation`，一次補 3 個型別層）—— 同型漏接，本 FIX 是第五次
- `claudedocs/reference/data-semantic-breakpoints.md` — 修復後此欄位會產生新的語義斷點，需登記
