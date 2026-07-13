# FIX-106: 批次上傳 20 份文件致應用端資源飽和 —— 連線握手逾時與文件狀態靜默丟失

> **建立日期**: 2026-07-10
> **最後更新**: 2026-07-13（v3.2 —— 收斂 1 已實作：修復無效的 `.catch()`，見 §5.3）
> **發現方式**: 用戶回報（Azure DEV 文件卡 `OCR_PROCESSING`）+ 用戶關鍵線索（「只在一次上傳 20 份時出現」）+ Azure 容器 log / 平台指標 / DB 查詢
> **影響頁面/功能**: 文件處理管線（OCR 階段）/ 文件列表頁 + 詳情頁
> **優先級**: 高（生產資料靜默丟失、無自動回收、可穩定重現）
> **狀態**: ✅ **根因已確認（應用端事件迴圈飽和，非 DB 故障）；已實施臨時緩解（§5.1）+ 收斂 1（§5.3）；治本／收斂 2／止血尚未實作**
> **關聯**: FIX-094（殭屍處理 sweeper，事後回收層）、CHANGE-098（DB 連線韌性 `withDbRetry` + fail-stop）

> ⚠️ **本文件標題與早期版本的方向相反**。v1／v2 認定根因是「DB 連線 timeout」。v3 以 PostgreSQL 與 App Service 平台指標證實：**PG 全程健康，是應用端把自己打爆**。錯誤訊息 `Connection terminated due to connection timeout` 由應用端的 `pg-pool` 自行拋出，不代表資料庫有任何問題。

---

## 1. 問題描述

用戶在 Azure DEV 一次批次上傳 **20 份** CEVA 文件後，部分文件永久卡在 `OCR_PROCESSING`（永不 timeout、永不轉 error、UI 無重試按鈕）。

**用戶提供的關鍵線索**：此現象**只在一次上傳 20 份文件時出現**，少量上傳不會發生。此線索是根因改判的轉折點（見 §4.4）。

### 1.1 那批上傳的真實全貌（DB 查詢結果）

20 份文件於 `03:12:15.164Z` – `03:12:16.479Z`（1.3 秒內）建立，`status` 初始皆為 `UPLOADED`（`upload/route.ts:328`）。事後狀態分佈：

| 狀態 | 份數 | 性質 |
|------|------|------|
| `MAPPING_COMPLETED` | 12 | 處理成功 |
| `OCR_PROCESSING` | 4 | UI 可見的殭屍；FIX-094 sweeper **掃得到** |
| `UPLOADED` | 4 | **靜默丟失**；UI 上與「待處理」無異；sweeper **掃不到** |

### 1.2 🔴 兩批受害者是不同的文件（v2 曾誤混）

**卡在 `OCR_PROCESSING` 的 4 份**（其 `OCR_PROCESSING` 在中斷**前**就已寫入成功）：

| 檔名 | document ID | `updated_at` |
|------|-------------|--------------|
| `CEVA_RCIM250271_59335.PDF` | `e978c70a-a7d0-45d8-9b3a-ba36438f7c52` | `03:12:17.545Z` |
| `CEVA_RCIM250327_17864.PDF` | `bcc0a103-48b1-4197-ba9a-8e2108ef6f30` | `03:12:18.230Z` |
| `CEVA_RCIM250346_17867.PDF` | `ba09dfd8-7ded-41e2-829d-8b901878b63d` | `03:12:18.249Z` |
| `CEVA_RCIM250349_17868.PDF` | `4971fa34-073a-4047-98f6-f477530e0153` | `03:12:18.319Z` |

> UI 僅觀察到後 3 份（第 4 份 `CEVA_RCIM250271_59335.PDF` 在列表另一頁）。

**停在 `UPLOADED` 的 4 份**（即容器 log 中 `aborting (no V2 fallback)` 的那 4 個 ID）：

