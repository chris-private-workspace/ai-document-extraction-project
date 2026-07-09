# Tech Spec: Epic 23 - 多 LLM Provider 整合管理系統

> **Version**: 0.2.0（D1–D4 決策已定，實作規格草案）
> **Created**: 2026-07-09 ｜ **Updated**: 2026-07-09
> **Status**: 🟢 D1–D4 決策已定；待排入 sprint 進實作（**尚未寫入 `sprint-status.yaml`**）
> **Epic Key**: EPIC-23（暫定編號，sprint-status 目前追蹤到 21、tech-specs 到 22）
> **前置**: CHANGE-099（LLM 模型選擇管理，已完成）

---

## 決策記錄（D1–D4，2026-07-09 用戶定案）

| # | 問題 | 定案 | 影響 |
|---|------|------|------|
| **D1** | 資料模型 | **新增 Prisma model**（`LlmProvider` + `LlmModel`） | 觸發 H1；需 migration |
| **D2** | 支援哪些 provider | **多家主流 provider**：OpenAI、Google Gemini、Anthropic Claude、xAI Grok **等**（可擴充） | 見 §3 架構、§5 依賴 |
| **D3** | 是否先只做 Phase 1（僅 Azure 抽象層） | **否** — 直接做完整、用戶可自行配置的多 provider 系統 | 移除 Phase 閘門，改為已承諾的 Story 序列（§11） |
| **D4** | VNet egress / 資料合規誰拍板 | **由 AI 決定** → 見 §6（我的決定已記錄） | 見 §6、§10 |

---

## ⚠️ Hard Constraint 觸發聲明（實作前逐項 approve）

| 約束 | 觸發點 | 需 approve 時機 |
|------|--------|----------------|
| **H1 架構變更** | 新增 Prisma model（`LlmProvider`/`LlmModel`）；引入 Provider 抽象層，改動 extraction 管線與 Tier 3（`term-classification`）的 LLM 呼叫底層 | Story 23.1 開工前 |
| **H2 依賴/Vendor** | **唯一新增 npm 套件 `@anthropic-ai/sdk`**（Claude 專用）；OpenAI/Gemini/Grok 皆複用既有 `openai` SDK，無新依賴 | Story 23.3 安裝套件時（確認版本） |
| **H4 安全/隱私** | 儲存各 provider API key（加密）；非 Azure provider 的發票資料落地合規 | Story 23.2 起 |

> 本文件為規劃文件；撰寫它不違反約束。**任何一行實作 code 前**，對應 Story 仍須取得 explicit approval。用戶已於 2026-07-09 approve **方向**（D1–D4）。

---

## Overview

| 項目 | 內容 |
|------|------|
| **Epic ID** | 23（暫定） |
| **Epic 名稱** | Multi-LLM Provider Integration & Governance |
| **預估規模** | 大型 / 跨多 Sprint（4 個 Story，約 3-4 週） |
| **前置依賴** | CHANGE-099（已完成，提供白名單 + Stage 模型選擇雛形） |
| **本質** | 把硬綁 Azure OpenAI、散落 7 處的 LLM 呼叫，收斂為統一 Provider 抽象層，並讓用戶在後台**自行配置多家 LLM provider 與模型** |

---

## 1. 需求背景

CHANGE-099 只能在 **2 個 Azure OpenAI 模型**（`gpt-5-nano`/`gpt-5.2`）間選。用戶要求建立更系統化的機制，管理**不同 LLM service provider** 的整合設定，讓用戶自行配置、決定使用哪家 provider 的模型。

**現況痛點**（實測盤點）：
- LLM 呼叫**完全綁 Azure OpenAI**：白名單 `src/lib/constants/llm-models.ts` 以 `deploymentEnvVar` 為核心，無 provider 維度、無 endpoint/apiKey 概念。
- **Client 初始化散落 7 處**：5× `new AzureOpenAI`（`gpt-vision.service.ts:710`、`term-classification.service.ts:170`、`ai-term-validator.service.ts:248`、`extraction-v2/gpt-mini-extractor.service.ts:159`、`api/v1/prompt-configs/test/route.ts:467`；另 `api/test/extraction-compare/route.ts:252`）+ 2× fetch（`gpt-caller.service.ts`、`unified-gpt-extraction.service.ts`）。
- **設定不一致**：`gpt-caller` 硬編 `API_VERSION='2024-12-01-preview'`；其他讀 `AZURE_OPENAI_API_VERSION`（預設值分歧）；`ai-term-validator` 用獨立命名 `AZURE_OPENAI_DEPLOYMENT`。

---

## 2. 目標與非目標

