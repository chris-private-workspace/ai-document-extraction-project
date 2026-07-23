# FIX-132: pg 連線池耗盡導致交易 P2028 —— template instance 加入 20 份文件無匹配

> **建立日期**: 2026-07-23
> **發現方式**: 用戶回報（Azure DEV 環境）+ Azure 容器 log 證實
> **影響頁面/功能**: Template Instance 批量加入文件（`/api/v1/documents/match`）、文件列表（`GET /api/documents`）—— 凡在 extraction pipeline 併發負載下需要資料庫連線的操作
> **優先級**: 高
> **狀態**: ✅ 已完成（2026-07-23 Azure DEV 部署上線，映像 `dev-fix131-132-20260723111721`，PR #140 已合併；功能驗收待使用者重跑 CEVA 20 份場景，見部署記錄）

---

## 問題描述

在 Azure DEV 對 Template Instance `[CEVA - import to inbound 5.0]` 一次加入 **20 份**文件時，**完全沒有匹配任何欄位內容**；但一次只加 **5 或 10 份**時欄位資料正常匹配。

這不是 template matching 邏輯本身的錯，而是**資料庫連線池在併發負載下耗盡**造成的交易無法啟動，且失敗被上層靜默吞掉，呈現為「沒匹配」。

---

## 重現步驟

1. Azure DEV（或任何私有端點 PostgreSQL + 有併發 extraction 負載的環境）
2. 進入 Template Instance 詳情頁 → 加入文件對話框
3. 一次勾選 20 份文件送出（`POST /api/v1/documents/match`）
4. 觀察現象：全部失敗、無任何 row 建立、無欄位資料；5～10 份則正常

---

## 根本原因（Azure log 已證實）

### 錯誤簽名

Azure 容器 log（Log Analytics `AppServiceConsoleLogs`）反覆出現：

```
prisma:error
Invalid `prisma.document.findMany()` invocation:
Transaction API error: Unable to start a transaction in the given time.
  code: 'P2028',
  clientVersion: '7.2.0'
```

三次事件（2026-07-22 07:11、07:14；2026-07-23 01:19 UTC）**全部發生在 extraction pipeline 執行中**（周邊 log 為 `[CHANGE-024 DEBUG] shouldUseV3`、`[Stage1/2/3]`、`[Retry] Processing completed`），被打掛的查詢是 `prisma.document.findMany()` / `count()`（文件列表 API）。

### 機制

| 項目 | 值 |
|------|-----|
| PG 規格 | `Standard_B1ms`（Burstable, 2 GiB） |
| PG `max_connections` | 50 |
| app pg pool `max`（`src/lib/prisma.ts:55`） | **10** |
| Prisma 交易 `maxWait` | 預設 **2000ms** |

P2028「Unable to **start** a transaction in the given time」= 交易/查詢在 `maxWait`（2 秒）內**拿不到連線**。app 把自己限制在 10 條連線（PG 其實可給 ~47），extraction pipeline 併發處理文件時 10 條被佔滿 → 其他查詢/交易 2 秒內取不到連線 → P2028。

### 與「20 份沒匹配」的關聯

同一個池耗盡機制。Template matching 的完整路徑：

```
AddFileDialog（未傳 batchSize）
  → POST /api/v1/documents/match
  → autoTemplateMatchingService.batchMatch（batchSize 預設 50 → 20 份 = 單一批次）
  → templateMatchingEngineService.matchDocuments（engine batchSize 預設 100 → 單一 processBatch）
  → 單一 prisma.$transaction（template-matching-engine.service.ts:377）
```

`processBatch` 把整批文件包在**一個互動式交易**裡，每份文件還跑 3 個循序查詢（`findUnique` + `findFirst(maxRowIndex)` + `create`/`update`）≈ 20 份 = 60 次循序往返，交易佔住 1 條連線很久。池滿時該交易也**無法啟動**（同 P2028）。

