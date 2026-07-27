# FIX-095: Stage 3 prompt 自相矛盾導致信心度非確定

> **建立日期**: 2026-06-28
> **發現方式**: 用戶回報（本地與 Azure 處理相同文件，信心度差異巨大）
> **影響頁面/功能**: V3.1 三階段提取的信心度計算與路由決策（影響所有文件）
> **優先級**: 高
> **狀態**: ✅ 已修復（本地 + Azure 全鏈完成）— A1+A2+B 程式碼 + A3 DB prompt 更新皆完成；本地與 Azure UI 端到端驗證信心度 ≥90% AUTO_APPROVE（2026-06-29）

---

## 問題描述

同一份發票（`CEVA_HEX250540_49651.pdf`）在本地與 Azure DEV 處理，得到差異巨大的信心度與路由：

| 環境 | 整體信心度 | 等級 | 路由 |
|------|-----------|------|------|
| 本地 | **92.0%** | High Confidence | Auto Approve |
| Azure DEV | **75.8%** | Medium Confidence | Quick Review |

兩個環境使用**相同的程式碼、相同的模型部署名**（Stage 3 = `gpt-5.4-mini-aidocprocessing`、Stage 1/2 = `gpt-5.4-nano-aidocprocessing`），且兩邊組裝出的 Stage 3 prompt **一字不差**。差異並非來自模型強弱或環境配置，而是 **prompt 本身自相矛盾**，導致 GPT 在兩邊各自選擇了一種互斥的輸出格式，進而被信心度公式給出截然不同的分數。

> ⚠️ **本質**：這是**系統性的非確定性問題**，非 Azure 特有。重新處理同一份文件，兩邊都可能翻轉。本地的「高信心度」其實是假象——它甚至沒有把費用填進 `fields`（後續 template 映射會對不上）；Azure 的提取反而更完整正確，卻因沒提取發票基本欄位而被扣分。屬 [[FIX-093]]、CHANGE-094 同源的「GPT 輸出格式非確定」家族問題。

---

## 重現步驟

1. 在本地與 Azure 分別上傳同一份 CEVA 發票（如 `CEVA_HEX250540_49651.pdf`）。
2. 等待處理完成，開啟文件詳情頁 → AI 詳情 → 檢視 Stage 3 GPT Response。
3. 觀察現象：
   - 本地 GPT 回傳 `{ success, confidence, invoiceData: { invoiceNumber, invoiceDate, totalAmount, currency, vendor, lineItems } }` 格式。
   - Azure GPT 回傳 `{ fields: { ...15 個費用 key... }, lineItems: [...含 category...], overallConfidence }` 格式。
   - 兩邊整體信心度分別為 92.0%（High）與 75.8%（Medium）。

---

## 根本原因

### 原因 1：Stage 3 prompt 的 SYSTEM 段與 USER 段要求互斥的輸出格式

| 段落 | 來源 | 要求的格式 |
|------|------|-----------|
| **SYSTEM**（`Required Output Format`） | `prompt-assembly` 動態組裝（含 `Field Extraction Requirements`） | 新格式 `{ fields: { 只列 15 個費用 key }, lineItems, overallConfidence }` —— `fields` 清單**不含**發票基本欄位（invoiceNumber / invoiceDate / vendorName / totalAmount / currency） |
| **USER**（`輸出 JSON 格式`） | **DB `PromptConfig`（GLOBAL scope）**，seed 自 `prisma/seed-data/prompt-configs.ts:138`（`static-prompts.ts:171` 僅為靜態備援，執行時未使用） | 舊格式 `{ success, confidence, invoiceData: { invoiceNumber, invoiceDate, totalAmount, currency, vendor, buyer, lineItems, subtotal } }` |

兩種格式無法同時滿足，GPT 只能選一種遵守，而**這個選擇是非確定的**（同模型、同文件、不同次/不同環境會翻轉）。

### 原因 2：下游解析對兩種格式的處理不對稱，造成 FIELD_COMPLETENESS 維度天差地別

