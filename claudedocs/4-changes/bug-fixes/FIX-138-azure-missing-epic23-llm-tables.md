# FIX-138: Azure DEV 缺 Epic 23 三張表，下次部署將使提取管線全面 P2021

> **建立日期**: 2026-07-28
> **發現方式**: 代碼審查（2026-07-28 session 檢討，補 runbook §14 時追出）
> **影響頁面/功能**: 文件提取主線（Stage 1–3）＋ `admin/llm-providers`、`admin/model-settings`
> **優先級**: 高
> **狀態**: 🚧 待修復

---

## 問題描述

Epic 23 新增的三張表 —— `llm_providers` / `llm_models` / `stage_model_assignments` —— 在 **Azure DEV 資料庫中不存在**，而且既有的兩條建表路徑**都不會建立它們**。

Epic 23 的程式碼（PR #155、#161）已在 `main`。**下次部署必定帶上**，屆時若未設 `RUN_SCHEMA_DRIFT_FIX=true`，提取管線會在 Stage 1 就拋 P2021，整批文件變成 `OCR_FAILED`。

### 目前尚未觸發（有時間差，但只有一次機會）

| 項目 | 值 |
|------|----|
| 線上映像 | `dev-change110-20260727164500`（UTC 2026-07-27 08:45 建置）|
| Epic 23（PR #155）合併時間 | UTC 2026-07-27 **09:19** |

映像比 Epic 23 早 34 分鐘，**所以線上目前不含相關程式碼、沒有壞**。這是時間差帶來的僥倖，不是設計上的保護。

### 嚴重度為何是「高」而非「兩個管理頁面壞掉」

一開始容易誤判成「只影響 Epic 23 的後台頁面」，因為 `FEATURE_LLM_GATEWAY_ENABLED` 預設 OFF。**但 extraction stage 1–3 不經過那道開關**：

- `src/lib/constants/llm-stages.ts:62-63` 明載：stage1-3 的指派「經 `getStageModel` 的 modelKey key-bridge 生效，**與 `FEATURE_LLM_GATEWAY_ENABLED` 無關**（CHANGE-099 起即如此）」
- `gpt-caller.service.ts` 每次決定模型都呼叫 `getStageModel()`
- `llm-model-config.service.ts:286-317` 的 `getStageModel()` **第一行就是** `prisma.stageModelAssignment.findUnique(...)`，且**沒有 try/catch**

所以每一份文件的每一個 stage 都會撞上這張不存在的表。

---

## 重現步驟

1. 部署任何含 Epic 23 程式碼（`main` 於 2026-07-27 09:19 UTC 之後）的映像到 Azure DEV
2. **不設** `RUN_SCHEMA_DRIFT_FIX=true`
3. 上傳任一文件觸發提取
4. 觀察現象：Stage 1 即失敗，文件狀態 `OCR_FAILED`；容器 log 出現 P2021（table does not exist）

---

## 根本原因

### 為何兩條建表路徑都漏掉

| 路徑 | 行為 |
|------|------|
| `prisma/bootstrap-db.js:57-59` | 對**非空 DB 直接 skip** —— Azure DEV 早有資料，永遠不會走到 |
| 空庫才套的 `init.sql` | 檔案裡**根本沒有**這三張表 |

Prisma migration 也不會自動套到 Azure（entrypoint 不跑 `migrate deploy`），這是既有的已知機制，見 `docs/07-deployment/02-azure-deployment/dev-deployment-runbook.md` §14。

### 為何 fallback 鏈救不了

`getStageModel()` 有三層 fallback（`StageModelAssignment` → 舊 `SystemConfig` key → `DEFAULT_STAGE_MODELS`），看起來很安全。**但那條鏈只處理「查得到表、但沒有資料」**：

```ts
const assignment = await prisma.stageModelAssignment.findUnique({ ... })  // ← 表不存在在這裡就拋了
const m = assignment?.llmModel
if (m?.isEnabled && ...) return m.modelKey
// 以下 fallback 永遠到不了
```

表不存在是**拋例外**，不是回 `null`。同一問題也存在於 `resolveModelIdForStage()`（:253）與 `getRoutingThresholds()`（:335）。

### 與 2026-07-14 事件同型

那次是 CHANGE-100/102 的新 env 沒設到 Azure，`process.env[X] || default` 靜默 fallback 到錯誤的部署名 → 404 → 整批 `OCR_FAILED`。**同樣是「新程式碼帶來的新外部相依，部署時沒同步」**。差別在那次是靜默降級，這次是直接拋錯。

---

## 解決方案

**無程式碼變更** —— DDL 已於 2026-07-27 備妥在 `prisma/apply-schema-drift.js`，Epic 23 佔其中 10 條（enum `LlmProviderType` + 三張表 + `llm_models.routing_thresholds` 欄位 + 3 組索引 + 2 個外鍵），且已在臨時空庫實跑驗證過（10/10 OK、重跑冪等）。

本 FIX 是**部署動作與其驗收**：

1. 部署帶 Epic 23 的映像時，同時設 `RUN_SCHEMA_DRIFT_FIX=true`
2. 容器啟動後檢查 log
3. 驗證通過後把旗標設回 `false`

### 期待的 log

`MIGRATIONS` 陣列**每次執行全跑**（DDL 全冪等），所以期待值是**陣列總條目數 21**，不是「新增的 10 條」：

```
[schema-drift] OK <每條 id>          ← 21 筆
[schema-drift] done — 21 applied, 0 failed
```

**總數對但 `failed > 0` 一樣是問題** —— 單筆失敗不中斷其餘，必須逐筆看 `ERR`。詳見 runbook §14（2026-07-28 已補上這段，PR #162）。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| — | **無程式碼變更**。`prisma/apply-schema-drift.js` 的 Epic 23 條目已於 2026-07-27 加入 |
| `docs/07-deployment/02-azure-deployment/dev-deployment-runbook.md` | 已於 PR #162 補上期待值與本問題的紅旗說明 |

---

## 測試驗證

部署後需驗證：

- [ ] 容器 log 出現 21 筆 `[schema-drift] OK ...` + `done — 21 applied, 0 failed`，且無任何 `ERR`
- [ ] 上傳一份文件，提取跑完不出現 P2021（Stage 1–3 全過）
- [ ] `admin/llm-providers` 頁面可開啟，列出至少 1 個 provider
- [ ] `admin/model-settings` 頁面可開啟，9 個環節皆渲染
- [ ] 確認 `RUN_SCHEMA_DRIFT_FIX` 已設回 `false`
- [ ] 唯讀查 Azure 的 `roles` 表，確認 `Auditor` 角色存在且權限含 `audit:view` / `audit:export`（順帶驗 FIX-134 BUG-3 的前提，本地因 dev bypass 驗不到）

---

## 相關

- `docs/04-implementation/tech-specs/epic-23-multi-llm-provider/AI-HANDOFF.md` §6 —— Epic 23 部署紅旗
- `docs/07-deployment/02-azure-deployment/dev-deployment-runbook.md` §14 —— schema drift 機制與期待值
- FIX-134 —— Auditor 角色驗證同樣待 Azure 環境

---

*文件建立日期: 2026-07-28*
*最後更新: 2026-07-28*
