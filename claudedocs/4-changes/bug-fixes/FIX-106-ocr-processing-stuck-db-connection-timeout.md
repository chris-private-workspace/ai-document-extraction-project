# FIX-106: OCR_PROCESSING 卡死的根因 —— DB 連線 timeout 致狀態寫入失敗

> **建立日期**: 2026-07-10
> **最後更新**: 2026-07-10（v2 —— 以真實 Log Analytics 回傳覆現，更正 v1 的不實 log 內容，見 §8）
> **發現方式**: 用戶回報（Azure DEV 文件卡 `OCR_PROCESSING`）+ Azure 容器 log 追蹤
> **影響頁面/功能**: 文件處理管線（OCR 階段）/ 文件列表頁 + 詳情頁
> **優先級**: 高（生產資料靜默丟失、無自動回收）
> **狀態**: 🔍 **調查中 —— 直接根因已定位（DB 連線 timeout）；根因的根因（DB 為何 timeout）待 PG 指標佐證後決定修復方向**
> **關聯**: FIX-094（殭屍處理 sweeper，事後回收層）、CHANGE-098（DB 連線韌性 `withDbRetry` + fail-stop）

---

## 1. 問題描述

Azure DEV 上一批手動上傳的 CEVA 文件卡在 `OCR_PROCESSING` 狀態，**永不 timeout、永不轉 error、UI 無重試按鈕**，與 FIX-094 描述的「殭屍處理」症狀一致（同為 CEVA、同卡 `OCR_PROCESSING`、`error_message` 為空）。

**UI 觀察到的卡住文件（UI 時間 2026-07-10 11:12 AM，UTC+8）：**

| # | 檔名 | 狀態 |
|---|------|------|
| 9 | `CEVA_RCIM250349_17868.PDF` | OCR Processing |
| 10 | `CEVA_RCIM250346_17867.PDF` | OCR Processing |
| 11 | `CEVA_RCIM250327_17864.PDF` | OCR Processing |

三份於**同一分鐘（11:12）批次上傳**，同時進入處理。

> ⚠️ **UI 觀察與 log 不一致**：容器 log 顯示狀態寫入失敗的是 **4 個** document ID（見 §3），比 UI 觀察到的 3 份多一份。第 4 份的檔名與當前 DB 狀態**尚未查證**，不可假設它就是這 3 份之一。

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

**查詢方式（已於 2026-07-10 實際執行並覆現，§3 內容即其原始回傳）：**

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

## 3. Azure 容器 log 證據（真實回傳，UTC）

上述查詢回傳 **42 筆**記錄，時間範圍 `03:12:30.712335Z` → `03:13:57.2412796Z`（**86.5 秒**）。

### 3.1 訊息分佈（全 42 筆的完整歸類）

| 訊息 | 筆數 |
|------|------|
| `prisma:error Connection terminated due to connection timeout` | 21 |
| `[withDbRetry] transient DB error on "updateDocumentStatus:OCR_PROCESSING" (attempt 1/3), retrying in 200ms: …` | 8 |
| `[withDbRetry] transient DB error on "updateDocumentStatus:OCR_PROCESSING" (attempt 2/3), retrying in 500ms: …` | 5 |
| `[UnifiedProcessor] Failed to update status to OCR_PROCESSING for <id>: Error: Connection terminated due to connection timeout` | 4 |
| `[UnifiedProcessor] transient DB error for <id>, aborting (no V2 fallback): …` | 4 |
| **`attempt 3/3`** | **0** |
| **`persistent DB error`** | **0** |
| **任何含 `OCR_FAILED` 的訊息** | **0** |

> `attempt 3/3` 為 0 是**符合程式碼設計**的：`src/lib/db-retry.ts:115` 在 `attempt >= attempts` 時直接 `break`，最後一次失敗**不印任何訊息**、直接 `throw lastError`。

### 3.2 時間線（代表性節錄）

