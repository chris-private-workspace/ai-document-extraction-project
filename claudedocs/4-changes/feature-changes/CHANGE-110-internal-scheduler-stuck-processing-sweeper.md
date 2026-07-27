# CHANGE-110: 應用程式內排程器 — 自動執行殭屍處理回收（FIX-094 排程缺口）

> **日期**: 2026-07-27
> **狀態**: ✅ 已完成（2026-07-27 本地四閘全過 —— `npm run build` / `type-check` / `lint` 0 warning / 9 項單元測試；初版曾因 instrumentation 的 edge bundle 解析而 build 失敗，見「實作路上的一個錯誤判斷」；**Azure 部署 + 設定 `ENABLE_INTERNAL_SCHEDULER=true` 後才實際生效**）
> **優先級**: High
> **類型**: Feature（新增基礎機制）
> **影響範圍**: `src/instrumentation.ts`（新增）、`.env.example`、Azure app settings

---

## 變更背景

[FIX-094](../bug-fixes/FIX-094-zombie-processing-stuck-unrecoverable.md) 實作了殭屍處理回收（sweeper），並於 2026-07-27 在 Azure DEV 實測成功（`sweptCount=13`，13 筆卡了 10.8–24.8 天的文件全部回收，無誤標）。

但該 FIX 只做了「**能被觸發**」，沒做「**誰來觸發**」：

| 觸發途徑 | 現況 |
|---|---|
| 排程 | **無任何排程器**。Log Analytics 近 30 天 `/api/jobs` 被呼叫 0 次 |
| 管理員手動 | 403（見 FIX-134，未修） |
| `x-cron-secret` | 已於 2026-07-27 補設 `CRON_SECRET` 打通，但仍需**外部**有人呼叫 |

FIX-094 的 `@note` 寫「可配合 n8n / Vercel Cron」—— 那是**規劃建議、非現況**。本專案自始至終沒有任何排程機制，所有背景 job 都只能手動 POST 觸發。

**後果**：sweeper 目前只在人工想起來時跑。未設排程之前，卡住的文件會持續累積 —— 這是目前 carry-over 清單中**唯一會隨時間惡化**的項目。

## 變更內容

在 Next.js server 啟動時註冊一個應用程式內的週期性排程，直接呼叫 `triggerStuckProcessingSweep()`，不經 HTTP、不需 `CRON_SECRET`。

| 項目 | 值 |
|---|---|
| 載體 | `src/instrumentation.ts`（Next.js 官方啟動 hook） |
| 間隔 | **5 分鐘**（FIX-094 原設計；閾值 10 分鐘由 `STUCK_PROCESSING_THRESHOLD_MINUTES` 控制） |
| 首次執行 | 啟動後 **60 秒**（讓 server 暖機完成再跑） |
| 開關 | `ENABLE_INTERNAL_SCHEDULER`，**預設關閉** |
| 新增依賴 | **0**（純 `setTimeout` / `setInterval`） |
| 新增 Azure 資源 | **0** |

### 為何此環境適合進程內排程

部署前查證 Azure DEV 的實際設定，兩個值決定了可行性：

| 設定 | 實測值 | 意義 |
|---|---|---|
| `alwaysOn` | **`true`** | 容器不會因閒置被卸載，timer 不會被中斷 |
| `numberOfWorkers` | **1** | 單一 worker，不會重複觸發 |

若任一條件不成立（閒置卸載／多 instance），進程內排程就不是好選擇。**這兩個值是本方案成立的前提，未來若調整需重新評估**（見下方「風險」）。

## 技術設計

### 修改範圍

| 文件 | 變更內容 |
|------|----------|
| `src/instrumentation.ts` | 🆕 新增。**極簡**：`register()` 僅在 `NEXT_RUNTIME === 'nodejs'` 且開關開啟的條件區塊內動態 import 排程模組。所有 node-only 依賴都不得出現在此檔的其他位置（原因見下方「實作路上的一個錯誤判斷」）|
| `src/jobs/internal-scheduler.ts` | 🆕 新增。`startInternalScheduler()` —— 實際的 timer、防重入與 log。靜態 import sweeper job |
| `.env.example` | 🔧 新增 `ENABLE_INTERNAL_SCHEDULER` 與 `STUCK_PROCESSING_THRESHOLD_MINUTES` 說明 |
| `tests/unit/jobs/internal-scheduler.test.ts` | 🆕 新增。9 項：`register()` 守衛 4 項 + 排程行為 5 項 |

