# FIX-106: OCR_PROCESSING 永久卡死的根因 —— DB 連線 timeout 致狀態無法收尾

> **建立日期**: 2026-07-10
> **發現方式**: 用戶回報（Azure DEV 3 份 CEVA 文件卡 `OCR_PROCESSING`）+ Azure 容器 log 追蹤
> **影響頁面/功能**: 文件處理管線（OCR 階段）/ 文件列表頁 + 詳情頁
> **優先級**: 高（生產資料靜默丟失、無自動回收）
> **狀態**: 🔍 **調查中 —— 直接根因已定位（DB 連線 timeout）；根因的根因（DB 為何 timeout）待 PG 指標佐證後決定修復方向**
> **關聯**: FIX-094（殭屍處理 sweeper，事後回收層）、CHANGE-098（DB 連線韌性 `withDbRetry` + fail-stop）

---

## 1. 問題描述

Azure DEV 上一批手動上傳的 CEVA 文件卡在 `OCR_PROCESSING` 狀態，**永不 timeout、永不轉 error、UI 無重試按鈕**，與 FIX-094 描述的「殭屍處理」症狀一致（同為 CEVA、同卡 `OCR_PROCESSING`、`error_message` 為空）。

**卡住文件（UI 時間 2026-07-10 11:12 AM，UTC+8）：**

| # | 檔名 | 狀態 |
|---|------|------|
| 9 | `CEVA_RCIM250349_17868.PDF` | OCR Processing |
| 10 | `CEVA_RCIM250346_17867.PDF` | OCR Processing |
| 11 | `CEVA_RCIM250327_17864.PDF` | OCR Processing |

三份於**同一分鐘（11:12）批次上傳**，同時進入處理。

---

## 2. 調查環境與資源

| 項目 | 值 |
|------|-----|
| WebApp | `WebApp-RAPOSCM-AIDocProcessing-DEV` |
| 當前映像 tag | `dev-azure-sync-20260710135241`（建置於事件**之後**，非本次中斷主因，見 §4.3） |
| Log Analytics workspace | `log-raposcm-aidocprocessing-dev`（customerId `1cf79233-ded9-48c7-ae6a-e6c84858ab5a`） |
| Resource Group | `RG-RAPOSCM-AIDocProcessing-DEV` |
| 容器 stdout 表 | `AppServiceConsoleLogs`（`ResultDescription` 欄） |
| 時區換算 | UI 用 UTC+8；11:12 AM (UTC+8) = **03:12 UTC** |

**查詢方式（供覆現）：**
```bash
az monitor log-analytics query \
  --workspace 1cf79233-ded9-48c7-ae6a-e6c84858ab5a \
  --analytics-query 'AppServiceConsoleLogs
    | where TimeGenerated between (datetime(2026-07-10T03:12:00Z) .. datetime(2026-07-10T03:30:00Z))
    | where ResultDescription has_any ("connection timeout","withDbRetry","OCR_PROCESSING")
    | order by TimeGenerated asc
    | project TimeGenerated, ResultDescription' -o json
```

---

## 3. Azure 容器 log 證據（時間線，UTC）

| 時間 (UTC) | log（`ResultDescription`，逐字節錄） |
|------------|------|
| 03:12:30.712 | `prisma:error Connection terminated due to connection timeout` |
| 03:12:30.715 | `[withDbRetry] transient DB error on "updateDocumentStatus:OCR_PROCESSING" (attempt 1/3), retrying in 200ms: Connection terminated due to connection timeout` |
| 03:12:30 ~ 03:13 | 上述兩行**連續大量重複**（多份文件併發，各自 attempt 1/3） |
| 03:13:17.793 | `[withDbRetry] transient DB error on "updateDocumentStatus:OCR_PROCESSING" (attempt 2/3), retrying in 500ms: ...` |
| 03:13:48.579 | `[withDbRetry] transient DB error on "updateDocumentStatus:OCR_PROCESSING" (attempt 3/3), retrying in 500ms: ...` |
| 03:13:49.109 | `[withDbRetry] persistent DB error on "updateDocumentStatus:OCR_PROCESSING" after 3 attempts: Connection terminated due to connection timeout` |
| 03:13:49 之後（至 03:45 窗口） | 以 `connection timeout` / `OCR_COMPLETED` / `MAPPING` / `recovered` 過濾**未見任何後續記錄** —— 連線風暴停止、且這批文件無恢復處理 |

**關鍵觀察：**
- 風暴橫跨約 **80 秒**（03:12:30 → 03:13:49）。三次 attempt 之間各隔數十秒，遠大於 200/500ms 退避 —— 代表**每次建立連線都卡到 connection timeout 才失敗**（不是被 refuse/reset）。
- 全程**只有 `updateDocumentStatus:OCR_PROCESSING` 的重試**，**無任何 `OCR_FAILED` 標記、無容器重啟 / 啟動訊號**。

---

## 4. 根本原因分析

### 4.1 直接根因：DB 連線 timeout（非 OCR 本身逾時、非容器重啟）

事件當下 PostgreSQL 連線**完全無回應**（connection **timeout**，非 refused），導致 `updateDocumentStatus` 的寫入在 `withDbRetry`（CHANGE-098）三次重試後仍失敗並拋出 `persistent DB error`。

