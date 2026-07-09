# CHANGE-099: LLM 模型選擇管理（全域 Stage 1-3 可配置 + 後台管理頁）

> **日期**: 2026-07-09
> **狀態**: ✅ 已完成（2026-07-09；D1 採方案 A = system_configs）
> **優先級**: Medium
> **類型**: Feature
> **影響範圍**: extraction-v3 三階段管線（`gpt-caller` + stage 1/2/3）+ 系統配置 + 新 admin 頁面 + i18n

---

## 變更背景

目前文件處理 Stage 1-3 的**模型選擇完全硬編碼在程式碼中**，無法從介面調整：

| Stage | 用的模型 | 硬編碼位置 |
|-------|---------|-----------|
| Stage 1 公司識別 | `gpt-5-nano` | `stage-1-company.service.ts:290` → `GptCallerService.callNano()` |
| Stage 2 格式匹配 | `gpt-5-nano` | `stage-2-format.service.ts:376` → `callNano()` |
| Stage 3 欄位提取 | `gpt-5.2` | `stage-3-extraction.service.ts:1008` → `callFull()` |

- 模型類型寫死為編譯期常量：`gpt-caller.service.ts:36` `type GptModelType = 'gpt-5-nano' | 'gpt-5.2'`
- `callNano` / `callFull` 內硬編模型名（`:442` / `:464`）
- 每模型參數（maxTokens / temperature / 圖片解析度）硬編於 `MODEL_CONFIG`（`:168`）
- **唯一外部可調**：Azure「部署名稱」可用 env 覆蓋（`AZURE_OPENAI_NANO_DEPLOYMENT_NAME` / `AZURE_OPENAI_DEPLOYMENT_NAME`），但屬部署層、非頁面，且不能改「哪個 Stage 用哪個模型」。

**需求**：讓管理者能在後台頁面選擇 Stage 1/2/3 各自使用哪個 LLM 模型（從一份可選模型白名單下拉），不需改程式碼或重新部署。

## 需求範圍（已與用戶確認）

| 決策項 | 選定方向 |
|--------|---------|
| 配置粒度 | **全域一組**（Stage 1/2/3 各選一個模型，全公司/全格式通用；不做三層 scope 覆蓋） |
| 適用範圍 | **只 extraction Stage 1-3**（不含 term-classification / ai-term-validator / V2 mini / gpt-vision 等其他 GPT 用途） |
| 模型清單來源 | **後台白名單下拉**（維護一份可選模型清單，含顯示名 + 對應 Azure 部署名，使用者從下拉選） |

## 變更內容

### 1. 可選模型白名單（新常量）
建立 `AVAILABLE_LLM_MODELS` 常量，每個項目含：
- `key`（內部識別符，如 `gpt-5-nano`、`gpt-5.2`）
- `label`（顯示名）
- `deploymentEnvVar` / `deploymentName`（對應 Azure 部署，沿用既有 env 覆蓋機制）
- `capability`：`maxTokens`、`supportsTemperature`、`defaultImageDetail`、`supportsJsonSchema`（取代目前硬編的 `MODEL_CONFIG`，讓新模型能正確設參數）

### 2. 全域 Stage→模型配置（讀寫）
儲存 Stage 1/2/3 各自選定的模型 key（**設計取捨見下方 §設計決策 D1**）。

### 3. `gpt-caller.service.ts` 改造
- 模型參數（maxTokens / temperature / imageDetail）改由白名單 `capability` 驅動，取代硬編 `MODEL_CONFIG`。
- 提供以 model key 為參數的通用呼叫（現有 `callNano` / `callFull` 可保留為便捷包裝或改為讀配置）。

### 4. Stage 1/2/3 服務改造
Stage 1/2/3 呼叫 GPT 前，改為**從配置服務讀取該 Stage 選定的模型**再傳入 gpt-caller，取代目前硬編的 `callNano` / `callFull`。
- **向後相容 fallback**：配置缺失/無效時，回退到目前的預設（Stage 1/2 = nano、Stage 3 = full），確保不改變現況行為。

### 5. 後台管理頁面
新增 `/admin/model-settings`（或併入 `/admin/settings` 分頁）：3 個 Stage 各一個下拉（選項來自白名單）+ 儲存。顯示各模型的 label 與簡短能力說明。

