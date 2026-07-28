# FIX-137: LLM 呼叫點的 fallback 部署名指向已移除的模型（env 未設即 404）

> **建立日期**: 2026-07-27
> **發現方式**: Story 23.4 Phase 1 遷移前盤點 8 個呼叫點時，比對 `llm-models.ts` 白名單發現
> **影響頁面/功能**: 術語分類（Tier 3）、AI 術語驗證、GPT Vision OCR/分類、V2 輕量提取、V3 單次提取、V3.1 健康檢查
> **優先級**: 高（env 未設即全數 404；與 2026-07-14 那次 `OCR_FAILED` 同源）
> **狀態**: ✅ 已完成（2026-07-27）—— 6 個服務檔改走白名單解析 + `isReasoningModel` 補 5.4 系列 + 8 個回歸測試；`type-check` / `lint` / `test`（264 passed）全過

---

## 問題描述

CHANGE-102 把 LLM 模型白名單收斂為 **只剩 `gpt-5.4-mini` 與 `gpt-5.4-nano`**（舊的 `gpt-5.2` / `gpt-5-nano` 對應的 Azure deployment 已不存在）。但白名單之外、直接呼叫 Azure 的 5 個服務仍各自硬編了舊模型名當 fallback：

| # | 檔案 | 位置 | env 變數 | fallback 值 | 白名單狀態 |
|---|---|---|---|---|---|
| 1 | `term-classification.service.ts` | :94, :276 | `AZURE_OPENAI_DEPLOYMENT_NAME` | `gpt-5.2` | ❌ 已移除 |
| 2 | `gpt-vision.service.ts` | :343, :749, :1099 | `AZURE_OPENAI_DEPLOYMENT_NAME` | `gpt-5.2` | ❌ 已移除 |
| 3 | `ai-term-validator.service.ts` | :60 | **`AZURE_OPENAI_DEPLOYMENT`**（少了 `_NAME`） | `gpt-5.2` | ❌ 已移除 |
| 4 | `extraction-v2/gpt-mini-extractor.service.ts` | :119-121, :516-519 | `AZURE_OPENAI_MINI_DEPLOYMENT_NAME` → `AZURE_OPENAI_NANO_DEPLOYMENT_NAME` | `gpt-5-nano` | ❌ 已移除 |
| 5 | `extraction-v3/unified-gpt-extraction.service.ts` | :153 | `AZURE_OPENAI_DEPLOYMENT_NAME` | `gpt-5-2-vision` | ❌ 已移除 |
| 6 | `extraction-v3/stages/gpt-caller.service.ts` | :172-175 | `AZURE_OPENAI_NANO_DEPLOYMENT_NAME` / `AZURE_OPENAI_DEPLOYMENT_NAME` | `gpt-5-nano` / `gpt-5-2-vision` | ❌ 已移除 |

**只要對應的 env 沒設，這些位置就會打到不存在的 Azure deployment → `404 DeploymentNotFound`。**

> 📌 **第 6 項是實作中才發現的**（原盤點只涵蓋「待遷移的 5 處」）。它的影響與其他 5 項**不同**：
> `nanoDeploymentName` / `fullDeploymentName` **不在提取路徑上**——Stage 1-3 實際呼叫走
> `resolveDeploymentName(modelOption)`（白名單），這兩個欄位只餵給 `checkHealth` 的部署可用性
> 探測（`:617-619`）。所以它造成的是**健康檢查誤報「部署不可用」**，不是提取失敗。仍須修，
> 否則維運看到的健康狀態是假的。

| # | 問題 | 嚴重度 | 影響 |
|---|------|--------|------|
| BUG-1 | 5 處 fallback 指向已移除的 deployment | 高 | env 未設即全數 404 |
| BUG-2 | env 變數名不一致（第 3 項少了 `_NAME`） | 中 | 就算維運補設 `AZURE_OPENAI_DEPLOYMENT_NAME`，`ai-term-validator` 仍讀不到 |
| BUG-3 | `isReasoningModel` 的 pattern 不認得 5.4 系列 | 中 | 見〈連帶問題〉——修 BUG-1 若不一併修它，會從「404」變成「送錯參數格式」 |

