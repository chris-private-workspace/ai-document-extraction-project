# CHANGE-102: 清理誤導的舊 LLM 模型選項 + Stage 配置正名（統一 gpt-5.4）

> **日期**: 2026-07-10
> **狀態**: ⏳ 待實作
> **優先級**: Medium
> **類型**: Refactor（技術債清理 + 配置正名）
> **影響範圍**: `src/lib/constants/llm-models.ts`、`system_configs`（本地 + Azure DEV 的 `extraction.model.stage1/2/3`）、模型選擇 UI（下拉來源）、相關引用盤點

---

## 變更背景

在本地測試中，文件 `CEVA_RCIM250306_20874.PDF` 出現 `OCR_FAILED`，根因追查發現：

- 本地連的 Azure DEV OpenAI resource 上**只剩兩個 deployment**：`gpt-5.4-mini-aidocprocessing` 與 `gpt-5.4-nano-aidocprocessing`（`az cognitiveservices account deployment list` 確認）。
- 舊的 gpt-5.2 / gpt-5-nano deployment **早已不存在**。
- 但系統的 `AVAILABLE_LLM_MODELS` 白名單仍保留 `gpt-5.2`、`gpt-5-nano` 這兩個舊 model key。它們透過既有 env 變數（`AZURE_OPENAI_DEPLOYMENT_NAME` / `AZURE_OPENAI_NANO_DEPLOYMENT_NAME`）被重新指向 5.4 的 deployment，因此**能跑，但 UI 顯示舊名、實際跑的是 5.4**。

### 誤導的實際映射（現況）

| UI 模型選項 | 讀的 env 變數 | env 實際指向 | 背後真實模型 |
|-------------|--------------|-------------|-------------|
| `gpt-5.2`（舊皮） | `AZURE_OPENAI_DEPLOYMENT_NAME` | `gpt-5.4-mini-aidocprocessing` | **其實是 5.4 mini** |
| `gpt-5-nano`（舊皮） | `AZURE_OPENAI_NANO_DEPLOYMENT_NAME` | `gpt-5.4-nano-aidocprocessing` | **其實是 5.4 nano** |
| `gpt-5.4-mini`（新皮） | `AZURE_OPENAI_GPT54_MINI_DEPLOYMENT_NAME` | `gpt-5.4-mini-aidocprocessing` | 5.4 mini（名實相符） |
| `gpt-5.4-nano`（新皮） | `AZURE_OPENAI_GPT54_NANO_DEPLOYMENT_NAME` | `gpt-5.4-nano-aidocprocessing` | 5.4 nano（名實相符） |

現在系統裡有兩對「名字不同、實際打到同一個 deployment」的 model key（`gpt-5.2` ≡ `gpt-5.4-mini`、`gpt-5-nano` ≡ `gpt-5.4-nano`），選擇模型時會誤導使用者以為在用 gpt-5.2，實際跑的是 5.4。

> 本任務源自使用者 2026-07-10 交辦：移除誤導的舊模型選項、Stage 配置正名、UI 只顯示真實的 5.4。

---

## 設計精髓：正名不改變實際行為

本 CHANGE 的核心保證——**「正名」只換 model key 的名字，不改變實際打到的 Azure deployment**，因此對提取行為零影響、風險低。

| Stage | 現在 key（誤導） | 實際打的 deployment | 正名後 key | 實際打的 deployment |
|-------|----------------|-------------------|-----------|-------------------|
| stage1 | `gpt-5.4-mini` | gpt-5.4-mini-aidocprocessing | `gpt-5.4-mini` | **不變** |
| stage2 | `gpt-5-nano` | gpt-5.4-nano-aidocprocessing | `gpt-5.4-nano` | **不變** |
| stage3 | `gpt-5.2` | gpt-5.4-mini-aidocprocessing | `gpt-5.4-mini` | **不變** |

---

## 變更內容

### 1. `AVAILABLE_LLM_MODELS` 白名單清理

移除 `gpt-5.2`、`gpt-5-nano` 兩筆，只保留 `gpt-5.4-mini`、`gpt-5.4-nano`。

- UI 模型下拉（`/model-configs` 等）以 `AVAILABLE_LLM_MODELS` 為來源，移除後**自動只顯示真實的 5.4**，UI 無需另改。