> 這**推翻**了初判的「Azure App Service 230 秒 request 逾時」與「容器重啟」假設 —— log 顯示是 DB 連線層故障。

### 4.2 為何永久卡在 OCR_PROCESSING（FIX-094 機制的更精確版本）

FIX-094 記述「錯誤在走到標記 `OCR_FAILED` 的 catch 之前就中斷處理」。本次 log 揭示更精確的因果：

> **DB 完全不可用時，連「把狀態寫成 `OCR_FAILED`」這個補救寫入本身也會 timeout 失敗。**

因此 CHANGE-098 的 fail-stop 即使把錯誤往上拋，上層 catch 想標記失敗也寫不進去 → 文件狀態停在最後一次成功寫入的 `OCR_PROCESSING`，成為殭屍。這是 **CHANGE-098（fail-stop）與 FIX-094（事後 sweeper）之間的缺口**：狀態收尾依賴 DB，而故障正是 DB 本身。

### 4.3 排除項：本次映像部署非主因

當前映像 tag `dev-azure-sync-20260710135241` 的時間戳（13:52）**晚於**事件（03:12 UTC），故本次部署／容器重啟**不是** 03:12 中斷的原因。

### 4.4 根因的根因（**待查** —— PG 為何 timeout）

connection **timeout**（無回應）指向以下候選，**需 PG 端指標佐證，尚未下定論**：

| 假設 | 佐證方向 | 備註 |
|------|----------|------|
| A. PG Burstable CPU credit 耗盡 | `az monitor metrics list` 查 `cpu_credits_remaining` @ 03:12 UTC | 本專案 PG 為 Burstable |
| B. 連線池 / `max_connections` 耗盡 | 查 `active_connections` 峰值；三份併發上傳同時開連線 | 批次同時處理是合理觸發點 |
| C. 私有端點 / VNet 網路瞬斷 | 對照網路層；CHANGE-098 起因 2026-07-08 01:42 UTC 亦為連線瞬斷 | timeout（非 refuse）較符合網路不可達 |
| D. PG 端維護 / 重啟 | PG 平台事件 log | 重啟通常為 refuse/reset，與 timeout 特徵略不符，優先級較低 |

---

## 5. 修復方向（候選，待根因 §4.4 確認後定案）

> 分三層：止血（回收）／收斂（fail-safe）／治本（根因）。前兩層與根因無關，可先行；第三層須依 §4.4 結果決定。

| 層 | 方向 | 說明 | 依賴 |
|----|------|------|------|
| **止血** | 排程 FIX-094 sweeper | `/api/jobs/stuck-processing-sweeper` 需定期觸發才會回收殭屍文件；目前**無排程**（本專案背景 job 無自動排程基礎設施） | 需先確認 Azure 映像已含 FIX-094（碼已在 `main` @ `b44f2e0`） |
| **收斂** | 狀態收尾去 DB 依賴 / 補償 | DB 不可用時無法寫 `OCR_FAILED`；可考慮：處理入口先建 `ProcessingQueue`／持久化「處理中」憑證，重啟後由 sweeper 依憑證回收，不依賴當下 DB 可寫 | 與 §4.4 無關，可獨立設計 |
| **治本** | 消除 DB 連線 timeout 來源 | 依 §4.4 A/B/C/D 結果：升 PG 規格 / 調連線池上限 / 修網路 / 加 connection pooler（如 PgBouncer） | **阻塞於 §4.4 PG 指標** |

**併發放大因素**：三份 CEVA 同分鐘上傳＝同步管線同時開多條 DB 連線，若根因為 B（連線池／`max_connections`），批次上傳會顯著放大故障機率 → 治本方向應納入「限制併發處理數 / 佇列化」評估。

---

## 6. 待辦（下一步）

- [ ] **（阻塞根因判定）** 拉 PG 指標 @ 2026-07-10 03:12 UTC：`cpu_credits_remaining`、`active_connections`、`memory_percent`（`az monitor metrics list` + `MSYS_NO_PATHCONV=1`）
- [ ] 確認 Azure 當前映像是否已含 FIX-094 sweeper 端點（`GET /api/jobs/stuck-processing-sweeper` 是否 404）
- [ ] 立即止血：手動觸發 sweeper 或直接改這 3 份 DB 狀態 `OCR_PROCESSING → OCR_FAILED`，再由 UI 重試（一次性資料修復，非根治）
- [ ] 根因確認後決定 §5 治本方向並建立實作 FIX
- [ ] 檢視 `withDbRetry` 退避策略：目前 3 次（200/500/500ms）對「每次連線各卡數十秒 timeout」的場景，總耗時受單次 connect timeout 主導，重試次數的效益有限 —— 評估是否需調整 connect timeout / 重試上限

---

## 7. 備註

- 本文件為**調查記錄**，尚未實作任何程式修復。§4.4 根因未確認前不動 code。
- 所有 log 均引自 Azure `AppServiceConsoleLogs` 實際回傳（2026-07-10 查詢），逐字節錄，未加工。
- 第二查詢（timeout 筆數 summarize）已回傳但數值未取回，故本文件不列具體筆數，僅依實際節錄描述「連續大量重複」。

---

*文件建立日期: 2026-07-10*
*最後更新: 2026-07-10*