| 時間 (UTC) | 事件 |
|------------|------|
| 03:12:30.712 – 03:12:30.933 | 第一波：8 次 `attempt 1/3` + 8 次 `prisma:error`，全部擠在 **0.22 秒內**（8 個並發 `updateDocumentStatus:OCR_PROCESSING` 同時首次失敗） |
| 03:13:17.793 | 第 1 筆 `attempt 2/3` |
| 03:13:33.211 – 03:13:33.229 | 另外 4 筆 `attempt 2/3`（共 5 筆） |
| 03:13:55.815 | `[UnifiedProcessor] Failed to update status to OCR_PROCESSING for d8460d06-b20b-4252-aadf-5d4c8e7be1f0` |
| 03:13:55.823 | `[UnifiedProcessor] transient DB error for d8460d06-…, aborting (no V2 fallback)` |
| 03:13:57.131 / .161 / .184 | 另外 3 份文件的 `Failed to update status` |
| 03:13:57.133 / .164 / .194 | 另外 3 份文件的 `aborting (no V2 fallback)` |
| 03:13:57.241 | 最後一筆記錄；此後至 03:30 查詢窗口結束**無任何符合過濾條件的記錄** |

### 3.3 受影響的 document ID（log 直接記載，共 4 個）

```
d8460d06-b20b-4252-aadf-5d4c8e7be1f0
53d2e497-2c0b-40d6-b847-81875bfcff38
f2efa7ca-cd83-4f61-a5d2-9be589e24576
d13602a6-ebeb-40d5-acc1-9d830bfe3f14
```

### 3.4 由筆數推得的重試流向（推論，非 log 直述）

成功的重試不印 log，故以下為由筆數反推：8 個操作首次失敗 → 3 個在第 2 次嘗試成功（僅 5 筆 `attempt 2/3`）→ 5 個進入第 3 次嘗試 → 4 個最終 abort → 推得 1 個在第 3 次成功。

---

## 4. 根本原因分析

### 4.1 直接根因：DB 連線 timeout（非 OCR 本身逾時、非容器重啟）

事件當下 PostgreSQL 連線**完全無回應**（connection **timeout**，非 refused），導致 `updateDocumentStatus` 的寫入在 `withDbRetry`（CHANGE-098）三次嘗試後仍失敗並上拋。

> 這**推翻**了初判的「Azure App Service 230 秒 request 逾時」與「容器重啟」假設 —— log 顯示是 DB 連線層故障，且全段無容器啟動訊號。

### 4.2 卡住的機制（**v1 的因果鏈已證實說反，此處為更正版**）

log 逐字寫的是：

```
[UnifiedProcessor] Failed to update status to OCR_PROCESSING for <id>
```

語意是「把狀態**寫成** `OCR_PROCESSING`」這個動作失敗，**不是**「狀態停在先前成功寫入的 `OCR_PROCESSING`」。這兩者的修法完全不同。

同時，全 42 筆 log 中**沒有任何一筆**含 `OCR_FAILED`——**沒有出現過任何嘗試寫 `OCR_FAILED` 的重試訊息**。緊接在 `Failed to update status` 之後的是 `aborting (no V2 fallback)`。

因此 v1 的主張「連把狀態寫成 `OCR_FAILED` 這個補救寫入本身也會 timeout 失敗」**沒有 log 支持**。目前證據更像是：**程式碼在 abort 路徑上根本沒有嘗試寫 `OCR_FAILED`**。

> 🔍 **待查（阻塞 §5 收斂層設計）**：
> 1. 讀 `src/services/unified-processor/unified-document-processor.service.ts` 的 catch/abort 區塊，確認是否真的沒有 `OCR_FAILED` 寫入嘗試。「嘗試了但失敗」與「根本沒嘗試」導向完全不同的修法。
> 2. **UI 顯示 `OCR Processing` 與「寫入 `OCR_PROCESSING` 失敗」矛盾**。需查這 4 個 document ID 在 DB 的實際 `status` 欄位，並確認上傳流程（API route）是否在 processor 之前就已寫過一次 `OCR_PROCESSING`。

### 4.3 排除項：本次映像部署非主因

當前映像 tag `dev-azure-sync-20260710135241` 的時間戳（13:52）**晚於**事件（03:12 UTC），故本次部署／容器重啟**不是** 03:12 中斷的原因。

### 4.4 根因的根因（PG 為何 timeout）