### 2. `DEFAULT_STAGE_MODELS` 同步改為 5.4 key

`llm-model-config.service.ts` 讀 stage 配置時，值若「不在白名單」→ fallback 到 `DEFAULT_STAGE_MODELS`（第 72、89-91 行）。目前 `DEFAULT_STAGE_MODELS` 全是舊 key（stage1/2=`gpt-5-nano`、stage3=`gpt-5.2`），**若只移除白名單而不改此處，fallback 會指向不存在的 key → 提取整條壞掉**。

改為對應「當前 DB 實際模型」的正名版（行為零變）：

```ts
export const DEFAULT_STAGE_MODELS: Record<ExtractionStage, string> = {
  stage1: 'gpt-5.4-mini',
  stage2: 'gpt-5.4-nano',
  stage3: 'gpt-5.4-mini',
};
```

### 3. DB `system_configs` Stage 配置正名

`extraction.model.stage1/2/3`（category=AI_MODEL、scope=GLOBAL）按上方對照表改為 5.4 key，**本地 + Azure DEV 皆須遷移**。

- 遷移後值仍在白名單內（有效），不會觸發 fallback；UI 顯示的 stage 模型與實際一致。
- Azure DEV 採 **gated 容器腳本**（比照 CHANGE-101 / `prisma/update-stage3-prompt.js`），env flag 觸發、冪等 upsert。

### 4. 引用點盤點（確保移除白名單後無 runtime 破壞）

移除白名單前，必須盤點所有 `getLlmModelOption()` / `isValidLlmModel()` 呼叫點與硬編碼 `'gpt-5.2'` / `'gpt-5-nano'` 字串，確認移除後不會產生 runtime `undefined`。

---

## 技術設計

### 修改範圍

| 文件 | 變更內容 | 分類 |
|------|----------|------|
| `src/lib/constants/llm-models.ts` | 移除 `gpt-5.2`/`gpt-5-nano` 白名單 + 改 `DEFAULT_STAGE_MODELS` | 🔧 必改 |
| `tests/unit/lib/llm-models.test.ts` | 更新白名單/預設模型相關斷言 | 🔧 必改 |
| `prisma/rename-stage-models-to-gpt54.js` | 🆕 gated 腳本：DB stage 配置正名（inspect/write） | 🆕 新增 |
| `scripts/docker-entrypoint.sh` | 🔧 新增 gated block（`RUN_STAGE_MODEL_RENAME`，非致命） | 🔧 必改 |
| 本地 DB `system_configs` | `extraction.model.stage1/2/3` 正名 | 🔧 資料 |
| Azure DEV DB `system_configs` | 同上（經 gated 腳本） | 🔧 資料 |

### 須盤點（移除白名單前逐一確認，不必然修改）

引用舊 model key（`gpt-5.2` / `gpt-5-nano`）或白名單 API 的檔案：

- `src/services/extraction-v3/stages/gpt-caller.service.ts`
- `src/services/unified-processor/unified-document-processor.service.ts`
- `src/services/extraction-v3/extraction-v3.service.ts`
- `src/services/extraction-v3/unified-gpt-extraction.service.ts`
- `src/services/gpt-vision.service.ts`
- `src/services/ai-term-validator.service.ts`
- `src/services/term-classification.service.ts`
- `src/app/api/v1/prompt-configs/test/route.ts`
- `src/app/api/test/extraction-compare/route.ts`
- `src/app/api/v1/model-configs/route.ts`
- `src/lib/validations/llm-model-config.schema.ts`
- `prisma/seed-data/config-seeds.ts`（含 `integration.ai.model` = `gpt-4-vision-preview`）

### 本次不動（列 backlog，見 OQ-2）

- `src/services/ai-cost.service.ts`（定價表可能以舊模型名為 key，屬計價層，另案處理）
- `src/services/extraction-v2/gpt-mini-extractor.service.ts`（V2 舊架構，V3.1@100% 下不在主路徑）
- `scripts/test-*.ts`（3 個開發測試腳本，非 runtime）
- `integration.ai.model` = `gpt-4-vision-preview`（不同用途，非 extraction stage）
- 舊 env 變數（`AZURE_OPENAI_DEPLOYMENT_NAME` 等）保留（見 OQ-4）