### 目標（In Scope）
- **G1**：統一 `LlmProviderAdapter` 抽象層，封裝「組 wire request / 認證 / 回應解析」。
- **G2**：收斂散落 7 處 LLM 呼叫到抽象層（漸進，先 extraction 管線，再其餘）。
- **G3**：後台可**由用戶自行配置** Provider（類型 + endpoint + 憑證）與其模型（+ 能力）。
- **G4**：各處理環節可指定「用哪個 provider 的哪個模型」。
- **G5**：憑證加密 at rest（複用既有 `aes-256-gcm` + `CONFIG_ENCRYPTION_KEY`）。
- **G6**：支援 OpenAI / Gemini / Claude / Grok，且**可擴充**任何 OpenAI-compatible provider（D2 的「等」）。

### 非目標（Out of Scope — 防 scope creep）
- ❌ 不做用量計費 / billing 對帳（另立治理 Epic）。
- ❌ 不做自動 A/B 路由 / 自動 failover。
- ❌ 不改動三層映射 Tier 1/2 邏輯（只換 Tier 3 的 LLM 呼叫底層）。
- ❌ 不引入 LangChain 等重量級 orchestration framework。
- ❌ 不建重量級合規審批 workflow（見 §6 決定）。

---

## 3. 架構設計

### 3.1 關鍵洞察 — OpenAI-compatible 收斂（大幅降低 D2 成本）

多數主流 provider 都提供 **OpenAI-compatible chat completions 端點**，可用**既有** `openai` SDK（改 `baseURL` + `apiKey`）呼叫，**零新依賴**：

| Provider | 接法 | 端點 | 新依賴 |
|----------|------|------|--------|
| Azure OpenAI | `AzureOpenAI`（既有 SDK）或既有 fetch | 私有端點 | 無 |
| OpenAI | `openai` SDK（官方 baseURL） | `api.openai.com/v1` | 無 |
| xAI Grok | `openai` SDK + 自訂 baseURL | `api.x.ai/v1` | 無 |
| Google Gemini | `openai` SDK + compat baseURL | `generativelanguage.googleapis.com/v1beta/openai/` | 無 |
| 其他 OpenAI-compatible（自建 / DeepSeek / Mistral…） | `openai` SDK + 自訂 baseURL | 各自 | 無 |
| **Anthropic Claude** | **`@anthropic-ai/sdk`（Messages API）** | `api.anthropic.com` | **`@anthropic-ai/sdk`（H2）** |

> 結論：**一個 `OpenAICompatibleAdapter`** 覆蓋 Azure/OpenAI/Grok/Gemini/自建；**只有 Anthropic** 因訊息格式（system 為 top-level、content blocks、vision base64 source、structured output 走 tool-use）不同，需專用 `AnthropicAdapter`。這也天然支援 D2 的「等」。

### 3.2 架構圖

```
┌──────────────────────────────────────────────────────────────────┐
│  呼叫方（收斂後統一走這裡）                                        │
│  extraction Stage 1-3 / term-classification / gpt-vision /         │
│  ai-term-validator / gpt-mini-extractor / unified-gpt-extraction   │
└───────────────────────────┬──────────────────────────────────────┘
                            │ LlmChatRequest（provider-agnostic）
                            ▼
              ┌──────────────────────────────┐
              │      LlmGatewayService        │  依配置解析 provider+model
              │  resolve(provider,model) →     │  讀 LlmModelConfigService（CHANGE-099 延伸）
              │  pick adapter → 重試 → 計時     │  憑證解密（aes-256-gcm）
              └───────────────┬──────────────┘
                    ┌─────────┴──────────┐
                    ▼                    ▼
        ┌────────────────────────┐  ┌────────────────────┐
        │ OpenAICompatibleAdapter │  │  AnthropicAdapter   │
        │ (openai SDK, 可配 baseURL)│  │ (@anthropic-ai/sdk) │
        │ Azure/OpenAI/Grok/Gemini │  │  Claude             │
        └───────────┬────────────┘  └─────────┬──────────┘
                    ▼                          ▼
        各 provider 的 chat/completions      Anthropic Messages API
```

### 3.3 統一型別與 Adapter 介面（草案）