| 檔名 | document ID | 狀態欄位 |
|------|-------------|----------|
| `CEVA_RCIM250124_31832.pdf` | `d13602a6-ebeb-40d5-acc1-9d830bfe3f14` | `error_message = null`、`processing_started_at = null`、`updated_at = created_at` |
| `CEVA_RCIM250272_59334 .PDF` | `d8460d06-b20b-4252-aadf-5d4c8e7be1f0` | 同上 |
| `CEVA_RCIM250325_17865.PDF` | `53d2e497-2c0b-40d6-b847-81875bfcff38` | 同上 |
| `CEVA_RCIM260007_20875.PDF` | `f2efa7ca-cd83-4f61-a5d2-9be589e24576` | 同上 |

這 4 份自建立後**從未被寫過任何一次**。UI 上它們看起來就像「剛上傳、尚未處理」，與正常待處理文件無法區分。**這是本 FIX 中危害最大的部分。**

---

## 2. 調查環境與資源

| 項目 | 值 |
|------|-----|
| WebApp | `WebApp-RAPOSCM-AIDocProcessing-DEV` |
| App Service Plan | `ASP-RAPOSCM-AIDocProcessing-DEV` |
| PostgreSQL | `pgsql-raposcm-aidocprocessing-dev`（Flexible Server，私有端點） |
| 當前映像 tag | `dev-azure-sync-20260710135241`（建置於事件**之後**，非主因，見 §4.3） |
| Log Analytics workspace | `log-raposcm-aidocprocessing-dev`（customerId `1cf79233-ded9-48c7-ae6a-e6c84858ab5a`） |
| 容器 stdout 表 | `AppServiceConsoleLogs`（`ResultDescription` 欄） |
| 時區換算 | UI 用 UTC+8；11:12 AM (UTC+8) = **03:12 UTC** |

### 2.1 容器 log 查詢（§3 的來源）

```bash
az monitor log-analytics query \
  --workspace 1cf79233-ded9-48c7-ae6a-e6c84858ab5a \
  --analytics-query 'AppServiceConsoleLogs
    | where TimeGenerated between (datetime(2026-07-10T03:12:00Z) .. datetime(2026-07-10T03:30:00Z))
    | where ResultDescription has_any ("connection timeout","withDbRetry","OCR_PROCESSING")
    | order by TimeGenerated asc
    | project TimeGenerated, ResultDescription' -o json
```

### 2.2 平台指標查詢（§4.4 的來源）

```bash
export MSYS_NO_PATHCONV=1
# App Service Plan
az monitor metrics list --resource "<serverFarms resource id>" \
  --metric CpuPercentage MemoryPercentage \
  --start-time 2026-07-10T03:00:00Z --end-time 2026-07-10T03:40:00Z \
  --interval PT1M --aggregation Maximum Average -o json
# PostgreSQL
az monitor metrics list --resource "<flexibleServers resource id>" \
  --metric cpu_percent memory_percent active_connections \
  --start-time 2026-07-10T03:00:00Z --end-time 2026-07-10T03:40:00Z \
  --interval PT1M --aggregation Maximum Average -o json
```

### 2.3 DB 唯讀查詢（§1.1 / §1.2 的來源）

Azure PG 走私有端點，本機不可達。經 Kudu（`<scm>/api/command`，AAD bearer + `curl --resolve` 繞本機 DNS，見 runbook §8）在容器內以 `pg` 執行純 `SELECT`。

---

## 3. Azure 容器 log 證據（真實回傳，UTC）

§2.1 查詢回傳 **42 筆**記錄，範圍 `03:12:30.712335Z` → `03:13:57.2412796Z`（**86.5 秒**）。

### 3.1 訊息分佈（全 42 筆完整歸類）

