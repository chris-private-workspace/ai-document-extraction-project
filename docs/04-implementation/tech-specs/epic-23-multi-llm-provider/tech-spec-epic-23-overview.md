# Tech Spec 提案: Epic 23 - 多 LLM Provider 整合管理系統

> **Version**: 0.1.0（提案草案）
> **Created**: 2026-07-09
> **Status**: 🟡 Draft — 提案，待用戶審批（**尚未寫入 `sprint-status.yaml`**）
> **Epic Key**: EPIC-23（暫定編號，sprint-status 目前追蹤到 21、tech-specs 到 22）
> **前置**: CHANGE-099（LLM 模型選擇管理，已完成）

---

## ⚠️ Hard Constraint 觸發聲明（本提案僅為規劃，尚未動 code）

本提案若獲批實作，將觸發下列 Strict Mode Hard Constraints，**必須逐項取得用戶 explicit approval 後才可進入實作**：

| 約束 | 觸發點 | 需 approve 的階段 |
|------|--------|------------------|
| **H1 架構變更** | 引入 Provider 抽象層，改動三層映射 Tier 3（`term-classification`）與 extraction 管線的 LLM 呼叫核心；新增 Prisma model（方案 B） | Phase 1 起 |
| **H2 依賴/Vendor** | 引入 Azure OpenAI 以外的 LLM vendor + 對應 npm SDK（`@anthropic-ai/sdk`、`@google/generative-ai` 等） | Phase 2 起 |
| **H4 安全/隱私** | 儲存各 provider 的 API key（憑證加密）；freight invoice 資料送往外部 provider 的合規面 | Phase 2 起 |

> 本文件本身是「規劃文件」，撰寫它不違反上述約束；但**任何一行實作 code 之前**，對應 Phase 必須先取得批准。

---

## Overview

| 項目 | 內容 |
|------|------|
| **Epic ID** | 23（暫定） |
| **Epic 名稱** | Multi-LLM Provider Integration & Governance（多 LLM Provider 整合與治理） |
| **預估規模** | 大型 / 跨多 Sprint（Phase 1 約 5-8 天；完整三 Phase 約 3-5 週，視 provider 數量） |
| **前置依賴** | CHANGE-099（已完成，提供白名單 + Stage 模型選擇雛形） |
| **本質** | 把目前**硬綁 Azure OpenAI、散落 7 處**的 LLM 呼叫，收斂為統一 **Provider 抽象層**，並讓用戶可在後台配置多家 LLM service provider 與其模型 |

---

## 1. 需求背景與動機

### 1.1 用戶提出的需求

> 現在的 model settings（CHANGE-099）只能在 **2 個 Azure OpenAI 模型**（`gpt-5-nano` / `gpt-5.2`）之間選。希望建立一套更有系統的機制，**管理不同 LLM service provider 的整合設定**，讓用戶自行配置、決定使用哪些 provider 的模型，而不是只有 2 個選擇。

### 1.2 現況痛點（實測盤點，附檔案位置）

1. **LLM 呼叫完全綁死 Azure OpenAI**：白名單 `src/lib/constants/llm-models.ts` 以 `deploymentEnvVar` 為核心，**無 provider 維度、無 endpoint/apiKey 概念**。
2. **Client 初始化重複散落 7 處**（無統一抽象層）：
   - 5 處各自 `new AzureOpenAI(...)`：`gpt-vision.service.ts:710`、`term-classification.service.ts:170`、`ai-term-validator.service.ts:248`、`extraction-v2/gpt-mini-extractor.service.ts:159`、`api/v1/prompt-configs/test/route.ts:467`（另 `api/test/extraction-compare/route.ts:252`）。
   - 2 條獨立 `fetch` 路徑：`extraction-v3/stages/gpt-caller.service.ts`、`extraction-v3/unified-gpt-extraction.service.ts`。