```typescript
interface LlmChatRequest {
  systemPrompt: string;
  userPrompt: string;
  imageBase64Array: string[];            // vision 輸入
  imageDetailMode?: 'auto' | 'low' | 'high';
  jsonSchema?: Record<string, unknown>;  // 結構化輸出（能力不足者降級）
  maxTokens: number;
  temperature?: number;                   // 不支援者忽略
}

interface LlmChatResponse {
  success: boolean;
  content: string;
  tokenUsage: { input: number; output: number; total: number };
  model: string;
  providerType: LlmProviderType;
  durationMs: number;
  error?: string;
}

/** Gateway 解析後餵給 adapter 的完整模型描述（含解密後憑證） */
interface ResolvedLlmModel {
  provider: {
    type: LlmProviderType;
    baseUrl?: string;
    apiKey: string;        // 已解密
    apiVersion?: string;   // Azure 專用
  };
  modelKey: string;        // Azure=deployment name；OpenAI/其他=model id
  capability: LlmModelCapability;
}

interface LlmProviderAdapter {
  readonly providerType: LlmProviderType;
  chatCompletion(req: LlmChatRequest, model: ResolvedLlmModel): Promise<LlmChatResponse>;
  testConnection(model: ResolvedLlmModel): Promise<{ ok: boolean; message?: string }>;
}
```

> **能力降級**：`capability`（image detail / json_schema / vision / temperature / maxTokens）由模型設定描述，adapter 內按能力降級（如不支援 json_schema → 退回 json_object），與現行 `gpt-caller` fallback 行為一致。

### 3.4 收斂策略（行為零變遷移）

Story 23.1 讓 `OpenAICompatibleAdapter` 的 Azure 路徑**完整重現現行 `gpt-caller` fetch 行為**（含 `2024-12-01-preview`、`response_format` fallback、重試、逾時）；`GptCallerService.callModel` 內部改呼叫 gateway，**對外簽章不變** → extraction 三階段零感知。其餘 5 處 client 於 Story 23.4 逐一遷移（每次一個、獨立可驗證，附 golden test 比對輸出）。

---

## 4. 資料模型（D1 定案：新 Prisma model）

```prisma
enum LlmProviderType {
  AZURE_OPENAI
  OPENAI
  ANTHROPIC
  GOOGLE_GEMINI
  XAI_GROK
  OPENAI_COMPATIBLE   // 泛用：任何 OpenAI-compatible 端點（自建 / 其他）
}

model LlmProvider {
  id                 String          @id @default(cuid())
  name               String          @unique      // 顯示名稱，如 "OpenAI (Prod)"
  providerType       LlmProviderType
  baseUrl            String?         // Azure/自建必填；OpenAI/Anthropic 可留空用官方預設
  apiVersion         String?         // Azure 專用
  apiKeyEnc          String?         // aes-256-gcm 加密後的 API key
  isEncrypted        Boolean         @default(true)
  isEnabled          Boolean         @default(true)
  isDefault          Boolean         @default(false) // 全域預設 provider（fallback 用）
  allowSensitiveData Boolean         @default(false) // 合規：是否允許處理敏感發票資料（§6）
  extraConfig        Json?           // provider 專屬（Azure resource、region 等）
  models             LlmModel[]
  createdAt          DateTime        @default(now())
  updatedAt          DateTime        @updatedAt
  updatedBy          String?
  @@index([providerType])
  @@index([isEnabled])
}

model LlmModel {
  id             String       @id @default(cuid())
  providerId     String
  provider       LlmProvider  @relation(fields: [providerId], references: [id], onDelete: Cascade)
  modelKey       String       // 呼叫識別（Azure=deployment name；OpenAI=model id）
  label          String       // 顯示名稱
  capability     Json         // { maxTokens, supportsTemperature, temperature?, defaultImageDetail, supportsJsonSchema, supportsVision }
  isEnabled      Boolean      @default(true)
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt
  @@unique([providerId, modelKey])
  @@index([isEnabled])
}
```

- **各環節指派**：延續 CHANGE-099 存 `SystemConfig(AI_MODEL/GLOBAL)`，但 value 改存 **`LlmModel.id`**（唯一決定 provider+model）。
- **Fallback 鏈（向後相容，行為零變）**：指派缺失/無效 → 該環節預設模型 → `isDefault` provider → 硬編 Azure 預設（`gpt-5-nano`/`gpt-5.2`，即 CHANGE-099 現行行為）。
- **憑證加解密**：複用 `system-config.service.ts` 的 `aes-256-gcm` 邏輯（建議抽共用 `src/lib/llm-credential-crypto.ts`），金鑰 `CONFIG_ENCRYPTION_KEY`（fail-closed）。
- **Migration 注意**：Azure DEV 有 schema drift 史 → 部署照既有 gated 流程（VNet 內 `db push` / `FORCE_SCHEMA_RESET`）。
- **資料播種**：migration 後以既有 `AZURE_OPENAI_*` env 建一筆 `isDefault` 的 Azure provider + 2 個既有模型（無痛升級，用戶原設定即刻可用）。