| 訊息 | 筆數 |
|------|------|
| `prisma:error Connection terminated due to connection timeout` | 21 |
| `[withDbRetry] transient DB error on "updateDocumentStatus:OCR_PROCESSING" (attempt 1/3), retrying in 200ms: …` | 8 |
| `[withDbRetry] transient DB error on "updateDocumentStatus:OCR_PROCESSING" (attempt 2/3), retrying in 500ms: …` | 5 |
| `[UnifiedProcessor] Failed to update status to OCR_PROCESSING for <id>: Error: …` | 4 |
| `[UnifiedProcessor] transient DB error for <id>, aborting (no V2 fallback): …` | 4 |
| **`attempt 3/3`** | **0** |
| **`persistent DB error`** | **0** |
| **任何含 `OCR_FAILED` 的訊息** | **0** |
| **任何含 `persistProcessingResult:` 的訊息** | **0** |

> `attempt 3/3` 為 0 符合程式碼設計：`src/lib/db-retry.ts:115` 在 `attempt >= attempts` 時 `break`，最後一次失敗**不印訊息**、直接 `throw lastError`。

### 3.2 時間線（代表性節錄）

| 時間 (UTC) | 事件 |
|------------|------|
| 03:12:15.164 – 03:12:16.479 | 20 份文件建立（`status = UPLOADED`）〔DB〕 |
| 03:12:17.545 – 03:12:18.319 | 4 份成功寫入 `OCR_PROCESSING`，進入 V3 管線〔DB〕 |
| **03:12:30.712 – 03:12:30.933** | 第一波失敗：8 次 `attempt 1/3` + 8 次 `prisma:error`，全部集中在 **0.22 秒內** |
| 03:13:17.793 | 第 1 筆 `attempt 2/3` |
| 03:13:33.211 – 03:13:33.229 | 另外 4 筆 `attempt 2/3`（共 5 筆） |
| 03:13:55.815 / 03:13:57.131 / .161 / .184 | 4 份文件 `Failed to update status to OCR_PROCESSING` |
| 03:13:55.823 / 03:13:57.133 / .164 / .194 | 4 份文件 `aborting (no V2 fallback)` |
| 03:13:57.241 | 最後一筆記錄；此後至 03:30 窗口結束**無任何符合過濾條件的記錄** |
| 03:15:33.773 – 03:30:28.706 | 12 份文件陸續完成 → `MAPPING_COMPLETED`〔DB〕 |

### 3.3 由筆數推得的重試流向（推論，非 log 直述）

成功的重試不印 log。由 `attempt 1/3` 8 筆、`attempt 2/3` 5 筆、abort 4 筆反推：8 個 `updateDocumentStatus:OCR_PROCESSING` 撞上事件 → 3 個在第 2 次嘗試成功 → 5 個進入第 3 次 → 4 個 abort、1 個成功。這 4 個重試成功者最終走完管線（`MAPPING_COMPLETED`），**不是** §1.2 中卡在 `OCR_PROCESSING` 的那 4 份。

---

## 4. 根本原因分析

### 4.1 直接根因：應用端事件迴圈飽和，非 DB 故障

批次上傳的 20 份文件在 `upload/route.ts:371` 被**無節流**地同時投入處理：

```ts
Promise.allSettled(
  documentsToProcess.map(async (doc) => {
    const fileBuffer = await downloadBlob(doc.blobName)   // 20 份同時下載
    const result = await processor.processFile({ ... })    // 20 條 V3 管線同時跑
    await persistProcessingResult({ ... })
    ...
  })
)
```

20 份 PDF 同時載入 buffer、轉圖片、做 base64 編碼 —— 皆為 CPU／記憶體密集的同步工作，全部擠在 Node 的單一事件迴圈上。App Service Plan 記憶體隨即由基線 77–80% 衝到 **95%**，CPU 衝到 **99%**（§4.4 指標）。

記憶體逼近上限 → V8 頻繁 GC，其 stop-the-world 暫停凍結事件迴圈 → `pg-pool` 以 `setTimeout` 實作的連線逾時 timer 無法準時執行，TCP／TLS 握手的 callback 同樣排不上 → pool 判定「連線未在 `connectionTimeoutMillis` 內建立」→ 主動 `stream.destroy()` → 拋出 `Connection terminated due to connection timeout`。