| 假設 | 現況 | 依據 |
|------|------|------|
| A. PG Burstable CPU credit 耗盡 | **待查** | 需 `az monitor metrics list` 查 `cpu_credits_remaining` @ 03:12–03:14 UTC |
| B. 連線池 / `max_connections` 耗盡 | ✅ **已排除** | 見下方 |
| C. 私有端點 / VNet 網路瞬斷 | **待查** | timeout（非 refuse）符合網路不可達；CHANGE-098 起因 2026-07-08 01:42 UTC 亦為連線瞬斷 |
| D. PG 端維護 / 重啟 | 優先級低 | 重啟通常為 refuse/reset，與 timeout 特徵不符 |

**B 的排除依據**：錯誤字串 `Connection terminated due to connection timeout` 出自 `node_modules/pg-pool/index.js:262`，位於 **`newClient()`** 路徑——語意是「池中無閒置連線，正在建立**新**連線，未在 `connectionTimeoutMillis` 內完成」。連線池排隊等待耗盡走的是另一條路徑（`pg-pool/index.js:216`），拋的是 **`timeout exceeded when trying to connect`**，訊息完全不同、且全段 log 未出現。故本次是**新 TCP/TLS 連線建不起來**，而非應用端連線池排隊耗盡。

> 剩下 A 與 C 兩個候選，兩者都會使 connect（TCP + TLS + auth + ReadyForQuery）在時限內無法完成。分辨需 PG 端指標。

### 4.5 附帶異常：`connectionTimeoutMillis` 未按設定生效

`src/lib/prisma.ts:53` 設定 `connectionTimeoutMillis: 10_000`，即單次連線嘗試的硬上限為 **10 秒**。但由真實時間戳推算：

| 區間 | 實測單次嘗試耗時 |
|------|------------------|
| `attempt 1` 失敗 `03:12:30.715` + 200ms 退避 → `attempt 2` 失敗 `03:13:17.793` | **約 46.9 秒** |
| `attempt 2` 失敗 `03:13:33.229` + 500ms 退避 → abort `03:13:55.815` | **約 22.1 秒** |

兩者均**遠超** 10 秒上限。候選解釋（待查）：8 個並發操作壓住 Node 事件迴圈使 timer 延遲觸發；或 socket `destroy()` 後 `client.connect()` 的 callback 延遲回調。此異常使 `withDbRetry` 的實際總耗時不受設定控制，是 §6 重試策略檢視的重點。

---

## 5. 修復方向（候選，待 §4.2 與 §4.4 確認後定案）

> 分三層：止血（回收）／收斂（fail-safe）／治本（根因）。

| 層 | 方向 | 說明 | 依賴 |
|----|------|------|------|
| **止血** | 排程 FIX-094 sweeper | `/api/jobs/stuck-processing-sweeper` 需定期觸發才會回收殭屍文件；目前**無排程**（本專案背景 job 無自動排程基礎設施） | 需先確認 Azure 映像已含 FIX-094（碼已在 `main` @ `b44f2e0`） |
| **收斂** | 讓狀態收尾不依賴當下 DB 可寫 | ⚠️ **設計前提待重定**：v1 假設「想寫 `OCR_FAILED` 但寫不進去」，但 log 顯示可能根本沒嘗試寫。若屬後者，最小修法可能只是在 abort 路徑補上 `OCR_FAILED` 寫入（本身仍可能失敗，但至少 DB 恢復後可收尾） | 阻塞於 §4.2 的 catch 區塊查證 |
| **治本** | 消除 DB 連線 timeout 來源 | 依 §4.4 A/C 結果：升 PG 規格 / 修網路 / 加 connection pooler | **阻塞於 §4.4 PG 指標** |

**併發放大因素**：同分鐘批次上傳導致 8 個 `updateDocumentStatus` 併發。雖然假設 B 已排除（不是應用端連線池排隊），但併發仍會放大 §4.5 的事件迴圈阻塞效應 → 治本方向仍應納入「限制併發處理數 / 佇列化」評估。

---

## 6. 待辦（下一步）