3. **設定不一致**：`gpt-caller` 的 `API_VERSION` 硬編 `'2024-12-01-preview'`；其他 service 讀 `AZURE_OPENAI_API_VERSION`，預設值還分歧（`2025-03-01-preview` / `2024-12-01-preview` / `2024-02-15-preview`）；`ai-term-validator` 甚至用獨立命名 `AZURE_OPENAI_DEPLOYMENT`（非 `_DEPLOYMENT_NAME`）。
4. **CHANGE-099 只解決了「選哪個模型」，沒解決「選哪家 provider」**：`LlmModelConfigService` 存的是 stage→model key，仍假設 Azure。

### 1.3 為何值得做

- 避免單一 vendor 鎖定（成本 / 可用性 / 模型能力上的彈性）。
- 收斂 7 處重複 client → 單一抽象層，本身就是巨大的可維護性改善（即使永遠只用 Azure）。
- 為未來新模型 / 新供應商提供「加設定、不改 code」的擴充點。

---

## 2. 目標與非目標

### 2.1 目標（In Scope）

- **G1**：建立統一的 `LlmProviderAdapter` 抽象層，把「組 wire request / 認證 / 回應解析」封裝在各 provider adapter 內。
- **G2**：把散落 7 處的 LLM 呼叫收斂到抽象層之上（漸進，先 extraction 管線，再其他 service）。
- **G3**：後台可管理「Provider（類型 + endpoint + 憑證）」與「該 provider 下可用的模型（+ 能力）」。
- **G4**：各處理環節（extraction Stage 1-3、term-classification、gpt-vision…）可指定「用哪個 provider 的哪個模型」。
- **G5**：憑證安全儲存（加密 at rest），沿用既有 `aes-256-gcm` + `CONFIG_ENCRYPTION_KEY` pattern。

### 2.2 非目標（Out of Scope — 明確排除以防 scope creep）

- ❌ 不做每 provider 的用量計費 / billing 對帳（可另立治理 Epic）。
- ❌ 不做 A/B 模型自動路由 / 自動 failover（Phase 3 之後再議）。
- ❌ 不改動三層映射 Tier 1/2 的邏輯（只換 Tier 3 的 LLM 呼叫底層）。
- ❌ 不引入 LangChain 之類的大型 orchestration framework（避免 H2 重量級依賴）。

---

## 3. 關鍵約束（實作前必須先解決的前提）🔴

這三項不是純技術問題，會直接決定可行性，**建議在 Phase 2 開工前由用戶 / IT 拍板**：

| # | 約束 | 說明 | 影響 |
|---|------|------|------|
| C1 | **Azure VNet 網路egress** | DEV/生產是 VNet 私有端點鎖定的 App Service，目前所有 AI 呼叫走 Azure OpenAI 內部。呼叫公網的 OpenAI/Anthropic/Google API 需開放 outbound 路由 | 非 app code 可解決，需 infra 配置 |
| C2 | **憑證加密 vs SP 權限** | Provider API key 須加密儲存。理想用 Azure Key Vault，但既有記錄顯示部署 SP 僅 Contributor、**不能用 Key Vault / Managed Identity** | 只能用 app 層 `aes-256-gcm` + env 主金鑰（`CONFIG_ENCRYPTION_KEY`），需接受此技術債 |
| C3 | **資料落地 / 合規** | Freight invoice 可能含 PII / 商業敏感資料。送往**不同**供應商有資料落地與合規問題 | 需 IT / security 正式 sign-off，屬業務決定非技術決定 |

---

## 4. 架構設計

### 4.1 核心抽象：`LlmProviderAdapter`