---

## 5. 依賴策略（H2）

| Provider | SDK | 狀態 |
|----------|-----|------|
| Azure OpenAI / OpenAI / xAI Grok / Google Gemini（compat） / 自建 | `openai@^6.15.0` | **既有，無新依賴** |
| Anthropic Claude | `@anthropic-ai/sdk` | **新增（唯一 H2 觸發，Story 23.3 安裝時確認版本）** |
| Google Gemini（native，選用） | `@google/generative-ai` | **暫不引入**；先用 compat 端點，除非 compat 能力不足才評估 |

> 設計刻意讓 H2 面積收斂到**一個套件**。

---

## 6. D4 決定（VNet egress / 資料合規）— AI 定案並記錄

用戶授權由我決定。決定如下：

### C1 — VNet egress
- **視為部署/infra 前置，非 code 阻塞**。App code 對網路拓撲無感（只發 HTTPS 到配置的 provider 端點）。
- Azure OpenAI（私有端點）維持預設可用；啟用**非 Azure** provider 前，infra 須開通 App Service outbound egress。
- 系統對無法連線的 provider **明確報錯**（不靜默失敗）；`testConnection` 提供後台即時驗證。
- DEV 可先開 egress 供測試。此前置寫入 §10 與部署 runbook。

### C3 — 資料合規
- **Azure OpenAI 維持全域預設 baseline**（資料留在既有 Azure tenant = 合規安全）；不主動改變現有資料流。
- `LlmProvider.allowSensitiveData`（預設 `false`）：後台配置**非 Azure** provider 時，UI 顯示明確合規警示，需 globalAdmin 主動勾選確認「知悉發票資料將離開 Azure 邊界」。
- 實際 sign-off 屬**組織/營運層 gate**：在 §10 標為「啟用非 Azure provider 於生產前的前置」，責任浮現給 IT/security，**不建重量級審批 workflow**（避免 over-engineering）。

---

## 7. 各處理環節接入（收斂範圍）

| 環節 | 檔案 | 遷移 Story |
|------|------|-----------|
| extraction Stage 1-3 | `gpt-caller.service.ts`（→ gateway，簽章不變） | 23.1 |
| Vision OCR / 文件分類 | `gpt-vision.service.ts` | 23.4 |
| 術語分類（Tier 3） | `term-classification.service.ts` | 23.4 |
| AI 術語驗證 | `ai-term-validator.service.ts` | 23.4 |
| V2 輕量提取 | `extraction-v2/gpt-mini-extractor.service.ts` | 23.4 |
| V3 單次提取 | `unified-gpt-extraction.service.ts` | 23.4 |
| 測試/比較 API route（2 處） | `prompt-configs/test`、`test/extraction-compare` | 23.4（低優先，可選） |

---

## 8. API 設計（Story 23.2）

| 端點 | 方法 | 權限 | 用途 |
|------|------|------|------|
| `/api/v1/llm-providers` | GET | 登入 | 列出 provider（**憑證 masked**） |
| `/api/v1/llm-providers` | POST | globalAdmin | 新增 provider（憑證加密存） |
| `/api/v1/llm-providers/[id]` | PATCH / DELETE | globalAdmin | 更新 / 刪除 |
| `/api/v1/llm-providers/[id]/test` | POST | globalAdmin | 連線測試（`testConnection`） |
| `/api/v1/llm-providers/[id]/models` | GET/POST | 登入 / globalAdmin | 管理該 provider 模型清單 |
| `/api/v1/model-configs`（既有，CHANGE-099） | GET/PUT | 登入 / globalAdmin | 各環節 provider+model 指派（value 改存 `LlmModel.id`） |

- 全採 Zod 驗證 + RFC 7807 top-level 錯誤格式。
- 憑證**永不回傳明文**（讀取一律 mask，比照 `maskSensitiveValue`）。
- `OPENAI_COMPATIBLE` / 自訂 `baseUrl` 僅 globalAdmin 可設（防 SSRF）。

---

## 9. UI 設計（Story 23.2）

- 新後台頁 `admin/llm-providers`：Provider 列表（類型/endpoint/啟用/預設/連線測試）+ 新增/編輯對話框（憑證遮罩輸入，比照 `ConfigEditDialog`；非 Azure 顯示 §6 合規警示勾選）。
- 既有 `admin/model-settings`（CHANGE-099）擴充：各環節模型下拉來源從「全域白名單」改為「已啟用 provider 的已啟用模型」。
- 三語言 i18n（en/zh-TW/zh-CN），新 namespace `llmProviders` 需註冊 `src/i18n/request.ts`。