`stage-3-extraction.service.ts` 的 `parseExtractionResult` 分三種 case：

| GPT 回傳格式 | 走的解析分支 | `standardFields`（5 必填欄位）填充結果 |
|-------------|------------|------------------------------------|
| `invoiceData` 包裹（本地） | [FIX-093](FIX-093) `unwrapInvoiceDataFormat` → **Case 3 `convertRawResponseDynamic`**（用 aliases 動態搜尋） | ✅ 透過 `invoice_number` 等別名撈到 → **5 欄位齊全** |
| `fields` 格式（Azure） | **Case 1** → `buildStandardFieldsFromRecord(fields)` | ❌ 該函數只從 `fields` 找 `invoice_number`/`total_amount` 等 key，但 `fields` 只有費用 key → **5 欄位全空** |

關鍵程式碼 `buildStandardFieldsFromRecord`（`stage-3-extraction.service.ts:1264`）只認 `fields` 裡的 `invoice_number`/`invoice_date`/`vendor_name`/`total_amount`/`currency`；Azure 的 `fields` 完全沒有這些 key，故標準欄位全部 fallback 成 `{ value: null, confidence: 0 }`。

### 原因 3：信心度公式中 FIELD_COMPLETENESS 權重 20%，被上述不對稱直接放大

`confidence-v3-1.service.ts` 五維度：STAGE_1_COMPANY 20% / STAGE_2_FORMAT 15% / STAGE_3_EXTRACTION 30% / **FIELD_COMPLETENESS 20%** / CONFIG_SOURCE_BONUS 15%。`calculateFieldCompleteness` 只計算 5 個必填標準欄位（`invoiceNumber`/`invoiceDate`/`vendorName`/`totalAmount`/`currency`）的填充比例。

- 本地（invoiceData 格式）：FIELD_COMPLETENESS ≈ 100
- Azure（fields 格式）：FIELD_COMPLETENESS = 0

**數字驗證**（Azure，反推）：公司 ≈95、格式 ≈95、Stage 3 提取 97、完整度 **0**、配置來源 ≈100
→ `95×0.2 + 95×0.15 + 97×0.3 + 0×0.2 + 100×0.15 ≈ 77`，與實測 75.8% 吻合。**差距幾乎全部來自 FIELD_COMPLETENESS 這 20%**（諷刺的是 Azure 的 Stage 3 提取信心度 97 反而比本地 92 更高）。

### 原因 4：prompt 實際來自 DB，且 Azure 案例「基本欄位根本沒被提取」

實作前深入追查後，修正兩項對方案有重大影響的認知：

1. **執行時的 SYSTEM/USER prompt 來自 DB `PromptConfig`**（`loadPromptConfigHierarchical` 依 FORMAT > COMPANY > GLOBAL 查 DB），內容 seed 自 `prisma/seed-data/prompt-configs.ts`。`getDefaultSystemPrompt()`/`getDefaultUserPrompt()`（英文簡短版）僅在 DB 完全無配置時 fallback，本案未觸及。
   - 完整 SYSTEM = DB `systemPrompt`（中文「你是一位專業…」）+ **程式碼注入**的 `buildFieldDefinitionsSection`（FIX-043，含 `Required Output Format {fields,...}` 與 `Do NOT add fields not in list`）。
   - 完整 USER = DB `userPromptTemplate`（`invoiceData` 格式）。
   - → **改 prompt 必須同時改 seed code 與已部署環境的 DB 記錄**（本地 + Azure），只改 code 不會更新既有 DB。
2. **Azure 的 `fields` 輸出中，發票基本欄位（號碼/日期/總額/幣別）完全沒被提取**（不在 `fields`、不在 `lineItems`、不在頂層）。原因是 SYSTEM 注入的欄位清單只含 15 個費用欄位（CEVA FieldDefinitionSet），且明令「不要加清單外欄位」。
   - → **方案 B（解析 fallback）對此案無效**：沒有數據可撈。方案 B 只能救「GPT 有提取、但放在非標準位置」的情況，無法救「GPT 根本沒提取」。**真正治本必須靠方案 A**（讓 SYSTEM 明確要求提取基本欄位）。