> 🔴 **關鍵澄清**：`Connection terminated due to connection timeout` 出自 `node_modules/pg-pool/index.js:262` 的 **`newClient()`** 路徑，是**應用端 pool 自己**在逾時後 destroy socket 所產生。它**不表示** PG 拒絕連線、不表示網路不可達、不表示 DB 有任何異常。
>
> （對照：連線池排隊耗盡走 `pg-pool/index.js:216`，拋 `timeout exceeded when trying to connect`，訊息完全不同，本次 log 中 0 筆。）

### 4.2 兩批受害者的形成機制

#### 4.2.1 停在 `UPLOADED` 的 4 份（有 log、但無人回收）

1. `processWithV3` 首步呼叫 `updateDocumentStatus(fileId, 'OCR_PROCESSING', { critical: true })`（`unified-document-processor.service.ts:238`）。
2. 該寫入撞上飽和期，`withDbRetry` 3 次嘗試皆逾時 → 上拋（`:328-330` 因 `critical: true` 而 `throw`）。
3. `processWithV3` 的 catch 判定為 transient → 印 `aborting (no V2 fallback)` → `return this.buildErrorResult(...)`（`:265-274`）。**此路徑不做任何 DB 寫入**（回傳的是記憶體物件）。
4. 回到 `upload/route.ts:383`，無條件呼叫 `persistProcessingResult`。該函數本應在 `!result.success` 時寫入 `OCR_FAILED`（`processing-result-persistence.service.ts:255`）。
5. **但它走不到那一步**：`:259` 的 `prisma.document.findUnique`（FIX-048 加入，查 `cityCode`）是**裸呼叫，未包在 `withDbRetry` 內**（該函數的 `withDbRetry` 要到 `:407` 才包住 `$transaction`）。DB 連線同樣建不起來 → 直接拋。
6. 拋出的錯誤落入 `Promise.allSettled`。**`allSettled` 對個別 promise 的 rejection 永不 reject 自身**，`upload/route.ts:394` 掛的 `.catch()` 因此是 dead code，且回傳陣列從未被檢查 → **錯誤被完全靜默吞掉，零 log**。

**結果**：文件停在建立時的 `UPLOADED`，`error_message` 為 `null`。這解釋了為何 log 在 `03:13:57.241` 之後戛然而止。

#### 4.2.2 卡在 `OCR_PROCESSING` 的 4 份（無 log、但 sweeper 可回收）

這 4 份在 `03:12:17–18`（飽和**之前**）已成功寫入 `OCR_PROCESSING` 並進入 V3 管線。其後的 OCR／GPT／`persistProcessingResult` 撞上飽和期，同樣經由 §4.2.1 第 5–6 步被 `allSettled` 吞掉 —— 因此**它們的失敗一行 log 都沒有**。狀態永遠停在 `OCR_PROCESSING`。

### 4.3 排除項：本次映像部署非主因

當前映像 tag `dev-azure-sync-20260710135241` 的時間戳（13:52）**晚於**事件（03:12 UTC），故本次部署／容器重啟不是原因。全段 log 亦無容器啟動訊號。

### 4.4 假設裁決（依平台指標 + 用戶線索）

#### 指標對照（1 分鐘聚合，Maximum）

| 時間 (UTC) | Plan CPU% | Plan Mem% | PG cpu% | PG mem% | PG active_conns |
|-----------|-----------|-----------|---------|---------|-----------------|
| 03:00–03:11（基線） | 7 – 23 | 77 – 80 | 9.5 – 17.8 | 54.4 – 56.1 | 6 – 8 |
| 03:12 | 31 | 80 | 12.1 | 56.9 | **16** |
| **03:13** | **75** | **95** | 12.0 | 55.7 | **8** |
| **03:14** | **99** | 87 | 9.7 | 55.5 | 8 |
| 03:15 | 62 | 84 | 11.0 | 57.1 | 16 |
| 03:16–03:39 | 9 – 46 | 81 – 88 | 8.8 – 15.2 | 55.5 – 57.3 | 8 – 12 |