### 關鍵實作決策

1. **三道守衛，預設不跑**
   - `process.env.NEXT_RUNTIME !== 'nodejs'` → 直接 return（避免 edge runtime 執行）
   - `ENABLE_INTERNAL_SCHEDULER !== 'true'` → 直接 return（本地開發、CI build 不受影響）
   - 兩者皆通過才動態載入 job 模組

2. **條件區塊內動態 `import()`，且邏輯拆到獨立模組**
   Next.js 為 instrumentation 同時編譯 **nodejs 與 edge 兩份 bundle**，而 edge runtime 沒有 `fs` / `path` / `stream` / `child_process`。排程要呼叫的 job 會牽出 `document.service` → `prisma`（`pg`）與 `extraction-v3`（`sharp`），全是 node-only。

   關鍵認知：**`await import()` 不會讓 webpack 略過打包** —— 它只延遲執行，模組仍會被靜態分析。唯一能讓 edge bundle 不去解析的方式，是把 import 放進以 `process.env.NEXT_RUNTIME`（build 時被替換為字面值）為條件的區塊，讓 webpack 的 dead-code elimination 整段消除。這也是 Next.js 官方 OpenTelemetry 範例的寫法。

   因此 `instrumentation.ts` 只保留條件判斷，實際邏輯放 `src/jobs/internal-scheduler.ts`。

3. **防重入旗標**
   sweep 實測僅 120ms，5 分鐘間隔重疊機率極低。但 DB 連線池才因耗盡出過事（FIX-132），加 3 行 `running` 旗標避免病態情況下堆疊。

4. **`unref()` timer**
   讓 timer 不阻止進程正常退出。Next.js server 有 TCP handle 保持存活，排程照常運作。

5. **`console` 而非 logger**
   查證後確認：`@/lib/logger` **只存在於技術規格文檔，程式碼中並不存在**（`src/lib/audit/logger.ts` 是寫 DB 的稽核日誌，非通用 logger）。`jobs/` 目錄全部使用 `console`，被呼叫的 `triggerStuckProcessingSweep()` 本身也是。沿用 `console` 可讓同一次執行的輸出風格一致，並與 FIX-094 §實作說明 的既定決策相符。

6. **間隔不做成可設定**
   FIX-094 已提供 `STUCK_PROCESSING_THRESHOLD_MINUTES` 控制「多久算卡住」，那才是有調整需求的參數。掃描間隔固定 5 分鐘即可，不加未被要求的 configurability。

### 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `ENABLE_INTERNAL_SCHEDULER` | 未設 = 關閉 | 設為 `"true"` 才啟用。**Azure DEV 需設；本地不設** |
| `STUCK_PROCESSING_THRESHOLD_MINUTES` | 10 | 既有變數（FIX-094），本次一併補進 `.env.example` |

### 資料庫影響

無。sweeper 沿用 FIX-094 既有的 `updateMany`（以 `status` 為條件防競態），本變更只負責「定時呼叫」。

## 設計決策

1. **選進程內排程而非 Azure Logic App** — 使用者 2026-07-27 決策。Logic App 方案為零程式碼變更、可立即生效，但需新增 Azure 資源、月費與 secret 複製；進程內排程零依賴、零資源、零成本，且不需要 `CRON_SECRET`。此環境的 `alwaysOn=true` + 單 worker 使其缺點不成立。

2. **觸發 H1（架構）已獲核可** — 本變更為專案引入「應用程式內常駐排程」這個先前不存在的架構模式。使用者於方案選擇時明示採用，等同 H1 approval，記錄於此。

3. **不改 FIX-094 的 API 路由** — `x-cron-secret` 途徑與手動觸發保留不動，作為排程失效時的後備。`CRON_SECRET` app setting 維持現狀。

## 實作路上的一個錯誤判斷

初版把守衛寫成**早期返回**，import 落在條件區塊之外：

```ts
// ❌ 初版：DCE 消不掉，edge bundle 仍會解析 pg / sharp
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.ENABLE_INTERNAL_SCHEDULER !== 'true') return;
  const { triggerStuckProcessingSweep } = await import('@/jobs/stuck-processing-sweeper-job');
  // ...
}
```

並在本文件寫下「動態 import 讓依賴只在真正啟用時載入」—— **這個理由是錯的**。`await import()` 只延遲執行，webpack 仍會靜態分析並打包。

