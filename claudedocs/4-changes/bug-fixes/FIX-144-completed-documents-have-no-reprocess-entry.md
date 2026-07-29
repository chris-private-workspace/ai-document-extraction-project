# FIX-144: 已處理成功的文件沒有重新處理入口，後端支援但前端不給按鈕

> **建立日期**: 2026-07-29
> **發現方式**: 使用者依建議在 Azure DEV 按「重試」，回報「按了之後沒有任何反應和提示」
> **影響頁面/功能**: 文件詳情頁 `/documents/[id]`、文件列表頁
> **優先級**: 中（設定變更後既有文件只能靠重新上傳套用新設定，持續累積重複記錄）
> **狀態**: ✅ 已修復（2026-07-29）

---

## 問題描述

設定變更（欄位定義集、Prompt、映射規則）後，既有文件必須重跑才會套用新設定 —— 這是 FIX-143 與 CYTS/Cargo Partner 稽核過程中反覆遇到的需求。但 `MAPPING_COMPLETED` 狀態的文件在 UI 上**找不到任何重跑入口**。

使用者的實際體驗是「按了沒反應」：詳情頁工具列上，「重新整理」與「重試」都是旋轉箭頭圖示、緊鄰排列，而重試按鈕在該狀態下根本沒有 render，按到的是重新整理（只重載頁面資料）。

---

## 重現步驟

1. 開啟任一 `MAPPING_COMPLETED` 狀態的文件詳情頁
2. 尋找重跑入口 → **不存在**
3. 文件列表頁該列同樣沒有重試按鈕

---

## 根本原因

**後端三處都支援重跑已完成文件，前端的按鈕顯示條件沒跟上。**

| 位置 | 允許 `MAPPING_COMPLETED`？ |
|------|--------------------------|
| `src/app/api/documents/[id]/process/route.ts` `PROCESSABLE_STATUSES` | ✅ |
| `src/services/document.service.ts` `retryProcessing` 的 `retryableStatuses` | ✅（註解明寫「對齊 /process 端點 + FAILED」） |
| `src/lib/document-status.ts` `canRetry` | ❌ |

而按鈕在兩個頁面都被 `canRetry` 包著：

- `DocumentDetailHeader.tsx:176` — `{isRetryable && <RetryButton />}`
- `DocumentListTable.tsx:317` — `{statusConfig.canRetry && <RetryButton />}`

`canRetry: true` 只有 `OCR_FAILED` / `REF_MATCH_FAILED` / `FAILED` 三個狀態。

這與 FIX-142（後端有 `/api/companies/[id]/activate`、UI 沒按鈕）、公司停用（`/deactivate` 存在、`ForwarderActions` 寫好卻沒接進任何頁面）屬同一類缺口：**能力做在後端，入口沒做在前端**。

### 為何不直接把 `canRetry` 改成 true

「重試」語意上指失敗後再試一次；已成功的文件出現「重試」按鈕會誤導，也會讓列表頁每一列都掛上重試鈕。故採分離語意的做法。

---

## 修復方式

### 1. `src/lib/document-status.ts` —— 新增 `canReprocess`

`StatusConfig` 加**可選**欄位 `canReprocess?: boolean`（可選是刻意的：只需在 2 個狀態標記，不必動其餘 12 處），並新增 `canReprocessStatus()`。

| 狀態 | canRetry | canReprocess |
|------|----------|--------------|
| `OCR_FAILED` / `REF_MATCH_FAILED` / `FAILED` | ✅ | — |
| `OCR_COMPLETED` / `MAPPING_COMPLETED` | — | ✅ |
| 其餘 | — | — |

兩者**互斥**：失敗狀態只出現「重試」，成功狀態只出現「重新處理」，同一排不會有兩個語意相近的按鈕。

> ⚠️ `canReprocess: true` 的取值必須是 `retryProcessing` 的 `retryableStatuses` 子集，否則按下去會被後端擋回 400。此約束已寫進欄位的 JSDoc。

### 2. 新組件 `ReprocessButton.tsx`

沿用 `useDocuments` 的 `retry` mutation（後端同一個端點同時服務兩種語意），但**加上確認對話框** —— 這是與 `RetryButton` 的關鍵差異：

`retryProcessing` 會先 `deleteMany` 該文件的 `extraction_result` 再重跑（`document.service.ts:605`）。對失敗文件而言本來就沒有結果可失去，但對已成功的文件，這是**取代既有提取結果**且會產生 AI 費用的操作，不該點一下就執行。對話框沿用詳情頁刪除確認的同一套 `AlertDialog` pattern。

### 3. `DocumentDetailHeader.tsx`

`isReprocessable = canReprocessStatus(document.status)`，在既有 Retry 之後掛上 `ReprocessButton`。

**只改詳情頁，不動列表頁** —— 列表頁每列加確認對話框會顯著增加噪音，且批次重跑本來就該有獨立設計。

### 4. i18n 三語言

`messages/{en,zh-TW,zh-CN}/documents.json` 新增 `reprocess` 段落（`button` / `success` / `failed` / `confirmTitle` / `confirmDescription`），未新增命名空間。確認文案明說會取代既有結果並產生 AI 費用。

---

## 驗證

| 檢查 | 結果 |
|------|------|
| `npm run type-check` | 通過 |
| `npm run i18n:check` | 通過（三語言 key 集合一致） |
| `npm run lint` | 本次三個改動檔案 0 warning，全專案 0 error |

待實機驗證：部署後開啟 `MAPPING_COMPLETED` 文件，確認「重新處理」按鈕出現、確認對話框顯示檔名、執行後狀態轉為 `OCR_PROCESSING` 並重跑。

---

## 這個缺口的成本

在它被修好之前，唯一的重跑方式是**重新上傳同一份 PDF**，每次都產生一筆新的 document 記錄。稽核 CYTS / Cargo Partner 時實測到的後果：

| 公司 | 文件記錄 | 實際發票 |
|------|---------|---------|
| `CYTS-SPIRIT LOGISTICS LIMITED` | 12 筆 | 10 張（2 張有 2 個版本） |
| `cargo-partner Logistics Ltd.` | 12 筆 | 5 張（2 張有 3 個版本、3 張有 2 個版本） |

這些重複記錄若一起加進模板實例，報表金額會重複計算。

---

## 相關

- FIX-142 — 同類缺口（後端有 activate API、UI 沒按鈕）
- FIX-143 — 觸發本次需求的場景（改欄位型別後需重跑才生效）
- FIX-117 — 上一次修 `canRetry` 判斷不一致（詳情頁硬編碼漏了 `REF_MATCH_FAILED`），本次沿用它建立的共用判斷