```
┌──────────────────────────────────────────────────────────────────┐
│  呼叫方（收斂後統一走這裡）                                        │
│  extraction Stage 1-3 / term-classification / gpt-vision / ...     │
└───────────────────────────┬──────────────────────────────────────┘
                            │ LlmChatRequest（provider-agnostic）
                            ▼
              ┌──────────────────────────────┐
              │      LlmGatewayService        │  ← 依配置選 provider+model
              │  (resolve provider & model,   │     讀 LlmModelConfigService
              │   pick adapter, 重試, 計時)    │
              └───────────────┬──────────────┘
                              │ 分派到對應 adapter
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│ AzureOpenAI    │  │ OpenAI         │  │ Anthropic      │
│ Adapter        │  │ Adapter        │  │ Adapter        │  … 可擴充
│ (Phase 1:      │  │ (Phase 2)      │  │ (Phase 2/3)    │
│  包現有 fetch)  │  │                │  │                │
└───────┬────────┘  └───────┬────────┘  └───────┬────────┘
        │ Azure REST         │ openai SDK        │ @anthropic-ai/sdk
        ▼                    ▼                   ▼
   Azure OpenAI          OpenAI API          Anthropic API
```

### 4.2 統一請求 / 回應型別（草案）

```typescript
// provider-agnostic 請求（各 adapter 負責轉成自家 wire format）
interface LlmChatRequest {
  systemPrompt: string;
  userPrompt: string;
  imageBase64Array: string[];          // vision 輸入
  imageDetailMode?: 'auto' | 'low' | 'high';
  jsonSchema?: Record<string, unknown>; // 結構化輸出（能力不足者降級）
  maxTokens: number;
  temperature?: number;                 // 不支援者忽略
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

interface LlmProviderAdapter {
  readonly providerType: LlmProviderType;   // AZURE_OPENAI | OPENAI | ANTHROPIC | ...
  chatCompletion(req: LlmChatRequest, model: LlmModelDescriptor): Promise<LlmChatResponse>;
  testConnection(model: LlmModelDescriptor): Promise<{ ok: boolean; message?: string }>;
}
```

> **關鍵設計取捨**：能力差異（image detail / json_schema / tool use / token 上限 / temperature）由 `LlmModelDescriptor.capability` 描述，adapter 內按能力**降級**（如不支援 json_schema → 退回 json_object），與現在 `gpt-caller` 的 fallback 行為一致。

### 4.3 收斂策略（降低風險的關鍵）

Phase 1 先讓 `AzureOpenAIAdapter` **完整包住現有 `gpt-caller` 的 fetch 邏輯**（含 `2024-12-01-preview`、`response_format` fallback、重試），行為**逐位元不變**；`GptCallerService.callModel` 內部改呼叫 gateway，對外簽章不變 → extraction 三階段零感知。其餘 5 處 SDK client 之後逐一遷移（每次一個，獨立可驗證）。

---

## 5. 資料模型（兩方案對比 — 需用戶決策 D1）

### 方案 A：延續 CHANGE-099，純 `SystemConfig`（key-value + JSON）

- provider 清單 / 模型清單 / 憑證都塞進 `SystemConfig` 的 value（JSON）。
- ✅ 免 migration、避開 Azure schema drift；憑證直接用 `isEncrypted`。
- ❌ provider→model 是天然一對多關聯，硬塞 JSON 難查詢、難做 UI 列表、難加 index、難做外鍵完整性。多 provider 後會很痛。

### 方案 B：新增 Prisma models（**推薦**，但觸發 H1）

```prisma
enum LlmProviderType {
  AZURE_OPENAI
  OPENAI
  ANTHROPIC
  GOOGLE_GENAI
  CUSTOM_OPENAI_COMPATIBLE
}

model LlmProvider {
  id            String          @id @default(cuid())
  name          String          // 顯示名稱，如 "Azure OpenAI (Prod)"
  providerType  LlmProviderType
  endpoint      String?         // Azure 需要；OpenAI/Anthropic 可選（預設官方）
  apiVersion    String?         // Azure 專用
  apiKeyEnc     String?         // aes-256-gcm 加密後的 API key（複用 CONFIG_ENCRYPTION_KEY）
  isEncrypted   Boolean         @default(true)
  isEnabled     Boolean         @default(true)
  extraConfig   Json?           // provider 專屬設定（如 Azure resource、region）
  models        LlmModel[]
  createdAt     DateTime        @default(now())
  updatedAt     DateTime        @updatedAt
  updatedBy     String?
  @@index([providerType])
  @@index([isEnabled])
}

model LlmModel {
  id             String       @id @default(cuid())
  providerId     String
  provider       LlmProvider  @relation(fields: [providerId], references: [id], onDelete: Cascade)
  modelKey       String       // 呼叫用識別（Azure=deployment name；OpenAI=model id）
  label          String       // 顯示名稱
  capability     Json         // { maxTokens, supportsTemperature, temperature?, defaultImageDetail, supportsJsonSchema, supportsVision }
  isEnabled      Boolean      @default(true)
  @@unique([providerId, modelKey])
  @@index([isEnabled])
}
```