### 6. API 端點
`GET`（讀目前配置 + 白名單）、`PUT`（更新 Stage→模型），採 Zod 驗證 + RFC 7807 錯誤格式。

### 7. i18n
新增頁面文字到 `messages/{en,zh-TW,zh-CN}/`（新 namespace 或複用 `systemSettings`）。

---

## 技術設計

### 設計決策

#### ✅ D1（已定案：方案 A，2026-07-09 用戶確認）— 配置儲存位置
| 選項 | 做法 | 取捨 |
|------|------|------|
| **A（建議）** | 用既有 `system_configs`（key-value）存 3 個 key：`extraction.stage1.model` / `stage2.model` / `stage3.model` | **無 Prisma schema 變更** → 免 migration、避開 Azure schema drift 風險（見 runbook §14）；最簡、最快落地。白名單為程式碼常量 |
| B | 新建 Prisma model `LlmModelConfig` 存全域 stage→model（+ 未來可擴充白名單入 DB） | 較「正規」、白名單可 DB 管理；但需 migration + Azure schema drift 處理，工程量大，且「全域一組」用不到 model 的關聯能力 |

> **建議採 A**（符合 §Simplicity First；全域一組不需要獨立 model）。白名單為程式碼常量（開發維護），使用者從下拉選、選擇結果存 `system_configs`。若日後要白名單本身也能 UI 增刪，再另立擴充 CHANGE。

#### D2 — 模型能力差異
不同模型限制不同（如 `gpt-5-nano` 不支援自定義 temperature）。白名單的 `capability` 欄位承載這些差異，`gpt-caller` 依 capability 組請求，避免對不支援的模型送錯參數。

#### D3 — 範圍邊界（非 H1）
本變更**不改**三層映射、信心度路由、vendor（仍 Azure OpenAI）；僅把「模型選擇」從硬編改為讀配置。故非 H1 架構變更。但因動到核心提取路徑，實作須含回歸測試（見測試場景）。

### 修改範圍

| 文件 | 類型 | 變更內容 |
|------|------|----------|
| `src/lib/constants/llm-models.ts`（或 `src/constants/`） | 🆕 新增 | `AVAILABLE_LLM_MODELS` 白名單 + capability |
| `src/services/llm-model-config.service.ts` | 🆕 新增 | 讀寫全域 stage→模型（封裝 system-config 存取 + fallback） |
| `src/services/extraction-v3/stages/gpt-caller.service.ts` | 🔧 修改 | 參數改由白名單 capability 驅動；通用 call 以 model key 為參數 |
| `src/services/extraction-v3/stages/stage-1-company.service.ts` | 🔧 修改 | 讀配置決定模型（取代硬編 `callNano`） |
| `src/services/extraction-v3/stages/stage-2-format.service.ts` | 🔧 修改 | 同上 |
| `src/services/extraction-v3/stages/stage-3-extraction.service.ts` | 🔧 修改 | 讀配置決定模型（取代硬編 `callFull`） |
| `src/lib/validations/*.ts` | 🆕 新增 | 模型配置 Zod schema |
| `src/app/api/v1/model-configs/route.ts` | 🆕 新增 | GET / PUT |
| `src/app/[locale]/(dashboard)/admin/model-settings/page.tsx` + 組件 | 🆕 新增 | 管理頁面（3 下拉 + 儲存） |
| `messages/{en,zh-TW,zh-CN}/*.json` | 🔧 修改 | 頁面 i18n 三語言 |
| `src/i18n/request.ts` | 🔧 修改 | 若新 namespace 需註冊 |
| 導航（sidebar 配置） | 🔧 修改 | 加入口 |