---

## 10. 安全與合規

| 風險 | 緩解 |
|------|------|
| Provider API key 外洩 | `aes-256-gcm` 加密存 DB（`CONFIG_ENCRYPTION_KEY`, fail-closed）；API mask；不 log 憑證 |
| 明文憑證進 log / commit | H4 紀律；grep gate；`isEncrypted` 旗標 |
| 敏感發票資料送外部 provider | Azure 為預設 baseline；`allowSensitiveData` 旗標 + UI 確認；**生產啟用非 Azure provider 前需 IT/security sign-off（組織層前置）** |
| SSRF（惡意 endpoint） | 自訂 `baseUrl` 僅 globalAdmin；可加 endpoint 白名單 |
| VNet egress 未開 → 非 Azure provider 不可用 | 部署前置（§6 C1）；`testConnection` 即時驗證；明確報錯 |

---

## 11. 實作 Story 拆分（已承諾序列，非 Phase 閘門）

> D3 定案：不做「僅 Azure」的閘門式 Phase 1；以下為 build order，全部承諾交付。

| Story | 範圍 | 觸發約束 | 依賴 |
|-------|------|----------|------|
| **23.1 抽象層 + 資料模型 + Gateway** | `LlmProvider`/`LlmModel` Prisma model + migration + `LlmProviderAdapter` 介面 + `LlmGatewayService` + `OpenAICompatibleAdapter`（Azure 路徑重現現行行為）+ extraction 三階段接 gateway（簽章不變）+ Azure provider 播種 | H1 | 無 |
| **23.2 憑證管理 + Provider 管理 API + UI** | 憑證加解密（複用 aes-256-gcm）+ `/api/v1/llm-providers` CRUD/test + `admin/llm-providers` 頁 + `model-settings` 擴充 + i18n | H1+H4 | 23.1 |
| **23.3 Anthropic adapter + 多 provider 能力** | `@anthropic-ai/sdk`（H2）+ `AnthropicAdapter`（Messages API / vision / tool-use 結構化輸出）+ OpenAI/Grok/Gemini 端點驗證 + 各 provider capability 對應 | H1+H2 | 23.1 |
| **23.4 全面遷移 + 各環節指派 + 測試/觀測** | 其餘 5 處 client 遷 gateway（golden test 比對）+ 各環節 provider+model 指派 UI + token/成本觀測 hook + 完整測試 | H1 | 23.1–23.3 |

---

## 12. 測試策略

- **Unit**：各 adapter 的 request 轉換 / 回應解析 / 能力降級；`LlmGatewayService` 的 provider+model 解析與 fallback 鏈；憑證加解密 round-trip。
- **Integration**：gateway → adapter → mock provider 端到端；provider CRUD + test API。
- **E2E（Playwright）**：`admin/llm-providers` CRUD + 連線測試 + `model-settings` 指派 + 合規警示勾選。
- **回歸（關鍵）**：每次遷移後，該環節輸出需與遷移前**逐位元一致**（golden test）；extraction 三階段為最高優先。

---

## 13. 風險與技術債務

| 項目 | 說明 |
|------|------|
| 技術債（無 Key Vault） | 憑證靠 app 層 `aes-256-gcm` + env 主金鑰（SP 僅 Contributor）；主金鑰輪替需人工流程 |
| Schema drift | 方案 B migration 需照 Azure DEV 既有 gated 流程 |
| Vendor 能力落差 | 各 provider vision / json_schema / tool-use 支援不一；降級邏輯需逐一驗證 |
| 遷移風險 | 7 處呼叫點逐一遷移，golden test 防行為漂移 |
| 合規 sign-off 未落實即啟用非 Azure | 組織層前置；UI 警示 + `allowSensitiveData` 為技術護欄，非替代 sign-off |

---

## 版本資訊

- **建立日期**：2026-07-09
- **版本**：0.2.0（D1–D4 決策已定，實作規格草案）
- **狀態**：🟢 決策已定；待排入 sprint 進實作；**未寫入 `sprint-status.yaml`**
- **依據**：用戶 2026-07-09 需求 + D1–D4 定案 + 現況盤點（附實測檔案位置）
- **格式依據**：`docs/04-implementation/tech-specs/epic-22-enterprise-security/tech-spec-story-22-1.md`
- **變更**：v0.1.0 → v0.2.0：D1–D4 open questions 全數 resolved；架構改為 OpenAI-compatible + Anthropic 雙 adapter（H2 收斂至單一套件）；資料模型定案為 Prisma model；移除 Phase 閘門改 Story 序列；新增 §6 D4 決定。
