# CHANGE-116: 上傳前端自動分批 —— 提高單次可選份數而不動記憶體峰值

> **建立日期**: 2026-08-05
> **提出背景**: 使用者詢問「是否可以提高單次上傳文件的數量上限？因為即使上載了 50 份，應該同一時間只會處理 3 份吧」
> **影響範圍**: `src/components/features/document/FileUploader.tsx`（前端）；**不改** API、**不改** `UPLOAD_CONFIG`
> **狀態**: 📋 規劃中
> **相關**: [FIX-106](../bug-fixes/FIX-106-ocr-processing-stuck-db-connection-timeout.md)（設下 15 份上限的事故）、[FIX-100](../bug-fixes/FIX-100-upload-blocks-documents-page-event-loop.md)、[FIX-165](../bug-fixes/FIX-165-auto-template-matching-never-ran.md)（**須先修，否則大量上傳沒有意義**）

---

## 需求

單次上傳上限目前是 **15 份**（`UPLOAD_CONFIG.MAX_FILES_PER_BATCH`）。超過即被前端 `toast.error` 擋下，使用者必須手動分次拖放。

使用者要處理的樣本是 375 份規模，手動分 25 次不可行。

---

## 使用者的判斷是對的：份數與併發是兩個獨立旋鈕

`upload/route.ts` 的處理是**序列分批**：

```ts
for (let i = 0; i < items.length; i += concurrency) {
  const chunk = items.slice(i, i + concurrency)
  await Promise.allSettled(chunk.map(worker))    // ← 做完才進下一批
}
```

`PROCESS_CONCURRENCY = 3`，所以無論單次上傳幾份，**同時處理的永遠是 3 份**。

上傳階段本身也是逐份序列（`for...of` → `Buffer.from(await file.arrayBuffer())` → 上傳 blob → 建 DB 記錄），不是併發。

而 `MAX_FILES_PER_BATCH: 15` 的註解自己寫明了它的理由已經過期：

> FIX-106: 由 20 降為 15。上傳後所有文件會在 upload/route.ts 被同時投入處理，20 份曾使 App Service 記憶體達 95%、事件迴圈凍結，導致 pg 連線握手逾時。
> **此值僅降低峰值，未移除觸發機制 —— 治本需限制併發處理數。**

治本（`PROCESS_CONCURRENCY`）後來做了。15 是治本前的止血措施。

---

## 但直接調高常數仍有一個獨立約束

`request.formData()` 會把**整個 multipart body 讀進記憶體**，這發生在 `runInBatches` 之前，不受 `PROCESS_CONCURRENCY` 保護：

| 單次份數 | 最壞情況（每份 10MB 上限） |
|---:|---:|
| 15（現況） | 150MB |
| 30 | 300MB |
| 50 | **500MB** |

實測樣本多在 160KB–970KB，50 份約 50MB 沒問題 —— 但上限必須按 `MAX_FILE_SIZE = 10MB` 算，因為使用者可以傳大檔。FIX-106 是真實事故，不宜再逼近。

第二個約束是 HTTP 逾時：上傳階段序列跑 blob，50 份約 50–100 秒，Azure App Service 預設 230 秒，還有餘裕但會變窄。

---

## 方案：前端自動分批（本專案已有同型實作）

`BatchFileUploader.tsx`（歷史資料上傳，Epic 0）的做法：

```
前端接受 500 份 → 切成每批 10 份 → 送 50 次請求
```

單次請求維持小體積，記憶體風險完全不變，但使用者感覺是「一次拖 500 份」。

⚠️ 它送的是 `/api/admin/historical-data/upload`，**不同端點、不同處理路徑**，不能直接複用元件，但分批模式可以照搬。

### 現況待改的程式碼

`FileUploader.tsx:218-241` 目前把**全部**檔案塞進單一 FormData：

```ts
const uploadMutation = useMutation({
  mutationFn: async (filesToUpload: FileWithStatus[]) => {
    const formData = new FormData()
    filesToUpload.forEach((fileItem) => formData.append('files', fileItem.file))
    if (cityCode) formData.append('cityCode', cityCode)
    const response = await fetch('/api/documents/upload', { method: 'POST', body: formData })
    // ...
  },
```

`FileUploader.tsx:145` 則直接拒絕超量：

```ts
if (totalCount > UPLOAD_CONFIG.MAX_FILES_PER_BATCH) {
  toast.error(t('uploadErrors.tooManyFiles', { count: UPLOAD_CONFIG.MAX_FILES_PER_BATCH }))
```

