# CHANGE-098: DB 連線韌性與 transient 錯誤處理強化

> **日期**: 2026-07-08
> **狀態**: ✅ 已部署 Azure DEV（2026-07-09，映像 `dev-change098-20260709102634`；部署記錄見 `docs/07-deployment/02-azure-deployment/deployment-records/2026-07-09-dev-change098.md`）
> **優先級**: High
> **類型**: Reliability / Resilience
> **影響範圍**: 資料庫連線層（`src/lib/prisma.ts`）+ 文件處理 pipeline（UnifiedProcessor / extraction-v3 / 結果持久化）

---

## 變更背景

2026-07-08 01:42:55–01:44:47 UTC（= 09:42–09:44 AM 本地），Azure DEV 環境私有端點到 PostgreSQL 發生**一次性連線瞬斷**（約 2 分鐘），容器 log 爆出一批 `prisma:error Connection terminated unexpectedly`，並導致**同一波 9 份文件**同時 `Failed to update status to OCR_PROCESSING`。

### 根因查證（實證，非推測）

| 項目 | 查證結果 |
|------|----------|
| 錯誤性質 | `Connection terminated unexpectedly` = node-postgres 在連線中途被切斷時丟出；非應用邏輯錯 |
| DB 伺服器端狀態 | **健康**：CPU credit 穩定 307（未耗盡）、記憶體 ~58%、活躍連線 ≤7、無 failed connection 尖峰、Activity Log 無重啟/維護、`is_db_alive=1` |
| 頻率 | 過去 3 天僅此一次爆發（01:00 桶 22 筆），之後歸零 → **一次性瞬斷，非慢性** |
| 影響範圍 | 同窗 **9 份不同文件**同時失敗（整個連線池同時被切） |
| 架構 | App Service 容器 → 私有端點 `pe-pgsql-raposcm-aidocprocessing-dev` → PostgreSQL（Burstable, PG18）|

**判定**：私有端點路徑上的短暫連線層瞬斷（DB 資源健康 + 整批同時失敗 + 非慢性），**非** DB 資源耗盡或重啟。

### 問題在應用端「零韌性」

1. **連線層裸配置**：`src/lib/prisma.ts` 以 `new Pool({ connectionString })` 建立，未設 `keepAlive`、無 retry、無 pool 錯誤監聽。
2. **無 transient 錯誤 retry**：pipeline 各步對 `Connection terminated` 不重試，一斷即硬失敗。
3. **DB 寫入失敗仍靜默續跑**：`updateDocumentStatus`（`unified-document-processor.service.ts:288-303`）自行 try/catch 後只 `console.warn`、不重拋；ref-match 例外被 catch 後亦繼續（`extraction-v3.service.ts:425`）。

### 後果

受影響文件在 DB 不可用的那 2 分鐘內無法正確持久化 `ExtractionResult`，卻仍被當「成功」推進 → 後續 template instance 匹配讀到空/不完整資料 → **匹配不到任何值**。

---

## 變更內容

### Part 1 — 連線韌性（`src/lib/prisma.ts`）

pg Pool 目前只有 `connectionString`。加上連線韌性設定：

- `keepAlive: true` + `keepAliveInitialDelayMillis`：啟用 TCP keepalive，降低私有端點閒置連線被默默切斷的機率。
- `connectionTimeoutMillis`：建立連線逾時，避免無限等待。
- `idleTimeoutMillis`、明確 `max`：閒置回收 + 明確連線上限（配合 Burstable 連線數限制）。
- `pool.on('error', …)`：監聽閒置 client 錯誤，避免變成未捕捉例外拖垮進程。

### Part 2 — transient 錯誤 retry（新增 `src/lib/db-retry.ts`）

小型 `withDbRetry(fn)` 包裝器：

- **只對暫時性連線錯誤**重試：訊息含 `Connection terminated unexpectedly` / `ECONNRESET` / `ETIMEDOUT`，或 pg code `57P01`（admin shutdown）/ `08006` / `08003`（connection failure）。
- 指數退避、限次（3 次：200ms → 500ms → 1s）。
- **只套用在冪等寫入路徑**（status update、upsert 持久化），避免重複寫入副作用。
- 非暫時性錯誤（如驗證錯、唯一鍵衝突）**不重試**、直接上拋。

### Part 3 — 失敗即停（`unified-document-processor.service.ts`、`extraction-v3.service.ts`）