### 待釐清（Open Question）

「為何相同 prompt 下，本地 GPT 偏向回 `invoiceData`、Azure 偏向回 `fields`」尚未定論——可能是兩邊 `AZURE_OPENAI_ENDPOINT` 指向不同 Azure OpenAI 資源/模型快照，或純粹是 mini 模型對矛盾 prompt 的隨機性。**本 FIX 的修復（消除矛盾、讓格式確定）不依賴回答此問題**；釐清後可補記。

---

## 解決方案

> 🔴 **硬約束（最高優先，不可違反）**：本修復**絕不能影響 line item 提取流程**，包含：
> - `convertRawLineItems`（lineItems 解析）
> - `backfillLineItemCharges`（CHANGE-094 費用確定性回填）
> - `unwrapInvoiceDataFormat` 中對 lineItems 的 `category` 補值邏輯（[FIX-093](FIX-093)）
>
> 兩個方案均**只動「標準必填欄位」的提取/解析與 prompt 格式宣告**，不移除、不修改任何 lineItems 相關處理。修改後必須以含費用明細的文件回歸驗證 lineItems 與費用回填結果不變。

### 方案 A（治本主力）：消除 prompt 矛盾 + 讓 SYSTEM 明確要求提取發票基本欄位

由原因 4 可知，唯有讓 GPT **在 `fields` 格式下也去提取發票基本欄位**，才能根治。三個協同改動：

- **A1（程式碼）** — `buildFieldDefinitionsSection`（`stage-3-extraction.service.ts:852`）的 `Required Output Format`：除了現有 15 個費用 key，明確要求 `fields` **必須包含** 5 個標準發票欄位 key（`invoice_number`/`invoice_date`/`vendor_name`/`total_amount`/`currency`），並調整「Do NOT add fields not in list」措辭以免與基本欄位衝突。🔴 **`lineItems` 區塊與 CHANGE-094 費用回填指示原樣保留，不更動。**
- **A2（seed + 靜態備援）** — 將 DB seed 的 `userPromptTemplate`（`prisma/seed-data/prompt-configs.ts` 的 `STAGE_3_FIELD_EXTRACTION` 與 `FIELD_EXTRACTION`）改為**不再貼互斥的 `invoiceData` JSON 範本**，改以自然語言要求「提取發票基本資訊 + 費用明細，依系統指定格式輸出」；`static-prompts.ts` 的對應常數同步修改（保持備援一致）。
- **A3（已部署 DB，關鍵）** — 經查證 prompt 生命週期：
  - **本地**：`npm run db seed`（`seed.ts:943`）以 findFirst→update 更新既有 `PromptConfig`；改 `prisma/seed-data/prompt-configs.ts` 後重跑即可更新本地 DB。
  - **Azure**：容器啟動的 `seed-prod-essential.ts` **完全不 seed PromptConfig**。Azure 現用的中文 `invoiceData` prompt 來自 2026-06-15「本地 DB 同步匯入」（非任何啟動 seed）。因此更新 Azure **必須**在 VNet 內直接跑一次性 `PromptConfig.update` 腳本，或透過 Prompt 管理 UI（Epic 14）手動編輯該 GLOBAL 記錄——**重新部署/容器啟動不會更新它**。
  - ~~🔴 **警告**：勿在 Azure 跑 `seed-prod-reference.ts`——其 `prisma/seed-data/reference/prompt-configs.json` 的 STAGE_3 是**另一套不相干的英文 `fields` 陣列格式**（`[{fieldName, value, confidence}]` + `{{ocrText}}` 變數），會覆蓋現用 prompt 並引發更嚴重問題。~~
    ✅ **已於 2026-07-20 由 [FIX-118](FIX-118-prod-reference-seed-overwrites-prompts-with-stale-copy.md) 根治**：`seed-prod-reference.ts` 改讀 `seed-data/prompt-configs.ts` 單一真相來源，該 reference JSON 已刪除。此警告不再適用。
  - ~~⚠️ 附帶技術債：`seed-data/prompt-configs.ts`（中文 `invoiceData`）與 `seed-data/reference/prompt-configs.json`（英文 `fields` 陣列）是**兩套互不一致的 STAGE_3 prompt**，超出本 FIX 範圍，另記。~~
    ✅ 同由 FIX-118 消除（副本已刪，不再有兩套）。當時查證範圍只涵蓋 STAGE_3，實際 Stage 1 / Stage 2 亦同樣不一致。