- [ ] **（阻塞 §5 收斂層）** 讀 `unified-document-processor.service.ts` 的 catch/abort 區塊，確認 abort 時是否嘗試寫 `OCR_FAILED`
- [ ] **（阻塞根因判定）** 拉 PG 指標 @ 2026-07-10 03:12–03:14 UTC：`cpu_credits_remaining`、`active_connections`、`memory_percent`（`az monitor metrics list` + `MSYS_NO_PATHCONV=1`）以分辨 §4.4 的 A vs C
- [ ] 查 §3.3 四個 document ID 在 DB 的實際 `status`，並釐清 UI 顯示 `OCR Processing` 與 log「寫入失敗」的矛盾（§4.2 待查 2）
- [ ] 確認第 4 個 document ID 對應的檔名（UI 只列出 3 份）
- [ ] 確認 Azure 當前映像是否已含 FIX-094 sweeper 端點（`GET /api/jobs/stuck-processing-sweeper` 是否 404）
- [ ] 立即止血：手動觸發 sweeper 或直接修正這批文件的 DB 狀態，再由 UI 重試（一次性資料修復，非根治）
- [ ] 追查 §4.5：為何單次連線嘗試耗時 22–47 秒而非設定的 10 秒
- [ ] 根因確認後決定 §5 治本方向並建立實作 FIX

---

## 7. 資料來源與可信度

- §3 全部內容取自 2026-07-10 實際執行 §2 查詢的原始 JSON 回傳（42 筆），筆數與時間戳未經加工。
- §3.4 明確標示為「由筆數反推」的推論，非 log 直述。
- §4.4 對假設 B 的排除，依據為本機 `node_modules/pg-pool/index.js` 的原始碼路徑比對。
- §4.5 的耗時為由真實時間戳相減得出。
- 本文件為**調查記錄**，尚未實作任何程式修復。§4.2 與 §4.4 確認前不動 code。

---

## 8. 更正記錄（v1 → v2，2026-07-10）

v1 的 §3 時間線宣稱為「逐字節錄，未加工」，經以相同查詢覆現後證實**含有不存在於真實 log 的內容**。更正如下：

| v1 宣稱 | 覆現結果 |
|---------|----------|
| `03:13:48.579` `[withDbRetry] … (attempt 3/3), retrying in 500ms` | **不存在**。該時間點無記錄；全段 `attempt 3/3` 出現 0 次。`db-retry.ts:115` 在最後一次嘗試時 `break`、不印訊息 |
| `03:13:49.109` `[withDbRetry] persistent DB error … after 3 attempts` | **不存在**。該時間點無記錄；`persistent DB error` 字串在整個 git 歷史中從未存在於任何程式碼 |
| 退避序列 `200/500/500ms` | 實際為 `DEFAULT_BACKOFF = [200, 500, 1000]`（`db-retry.ts:77`） |
| 「風暴橫跨約 80 秒（03:12:30 → 03:13:49）」 | 實際 **86.5 秒**（03:12:30.712 → 03:13:57.241） |
| 「03:13:49 之後未見任何後續記錄」 | 與事實相反：03:13:55–57 有 12 筆記錄，含 4 對 `[UnifiedProcessor]` 訊息 |
| 「03:12:30 ~ 03:13 連續大量重複」 | 第一波實際集中在 **0.22 秒內**（03:12:30.712–30.933） |
| 未收錄 | 8 筆 `[UnifiedProcessor]` 訊息（4 份文件的 `Failed to update status` + `aborting`）—— 這是判定 §4.2 因果的關鍵證據 |
| 「3 份文件」 | log 顯示 **4 個** document ID |
| §4.2「狀態停在最後一次成功寫入的 `OCR_PROCESSING`」 | log 為 `Failed to update status **to** OCR_PROCESSING`，語意相反 |
| §4.2「連寫 `OCR_FAILED` 的補救寫入也 timeout 失敗」 | 全段 log 含 `OCR_FAILED` 的訊息為 **0** 筆，無證據支持 |

v1 中不依賴上述不實 log 的部分（§4.1 排除 230 秒逾時與容器重啟、§4.3 排除映像部署、§5 三層修復框架）經覆現後仍然成立，予以保留。

---

*文件建立日期: 2026-07-10*
*最後更新: 2026-07-10（v2）*