### 這與 2026-07-14 的事件同源

當時 CHANGE-100/102 新增的 `AZURE_OPENAI_GPT54_{MINI,NANO}_DEPLOYMENT_NAME` 在 Azure 沒設 → `process.env[X] || default` 靜默 fallback 到無後綴的 `gpt-5.4-mini` → 404 → 整批 `OCR_FAILED`。

本次是**同一個 pattern 的另一組變數**：那次修的是白名單內的模型，這 5 處在白名單**之外**，因此沒被那次修復涵蓋。

> ⚠️ **本地無法查證線上是否正在燃燒**：Azure App Service 是否設了 `AZURE_OPENAI_DEPLOYMENT_NAME` / `AZURE_OPENAI_DEPLOYMENT` 需要另行確認。若已設且指向有效 deployment，則目前未爆；但 fallback 本身仍是地雷。

---

## 連帶問題：reasoning 模型偵測

`gpt-mini-extractor.service.ts:138-147` 的 `isReasoningModel()` 以 pattern 比對部署名：

```ts
/gpt-5-nano/i, // gpt-5-nano（可能是 o-series）
/gpt-5-mini/i, // gpt-5-mini（可能是 o-series）
```

這兩個 pattern **對 `gpt-5.4-nano` / `gpt-5.4-mini` 都不匹配**（`5-nano` ≠ `5.4-nano`）。

而 5.4 系列**確實是 reasoning 模型**——2026-07-27 影子比對實跑時 AI SDK 明確警告：

```
AI SDK Warning (azure.chat / gpt-5.4-mini-aidocprocessing):
The feature "temperature" is not supported. temperature is not supported for reasoning models
```

reasoning 模型的 API 要求不同（不吃 `temperature`、須用 `max_completion_tokens`、system 被當 developer message）。若只把 fallback 改成 5.4 而不修 pattern，行為會從「打不存在的部署（404）」變成「打對部署但送錯參數格式」——**後者更難診斷**。

---

## 修復方案

### 1. fallback 統一走白名單（不是換一個硬編值）

新增 `resolveDeploymentNameByKey(key)`（`llm-models.ts`）封裝 `getLlmModelOption` + `resolveDeploymentName` 兩步，避免 6 個檔案各自重複「查白名單 → 處理 undefined → 解析 env」的樣板。白名單外的 key 原樣回傳，因此呼叫端顯式指定的部署名不受干擾。

各服務改用它取得預設部署名（env 覆蓋 → 白名單預設，變數名由白名單集中定義）：

| # | 服務 | 採用的 modelKey | 理由 |
|---|---|---|---|
| 1 | term-classification | `gpt-5.4-mini` | 原為高精度 `gpt-5.2`，對應 CHANGE-102 的正名映射 |
| 2 | gpt-vision | `gpt-5.4-mini` | 同上；需 vision + json schema 能力 |
| 3 | ai-term-validator | `gpt-5.4-mini` | 同上 |
| 4 | gpt-mini-extractor | `gpt-5.4-nano` | 原為輕量 `gpt-5-nano` |
| 5 | unified-gpt-extraction | `gpt-5.4-mini` | 原為 `gpt-5-2-vision`，需 vision |
| 6 | gpt-caller（健康檢查） | `gpt-5.4-nano` / `gpt-5.4-mini` | 對應該檔既有的 nano / full 兩個探測目標 |

此映射與 `DEFAULT_STAGE_MODELS`（`llm-models.ts:87-92`，stage1/3 → mini、stage2 → nano）的正名邏輯一致。

### 2. env 變數名統一

各服務不再自行讀散落的 `AZURE_OPENAI_DEPLOYMENT*`，一律經白名單的 `deploymentEnvVar`（`AZURE_OPENAI_GPT54_{MINI,NANO}_DEPLOYMENT_NAME`）。

> 📌 **保留各服務既有的 config 覆蓋能力**：呼叫端顯式傳入的 `config.deploymentName` 仍優先，僅**預設值**改走白名單。這確保既有測試與特殊呼叫不受影響。

