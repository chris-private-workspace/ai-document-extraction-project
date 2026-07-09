# CHANGE-100: 新增 gpt-5.4-mini / gpt-5.4-nano 至 LLM 模型白名單（Stage 1-3 可選）

> **日期**: 2026-07-09
> **狀態**: ✅ 已完成（2026-07-09）
> **優先級**: Medium
> **類型**: Feature
> **影響範圍**: `src/lib/constants/llm-models.ts`（白名單）→ 自動反映到 model-settings 下拉、model-configs API 驗證、gpt-caller、Stage 1-3

---

## 變更背景

CHANGE-099（2026-07-09）已把 extraction Stage 1-3 的模型選擇改為**白名單驅動**：白名單 `AVAILABLE_LLM_MODELS`（`src/lib/constants/llm-models.ts`）是唯一事實來源，管理頁下拉、`model-configs` API 的 Zod 驗證、`gpt-caller` 三處都從它讀取。目前白名單只有 `gpt-5-nano`、`gpt-5.2` 兩個模型。

用戶需求：在 model settings 多加 **gpt-5.4-mini** 與 **gpt-5.4-nano** 兩個選項，並確保換用時能**真實套用到 Stage 1-3**。

### 為何「加白名單即可真實套用」（已驗證）

Stage 1/2/3 都走同一條白名單路徑，無其他硬編碼模型 gate：

| Stage | 呼叫點 | 路徑 |
|-------|--------|------|
| Stage 1 | `stage-1-company.service.ts:304-305` | `getStageModel('stage1')` → `callModel(modelKey)` |
| Stage 2 | `stage-2-format.service.ts:377-378` | `getStageModel('stage2')` → `callModel(modelKey)` |
| Stage 3 | `stage-3-extraction.service.ts:1009-1010` | `getStageModel('stage3')` → `callModel(modelKey)` |

`callModel` → `getLlmModelOption(key)`（取 capability）→ `resolveDeploymentName(option)`（取 Azure 部署名）。因此在白名單加一筆（含正確 capability + 部署 env），三個 stage 選它即生效——正如 `llm-models.ts` 註釋所述「管理頁下拉與 gpt-caller 會自動反映，無需改其他程式碼」。

---

## 變更內容

### 在 `AVAILABLE_LLM_MODELS` 新增兩個模型

```ts
{
  key: 'gpt-5.4-mini',
  label: 'GPT-5.4 Mini（中階・平衡）',
  deploymentEnvVar: 'AZURE_OPENAI_GPT54_MINI_DEPLOYMENT_NAME',
  defaultDeploymentName: 'gpt-5.4-mini',
  capability: {
    maxTokens: 8192,
    supportsTemperature: true,
    temperature: 0.1,
    defaultImageDetail: 'auto',
    supportsJsonSchema: true,
  },
},
{
  key: 'gpt-5.4-nano',
  label: 'GPT-5.4 Nano（快速・低成本）',
  deploymentEnvVar: 'AZURE_OPENAI_GPT54_NANO_DEPLOYMENT_NAME',
  defaultDeploymentName: 'gpt-5.4-nano',
  capability: {
    maxTokens: 4096,
    supportsTemperature: false,
    defaultImageDetail: 'low',
    supportsJsonSchema: false,
  },
},
```

---

## 技術設計

### 設計決策（已與用戶確認 2026-07-09）

| # | 決策點 | 選定方向 | 理由 |
|---|--------|----------|------|
| D1 | 部署名稱 | **部署名 = 模型名**（Azure deployment 即 `gpt-5.4-mini` / `gpt-5.4-nano`），各加專屬 env var 可覆蓋 | 符合用戶「部署名稱跟模型名稱一樣」；env var 與既有模型一致、可跨環境覆蓋 |
| D2 | API key / endpoint | **共用現有** `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` | 同一 Azure OpenAI 資源，`gpt-caller` 本就全域取這兩個 env，無需改動 |
| D3 | gpt-5.4-mini 能力 | **對標 gpt-5.2**：`maxTokens 8192`、`supportsTemperature true`（0.1）、`supportsJsonSchema true`、`defaultImageDetail 'auto'` | 中高階模型，Stage 3 可用 json_schema structured output |
| D4 | gpt-5.4-nano 能力 | **對標 gpt-5-nano**：`maxTokens 4096`、`supportsTemperature false`、`supportsJsonSchema false`、`defaultImageDetail 'low'` | 輕量模型，`gpt-caller` 對其不送 temperature / 用 json_object |
| D5 | 範圍邊界（非 H1） | 不改三層映射 / 信心度路由 / vendor（仍 Azure OpenAI）；僅擴充白名單清單 | 純資料/常量新增，非架構變更 |

### 修改範圍

| 文件 | 類型 | 變更內容 |
|------|------|----------|
| `src/lib/constants/llm-models.ts` | 🔧 修改 | `AVAILABLE_LLM_MODELS` 新增 `gpt-5.4-mini` / `gpt-5.4-nano` 兩筆（含 capability + 部署 env） |
| `.env.example` | 🔧 修改 | 新增 `AZURE_OPENAI_GPT54_MINI_DEPLOYMENT_NAME` / `AZURE_OPENAI_GPT54_NANO_DEPLOYMENT_NAME` 說明（可選覆蓋，預設等於模型名） |
| `tests/unit/lib/llm-models.test.ts` | 🔧 修改 | 更新白名單相關斷言（若測試斷言模型數量/內容），補新模型的 `getLlmModelOption` / `resolveDeploymentName` / capability 驗證 |

