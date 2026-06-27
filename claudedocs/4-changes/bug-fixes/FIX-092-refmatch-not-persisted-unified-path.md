# FIX-092: referenceNumberMatch 未被持久化 — Template Instance 的 _ref_number 永遠空值

> **建立日期**: 2026-06-26
> **發現方式**: 用戶測試（Template Instance 加入 CEVA 出口文件後，shipment_number 等 ref 欄位持續空值）+ 代碼追蹤
> **影響頁面/功能**: 文件提取管線持久化（`UnifiedDocumentProcessor` 主路徑）→ Template Instance 參考編號注入（`_ref_number` / `_ref_{TYPE}`）
> **優先級**: 高
> **狀態**: ✅ 已修復（2026-06-26）— `convertV3Result` + `persistProcessingResult`（create/update）補接 `referenceNumberMatch`（仿既有 `fxConversionResult` 接線）+ `UnifiedProcessingResult` type 新增欄位；`type-check` 通過、改動 3 檔 `lint` 0 error。**待用戶重新處理文件驗證** `_ref_number` 實際注入

---

## 問題描述

Template Field Mapping 以 `_ref_number` 作為 sourceField（映射到模板的 `shipment_number` 等目標欄位）時，執行 Template Instance 匹配後該欄位**永遠為空**，即使：

- `PipelineConfig.refMatchEnabled`（GLOBAL）= `true`（功能已啟用）
- ReferenceNumber 主檔存在對應號碼（如 `CEX240464`），且檔名 `CEVA LOGISTICS_CEX240464_39613` 含該號碼，子字串匹配可命中
- 文件處理已完成（`MAPPING_COMPLETED`），費用等其他欄位正常

直接觀察：`extraction_results.referenceNumberMatch` 欄位**全部為 NULL**（多份文件一致），但 `pipeline_steps` 顯示 `REFERENCE_NUMBER_MATCHING` 步驟 `success: true`。

> **背景**：`_ref_number` 不是文件內容提取欄位，而是 pipeline「參考編號匹配」（`reference-number-matcher.service.ts`，CHANGE-036）的產物——拿**檔名**對 ReferenceNumber 主檔做 DB 子字串匹配（ILIKE），結果存入 `ExtractionResult.referenceNumberMatch`，Template 匹配時由 `template-matching-engine.injectRefNumberFields`（CHANGE-047，第 633 行）注入為 `_ref_*` 合成來源欄位。

---

## 重現步驟

1. 確認 GLOBAL `PipelineConfig.refMatchEnabled = true`，且 ReferenceNumber 主檔有與文件檔名相符的號碼
2. 上傳或重新處理一份文件（走 `/api/documents/[id]/process` 或 `/api/documents/upload`）
3. 建立 Template Field Mapping，以 `_ref_number` → 目標欄位（如 `shipment_number`）
4. 建立 Template Instance 並加入該文件、執行匹配
5. 觀察現象：目標欄位空值；查 DB `extraction_results.referenceNumberMatch` = NULL，但 `pipeline_steps` 內 `REFERENCE_NUMBER_MATCHING` = `success: true`

---

## 根本原因

文件處理（上傳 + 重新處理）走 `UnifiedDocumentProcessor` → `persistProcessingResult`。ref matching 在 V3 pipeline 內**確實執行**（`extraction-v3.service.ts:368-374`，`V3Output.referenceNumberMatch` 於第 685 行有值），但結果在往 DB 的路徑上被**兩處同時漏接**，與 FX 換算（已由 CHANGE-072 正確接線）形成不對稱遺漏。

### 斷點 A — `convertV3Result` 丟棄 referenceNumberMatch

`src/services/unified-processor/unified-document-processor.service.ts:310` `convertV3Result()` 將 `ExtractionV3Output` 轉為 `UnifiedProcessingResult`。其 return 物件（成功分支 404-472+）**完全沒有帶入 `referenceNumberMatch`**（整個檔案未出現該識別符），但有保留 `exchangeRateConversion`、`stepResults` 與 `lineItems`。

→ 這解釋了為何 `pipeline_steps` 看得到 `REFERENCE_NUMBER_MATCHING success:true`（`stepResults` 第 409 行有保留步驟摘要），卻沒有實際匹配結果（`referenceNumberMatch` 被丟棄）。

### 斷點 B — `persistProcessingResult` upsert 無 referenceNumberMatch 欄位

`src/services/processing-result-persistence.service.ts:218` `persistProcessingResult()` 的 `extractionResult.upsert`，`create`（266-306）與 `update`（307-344）兩個區塊**皆無 `referenceNumberMatch` 欄位**（對照：兩區塊都有寫 `fxConversionResult`，見 302-305 / 340-343）。