- `updateDocumentStatus` 對**關鍵狀態轉換**（初始 `OCR_PROCESSING`）改為：`withDbRetry` 後仍失敗即**上拋**（不再靜默 `console.warn`）。
- 主處理流程遇關鍵 DB 操作失敗 → 文件標為 **FAILED（可重試）並中止**，不再續跑產生半殘結果。
- 最終結果持久化（`persistProcessingResult`）以 `withDbRetry` 包裝；仍失敗則視為處理失敗。
- ref-match 的**連線類例外**比照中止（與「查無匹配 = REF_MATCH_ABORT」分開處理，不混為一談、不靜默續跑）。

---

## 技術設計

### 修改範圍

| 文件 | 類型 | 變更內容 |
|------|------|----------|
| `src/lib/prisma.ts` | 🔧 修改 | pg Pool 加 `keepAlive` / `connectionTimeoutMillis` / `idleTimeoutMillis` / `max` + `pool.on('error')` |
| `src/lib/db-retry.ts` | 🆕 新增 | `withDbRetry()` transient 連線錯誤重試工具（自寫，無新依賴） |
| `src/services/unified-processor/unified-document-processor.service.ts` | 🔧 修改 | `updateDocumentStatus`（:288）關鍵轉換 retry + 失敗即上拋；主流程 DB 失敗 → 標 FAILED 並中止 |
| `src/services/processing-result-persistence.service.ts` | 🔧 修改 | `persistProcessingResult`（:515）以 `withDbRetry` 包裝 |
| `src/services/extraction-v3/extraction-v3.service.ts` | 🔧 修改 | ref-match（:425）連線類例外比照中止，不靜默續跑 |

### i18n 影響

無。本變更不新增使用者可見字串（錯誤訊息為開發者/logger 層級，用英文）。

### 資料庫影響

無 Prisma Schema 變更。僅調整連線層設定與錯誤處理邏輯。

---

## 設計決策

| # | 決策 | 選擇 | 理由 |
|---|------|------|------|
| 1 | retry 實作方式 | **自寫 `src/lib/db-retry.ts`** | 免加 npm 依賴（避免 H2 觸發）；邏輯簡單（~30 行） |
| 2 | retry 次數 / 退避 | **3 次，200ms → 500ms → 1s** | 撐過秒級瞬斷，又不過度拉長失敗案例 |
| 3 | 「關鍵、失敗即停」範圍 | **初始狀態轉換 + 最終結果持久化** | 這兩者失敗會直接造成資料遺失/半殘；中間 best-effort 狀態可容忍 |
| 4 | retry 套用對象 | **僅冪等操作**（status update、upsert 持久化） | 避免對非冪等寫入重試造成重複資料 |
| 5 | 受影響的 9 份文件資料修復 | **不含在本 CHANGE** | 另列清單供人工重新觸發處理（屬營運修復，非程式碼變更） |

---

## 影響範圍評估

### 文件影響清單

| 文件路徑 | 類型 | 說明 |
|----------|------|------|
| `src/lib/prisma.ts` | 🔧 修改 | 連線池韌性設定 |
| `src/lib/db-retry.ts` | 🆕 新增 | transient 重試工具 |
| `src/services/unified-processor/unified-document-processor.service.ts` | 🔧 修改 | 狀態更新 retry + 失敗即停 |
| `src/services/processing-result-persistence.service.ts` | 🔧 修改 | 持久化 retry |
| `src/services/extraction-v3/extraction-v3.service.ts` | 🔧 修改 | ref-match 例外處理對齊 |

### 向後兼容性

- **正常流程完全不變**：DB 健康時，retry 不觸發、行為與現況一致。
- **行為改變（刻意）**：DB 持續不可用時，文件由「假成功、資料半殘」改為「明確 FAILED、可重試」——這是修正，不是回歸。
- 無 API contract / DB schema / i18n 變更。

---

## 風險評估

| 風險 | 等級 | 緩解 |
|------|------|------|
| retry 拉長失敗案例處理時間 | 低 | 退避總和上限數秒；僅失敗路徑才觸發 |
| fail-stop 讓文件顯示 FAILED | 低（且為預期） | 取代「假成功」；標記為可重試，使用者可重新處理 |
| 對非冪等操作誤加 retry 造成重複寫入 | 中 | 決策 4：僅套冪等操作；review 時逐一確認 |

---

## 回滾計劃

純程式碼變更、無 schema/資料遷移。回滾方式：`git revert` 對應 commit → 重新 `az acr build` + 容器更新即還原。

---

## 部署（🔴 手動）

本項目 Azure **只用手動部署**，無任何自動部署：

1. 合併後手動 `az acr build`（registry `acrscmdocprocessingdev`）建置映像。
2. `az webapp config container set` 更新 `WebApp-RAPOSCM-AIDocProcessing-DEV` 至新映像 tag。
3. 推送 main 只觸發 GitHub CI 檢查（quality/security），**不部署** Azure。