### 資料庫影響

- **不改 Prisma schema**，僅更新 `system_configs` 三筆值。
- gated 腳本冪等：以 `key` 為條件 upsert 新值；重跑不產生副作用。

---

## 設計決策（原 Open Questions，2026-07-10 使用者定案）

| # | 決策 | 定案 | 理由 |
|---|------|------|------|
| OQ-1 | 舊 key 完全移除 vs 保留標記 legacy | **完全移除** | 使用者要清掉誤導選項；fallback 安全網 + DB 遷移可保證不壞 |
| OQ-2 | 17 檔其他引用一起清 vs 只清白名單+stage 配置 | **只清白名單 + stage 配置 + 確保無 runtime 破壞** | surgical，避免 scope 膨脹；定價表/V2 舊名引用另案 |
| OQ-3 | Azure DEV DB stage 配置遷移是否納入 | **納入**（gated 腳本） | 與本地一致；appsettings 確認新 env 已設 |
| OQ-4 | 舊 env 變數保留 vs 清除 | **保留** | 可能被 integration / V2 讀，清除風險大、收益低 |

---

## 影響範圍評估

### 向後兼容性

- **行為零變**：正名前後實際打到的 deployment 完全相同（見「設計精髓」對照表）。
- 已上傳並成功處理的 70 份文件不受影響（stage 配置只影響「未來的處理」）。
- 移除白名單後，若 DB 尚有未遷移的舊 key 值 → `llm-model-config.service` 的 fallback 會導向新的 `DEFAULT_STAGE_MODELS`（5.4 key），仍可正常運作（安全網）。

### 風險評估

| 風險 | 緩解 |
|------|------|
| 移除白名單後某處 `getLlmModelOption('gpt-5.2')` 回 undefined → runtime 崩潰 | 實作 Phase 1 先盤點所有呼叫點，確認無硬依賴後才移除 |
| DB stage 配置未遷移 → fallback 行為與預期不符 | `DEFAULT_STAGE_MODELS` 已對應現有實際行為；gated 腳本完成遷移後值即有效 |
| Azure DEV appsettings 未設新 env → 部署後 stage 仍可能 404 | 遷移前確認 `AZURE_OPENAI_GPT54_MINI/NANO_DEPLOYMENT_NAME` 已在 appsettings |
| 測試/腳本引用舊 key 造成 CI 失敗 | `llm-models.test.ts` 同步更新；test scripts 屬 backlog、非 CI gate |

### 回滾計劃

- 程式碼：白名單加回 `gpt-5.2` / `gpt-5-nano`、`DEFAULT_STAGE_MODELS` 改回舊 key。
- DB：gated 腳本反向 upsert（或手動改回三筆 `system_configs` 值）。
- 因「正名不改實際 deployment」，回滾亦不影響實際提取行為。

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | 白名單清理 | `AVAILABLE_LLM_MODELS` 只含 `gpt-5.4-mini`、`gpt-5.4-nano` | High |
| 2 | 預設模型有效 | `DEFAULT_STAGE_MODELS` 三個 stage 皆為白名單內的 5.4 key | High |
| 3 | 引用無破壞 | 全 repo 無 `getLlmModelOption`/`isValidLlmModel` 因移除而回 undefined 的 runtime 路徑 | High |
| 4 | DB 正名 | 本地 + Azure DEV 的 `extraction.model.stage1/2/3` 皆為 5.4 key | High |
| 5 | UI 正確 | 模型下拉只顯示真實 5.4，stage 顯示與實際一致 | High |
| 6 | 行為零變 | 正名後重新處理文件，實際打到的 deployment 與正名前相同 | High |
| 7 | 品質 gate | `type-check` / `lint` / `llm-models.test.ts` 通過 | High |

---

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | 白名單移除 | 檢視 `AVAILABLE_LLM_MODELS` | 只有 2 個 5.4 model |
| 2 | Fallback 安全網 | 清空/設無效 stage 配置，讀 `getStageModel` | 回 5.4 的 `DEFAULT_STAGE_MODELS` |
| 3 | DB 正名（本地） | 執行遷移後查 `system_configs` | 三筆皆 5.4 key |
| 4 | DB 正名（Azure DEV） | 設 `RUN_STAGE_MODEL_RENAME=write` 部署 → 查 log/DB | 三筆正名、冪等重跑 0 變更 |
| 5 | 端到端 | 重新處理一份文件 | 提取成功、實際 deployment 不變 |
| 6 | UI 驗證 | 開模型設定頁 | 下拉無 gpt-5.2 / gpt-5-nano，stage 顯示 5.4 |