**PG 在整個事件期間毫無異常**：CPU ~12%、記憶體 ~56%、連線數峰值 16。
`active_connections` 於 `03:12` 升至 16、`03:13` **降回 8** —— 連線是被**應用端主動 destroy**，而非 PG 斷開或拒絕。

#### 裁決

| 假設 | 結果 | 依據 |
|------|------|------|
| A. PG Burstable CPU credit 耗盡 | ❌ **排除** | PG `cpu_percent` 全程 ~12%，無壓力 |
| B. 連線池 / `max_connections` 耗盡 | ❌ **排除** | `active_connections` 峰值僅 16；錯誤字串出自 `newClient()` 而非 pending queue（`timeout exceeded when trying to connect` 0 筆） |
| C. 私有端點 / VNet 網路瞬斷 | ❌ **幾近排除** | 無法解釋「連線數先升後降」「同批 12 份成功」「只在 20 份併發時出現」三點 |
| D. PG 端維護 / 重啟 | ❌ **排除** | PG 指標連續無斷點 |
| **E. 應用端事件迴圈飽和** | ✅ **確立** | Plan Mem 95% + CPU 99%；timer 延遲 12–37 秒（§4.5）；與併發量呈確定性關聯（用戶線索） |

> 用戶線索「**只在一次上傳 20 份時出現**」是排除 C 的決定性依據：網路瞬斷是隨機事件，不會挑併發量。

### 4.5 核心機制證據：`connectionTimeoutMillis` 被延遲 12–37 秒

`src/lib/prisma.ts:53` 設定 `connectionTimeoutMillis: 10_000`（`max: 10`，`:55`），即單次連線嘗試上限應為 **10 秒**。由真實時間戳推算：

| 區間 | 實測單次嘗試耗時 |
|------|------------------|
| `attempt 1` 失敗 `03:12:30.715` + 200ms 退避 → `attempt 2` 失敗 `03:13:17.793` | **約 46.9 秒** |
| `attempt 2` 失敗 `03:13:33.229` + 500ms 退避 → abort `03:13:55.815` | **約 22.1 秒** |

`pg-pool` 的逾時靠 `setTimeout` 實作。10 秒的 timer 被拖成 22–47 秒，**只可能是事件迴圈長時間被阻塞**（GC stop-the-world / 同步 CPU 工作）。閒置的 Node 進程不可能出現此現象。

此為假設 E 最硬的單項證據，且與 §4.4 的 Mem 95% / CPU 99% 相互印證。

---

## 5. 修復方向（根因已確認，方向重定）

> ⚠️ v1／v2 的「治本」寫的是「升 PG 規格 / 修網路 / 加 PgBouncer」。**這三個方向全部無效** —— PG 沒有任何問題。

| 層 | 方向 | 具體內容 | 風險／備註 |
|----|------|----------|------------|
| **治本** | **限制併發處理數** | `upload/route.ts:371` 的 `Promise.allSettled(documentsToProcess.map(...))` 改為分批（例如一次 3–5 份）。**無需新依賴**，chunk loop 即可 | 需評估批量大小；記憶體基線本就 77–80%，餘裕薄 |
| **收斂 1** | ✅ **已實作**（§5.3） | `upload/route.ts` 兩處 `.catch()` 掛在 `allSettled` 上為 dead code。已改為 `.then()` 檢查 `status === 'rejected'` 並記錄失敗文件 | **本次事故完全不可觀測的根源**，已消除 |
| **收斂 2** | 補上 `persistProcessingResult` 的 retry 缺口 | `processing-result-persistence.service.ts:259` 的裸 `findUnique` 未受 `withDbRetry` 保護，把「標記 `OCR_FAILED`」的路徑擋死在門口 | 修好後 §4.2.1 的 4 份至少能被標為 `OCR_FAILED` 而進入重試路徑 |
| **止血 A** | 回收 `OCR_PROCESSING` 殭屍 | FIX-094 sweeper（`/api/jobs/stuck-processing-sweeper`）可處理；但本專案**無自動排程**，需手動觸發 | 需先確認 Azure 映像已含 FIX-094（碼在 `main` @ `b44f2e0`） |
| **止血 B** | 回收 `UPLOADED` 孤兒 | FIX-094 sweeper **掃不到**（`document.service.ts:723` 的 `STUCK_PROCESSING_STATUSES` 僅含 `OCR_PROCESSING` / `MAPPING_PROCESSING`）。`UPLOADED` 已在 `document.service.ts:581` 的 `retryableStatuses` 內，可重新觸發處理 | 需要人工識別哪些 `UPLOADED` 是孤兒 —— **目前無任何欄位可資區分** |