### 向後兼容性
- 配置未設定時 fallback 到現況硬編預設 → **未部署/未設定的環境行為完全不變**。
- 白名單至少含現有兩模型（`gpt-5-nano`、`gpt-5.2`），確保現行 Azure 部署可直接對應。

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | 後台可設定 | `/admin/model-settings` 可為 Stage 1/2/3 各選一個模型並儲存 | High |
| 2 | 生效 | 儲存後新處理的文件，各 Stage 實際呼叫所選模型（AI Details / log 可佐證 `modelUsed`） | High |
| 3 | 白名單下拉 | 下拉選項來自 `AVAILABLE_LLM_MODELS`，顯示 label | High |
| 4 | 向後相容 | 未設定配置時，行為與現況一致（1/2=nano、3=full） | High |
| 5 | 能力正確 | 選用不支援 temperature 的模型時不送 temperature，不報錯 | Med |
| 6 | i18n | 三語言同步，`npm run i18n:check` 通過 | Med |
| 7 | 驗證/錯誤格式 | API 採 Zod 驗證 + RFC 7807 | Med |

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | 切換 Stage 3 模型 | 後台把 Stage 3 改為 nano → 處理一份文件 | AI Details 顯示 Stage 3 用 nano |
| 2 | 未設定 fallback | 清空配置 → 處理文件 | 沿用預設（1/2=nano、3=full），不報錯 |
| 3 | 無效 model key | 配置指向白名單不存在的 key | fallback 到預設 + 記警告，不中斷處理 |
| 4 | 能力差異 | 選 nano 給 Stage 3 | 不送自定義 temperature、正常提取 |
| 5 | 回歸 | 全 Stage 維持預設模型 | 提取結果與變更前一致 |

---

## 未決問題 / 風險

1. **D1 儲存位置**（system_configs vs 新 model）— **待用戶確認**（建議 A）。
2. **成本影響**：允許把 Stage 1/2 換成更貴模型（如 gpt-5.2）會提高成本 → 頁面可加提示，但不強制阻擋。
3. **新模型的 structured output 支援**：Stage 3 用 `json_schema`（CHANGE-042），白名單需標明模型是否支援；不支援者用於 Stage 3 可能降級提取品質 → capability 標記 + 頁面提示。
4. **範圍蔓延**：本 CHANGE 只做 extraction Stage 1-3；其他 GPT 用途（term-classification 等）若日後也要可配置，另立 CHANGE。

---

## 實作記錄（2026-07-09 完成）

| 層 | 檔案 | 動作 |
|----|------|------|
| 常量 | `src/lib/constants/llm-models.ts` | 🆕 白名單 `AVAILABLE_LLM_MODELS` + capability + 預設/解析 helper |
| 服務 | `src/services/llm-model-config.service.ts` | 🆕 讀寫 system_configs（`upsert`，category=`AI_MODEL`、scope=`GLOBAL`）+ 無效/缺失 fallback |
| 提取 | `src/services/extraction-v3/stages/gpt-caller.service.ts` | 🔧 `call` 改白名單驅動（能力 + 部署名）+ 新增 `callModel`；移除硬編 `MODEL_CONFIG` |
| 提取 | `stage-1-company` / `stage-2-format` / `stage-3-extraction.service.ts` | 🔧 改讀配置決定模型（取代硬編 `callNano`/`callFull`） |
| 驗證 | `src/lib/validations/llm-model-config.schema.ts` | 🆕 Zod（白名單動態 enum） |
| API | `src/app/api/v1/model-configs/route.ts` | 🆕 GET（登入即可讀）/ PUT（限 globalAdmin） |
| Hook | `src/hooks/use-model-configs.ts` | 🆕 React Query GET/PUT |
| 頁面 | `src/app/[locale]/(dashboard)/admin/model-settings/{page,client}.tsx` | 🆕 管理頁（3 下拉 + 能力提示 + 非 admin 唯讀） |
| 導航 | `src/components/layout/Sidebar.tsx` | 🔧 加「模型設定」入口 |
| i18n | `messages/{en,zh-TW,zh-CN}/{systemSettings,navigation}.json` | 🔧 複用既有 namespace（未動 `request.ts`） |
| 測試 | `tests/unit/lib/llm-models.test.ts` | 🆕 8 測試（白名單 + fallback 不變量） |

**驗證**：`type-check` ✅ / `lint` ✅ 0 errors / `i18n:check` ✅ 三語言同步 / `vitest` ✅ 17/17。
**向後相容**：配置缺失時 fallback 到 Stage 1/2=nano、Stage 3=gpt-5.2（＝變更前行為）。
**待執行期驗證**：頁面 E2E（載入 / 儲存 / 非 admin 唯讀）需啟動服務登入實測。
