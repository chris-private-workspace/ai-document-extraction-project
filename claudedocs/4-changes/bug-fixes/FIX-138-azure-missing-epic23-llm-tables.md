# FIX-138: Azure DEV 缺 Epic 23 三張表，下次部署將使提取管線全面 P2021

> **建立日期**: 2026-07-28
> **發現方式**: 代碼審查（2026-07-28 session 檢討，補 runbook §14 時追出）
> **影響頁面/功能**: 文件提取主線（Stage 1–3）＋ `admin/llm-providers`、`admin/model-settings`
> **優先級**: 高
> **狀態**: ✅ 已修復（2026-07-28 部署 `dev-fix138-20260728115434`，21/21 套用成功）

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

## 部署結果（2026-07-28）

| 項目 | 值 |
|------|----|
| 映像 | `dev-fix138-20260728115434`（ACR run `ck1f`，Succeeded）|
| 切換 + 重啟 | 12:06:29（UTC 04:06:29）|
| 容器就緒 | UTC 04:07:54，**85 秒** |
| 帶上線的變更 | **8 個 PR** —— Epic 23 兩批（#155 / #161）、FIX-134（#159）、`.gitattributes`（#160）、CI 兩閘（#158）+ 3 份文檔/工具 |

### 部署前檢查（runbook §A.0）

| 檢查項 | 結果 |
|--------|------|
| `.env.example` 差異（權威清單）| **零變更** —— 無新的必要 env |
| Epic 23 feature flags | 全部 `=== 'true'` 模式，不設 = 關閉 = 行為零變（`feature-flags.ts:422`、`:512`）|
| entrypoint 有無 Epic 23 播種 | **沒有** —— 三張表建好即為空表，由 `getStageModel` 的 fallback 鏈接手 |
| `docker-entrypoint.sh` 行尾 | CR=0、無 BOM（避免 §12 的 exit 127）|

### 驗收結果

| # | 驗收項 | 結果 |
|---|--------|------|
| 1 | 21 筆 `[schema-drift] OK` + `done — 21 applied, 0 failed`，無 `ERR` | ✅ **完全符合**，Epic 23 的 10 條全數套用 |
| 2 | 提取管線不出現 P2021 | ✅ 日誌掃描 20 分鐘區間，無 P2021/P2022/P2028/PrismaClient 錯誤 |
| 3 | `admin/llm-providers` 可開啟 | ✅ 正常渲染，顯示 “No providers configured yet.” |
| 4 | `admin/model-settings` 可開啟，9 環節渲染 | ✅ 全部渲染，「Not in effect yet」警示正確只出現在 6 個經 gateway 的環節 |
| 5 | `RUN_SCHEMA_DRIFT_FIX` 設回 `false` | ✅ 已設回；7 個 `RUN_*` 與 `FORCE_SCHEMA_RESET` 全為 `false` |
| 6 | Azure `roles` 的 `Auditor` 權限 | ⚠️ 角色存在，但**權限格式與程式碼常量不符** → 另立 **FIX-139** |
| — | `/api/health` | ✅ 200 `{"status":"healthy","services":{"database":"connected"}}` |

### 🔴 修正本文件原先的錯誤預期

驗收項 3 原寫「**列出至少 1 個 provider**」——**這個預期是錯的**。entrypoint 沒有 Epic 23 的播種步驟，Azure 上 `llm_providers` / `llm_models` 建好後就是空的，**空表才是正確狀態**。撰寫本文件時誤把本地（dev seed 有播種）當成 Azure 的預期。

空表不影響提取：`getStageModel` 查無指派 → 回退舊 `SystemConfig` → 再回退 `DEFAULT_STAGE_MODELS`，這正是該 fallback 鏈的設計目的。副作用是 Epic 23 的後台 UI 在 Azure 上「可看不可用」——模型下拉全為 “Select a model”，要有人先建 provider + models 才有內容。而建 provider 需要 `CONFIG_ENCRYPTION_KEY`（Azure 仍未設，見 runbook:217），屬既有缺口。

### 一個對後續部署有用的記錄

`az acr build` 在本機以 **exit 1** 結束，但那是 az CLI 的顯示層崩潰，不是建置失敗：

```
UnicodeEncodeError: 'charmap' codec can't encode character '✔'
  ... colorama/ansitowin32.py -> encodings\cp1252.py
```

`✔` 是 `prisma generate` 輸出的 `✔`。控制面同時顯示 `ck1f` = `Running` → 之後 `Succeeded`。**判斷建置成敗一律看 `az acr task show-run`，不看本機串流**（runbook §A.1 已載明；CHANGE-110 部署時曾因誤判此訊號多繞十分鐘）。

---

## 相關

- `docs/04-implementation/tech-specs/epic-23-multi-llm-provider/AI-HANDOFF.md` §6 —— Epic 23 部署紅旗
- `docs/07-deployment/02-azure-deployment/dev-deployment-runbook.md` §14 —— schema drift 機制與期待值
- FIX-134 —— Auditor 角色驗證同樣待 Azure 環境

---

*文件建立日期: 2026-07-28*
*最後更新: 2026-07-28*