**止血 B 的深層問題**：`UPLOADED` 孤兒與正常待處理文件在 DB 中完全無法區分（`error_message`、`processing_started_at` 皆為 `null`）。若不改善，未來同類事故仍將靜默丟失。可考慮在觸發處理前先寫 `processing_started_at`，使孤兒可被識別 —— 但此屬設計變更，需另行討論（H1）。

### 5.1 已實施：臨時緩解（2026-07-10）

| 項目 | 內容 |
|------|------|
| 改動 | `src/lib/upload/constants.ts:46` —— `MAX_FILES_PER_BATCH` 由 `20` 降為 `15` |
| Commit | `35f7298` |
| 決策 | 用戶於 2026-07-10 在已知悉下列侷限後選擇此方案（優先取其立即可行） |
| 效果 | 降低單次上傳的記憶體峰值 |
| 🔴 **侷限一** | **未移除觸發機制**。`upload/route.ts:371` 仍將該批全部文件**同時**投入處理。15 份併發只要使事件迴圈阻塞逾 `connectionTimeoutMillis`（10 秒），同一錯誤即會重現 |
| 🔴 **侷限二** | 「15 份約 91% 記憶體」係由單一資料點（20 份 → 95%）**線性外推**，而記憶體壓力對 GC 的影響為非線性。**15 份是否安全無實測數據支持** |
| 🔴 **侷限三** | 未防止「短時間內分兩次各上傳 15 份」導致兩批處理重疊 |
| 影響面確認 | 前端 dropzone `maxFiles`、`FileUploader.tsx:145` 數量檢查、`upload/route.ts:240` 伺服器端驗證、UI 顯示文字皆讀此常數，無硬編碼數字；i18n 走 `{count}` 插值，無需同步（H5 不觸發） |
| 驗證 | `npx eslint` 對改動檔案與兩個引用者通過；`npm run type-check` 剩餘 4 個錯誤全在 `src/services/llm/`（本地缺 Epic 23 的 `ai` / `@ai-sdk/*` 套件），與本改動無關 |

> ⚠️ **此緩解不得視為 FIX-106 已解決**。收斂 1（可觀測性）已於 §5.3 補上，但**治本**（限制併發處理數）仍未實作——在治本完成前，15 份併發只要使事件迴圈阻塞逾 10 秒，同一故障即會重現（差別僅在：現在會留下 log）。

### 5.3 已實施：收斂 1 —— 修復無效的錯誤處理（2026-07-13）