### 旁證 — 正確接線寫在 dead code

唯一會寫入 `referenceNumberMatch` 的 `persistV3_1ProcessingResult()`（同檔，第 617 / 666 行）**沒有任何呼叫端**（全專案 Grep 僅見定義），屬 dead code。`/api/documents/[id]/process:178` 與 `/api/documents/upload` 實際呼叫的是 `persistProcessingResult`。

### 串接結論

V3 pipeline 算出 `referenceNumberMatch` → `convertV3Result` 未帶入 `UnifiedProcessingResult`（斷點 A）→ `persistProcessingResult` 亦無此欄位（斷點 B）→ `extraction_results.referenceNumberMatch` 永遠 NULL → `injectRefNumberFields` 讀到 NULL、不注入 `_ref_number` → 模板目標欄位永遠空值。所有走 unified 路徑的文件皆受影響。

---

## 解決方案

仿 `exchangeRateConversion` / `fxConversionResult` 既有接線（CHANGE-072），補上 ref matching 的等價持久化兩處：

### 修復 A — `convertV3Result` 帶入 referenceNumberMatch

`unified-document-processor.service.ts`：
1. `UnifiedProcessingResult` type 新增 `referenceNumberMatch?: ReferenceNumberMatchResult`（與 `exchangeRateConversion` 並列）。
2. `convertV3Result()` 成功分支 return 補 `referenceNumberMatch: v3Result.referenceNumberMatch`（仿 `exchangeRateConversion` 寫法）。

### 修復 B — `persistProcessingResult` upsert 寫入 referenceNumberMatch

`processing-result-persistence.service.ts` 的 `extractionResult.upsert`，`create` 與 `update` 兩區塊各補：

```ts
referenceNumberMatch: result.referenceNumberMatch
  ? (result.referenceNumberMatch as unknown as Prisma.InputJsonValue)
  : undefined,
```

（仿同檔 `fxConversionResult` 第 302-305 / 340-343 的條件寫法。）

> **注意**：`persistV3_1ProcessingResult` dead code 暫不刪除（屬清理範疇，避免擴大本次 scope）；僅在本 FIX 記錄其為未接線之冗餘。

### 生效條件

修復後需**重新處理文件**（重跑 pipeline + 新持久化邏輯），`referenceNumberMatch` 才會寫入；既有文件的舊提取結果不會自動回填。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `src/types/unified-processor.ts` | import `ReferenceNumberMatchResult`；`UnifiedProcessingResult` 新增 `referenceNumberMatch?` 欄位（與 `exchangeRateConversion` 並列） |
| `src/services/unified-processor/unified-document-processor.service.ts` | `convertV3Result` 成功分支 return 補 `referenceNumberMatch: v3Result.referenceNumberMatch`（斷點 A 修復） |
| `src/services/processing-result-persistence.service.ts` | `persistProcessingResult` 的 `extractionResult.upsert` create + update 各補 `referenceNumberMatch` 條件寫入（斷點 B 修復，仿 `fxConversionResult`） |

---

## 測試驗證

修復完成後需驗證：

- [x] `npm run type-check` 通過（2026-06-26，`tsc --noEmit` 無錯誤）
- [x] `npm run lint` 改動 3 檔 0 error（既有 `console`/`unused-vars` warning 非本次引入）
- [ ] 重新處理一份檔名含主檔號碼的文件（如 `CEVA LOGISTICS_CEX240464_39613.pdf`），查 `extraction_results.referenceNumberMatch` 不再為 NULL，且 `summary.matchesFound > 0`（待用戶驗證）
- [ ] 該文件加入 Template Instance 並執行匹配後，`_ref_number` 映射的目標欄位（如 `shipment_number`）顯示匹配到的號碼（`CEX240464`）（待用戶驗證）
- [ ] 確認 FX 換算（`fxConversionResult`）仍正常（無回歸）（待用戶驗證）
- [ ] `pipeline_steps` 的 `REFERENCE_NUMBER_MATCHING` 與實際 `referenceNumberMatch` 結果一致（待用戶驗證）

---

## 關聯背景

本 FIX 是 CEVA Template Instance 測試串中第 3 個（亦最後一個）獨立問題，前兩者已處理：
1. 公司重複 → COMPANY 級 Template Field Mapping 對不上（已用 `mergeCompanies` 合併 CEVA 3 筆）
2. 公司重複 → Field Definition Set 未生效、提取走 fallback（重新處理後費用正常）
3. **本 FIX**：ref matching 結果未持久化（與公司重複無關，純 unified 路徑接線缺失）

---

*文件建立日期: 2026-06-26*
*最後更新: 2026-06-26*