效果：SYSTEM 與 USER 一致 → GPT 穩定輸出含基本欄位的 `fields` 格式 → `standardFields` 齊全 → FIELD_COMPLETENESS 正確 → 兩邊信心度一致。

### 方案 B（防禦性補強，非主力）：Case 1 解析容錯

在 `parseExtractionResult` 的 **Case 1（`fields` 格式）** 分支，當標準欄位為空時，從頂層/`invoiceData`（若 GPT 仍回此結構）以 aliases 補撈。**完全不碰 lineItems**。

- 定位修正：B **無法**救 Azure 那種「GPT 根本沒提取基本欄位」的情況（無數據可撈）；僅作為「GPT 有提取但放錯位置」的容錯保險。
- 仍值得做：降低未來 prompt 漂移時的脆弱度，但**不能取代方案 A**。

### 建議落地順序

1. **方案 A1 + A2**（程式碼 + seed）：核心治本。
2. **方案 B**：補強容錯。
3. **方案 A3**（更新已部署 DB）：本地先驗證，Azure 待用戶確認部署方式後執行。
4. 全程以含費用明細的文件回歸，確認 line item 與 CHANGE-094 回填零變化。

---

## 修改的檔案

> 以下為**實際**修改範圍。

| 檔案 | 實際修改內容 | 對應方案 |
|------|------------|----------|
| `src/services/extraction-v3/stages/stage-3-extraction.service.ts` | `buildFieldDefinitionsSection` 要求 `fields` 含 8 個標準發票欄位並調整「Do NOT add fields」措辭（A1）；新增 `backfillStandardFieldsFromRaw` 並於 Case 1 解析後呼叫補容錯（B）。**未動 `convertRawLineItems` / `backfillLineItemCharges` / lineItems 區塊** | A1 + B |
| `prisma/seed-data/prompt-configs.ts` | `STAGE_3_FIELD_EXTRACTION` 與 `FIELD_EXTRACTION` 的 `userPromptTemplate` 移除互斥 `invoiceData` JSON 範本，改為自然語言 + 指向 SYSTEM 格式 | A2 |
| `src/services/static-prompts.ts` | `FIELD_EXTRACTION_USER_PROMPT` 同步修改（靜態備援一致） | A2 |
| `scripts/fix-095-update-stage3-prompt.ts` | 一次性更新已部署 DB 的 `PromptConfig.userPromptTemplate`（gated，未帶 `--confirm` 即 DRY-RUN）。**本地工具**（tsx，能直連時用） | A3（本地工具） |
| `prisma/update-stage3-prompt.js` | **新增**：Azure 端 A3 機制。純 `pg`、冪等（`is distinct from`）、參數化；由容器 entrypoint gated 觸發。production runner 映像只含 `scripts/docker-entrypoint.sh`、不含 `scripts/` 其餘檔與 `tsx`，故 `.ts` 版無法在容器內跑 → 比照 `grant-global-admin.js` 改寫為 prisma/*.js。模板與 `.ts`／seed 逐字一致 | A3（Azure 機制，2026-06-29） |
| `scripts/docker-entrypoint.sh` | **新增** gated step：`RUN_STAGE3_PROMPT_FIX=true` 時於啟動跑 `node prisma/update-stage3-prompt.js`（非致命，比照其他 4 個 gated 步驟），補完設回 false | A3（Azure 機制，2026-06-29） |

---

## 測試驗證

修復完成後需驗證：

- [x] 同一份 CEVA 文件在本地重新處理，信心度與 FIELD_COMPLETENESS 維度正確反映實際提取（不再因格式而 0 分）— 2026-06-28 live 重新處理 `CEVA_HEX250447,0448_45585.pdf`，整體 95.9% AUTO_APPROVE
- [x] 強制 GPT 回 `fields` 格式時，5 個標準必填欄位能被正確填充 — fresh run 為 fields 格式，5 欄全填（GPT 信心度 98–99）
- [ ] 強制 GPT 回 `invoiceData` 格式時，行為與修復前一致（無回歸）— fresh run 落在 fields 格式，此分支由 B 容錯 + 既有 invoiceData 格式結果覆蓋，未於本次 live 強制觸發
- [x] 🔴 **line item 提取結果不變**（數量、description、amount、category）— 與 baseline 同為 4 筆，description／classifiedAs **完全相同**
- [x] 🔴 **CHANGE-094 費用回填結果不變**（`backfillLineItemCharges` 行為一致）— `fields` 含原 15 個費用 key（範例 `origin_thc_...`=5990.0 conf 98），與標準欄位並存無衝突
- [x] `npm run type-check` 通過（2026-06-28）
- [x] `npm run lint` 通過（2026-06-28，無 error）
- [ ] （方案 A）多份不同格式文件回歸，確認提取與信心度皆穩定 — 本次 live 驗 1 份 fields 格式；多份／invoiceData 格式可後續補
- [x] **Azure DEV 端到端驗證**：部署後處理文件信心度 ≥90% AUTO_APPROVE（2026-06-29，用戶 UI 實測）— 原 75.8% Quick Review 症狀解決

### Live 回歸結果（2026-06-28，本地，新 code + 新 prompt）

| 項目 | Baseline（舊狀態）| Fresh（745d02f0, 15:29）|
|------|------|------|
| GPT 格式 | fields | fields |
| 整體信心度 | 95.3% | **95.9%** AUTO_APPROVE |
| 標準欄位 | ❌ 壞（invoiceNumber/totalAmount 顯示 "USD"）| ✅ 全填正確（GPT conf 98–99）|
| line item 數 / 描述 / 分類 | 4 筆 | **完全相同** 4 筆 |
| `fields` key 數 | — | 23（8 標準 + 15 費用並存）|
| mapped_fields | 4 | 12 |

> 結論：A1（讓 GPT 在 fields 格式下提取標準欄位）為治本主力，FIELD_COMPLETENESS 不再因格式崩盤；line item 與 CHANGE-094 費用回填零變化。**本地驗證通過**。

### Azure DEV 部署 + 驗證（2026-06-29）

A3 機制實作為 `prisma/update-stage3-prompt.js` + entrypoint gated `RUN_STAGE3_PROMPT_FIX`（PR #84），按 runbook §A 標準流程部署：

| 步驟 | 結果 |
|------|------|
| 映像 | `dev-fix095prompt-20260629112650`（含 FIX-095/096/097 全部碼 + A3 gated 腳本）|
| A3 prompt 更新 | 容器 log `[stage3-prompt] done — 2 GLOBAL prompt(s) updated to FIX-095 template`（2 筆 GLOBAL：`STAGE_3_FIELD_EXTRACTION` + `FIELD_EXTRACTION`）|
| 啟動 | health 200、database connected、無 exit 127 / re2.wasm ENOENT |
| 一次性旗標 | `RUN_STAGE3_PROMPT_FIX` 部署後設回 false（runbook §A.5）|
| **UI 端到端驗證** | 用戶實測 Azure 處理文件信心度 **≥90% AUTO_APPROVE**，原 75.8% Quick Review 症狀解決 |

> 結論：FIX-095 本地 + Azure 全鏈完成。原始跨環境信心度差異（本地 92% vs Azure 75.8%）已消除，兩環境一致落在 AUTO_APPROVE 區間。

---

*文件建立日期: 2026-06-28*
*最後更新: 2026-06-29*