| 項目 | 內容 |
|------|------|
| 改動 | `src/app/api/documents/upload/route.ts` —— unified 分支（第 371 起）與 legacy 分支（`ENABLE_UNIFIED_PROCESSOR !== 'true'`）兩處 |
| Commit | `05ee290` |
| 問題 | `Promise.allSettled(...)` 回傳的 promise **永不 reject**，故其後的 `.catch()` 為 dead code；回傳的結果陣列亦從未被檢查 → 個別文件失敗被靜默吞掉（事故當日 8 份失敗、**零 log**） |
| 做法 | 改為 `.then((results) => …)` 逐一檢查 `status === 'rejected'`，以索引對回 `documentsToProcess[i]` / `uploaded[i]` 取得失敗文件的 `id` + `fileName`，用 `console.error` 記錄；末尾保留 `.catch()` 作為「處理邏輯本身出錯」的 backstop（此處才是真正可能 reject 之處，同時滿足 `no-floating-promises`） |
| 保留行為 | 兩處仍為 fire-and-forget（不 `await`），HTTP 回應照舊立即返回；僅失敗不再消失 |
| 效果 | 同類事故重演時，容器 log 會出現 `[upload] auto-process failed for <id> (<fileName>): <reason>`，不再需要靠用戶回報 |
| 格式 | `%s` 佔位符沿用 repo 既有 pattern（Semgrep unsafe-formatstring）；`console.error` match 相鄰既有風格（換 logger 屬另一 backlog 項，未混入） |
| 驗證 | `npx eslint` 通過；`npm run type-check` 剩餘 4 個錯誤全在 `src/services/llm/`（本地缺 Epic 23 套件），與本改動無關；`UploadedFile`（本檔 79-86 行）確認有 `id` / `fileName` |

> ⚠️ 收斂 1 只捕捉 promise **reject** 的失敗（即本次事故那種：`persistProcessingResult` 於裸 `findUnique` throw）。「`processFile` 回傳 `success: false` 但 `persistProcessingResult` 成功寫入 `OCR_FAILED`」的情況 promise 為 fulfilled，不在此範圍——但該情況已在 DB 留記錄，非靜默丟失，屬可接受。

### 5.4 記憶體基線隱患

Plan 記憶體基線常駐 **77–80%**，事件期間達 95%。即使實施限流，餘裕仍相當薄。建議一併評估 App Service Plan SKU 是否足夠（**尚未查證 SKU 規格**）。

---

## 6. 待辦（下一步）

- [x] ~~**臨時緩解**：`MAX_FILES_PER_BATCH` 20 → 15~~（已完成 2026-07-10，commit `35f7298`，見 §5.1；**不等於問題已解決**）
- [ ] **止血 A**：手動觸發 FIX-094 sweeper 回收 §1.2 的 4 份 `OCR_PROCESSING`（先確認端點是否 404）
- [ ] **止血 B**：重新觸發 §1.2 的 4 份 `UPLOADED` 文件處理（sweeper 掃不到，需人工）
- [ ] **治本**：`upload/route.ts:371` 實作併發限制（建立實作 FIX 或擴充本 FIX，需用戶決定範圍）
- [x] ~~**收斂 1**：修復無效的 `.catch()`，改為檢查 `allSettled` 回傳陣列~~（已完成 2026-07-13，commit `05ee290`，見 §5.3；unified + legacy 兩處）
- [ ] **收斂 2**：`processing-result-persistence.service.ts:259` 的裸 `findUnique` 納入 `withDbRetry`
- [ ] 查 App Service Plan `ASP-RAPOSCM-AIDocProcessing-DEV` 的 SKU 與記憶體上限（§5.4）
- [ ] 評估 `UPLOADED` 孤兒的可識別性設計（寫入 `processing_started_at`？屬 H1，需討論）
- [ ] 覆核 CHANGE-098 的起因事件（2026-07-08 01:42 UTC）是否亦為批次上傳所致 —— 若是，該 CHANGE 的方向可能同樣被誤判
- [ ] 清理 Kudu `/home` 遺留的 `fix106-query.js`、`/home/home/fix106-query.js`、`node_modules/pg`

---

## 7. 資料來源與可信度