### 3. `isReasoningModel` 補 5.4 系列

pattern 改為同時涵蓋 `gpt-5-nano` 與 `gpt-5.4-nano`（mini 同理），且維持非錨定比對以容納 Azure 的部署名後綴（如 `gpt-5.4-mini-aidocprocessing`）。

---

## 驗收條件

- [x] 6 處 fallback 皆不再出現已移除的模型名（`gpt-5.2` / `gpt-5-nano` / `gpt-5-2-vision`）——全 repo `src/` grep 確認僅剩註解與定價表
- [x] 6 處皆經 `resolveDeploymentNameByKey(...)` 取得預設部署名
- [x] `ai-term-validator` 不再讀 `AZURE_OPENAI_DEPLOYMENT`（無 `_NAME` 的孤兒變數）
- [x] `isReasoningModel('gpt-5.4-nano')` / `('gpt-5.4-mini-aidocprocessing')` 皆回 `true`，且 `('gpt-5-nano')`、o-series 維持 `true`、`gpt-4o` 維持 `false`
- [x] 呼叫端顯式傳入的 `deploymentName` 仍優先於預設（白名單外的值原樣回傳）
- [x] `npm run type-check` / `lint`（0 error）/ `test`（**264 passed**，本 FIX 新增 8 個）全過

### 新增測試

`tests/unit/services/llm-deployment-fallback.test.ts`（8 個）：

| 測試 | 驗證 |
|---|---|
| 無 env 覆蓋 → 回白名單預設部署名 | fallback 正確 |
| 有 env 覆蓋 → 優先採用 | 涵蓋 Azure 帶後綴的部署名（2026-07-14 那次 404 的成因） |
| 白名單外的 key → 原樣回傳 | 不干擾顯式指定 |
| 解析結果不再是任何已移除的部署名 | 本 FIX 的核心斷言 |
| 5.4 系列 / 帶後綴 / 舊名 / o-series / `gpt-4o` | reasoning 偵測不誤判也不漏判 |

> 📌 為使 `isReasoningModel` 可測，將其由 module-private 改為 `export`。純函數、無副作用，不改變任何呼叫行為。

---

## 不在本次範圍

| 項目 | 理由 |
|------|------|
| 把這 5 處遷移到 `LlmGatewayService` | 那是 Story 23.4 Phase 1 的工作；本 FIX 只修**舊路徑**的 fallback，兩者獨立（遷移 behind flag，flag 關著時仍走舊路徑，故本 FIX 有獨立價值） |
| 為這些環節新增 `StageModelAssignment` | Story 23.4 子項 2「per-環節指派 UI」 |
| 查證 Azure 線上 env 實際設定 | 需要 az CLI 權限；本 FIX 讓「沒設」也不再是 404，與線上現況無關 |
| 修 DB 內 `gpt-5.4-mini` 的 `capability.supportsTemperature`（實測為 reasoning 模型、不支援） | 屬 gateway 的資料面，另議 |
| **2 個測試 API 的同源 fallback**（`app/api/v1/prompt-configs/test/route.ts:450`、`app/api/test/extraction-compare/route.ts:218,409`，皆為 `\|\| 'gpt-5.2'`） | 同樣壞掉，但它們是 Story 23.4 明確標「低優先」的測試/比較端點，且部分已受 FIX-066 的測試端點停用機制約束。留給該子項一併處理，避免本 FIX 擴散到 API 層 |
| `ai-cost.service.ts` 的 `DEFAULT_PRICING` 缺 5.4 系列條目 | 有 `'default'` 兜底、不會炸，但成本會以舊費率估算。屬計價資料面，與部署名解析無關 |

---

## 相關

- **CHANGE-102** — 移除舊 LLM 模型、白名單收斂至 5.4 系列（本問題的成因）
- **Story 23.4 Phase 1** — 8 個呼叫點遷移（本 FIX 為其前置盤點的副產物）
- 2026-07-14 的 `OCR_FAILED` 事件 — 同一個 `process.env[X] || default` pattern 的前一次爆發