後果是 `next build` 直接失敗：

```
./node_modules/detect-libc/lib/detect-libc.js  Can't resolve 'child_process'   ← sharp
./node_modules/pg-connection-string/index.js   Can't resolve 'fs'              ← pg
./node_modules/pgpass/lib/helper.js            Can't resolve 'path' / 'stream' ← pg
Import trace: ./src/instrumentation.ts → stuck-processing-sweeper-job → document.service → ...
```

修正方式見上方「關鍵實作決策」第 2 點：把 import 移進 `NEXT_RUNTIME === 'nodejs'` 的條件區塊內，邏輯拆到 `src/jobs/internal-scheduler.ts`。

### 更值得記的教訓：`npm run build` 是部署前必跑的閘

`type-check`、`lint`、單元測試**全部通過**，但 `next build` 失敗 —— 這類 bundle／runtime 解析問題只有 build 抓得到。

初次嘗試部署時我沒跑 build，直接送 `az acr build`，結果連續兩次失敗（run `ck1c`、`ck1d`），白花約 10 分鐘。診斷過程還一度誤判：`az acr task logs` 對成功與失敗的 run **都**只回 230 行、都停在 `Step 10/56`、都回 exit 1，我因此誤認失敗點在 COPY node_modules 而排除了自己的改動。拿上午成功的 `ck1b` 當對照組才發現 230 行是 log 抓取的邊界，不是失敗點。

本專案已有 FIX-069（re2-wasm）、FIX-083（pdfkit）兩次「只有 build／部署才爆」的先例，這是第三次。

## 影響範圍評估

### 向後兼容性

- 開關預設關閉 → 未設定 `ENABLE_INTERNAL_SCHEDULER` 的環境（本地、CI）行為完全不變
- 不改動任何既有 API、service、schema
- 回滾方式：把 Azure app setting 設回 `false` 並重啟，不需重部署映像

### 風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| 未來 scale out（多 instance） | 每個 instance 各跑一次 | sweeper 的 `updateMany` 冪等，重複執行無害（僅多餘查詢）。若 instance 數變多需重新評估 |
| 未來關閉 `alwaysOn` | 容器閒置被卸載，排程停止 | 本文件已記錄此前提；`alwaysOn` 為 B3 方案預設開啟 |
| 排程靜默失效 | 卡住文件再度累積而無人知 | 每次執行都有 `[InternalScheduler]` log；可用 Log Analytics KQL 查最近執行時間 |

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | 開關關閉時不註冊 | 未設 `ENABLE_INTERNAL_SCHEDULER` → 無 `[InternalScheduler]` log、無任何 sweep 執行 | High |
| 2 | 開關開啟時註冊 | Azure 容器啟動 log 出現 `[InternalScheduler] stuck-processing sweeper registered` | High |
| 3 | 首次執行 | 啟動約 60 秒後出現 `[StuckProcessingSweeper] Starting sweep...` | High |
| 4 | 週期執行 | 相隔約 5 分鐘出現第二次、第三次 sweep log | High |
| 5 | 實際回收能力 | 若有超過閾值的卡住文件 → `sweptCount > 0` 且該文件轉為 `OCR_FAILED` | High |
| 6 | 不誤標 | 正常處理中（未超閾值）的文件不被標記 | High |
| 7 | 本地不受影響 | 本地 `npm run dev` 無排程 log | Medium |

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | edge runtime 守衛 | `NEXT_RUNTIME='edge'` 呼叫 `register()` | 不載入 job、不註冊 timer |
| 2 | 開關未設 | 不設 `ENABLE_INTERNAL_SCHEDULER` 呼叫 `register()` | 不載入 job、不註冊 timer |
| 3 | 開關為其他值 | 設為 `"1"` / `"yes"` | 不啟用（嚴格比對 `"true"`） |
| 4 | 正常註冊 | 兩條件皆滿足 | 註冊成功，60 秒後首次執行，之後每 5 分鐘 |
| 5 | 防重入 | 前一次 sweep 未結束時觸發下一次 | 跳過本次並輸出警告，不併發執行 |
| 6 | 錯誤不中斷排程 | sweep 拋出例外 | 捕捉並記錄，下一個週期照常執行 |

---

*文件建立日期: 2026-07-27*
*最後更新: 2026-07-27*