> 參考 memory `project_azure_manual_deploy_only`、runbook `docs/07-deployment/02-azure-deployment/dev-deployment-runbook.md`。

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | transient 瞬斷可撐過 | 模擬連線中途被切（kill 連線）→ 關鍵寫入 retry 後成功，文件不半殘 | High |
| 2 | 持續不可用即停 | DB 持續不可用 → 文件標 FAILED（可重試），**不**產生空的 `ExtractionResult` | High |
| 3 | 正常流程不回歸 | DB 健康時行為與現況一致；`npm run type-check` / `npm run lint` / 既有測試通過 | High |
| 4 | retry 僅限 transient | 非暫時性錯誤（驗證錯、唯一鍵衝突）不重試、直接上拋 | Medium |
| 5 | pool 錯誤不拖垮進程 | 閒置 client 錯誤被 `pool.on('error')` 捕捉、記錄，不造成未捕捉例外 | Medium |

---

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | 單次瞬斷自動恢復 | 處理文件過程中重啟/切斷 DB 連線一次 | 關鍵寫入 retry 後成功，文件正常完成 |
| 2 | 持續不可用 | 處理期間 DB 全程不可達 | 文件標 FAILED（可重試），無半殘資料 |
| 3 | ref-match 連線例外 | ref-match 查詢時連線被切 | 比照中止、標失敗，不靜默續跑 |
| 4 | 正常路徑 | DB 健康下處理文件 | 行為與現況完全一致，retry 不觸發 |

---

## 實施計劃（分階段）

1. **Phase 1**：`src/lib/db-retry.ts` + `src/lib/prisma.ts` 連線韌性（基礎設施層，可獨立測試）。
2. **Phase 2**：`updateDocumentStatus` + `persistProcessingResult` 套 retry + 失敗即停。
3. **Phase 3**：`extraction-v3.service.ts` ref-match 例外處理對齊。
4. **驗證**：`npm run type-check` / `npm run lint` / 既有測試 + 場景 1-4。
5. **部署**：手動 `az acr build` + 容器更新（見上）。

---

## 關聯

- 相關既有機制：CHANGE-032（ref-match）、CHANGE-047（`_ref_*` 注入 template row）、FIX-036（ref-match 啟用即阻塞）。
- 相關 CHANGE-068（Resilience / Circuit Breaker / Retry / IR 規劃）——本 CHANGE 為其中「DB 連線韌性」的具體落地。
- 受影響文件清單（9 份，另附）：待營運重新觸發處理。

---

---

## 實作記錄（2026-07-08）

| 檔案 | 類型 | 實作內容 |
|------|------|----------|
| `src/lib/db-retry.ts` | 🆕 | `isTransientDbError()` + `withDbRetry()`（3 次、200/500/1000ms 退避、僅 transient 重試） |
| `src/lib/prisma.ts` | 🔧 | pg Pool 加 `keepAlive` / `keepAliveInitialDelayMillis` / `connectionTimeoutMillis` / `idleTimeoutMillis` / `max` + `pool.on('error')` |
| `src/services/processing-result-persistence.service.ts` | 🔧 | `persistProcessingResult` 的 `$transaction`（全冪等操作）包 `withDbRetry` |
| `src/services/unified-processor/unified-document-processor.service.ts` | 🔧 | `updateDocumentStatus` 加 retry + `critical` 參數（關鍵轉換失敗上拋）；初始 `OCR_PROCESSING` 設 critical；`processWithV3` catch 對 transient DB 錯誤 fail-stop（不回退 V2、不白燒 GPT） |
| `src/services/extraction-v3/extraction-v3.service.ts` | 🔧 | ref-match catch 對 transient DB 錯誤改為上拋（不再靜默續跑） |
| `tests/unit/lib/db-retry.test.ts` | 🆕 | 9 個單元測試（isTransientDbError 5 + withDbRetry 4） |

**驗證**：`npm run type-check` 通過；lint 0 errors（僅既有 warning）；`vitest` 9/9 通過。

**待辦**：
1. 手動 `az acr build`（`acrscmdocprocessingdev`）+ 容器更新 `WebApp-RAPOSCM-AIDocProcessing-DEV` 後才在 Azure 生效。
2. 重新處理 2026-07-08 01:42 UTC 受影響的 9 份文件。

---

*建立日期: 2026-07-08*
*根因查證: Azure Log Analytics `log-raposcm-aidocprocessing-dev` + PG 指標（唯讀）*