- 「各環節用哪個 provider+model」：延續 CHANGE-099，仍存 `SystemConfig(AI_MODEL/GLOBAL)`，但 value 改存 `LlmModel.id`（而非裸 model key），fallback 規則不變。
- 憑證加解密：**複用** `system-config.service.ts` 的 `aes-256-gcm` 邏輯（建議抽出共用 `src/lib/llm-credential-crypto.ts` 或直接沿用 `src/lib/encryption.ts`），金鑰 `CONFIG_ENCRYPTION_KEY`（fail-closed）。

> **Migration 注意**：方案 B 需 `prisma migrate`。Azure DEV 有 schema drift 史（見 memory），部署時比照既有做法（VNet 內 `db push` / gated reset）。這也是 D1 需拍板的原因之一。

---

## 6. 分階段 Roadmap（建議漸進落地）

| Phase | 範圍 | 觸發約束 | 風險 | 可獨立交付價值 |
|-------|------|----------|------|----------------|
| **Phase 1 — 抽象層收斂（仍只 Azure）** | 建 `LlmProviderAdapter` + `AzureOpenAIAdapter`（包現有 fetch）+ `LlmGatewayService`；extraction 三階段改走 gateway；統一 API version / env 讀取 | H1 | **低**（行為不變，純內部重構 + 收斂） | 消除 7 處重複、統一設定、為多 provider 鋪路 |
| **Phase 2 — Provider 資料模型 + 憑證管理 + 第 2 家 provider** | 方案 B 的 Prisma models + 加密憑證 + `OpenAIAdapter`（或 Anthropic）+ 後台 Provider 管理頁；先解 C1/C2/C3 | H1+H2+H4 | **中高**（vendor / 網路 / 合規） | 真正「多 provider 可選」 |
| **Phase 3 — 全面遷移 + 治理** | 其餘 5 處 SDK client 全遷到 gateway；連線測試 / 健康檢查 / 用量與成本觀測；每環節 provider+model 指派 UI | H1 | 中 | 全站統一治理、可觀測 |

> **強烈建議**：**先只做 Phase 1**。它風險最低、行為零變、且不需要動 vendor / 網路 / 合規（不觸發 H2/H4），做完就已大幅改善可維護性；之後再視業務是否真的要接第二家 provider 決定 Phase 2。

---

## 7. API 設計草案（Phase 2）

| 端點 | 方法 | 權限 | 用途 |
|------|------|------|------|
| `/api/v1/llm-providers` | GET | 登入 | 列出 provider（**憑證 masked**） |
| `/api/v1/llm-providers` | POST | globalAdmin | 新增 provider（憑證加密存） |
| `/api/v1/llm-providers/[id]` | PATCH / DELETE | globalAdmin | 更新 / 刪除 |
| `/api/v1/llm-providers/[id]/test` | POST | globalAdmin | 連線測試（`testConnection`） |
| `/api/v1/llm-providers/[id]/models` | GET/POST | 登入 / globalAdmin | 管理該 provider 的模型清單 |
| `/api/v1/model-configs`（既有，CHANGE-099） | GET/PUT | 登入 / globalAdmin | 各環節 provider+model 指派（value 改存 `LlmModel.id`） |

