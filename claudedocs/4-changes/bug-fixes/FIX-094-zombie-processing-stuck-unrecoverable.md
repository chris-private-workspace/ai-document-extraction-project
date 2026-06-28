# FIX-094: 處理程序中斷致文件永久卡在 processing 狀態（殭屍處理）無法自救

> **建立日期**: 2026-06-28
> **發現方式**: 用戶回報（Azure DEV 文件卡 OCR_PROCESSING 約 12 小時）+ 代碼追蹤
> **影響頁面/功能**: 文件處理管線 / 文件列表頁 + 詳情頁「重試」/ `retryProcessing`
> **優先級**: 中
> **狀態**: 🚧 待修復

---

## 問題描述

當文件處理流程在 `OCR_PROCESSING` 或 `MAPPING_PROCESSING` 階段被「硬中斷」（程序回收 / 逾時 / 容器重啟），文件狀態會**永久停留**在 processing 狀態，且：

1. 沒有任何背景機制會偵測或重試這類卡住的文件；
2. UI 與 service 三道關卡都不接受 processing 狀態重試 → 文件**無法從介面自救**，永遠不會完成也不會失敗。

實例（2026-06-28 Azure DEV）：`CEVA LOGISTICS_CEX240464_39613.pdf` 卡在 `OCR_PROCESSING` 約 12 小時。診斷確認 `error_message=null`、`processing_started_at=null`、`document_processing_stages` 空、`processing_queues` 空、`ocr_results=0`。同批次其他 5 份文件正常跑到 `MAPPING_COMPLETED`，僅此 1 份在 OCR 早期被中斷（未走到 catch 區塊標記 `OCR_FAILED`）。

| # | 問題 | 嚴重度 | 影響 |
|---|------|--------|------|
| BUG-1 | 處理中斷後狀態永久卡在 processing，無背景偵測 | 中 | 文件永久卡死、佔用「處理中」 |
| BUG-2 | UI/service 不接受 processing 狀態重試，無法自救 | 中 | 使用者無法從介面恢復 |

---

## 重現步驟

1. 上傳文件觸發處理（同步在 request 內跑：upload route → `UnifiedDocumentProcessor`）。
2. 在 OCR/映射階段使處理 request 中斷（容器回收 / 逾時）。
3. 觀察現象：文件狀態停在 `OCR_PROCESSING`（或 `MAPPING_PROCESSING`），`error_message` 為空，且文件列表頁與詳情頁皆**無「重試」按鈕**，無法恢復。

---

## 根本原因

### 主因 1：同步處理 + 無殭屍偵測
處理同步在 HTTP request 內執行，一旦該 request 程序被中斷，狀態永遠停在 processing；系統無任何背景 worker 掃描/回收卡住的文件。

### 主因 2：三道關卡皆拒絕 processing 狀態重試（雙重死局）
| 位置 | 現況 |
|------|------|
| `src/lib/document-status.ts:116-127` | `OCR_PROCESSING` 的 `canRetry: false`（列表頁 `DocumentListTable.tsx:317` 依 `statusConfig.canRetry` 不顯示重試按鈕） |
| `src/components/features/document/detail/DocumentDetailHeader.tsx:84` | `isRetryable = ['OCR_FAILED','FAILED'].includes(status)`，不含 processing 狀態（詳情頁不顯示按鈕） |
| `src/services/document.service.ts:567` | `retryProcessing()` 的 `retryableStatuses` 不含 `OCR_PROCESSING`/`MAPPING_PROCESSING`（後端拒絕） |

---

## 解決方案

> 關鍵約束：**不可無條件**對 processing 狀態開放重試，否則正在正常處理中的文件也會冒出重試按鈕，使用者誤點會中斷處理、造成競態與重複處理。必須以「卡住時間」為條件。

### 方向 B（建議優先，治本且風險最低）：背景偵測殭屍處理
新增定期 job（參考既有 `src/jobs/webhook-retry-job.ts` 模式），掃描 `status ∈ {OCR_PROCESSING, MAPPING_PROCESSING}` 且 `updatedAt` 超過閾值（建議 10 分鐘，可配置）的文件，自動標記為 `OCR_FAILED` + 寫入 `error_message`。文件因此回到**既有的失敗 → 重試路徑**，UI 三處邏輯**不需更動**，無競態風險。

### 方向 A（可選增強）：閾值式手動重試
新增以時間為條件的判斷（如 `isStaleProcessing(status, updatedAt)`），讓「卡在 processing 且超過閾值」的文件才顯示重試按鈕並被後端接受。需同步調整三處（`document-status.ts` 改用函數判斷、`DocumentDetailHeader.tsx` 的 `isRetryable`、`retryProcessing` 的 `retryableStatuses` + 加 `updatedAt` 守衛），三者邏輯與閾值須一致。

> 建議：先實作 B（自動回收，最小且安全）；A 視需要再加。

---

## 修改的檔案（預估，實作時更新）

| 檔案 | 修改內容 |
|------|----------|
| `src/jobs/`（新增，如 `stuck-processing-sweeper-job.ts`） | 方向 B：掃描殭屍處理 → 標記 `OCR_FAILED` |
| 註冊背景 job 的排程處（依現有 job 註冊機制） | 啟用定期掃描 |
| `src/services/document.service.ts` | 方向 A（若採用）：`retryProcessing` 接受逾時的 processing 狀態 + `updatedAt` 守衛 |
| `src/lib/document-status.ts` | 方向 A（若採用）：時間條件判斷函數 |
| `src/components/features/document/detail/DocumentDetailHeader.tsx` | 方向 A（若採用）：`isRetryable` 改用時間條件 |
| `src/components/features/document/DocumentListTable.tsx` | 方向 A（若採用）：重試按鈕顯示條件 |

---

## 測試驗證

- [ ] 模擬卡在 `OCR_PROCESSING` 超過閾值的文件 → 背景 job 自動標記為 `OCR_FAILED` + 寫入 `error_message`
- [ ] 正常處理中（未超過閾值）的文件**不被**標記、**不顯示**重試按鈕（無競態）
- [ ] 被標記 `OCR_FAILED` 後，列表頁與詳情頁出現重試按鈕，點擊可重跑完整 OCR→映射流程
- [ ] `type-check` / `lint` 通過
- [ ] （方向 A 若採用）三處重試判斷邏輯與閾值一致

---

## 備註

- 本次（2026-06-28）已手動把該文件 `OCR_PROCESSING` → `OCR_FAILED` 解除阻塞，屬一次性資料修復，非根治。
- 本項目 Azure 部署為手動 `az acr build`，此 FIX 程式碼變更需走正常開發 + 手動部署流程才會在 Azure 生效。

---

*文件建立日期: 2026-06-28*
*最後更新: 2026-06-28*