- §3 全部內容取自 2026-07-10 實際執行 §2.1 查詢的原始 JSON 回傳（42 筆），筆數與時間戳未經加工。
- §1.1／§1.2 取自 2026-07-10 經 Kudu 在容器內執行的純 `SELECT` 查詢（§2.3），無任何寫入。
- §4.4 指標表取自 2026-07-10 執行 §2.2 的 `az monitor metrics list` 回傳（1 分鐘聚合，Maximum）。
- §3.3 明確標示為「由筆數反推」的推論，非 log 直述。
- §4.1／§4.4 對 `newClient()` vs pending-queue 路徑的區分，依據本機 `node_modules/pg-pool/index.js`（`:262` / `:216`）原始碼比對。
- §4.5 的耗時為真實時間戳相減得出。
- 本文件原為調查記錄。截至 v3.2，已實作 **§5.1 臨時緩解**（commit `35f7298`）與 **§5.3 收斂 1**（commit `05ee290`）；§5 表格中的**治本**、**收斂 2**、**止血 A/B** 仍未執行。

---

## 8. 更正記錄

### 8.1 v2 → v3（2026-07-10）—— 根因改判

| v2 認定 | v3 覆現結果 |
|---------|-------------|
| 直接根因為「DB 連線 timeout」（PG 側故障） | **PG 全程健康**（CPU ~12%、Mem ~56%、conns ≤16）。是 App Service 記憶體 95% / CPU 99% 導致事件迴圈凍結，`pg-pool` 自行 destroy socket |
| §4.4 假設 A / C / D 列為「待查」 | 全部**排除**。新增並確立假設 **E（應用端事件迴圈飽和）** |
| §4.5「附帶異常：`connectionTimeoutMillis` 未生效」 | 升格為**核心機制證據**（timer 延遲 12–37 秒 = 事件迴圈阻塞指紋） |
| §5 治本 =「升 PG 規格 / 修網路 / 加 PgBouncer」 | 全部**無效**。治本 = **限制併發處理數** |
| §5「併發放大因素」僅為次要註記 | 併發即**主因** |
| §1 稱「log 的 4 個 ID 比 UI 的 3 份多一份」 | **錯誤**。兩批文件**完全不重疊**：log 中 abort 的 4 份停在 `UPLOADED`；UI 卡住的 4 份狀態為 `OCR_PROCESSING` |
| §3.4 推論「4 個重試成功者即卡住的那批」 | **錯誤**。重試成功的 4 份最終為 `MAPPING_COMPLETED` |
| §4.2 標為「待查：是否嘗試寫 `OCR_FAILED`」 | **已確認**：abort 路徑不寫 DB；負責寫入的 `persistProcessingResult` 在 `:259` 裸 `findUnique` 即拋，錯誤被 `Promise.allSettled` 靜默吞掉 |

### 8.2 v1 → v2（2026-07-10）—— log 造假更正

v1 的 §3 時間線宣稱「逐字節錄，未加工」，經覆現證實**含有不存在於真實 log 的內容**：

| v1 宣稱 | 覆現結果 |
|---------|----------|
| `03:13:48.579` `(attempt 3/3), retrying in 500ms` | **不存在**。全段 `attempt 3/3` 出現 0 次；`db-retry.ts:115` 在最後一次嘗試時 `break`、不印訊息 |
| `03:13:49.109` `persistent DB error … after 3 attempts` | **不存在**。`persistent DB error` 字串在整個 git 歷史中從未存在於任何程式碼 |
| 退避序列 `200/500/500ms` | 實際為 `DEFAULT_BACKOFF = [200, 500, 1000]`（`db-retry.ts:77`） |
| 「風暴橫跨約 80 秒」 | 實際 **86.5 秒**（`03:12:30.712` → `03:13:57.241`） |
| 「03:13:49 之後未見任何後續記錄」 | 與事實相反：`03:13:55–57` 有 12 筆記錄 |
| 「`03:12:30 ~ 03:13` 連續大量重複」 | 第一波實際集中在 **0.22 秒內** |
| 未收錄 | 8 筆 `[UnifiedProcessor]` 訊息 —— 判定因果的關鍵證據 |
| 「3 份文件」 | log 顯示 4 個 document ID（且與 UI 的 3 份不重疊） |

---

*文件建立日期: 2026-07-10*
*最後更新: 2026-07-10（v3 —— 根因確認）*