而 `batchMatch`（`auto-template-matching.service.ts:542`）的 catch **靜默吞掉單批錯誤**（`errorCount += 20`、續跑、回 `success:true`、**不寫 server log**）→ UI 顯示「全部失敗」toast，資料庫一筆 row 都沒建。20 份比 10 份佔用連線更久、更容易撞上池滿，所以呈現「20 不行、10 可以」。

> ⚠️ template matching 自身的失敗因錯誤被吞掉，**未直接出現在 log**；log 直接證實的是同一個 P2028 池耗盡機制在此環境真實、反覆發生。

---

## 解決方案（根因＋針對性硬化）

### 1. 連線池紓解（根因）— `src/lib/prisma.ts`

- pg pool `max` 10 → **20**（安全低於 PG 的 50，且留給 admin/migration/多實例足夠餘裕；本地 PG 預設 `max_connections`=100 亦無虞）。
- 為 PrismaClient 加 `transactionOptions: { maxWait: 10_000, timeout: 20_000 }`，容忍私有端點連線取得延遲與較長的批次交易 body。

### 2. 縮小 template matching 交易佔用 — `src/services/template-matching-engine.service.ts`

- `processBatch` 去掉每份文件的 `findFirst(maxRowIndex)`：改在交易迴圈前查一次最大 `rowIndex`，之後以記憶體計數器遞增。60 → ~40 次循序查詢，縮短交易佔住連線的時間，降低對連線池的壓力。
- `upsertRow` 改為接收 `rowIndex`（新列用）並回傳 `{ row, created }`，讓 `processBatch` 依是否新建遞增計數器。

### 3. 批次失敗不再靜默 — `src/services/auto-template-matching.service.ts`

- `batchMatch` 的 catch 在 `errors.push(...)` 之外加 `console.error`，讓未來同類失敗在 Azure 容器 log 可見（本次調查最大的盲點就是這個吞錯誤）。

> 無 schema 變更、無新 API、無新 npm 依賴、無 vendor 變更、無新 env、無 i18n 變更。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `src/lib/prisma.ts` | pool `max` 10→20；PrismaClient 加 `transactionOptions.maxWait/timeout` |
| `src/services/template-matching-engine.service.ts` | `processBatch` 迴圈前查一次 maxRowIndex + 記憶體遞增；`upsertRow` 改收 `rowIndex`、回傳 `{ row, created }` |
| `src/services/auto-template-matching.service.ts` | `batchMatch` 批次失敗加 `console.error` server 端記錄 |

---

## 測試驗證

- [x] `npm run type-check` 通過（2026-07-23）
- [x] `npm run lint` 僅既有 warning（新增 1 個刻意的 `console.error`，與呼叫端 match route 風格一致）
- [ ] 本地：對 template instance 加入 20+ 份文件，欄位資料正常匹配（本地 localhost 池充足，主要驗證重構無回歸）
- [ ] `rowIndex` 遞增正確（新列連續、合併列不新增 index）
- [ ] Azure 部署後：extraction 併發時文件列表不再 P2028；template instance 加入 20 份正常匹配
- [ ] 若 Azure 仍出現 P2028 → 容器 log 現在應能看到 `batchMatch` 的 `console.error`（可見性驗證）

---

## Implementation Notes

### 調查過程（root cause 三步收斂）
1. 初判：`processBatch` 單一交易 60 查詢 → 疑似交易 body 超過預設 5 秒 timeout。
2. Azure log 證實：錯誤是 **P2028「Unable to start a transaction」**（= `maxWait` 取不到連線），**非** body timeout（那會是 "Transaction already closed"）。
3. 定位：失敗查詢是 `document.findMany/count`、且全在 extraction pipeline 併發時發生 → 根因是**連線池 `max:10` 太小 + `maxWait:2s` 太短**的池耗盡，非 template matching 專屬。

### 教訓
- 靜默吞錯誤（`batchMatch`）讓真正的失敗簽名無法從 log 觀察，害調查繞路 → 服務層批次操作的 catch 至少要 server-log。
- 本地 localhost 池充足、延遲低，這類池耗盡不易重現 → 私有端點環境要特別注意連線池 sizing。

---

*文件建立日期: 2026-07-23*
*最後更新: 2026-07-23*