### 改動範圍

| 項目 | 改動 |
|---|---|
| `maxFiles`（dropzone） | 由 `MAX_FILES_PER_BATCH` 改為新常數 `MAX_FILES_PER_SELECTION` |
| 超量檢查（:145） | 改為檢查新的較大上限 |
| `uploadMutation` | 改為切批 → 序列送出 → 累計結果 |
| 進度顯示 | 需顯示「第 N / M 批」與累計成功／失敗 |
| `UPLOAD_CONFIG` | **新增** `MAX_FILES_PER_SELECTION`；`MAX_FILES_PER_BATCH: 15` **維持不變**（它是單次請求上限，是安全邊界） |

### 待決定的參數

| 參數 | 建議值 | 理由 |
|---|---|---|
| `MAX_FILES_PER_SELECTION` | 100 | 一次拖 100 份 = 7 個請求。再多會讓等待時間長到不像同步操作（見下方時間估算） |
| 批間是否等待 | **是，建議 3–5 秒** | 見下方 GPT 429 |

---

## 🔴 三件必須先講清楚的事

### 1. 這不會讓處理變快

併發仍是 3。拖 100 份與分 7 次拖 15 份，總等待時間**完全一樣**，差別只是不用手動操作 7 次。

### 2. GPT 429 的節流點在提取端，不在上傳端

實測（TEST-REPORT-006 §2.1）：第二批 197 份未節流時，有 7 份因 GPT 429 掛在 Stage 1/2/3；第三批 145 份改為每批 3 份 + 批間 25 秒後，429 歸零。

上傳速率是提取併發的**上游閥門** —— 因為 `autoExtract` 會 fire-and-forget 觸發提取。所以前端分批若毫無間隔連送 7 個請求，等於一次投入 100 份的提取需求，`PROCESS_CONCURRENCY=3` 會排隊但 429 風險仍在（3 併發本身就可能觸發）。

**因此批間必須有等待。** 具體秒數需實測，25 秒是我先前腳本的保守值（0 錯誤），但那是每批 3 份；每批 15 份時的合適間隔未知。

### 3. 先修 FIX-165，否則大量上傳沒有意義

[FIX-165](../bug-fixes/FIX-165-auto-template-matching-never-ran.md)：三層預設模板全空，自動模板匹配從未運作（375 份中僅 9 份成功，2.4%）。

現在上傳進來的文件會完成提取，但**不會進任何模板實例**，而且沒有任何錯誤提示。在那之前提高上傳量，只是更快地累積一批「卡在提取完成、進不了模板」的文件。

---

## i18n（H5）

新增的進度提示需同步三語言：

| key（暫定，`documents` 命名空間） | 用途 |
|---|---|
| `upload.batchProgress` | 「上傳中 {current} / {total} 批」 |
| `upload.batchResult` | 「完成 {success} 份，失敗 {failed} 份」 |
| `uploadErrors.tooManyFiles` | 既有 key，`count` 參數改為新上限 |

完成前執行 `npm run i18n:check`。

---

## 待確認

| # | 事項 | 影響 |
|---|------|------|
| 1 | UI 目前**沒有**傳 `autoExtract` 與 `processingVersion` | API 端 `autoExtract = formData.get('autoExtract') !== 'false'` → 未傳即為 `true`，行為等效；但 `processingVersion` 未傳時的預設值需確認，否則分批後可能與預期版本不符 |
| 2 | 部分批次失敗時的行為 | 中止後續批次？還是繼續並在最後彙總？建議繼續 + 彙總，但需使用者確認 |
| 3 | 上傳中離開頁面 | 現況單一請求，離開即中斷；分批後會中斷在某一批，已上傳的不會回滾。是否需要警告？ |
| 4 | 批間間隔的合適值 | 需實測。與 `PROCESS_CONCURRENCY` 及 Azure OpenAI 配額相關 |

---

## 驗證方式

1. 選 100 份，確認切成 7 批送出，每批 ≤ 15
2. 確認全部 100 份都入庫（`documents` 表筆數）
3. 確認 GPT 429 為 0（查提取失敗數）
4. 中途關閉頁面，確認已完成批次的文件狀態正常、未完成的不留半筆記錄
5. `npm run type-check` / `npm run lint` / `npm run i18n:check`

---

**建立者**: AI 助手
**最後更新**: 2026-08-05