- 全部採 Zod 驗證 + RFC 7807 top-level 錯誤格式（新 API 慣例）。
- 憑證**永不回傳明文**（讀取一律 mask，比照 `maskSensitiveValue`）。

---

## 8. UI 草案（Phase 2/3）

- 新後台頁 `admin/llm-providers`：Provider 列表（類型 / endpoint / 啟用狀態 / 連線測試按鈕）+ 新增/編輯對話框（憑證欄位遮罩輸入，比照 `ConfigEditDialog`）。
- 既有 `admin/model-settings`（CHANGE-099）擴充：Stage 下拉來源從「全域白名單」改為「已啟用 provider 的已啟用模型」。
- 三語言 i18n（en/zh-TW/zh-CN），新 namespace（如 `llmProviders`）需註冊 `src/i18n/request.ts`。

---

## 9. 安全考量

| 風險 | 緩解 |
|------|------|
| Provider API key 外洩 | `aes-256-gcm` 加密存 DB（`CONFIG_ENCRYPTION_KEY`, fail-closed）；API 回傳 mask；不 log 憑證 |
| 明文憑證進 log / commit | 沿用 H4 紀律；grep gate；`isEncrypted` 旗標 |
| 敏感發票資料送外部 provider | C3 合規 sign-off；可加 provider 層級「允許處理敏感資料」開關 |
| 惡意 endpoint（SSRF） | `CUSTOM_OPENAI_COMPATIBLE` 需 endpoint 白名單 / 僅 globalAdmin 可設 |

---

## 10. 待用戶決策問題清單（Open Questions）

| # | 問題 | 選項 | 建議 |
|---|------|------|------|
| **D1** | 資料模型走方案 A（config）還是 B（Prisma models）？ | A 免 migration / B 結構清晰 | **B**（provider→model 是關聯實體），接受 migration 成本 |
| **D2** | 第一個要接的非 Azure provider 是哪家？ | OpenAI 直連 / Anthropic / Google / 自建 OpenAI-compatible | 依業務；OpenAI 直連改動最小（可複用 `openai` SDK） |
| **D3** | 是否先只做 Phase 1（低風險收斂），暫緩 Phase 2？ | 是 / 否 | **是**（先拿可維護性紅利，vendor/合規之後再議） |
| **D4** | C1（VNet egress）/ C3（合規）誰負責拍板？ | IT / security | 需在 Phase 2 前確認 |

---

## 11. 測試策略概要

- **Unit**：各 adapter 的 request 轉換 / 回應解析 / 能力降級；`LlmGatewayService` 的 provider+model 解析與 fallback。
- **Integration**：gateway → adapter → mock provider 的端到端；憑證加解密 round-trip。
- **E2E（Playwright）**：Provider 管理頁 CRUD + 連線測試 + model-settings 指派。
- **回歸**：Phase 1 完成後，extraction 三階段輸出需與遷移前**逐位元一致**（golden test）。

---

## 12. 風險與技術債務

| 項目 | 說明 |
|------|------|
| 技術債（C2） | 無 Key Vault，憑證靠 app 層加密 + env 主金鑰，主金鑰輪替需人工流程 |
| Schema drift（方案 B） | Azure DEV 有前科，migration 需照既有 gated 流程 |
| Vendor 能力落差 | 各 provider 的 vision / json_schema / tool use 支援不一，降級邏輯需逐一驗證 |
| 遷移風險 | 5 處 SDK client 遷移需逐一回歸，避免行為漂移 |

---

## 版本資訊

- **建立日期**：2026-07-09
- **版本**：0.1.0（提案草案）
- **狀態**：🟡 Draft，待用戶審批；**未寫入 `sprint-status.yaml`**
- **依據**：用戶 2026-07-09 需求 + 現況盤點（Explore agent，附實測檔案位置）
- **格式依據**：`docs/04-implementation/tech-specs/epic-22-enterprise-security/tech-spec-story-22-1.md`