> **自動反映、無需改動**：`model-settings` 頁下拉、`model-configs` API 的 Zod 驗證（動態 enum）、`gpt-caller` 呼叫邏輯、`isValidLlmModel` 均從白名單衍生，加白名單後自動涵蓋新模型。

### i18n 影響
無。模型 `label` 為白名單常量（下拉直接顯示），CHANGE-099 頁面文字未依賴逐模型 i18n key。

### 資料庫影響
無。沿用 CHANGE-099 的 `system_configs`（`extraction.model.stageN`）；選用新模型只是把 value 存為 `gpt-5.4-mini` / `gpt-5.4-nano`，`isValidLlmModel` 加白名單後即通過驗證。

---

## 向後兼容性

- `DEFAULT_STAGE_MODELS` **不變**（stage1/2=`gpt-5-nano`、stage3=`gpt-5.2`），未選新模型的環境行為完全不變。
- 新模型為「新增選項」，不影響既有兩模型。

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | 下拉出現 | `/admin/model-settings` 三個 Stage 下拉都出現 gpt-5.4-mini / gpt-5.4-nano | High |
| 2 | 可儲存 | 任一 Stage 選新模型可儲存、GET 讀回一致（`isValidLlmModel` 通過） | High |
| 3 | 真實套用 | 選新模型後處理文件，該 Stage 實際以新模型的部署名呼叫（AI Details `model` 佐證） | High |
| 4 | 能力正確 | gpt-5.4-nano 用於任一 Stage 時不送 temperature；gpt-5.4-mini 於 Stage 3 可用 json_schema | Med |
| 5 | 部署解析 | `resolveDeploymentName` 對新模型回傳 `gpt-5.4-mini` / `gpt-5.4-nano`（或 env 覆蓋值） | Med |
| 6 | 品質檢查 | `type-check` / `lint` / `vitest` 通過 | Med |

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | 選 gpt-5.4-mini 給 Stage 3 | 後台設定 → 儲存 → 處理文件 | Stage 3 AI Details 顯示 model=gpt-5.4-mini、json_schema 正常 |
| 2 | 選 gpt-5.4-nano 給 Stage 1 | 後台設定 → 儲存 → 處理文件 | Stage 1 用 gpt-5.4-nano、不送 temperature |
| 3 | 單元測試不變量 | `vitest tests/unit/lib/llm-models.test.ts` | 新模型 capability / 部署解析正確、既有斷言更新後通過 |

---

## 風險 / 註記

1. **實跑依賴 Azure 部署**：若 Azure 端未建立名為 `gpt-5.4-mini` / `gpt-5.4-nano` 的部署，選用該模型處理文件會回 `DeploymentNotFound`（屬環境配置、非代碼缺陷）。本地無此部署時，選項仍會顯示、可儲存，但實跑會失敗。
2. **成本**：gpt-5.4-mini 對標 gpt-5.2（較貴），用於 Stage 1/2 會提高成本；沿用 CHANGE-099 頁面提示機制，不強制阻擋。

---

## 實作記錄（2026-07-09 完成）

| 檔案 | 動作 |
|------|------|
| `src/lib/constants/llm-models.ts` | 🔧 `AVAILABLE_LLM_MODELS` 新增 `gpt-5.4-mini`（對標 gpt-5.2 capability + `AZURE_OPENAI_GPT54_MINI_DEPLOYMENT_NAME`）與 `gpt-5.4-nano`（對標 gpt-5-nano capability + `AZURE_OPENAI_GPT54_NANO_DEPLOYMENT_NAME`）；部署名預設等於模型名 |
| `.env.example` | 🔧 新增 GPT-5.4 系列部署 env var 說明（可選覆蓋、共用 endpoint + API key、需 Azure 端有對應部署） |
| `tests/unit/lib/llm-models.test.ts` | 🔧 新增 `CHANGE-100` describe（4 測試）：兩模型在白名單、capability 對標、部署名預設等於模型名、env 覆蓋 |

**未改動、自動反映**（CHANGE-099 白名單驅動）：`model-settings` 頁下拉、`model-configs` API Zod 驗證、`gpt-caller`、`isValidLlmModel`、Stage 1-3（`getStageModel → callModel → getLlmModelOption → resolveDeploymentName`）。

**驗證**：`type-check` ✅ / `vitest` ✅ 12 passed（原 8 + 新 4）/ `lint` ✅ 改動檔 0 warning（既有 console/unused 警告非本次引入）。
**向後相容**：`DEFAULT_STAGE_MODELS` 不變（1/2=nano、3=gpt-5.2），新模型僅為新增選項。
**未 UI/實跑實測**：實際選新模型跑真文件需 Azure 端已建立 `gpt-5.4-mini` / `gpt-5.4-nano` 部署（本地無該部署選了會 `DeploymentNotFound`，屬環境配置）。Azure DEV 環境依先前記錄已有這兩個部署。

---

*文件建立日期: 2026-07-09*
*最後更新: 2026-07-09*