---

## 實施計劃（分階段）

1. **Phase 1 — 引用盤點**：grep 所有 `getLlmModelOption` / `isValidLlmModel` / `'gpt-5.2'` / `'gpt-5-nano'` 呼叫點，逐一確認移除白名單後無 runtime 破壞。→ verify：盤點清單 + 無硬依賴。
2. **Phase 2 — 程式碼變更**：移除白名單兩筆 + 改 `DEFAULT_STAGE_MODELS` + 更新 `llm-models.test.ts`。→ verify：`type-check` / `lint` / `test` 通過。
3. **Phase 3 — 本地 DB 正名 + 驗證**：更新本地 `system_configs` 三筆 → 重啟 dev server → 重新處理文件確認行為零變。→ verify：驗收標準 4/5/6。
4. **Phase 4 — Azure DEV 遷移**：gated 腳本 `RUN_STAGE_MODEL_RENAME`，`az acr build` 手動部署 → write → flag 清空。→ verify：Azure DB 三筆正名、冪等。

---

## Implementation Notes

### Phase 1 — 引用盤點結果（2026-07-10）

**結論：移除白名單 `gpt-5.2`/`gpt-5-nano` 無任何 runtime 破壞路徑。**

| 引用類型 | 位置 | 移除白名單後 | 處理 |
|---------|------|-------------|------|
| `getLlmModelOption` 主呼叫 | gpt-caller:222 | 有 `if(!modelOption)` 防護 + 輸入來自 fallback 安全網 | 安全，不改 |
| `isValidLlmModel` | llm-model-config:72/89/105 | fallback/驗證邏輯，舊值→DEFAULT（改 5.4） | 安全，不改 |
| 白名單消費 | schema:16、model-configs route:20 | 自動反映（zod enum / UI 只剩 5.4） | 正是目標 |
| `callNano`/`callFull` 硬編 key | gpt-caller:437/459 | **dead code（零呼叫點）**，不觸發 | Phase 2 順手正名 |
| `GptModelType` 型別 | gpt-caller:41 | 編譯期型別，名稱誤導 | Phase 2 更新 |
| deployment name env fallback | gpt-vision / term-classification / ai-term-validator / test routes | 不經白名單，直接當 Azure deployment | backlog（OQ-2） |
| 定價表 key | ai-cost:80/87 | 不經白名單 | backlog（OQ-2） |
| metadata 顯示 fallback | extraction-v3:687、unified-processor:485 | 不經白名單，僅顯示 | backlog（OQ-2） |
| V2 / test scripts | gpt-mini-extractor、scripts/ | 不在主路徑/非 runtime | backlog（OQ-2） |

**安全網**：`getStageModels()`（llm-model-config.service）對非白名單值 fallback 到 `DEFAULT_STAGE_MODELS`，故傳給 gpt-caller 的永遠是有效 5.4 key。

### Phase 2 — 程式碼變更（2026-07-10 完成）

| 檔案 | 變更 |
|------|------|
| `llm-models.ts` | `AVAILABLE_LLM_MODELS` 移除 gpt-5.2 / gpt-5-nano（只留 gpt-5.4-mini/nano）；`DEFAULT_STAGE_MODELS` → stage1/3=gpt-5.4-mini、stage2=gpt-5.4-nano |
| `gpt-caller.service.ts` | `GptModelType` 型別 → 5.4；`callNano`/`callFull`（dead code）硬編 key 正名為 gpt-5.4-nano/mini |
| `llm-models.test.ts` | 移除測舊 model 的 describe；更新 DEFAULT 斷言；新增「舊 key 已移出白名單」斷言 |

**驗證**：`vitest llm-models.test.ts` 9 passed、`eslint` exit 0、`tsc --noEmit` exit 0。

### Phase 3/4 — DB 正名 + Azure 部署

_（實作後補充：本地/Azure 遷移筆數、行為零變驗證。）_
