# Tech Spec: Epic 23 - 多 LLM Provider 整合管理系統

> **Version**: 0.3.0（Vercel AI SDK 架構 + D1–D6 定案 + v0.2.0 審視修正）
> **Created**: 2026-07-09 ｜ **Updated**: 2026-07-09
> **Status**: 🟢 決策已定（D1–D6）；待建 worktree 進實作（**尚未寫入 `sprint-status.yaml`**）
> **Epic Key**: EPIC-23（暫定）
> **前置**: CHANGE-099（已完成）
> **配套審視**: `design-review-v0.2.0.md`（本版據其 A1/A2/B/C 全數修正）

---

## 決策記錄（D1–D6）

| # | 問題 | 定案 |
|---|------|------|
| **D1** | 資料模型 | 新增 Prisma model（`LlmProvider` + `LlmModel`） |
| **D2** | 支援哪些 provider | OpenAI / Google Gemini / Anthropic Claude / xAI Grok **等**（可擴充） |
| **D3** | 是否先只做 Phase 1 | 否 — 直接做完整、用戶可自行配置的多 provider 系統 |
| **D4** | VNet egress / 資料合規 | AI 定案（見 §7）：egress = infra 前置；Azure 為預設合規基準 + `allowSensitiveData` 護欄 + 組織 sign-off |
| **D5** | 自建 adapter vs Vercel AI SDK | **Vercel AI SDK**（`ai` + `@ai-sdk/*`）— 審視 A1 證實自建對 Anthropic/Gemini 有破口 |
| **D6** | Prompt 相容性 / 準確率 | 低風險環節先開放他家；核心提取（Stage 3）切非 Azure 前需準確率回歸通過 |

---

## ⚠️ Hard Constraint 觸發聲明（實作前逐項 approve）

| 約束 | 觸發點 | approve 狀態 |
|------|--------|-------------|
| **H1 架構變更** | 新增 Prisma model；引入 `LlmGatewayService` 抽象層，改動 extraction 管線與 Tier 3 的 LLM 呼叫底層 | 方向已 approve（D1/D3）；Story 開工前逐一確認 |
| **H2 依賴/Vendor** | 新增 `ai` + `@ai-sdk/{azure,openai,anthropic,google,xai}`（取代自建 adapter；不再需要裸 `@anthropic-ai/sdk`） | **方向已 approve（D5，用戶接受多套件）**；安裝時確認具體版本 |
| **H4 安全/隱私** | 儲存各 provider API key（加密）；非 Azure provider 的發票資料落地合規 | Story 23.2 起 |

---

## Overview

| 項目 | 內容 |
|------|------|
| **Epic 名稱** | Multi-LLM Provider Integration & Governance |
| **預估規模** | 大型 / 跨多 Sprint（4 Story，約 3-4 週） |
| **前置** | CHANGE-099（白名單 + Stage 模型選擇雛形） |
| **本質** | 把硬綁 Azure OpenAI、散落 7 處的 LLM 呼叫，經 **Vercel AI SDK** 收斂為統一 gateway，並讓用戶後台自行配置多家 provider 與模型 |

---

## 1. 需求背景

CHANGE-099 只能在 2 個 Azure OpenAI 模型間選。用戶要求系統化管理不同 LLM provider，讓用戶自行配置、決定用哪家的模型。

**現況痛點**（實測）：LLM 呼叫**完全綁 Azure**；client 初始化**散落 7 處**（5× `new AzureOpenAI` + 2× fetch）；api-version **6 種**不一致；`term-classification`/`ai-term-validator` 甚至用獨立 env 命名。詳見 `design-review-v0.2.0.md` §B。

---

## 2. 目標與非目標

**目標**：G1 統一 `LlmGatewayService`（基於 AI SDK）｜G2 收斂 7 處呼叫｜G3 後台用戶自配置 Provider+模型｜G4 各環節指定 provider+model｜G5 憑證加密｜G6 支援 OpenAI/Gemini/Claude/Grok 且可擴充。

**非目標**：不做 billing 對帳｜不做自動 A/B 路由 / failover｜不改三層映射 Tier 1/2｜不引入 LangChain｜不建重量級合規審批 workflow。

---

## 3. 架構設計（Vercel AI SDK）

### 3.1 為何 Vercel AI SDK（審視 A1 結論）

WebSearch 官方文件查證推翻了 v0.2.0「一個 OpenAI-compat adapter 打天下」的假設：
- **Anthropic**：compat 端點 `response_format` 與 tool `strict` 被 Ignored，structured output **必須 native SDK**。
- **Gemini**：compat 層 beta，只支援 JSON schema **子集**。
- 自建路線實際會退化成「openai-compat 主線 + Anthropic native 分支 + Gemini 降級」三叉。

**Vercel AI SDK** 正好把這些 per-provider 差異封裝（對 Anthropic 自動用 tool-mode 達成 `generateObject`），原生支援 Azure。代價：新增 `ai` + `@ai-sdk/*`（H2，已 approve）+ 呼叫層遷到 `generateText`/`generateObject` + 抽象 lock-in。（LiteLLM/LangChain 已評估否決，見審視 A1。）

### 3.2 架構圖

```
呼叫方（收斂後統一走這裡）
 extraction Stage 1-3 / term-classification / gpt-vision /
 ai-term-validator / gpt-mini-extractor / unified-gpt-extraction
        │  LlmCallInput（provider-agnostic）
        ▼
┌───────────────────────────────────────────────┐
│              LlmGatewayService                 │
│  1. resolve(modelId) → provider+model+capability│  ← 讀 LlmModelConfigService（延伸 CHANGE-099）
│  2. 解密憑證（aes-256-gcm）                      │
│  3. buildModel() → AI SDK LanguageModel         │
│  4. generateText / generateObject               │
│  5. capability gate（temperature 等）+ 降級      │
│  6. 統一回應 + usage + 錯誤（不吞呼叫端 fallback）│
└───────────────────┬───────────────────────────┘
                    ▼  Vercel AI SDK
   @ai-sdk/azure · openai · anthropic · google · xai
                    ▼
   Azure OpenAI · OpenAI · Claude · Gemini · Grok
```

### 3.3 `LlmGatewayService` — provider 由 AI SDK 建立

```typescript
import { generateText, generateObject, jsonSchema } from 'ai';
import { createAzure } from '@ai-sdk/azure';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createXai } from '@ai-sdk/xai';

/** 依 provider config（含解密憑證）建 AI SDK model instance */
function buildModel(p: ResolvedProvider, modelKey: string) {
  switch (p.type) {
    case 'AZURE_OPENAI':
      return createAzure({ baseURL: p.baseUrl, apiKey: p.apiKey, apiVersion: p.apiVersion })(modelKey);
    case 'OPENAI':
      return createOpenAI({ baseURL: p.baseUrl, apiKey: p.apiKey })(modelKey);
    case 'ANTHROPIC':
      return createAnthropic({ apiKey: p.apiKey })(modelKey);
    case 'GOOGLE_GEMINI':
      return createGoogleGenerativeAI({ apiKey: p.apiKey })(modelKey);
    case 'XAI_GROK':
      return createXai({ apiKey: p.apiKey })(modelKey);
    case 'OPENAI_COMPATIBLE':
      return createOpenAI({ baseURL: p.baseUrl, apiKey: p.apiKey })(modelKey); // 自建/其他
  }
}
```

### 3.4 統一呼叫介面（重設計，補審視 G1–G10）

```typescript
interface LlmCallInput {
  modelId: string;                     // G1: LlmModel.id → gateway 解析 provider+model+capability
  messages: LlmMessage[];              // G7: 保真訊息（system/user/assistant，多段）
  images?: LlmImagePart[];             // G2: optional（純文字呼叫不傳，空值不視為錯）
  output?:                             // G3/G10: 三態
    | { mode: 'text' }                 //   純文字（#2/#5/#7 無 response_format）
    | { mode: 'json' }                 //   期待 JSON 但無 strict schema（#3/#4/#6，呼叫端自 parse）
    | { mode: 'object'; jsonSchema: Record<string, unknown>; name?: string }; // structured（#1 帶 schema）
  maxOutputTokens?: number;            // G6: gateway 依 provider 映射 max_tokens/max_completion_tokens（AI SDK 已抽象）
  temperature?: number;                // G5: gateway 依 capability gate（不支援則丟棄，不報錯）
  providerOptions?: Record<string, Record<string, unknown>>; // G4: 如 { openai: { reasoningEffort: 'low' } }
  abortTimeoutMs?: number;             // G9: 呼叫端可指定逾時
}

interface LlmCallResult {
  success: boolean;
  text: string;                        // 原始 content（gateway 不代 parse，保留呼叫端容錯）
  object?: unknown;                    // mode:'object' 成功時（AI SDK 已 parse）
  usage: { input: number; output: number; total: number };
  modelId: string; providerType: LlmProviderType; finishReason?: string; durationMs: number;
  error?: string;
}
```

> 對照審視缺口：G1 model✓｜G2 image optional✓｜G3/G10 三態 output✓｜G4 providerOptions✓｜G5 capability gate✓｜G6/G8 由 provider 設定 + AI SDK 抽象✓｜G7 messages 保真✓｜G9 timeout + 業務 fallback 留呼叫端✓。

### 3.5 訊息結構保真（G7）

`LlmMessage` 支援 `role: 'system' | 'user' | 'assistant'` + content parts。忠實對應現況三種擺法：
- **system+user**（#1/#4/#6）：傳兩則。
- **單一 user、無 system**（#2/#7a，刻意）：只傳一則 user，**不自動補 system**。
- **reasoning 模型的 developer role**（#5）：由 AI SDK 的 `@ai-sdk/openai` 對 reasoning 模型自動處理 system→developer；必要時經 `providerOptions` 明示。

### 3.6 結構化輸出策略（G3/G10）

| output.mode | 實作 | 對應現況 |
|-------------|------|----------|
| `text` | `generateText` | #2/#5/#7（無 response_format） |
| `json` | `generateText`（provider 支援時設 JSON response）；**呼叫端保留既有容錯解析** | #3/#4/#6（json_object） |
| `object` | `generateObject({ schema: jsonSchema(raw) })`；AI SDK 對 Anthropic 自動 tool-mode | #1（json_schema strict） |

**降級（G10）**：`generateObject` 失敗（如 Gemini schema 子集不支援）→ gateway 退回 `generateText` + 指示 JSON，呼叫端自 parse（保留 #1 現行 json_schema→json_object 回退精神）。

### 3.7 韌性與業務 fallback 保留（G9）

- gateway 提供**技術層** retry（預設 2 + 遞增 delay，呼叫端可覆蓋）+ `abortTimeoutMs`。
- **業務層 fallback 留在呼叫端**：如 `ai-term-validator` 失敗時退回 rule-based 判斷（`ai-term-validator.service.ts:406-468`）—— gateway 只回 `success:false`，**不吞掉**呼叫端的業務降級。

### 3.8 遷移策略（審視 C1 修正）

- **不要求 LLM 回應逐位元一致**（LLM 非確定性）。改以**請求組裝快照比對**：對每個呼叫點，快照 gateway 產生的 AI SDK 呼叫參數（model / messages / options），確保遷移**送出的內容**與遷移前等價。
- 核心提取（Stage 3）另做**準確率回歸**（見 §6/§13）。
- 每次遷移一個呼叫點、獨立驗證。

---

## 4. 資料模型（Prisma，含審視 C2/C3 修正）

```prisma
enum LlmProviderType {
  AZURE_OPENAI  OPENAI  ANTHROPIC  GOOGLE_GEMINI  XAI_GROK  OPENAI_COMPATIBLE
}

model LlmProvider {
  id                 String          @id @default(cuid())
  name               String          @unique
  providerType       LlmProviderType
  baseUrl            String?
  apiVersion         String?         // Azure 專用
  apiKeyEnc          String?         // aes-256-gcm 加密
  isEncrypted        Boolean         @default(true)
  isEnabled          Boolean         @default(true)
  isDefault          Boolean         @default(false) // 全域預設（fallback）；唯一性見下
  allowSensitiveData Boolean         @default(false) // §7 合規護欄
  extraConfig        Json?
  models             LlmModel[]
  createdAt DateTime @default(now())  updatedAt DateTime @updatedAt  updatedBy String?
  @@index([providerType]) @@index([isEnabled])
}

model LlmModel {
  id          String       @id @default(cuid())
  providerId  String
  provider    LlmProvider  @relation(fields: [providerId], references: [id], onDelete: Cascade)
  modelKey    String       // Azure=deployment name；其他=model id
  label       String
  capability  Json         // { maxTokens, supportsTemperature, temperature?, defaultImageDetail, supportsJsonSchema, supportsVision }
  pricing     Json?        // C 修正: { inputPer1k, outputPer1k, currency } 供 ai-cost.service 跨 provider 計價
  isEnabled   Boolean      @default(true)
  createdAt DateTime @default(now())  updatedAt DateTime @updatedAt
  @@unique([providerId, modelKey]) @@index([isEnabled])
}
```

- **`isDefault` 唯一性（C2）**：Prisma 無法宣告條件唯一 → migration 加 partial unique index：
  `CREATE UNIQUE INDEX one_default_provider ON "LlmProvider" ("isDefault") WHERE "isDefault" = true;`（或應用層 setDefault 用 transaction 清除其他）。
- **per-環節指派（C3）**：延續 `SystemConfig(AI_MODEL/GLOBAL)`，value = `LlmModel.id`，key 擴充：`extraction.model.stage1/2/3`（既有）+ `vision.model` / `termClassification.model` / `termValidation.model` / `v2Extraction.model`。
- **Fallback 鏈**：環節指派缺失/無效 → `isDefault` provider 的對應模型 → 硬編 Azure 預設（CHANGE-099 現行行為，零變）。
- **播種**：migration 後以既有 `AZURE_OPENAI_*` 建一筆 `isDefault` Azure provider + 既有模型，用戶原設定即刻可用。
- **Migration**：Azure DEV 有 schema drift 史，照既有 gated 流程。

---

## 5. 依賴（H2，D5 已 approve 方向）

| 套件 | 用途 |
|------|------|
| `ai` | AI SDK 核心（`generateText`/`generateObject`/`jsonSchema`） |
| `@ai-sdk/azure` | Azure OpenAI（含 apiVersion / Entra ID token 選項） |
| `@ai-sdk/openai` | OpenAI + 自訂 baseURL（Grok/自建 OpenAI-compatible 亦可經此） |
| `@ai-sdk/anthropic` | Claude（native，解決審視 A1 的 structured output 破口） |
| `@ai-sdk/google` | Gemini（native，避開 compat 層 beta 限制） |
| `@ai-sdk/xai` | Grok（native provider） |

> 不再需要自建 adapter，也不需裸 `@anthropic-ai/sdk`（由 `@ai-sdk/anthropic` 取代）。安裝時確認各套件版本並記入 CHANGE/Story。

---

## 6. Prompt 相容性與準確率（D6，審視 A2）

現有 prompt 針對 GPT 調校（Epic 14）。換 Claude/Gemini/Grok **不保證等價準確率**，直接關係 90–95% 目標。策略（D6 定案 a+b）：

- **低風險環節**（term-classification / ai-term-validator 等分類/驗證）：可直接切非 Azure provider。
- **核心提取（Stage 3 欄位提取）**：切換非 Azure provider 前，**必須用既有測試文件集通過準確率回歸**才准用（見 §13）。
- UI 在指派「核心環節 × 非 Azure 模型」時顯示警示，提醒需先過回歸。
- 未採 per-provider prompt 覆蓋層（維護成本高，暫不做）。

---

## 7. D4 決定（VNet egress / 資料合規）

- **C1 egress**：視為部署/infra 前置、非 code 阻塞。App code 對網路拓撲無感。Azure（私有端點）維持預設可用；非 Azure provider 啟用前 infra 需開 outbound egress。對不可達 provider 明確報錯；`testConnection` 提供即時驗證。
- **C3 合規**：Azure 維持全域預設基準（資料留既有 tenant）。`allowSensitiveData`（預設 false）+ 後台配置非 Azure provider 時 UI 強制合規勾選。生產啟用非 Azure provider 前需 IT/security **組織層 sign-off**（不建重量級審批 workflow）。

---

## 8. 各處理環節接入（收斂範圍）

| 環節 | 檔案 | 輸入 | Story |
|------|------|------|-------|
| extraction Stage 1-3 | `gpt-caller.service.ts`（→ gateway，簽章不變） | 文字+圖片 | 23.1 |
| Vision OCR / 分類 | `gpt-vision.service.ts` | 文字+單圖 | 23.4 |
| 術語分類（Tier 3） | `term-classification.service.ts` | **純文字** | 23.4 |
| AI 術語驗證 | `ai-term-validator.service.ts`（保留 rule-based fallback） | **純文字** | 23.4 |
| V2 輕量提取 | `extraction-v2/gpt-mini-extractor.service.ts` | **純文字**（reasoning 模型 + `reasoning_effort`） | 23.4 |
| V3 單次提取 | `unified-gpt-extraction.service.ts` | 文字+圖片 | 23.4 |
| 測試/比較 API（2 處） | `prompt-configs/test`、`test/extraction-compare` | 文字+圖片 | 23.4（低優先） |

---

## 9. API 設計（Story 23.2）

| 端點 | 方法 | 權限 | 用途 |
|------|------|------|------|
| `/api/v1/llm-providers` | GET / POST | 登入 / globalAdmin | 列出（憑證 masked）/ 新增（加密存） |
| `/api/v1/llm-providers/[id]` | PATCH / DELETE | globalAdmin | 更新 / 刪除 |
| `/api/v1/llm-providers/[id]/test` | POST | globalAdmin | 連線測試 |
| `/api/v1/llm-providers/[id]/models` | GET / POST | 登入 / globalAdmin | 模型清單 |
| `/api/v1/model-configs`（既有） | GET / PUT | 登入 / globalAdmin | 各環節 provider+model 指派（value=`LlmModel.id`） |

Zod 驗證 + RFC 7807 top-level；憑證永不回傳明文；自訂 `baseUrl` 僅 globalAdmin（防 SSRF）。

---

## 10. UI 設計（Story 23.2）

- 新頁 `admin/llm-providers`：Provider 列表 + 新增/編輯（憑證遮罩，非 Azure 顯示 §7 合規勾選）+ 連線測試。
- 既有 `admin/model-settings` 擴充：各環節模型下拉來源改為「已啟用 provider 的已啟用模型」；核心環節×非 Azure 顯示準確率回歸警示。
- 三語言 i18n，新 namespace `llmProviders` 註冊 `src/i18n/request.ts`。

---

## 11. 安全與合規

| 風險 | 緩解 |
|------|------|
| API key 外洩 | `aes-256-gcm` 加密（`CONFIG_ENCRYPTION_KEY`, fail-closed）；API mask；不 log |
| 敏感發票資料送外部 | Azure 為預設基準；`allowSensitiveData` + UI 確認；**非 Azure 生產前需組織 sign-off** |
| SSRF | 自訂 `baseUrl` 僅 globalAdmin |
| egress 未開 | 部署前置；`testConnection` 驗證；明確報錯 |

---

## 12. 實作 Story 拆分

| Story | 範圍 | 約束 | 依賴 |
|-------|------|------|------|
| **23.1 Gateway + 資料模型** | `LlmProvider`/`LlmModel` model + migration + partial unique index + `LlmGatewayService`（AI SDK）+ `@ai-sdk/azure` 接上 extraction 三階段（請求組裝快照驗證）+ Azure provider 播種 | H1+H2 | 無 |
| **23.2 憑證 + Provider 管理 + UI** | 憑證加解密 + `/api/v1/llm-providers` + `admin/llm-providers` + `model-settings` 擴充 + i18n | H1+H4 | 23.1 |
| **23.3 多 provider + 準確率框架** | `@ai-sdk/{openai,anthropic,google,xai}` 接上 + 各 provider 能力/降級 + **準確率回歸框架（D6）** | H1+H2 | 23.1 |
| **23.4 全面遷移 + 治理** | 其餘 5 處遷 gateway（保留純文字/reasoning/業務 fallback 差異）+ per-環節指派 UI + `ai-cost.service` 跨 provider 計價 + 測試/觀測 | H1 | 23.1–23.3 |

---

## 13. 測試策略（審視 C1 修正）

- **請求組裝快照**：對每個呼叫點快照 gateway 產生的 AI SDK 參數，確保遷移不改變送出內容（**非**要求 LLM 回應逐位元一致）。
- **準確率回歸（D6）**：核心提取切換非 Azure provider 前，用既有測試文件集比對提取準確率並通過門檻。
- **Unit**：gateway 解析 / capability gate / fallback 鏈 / 憑證加解密 round-trip / 三態 output 降級。
- **Integration**：gateway → AI SDK → mock provider；provider CRUD + test API。
- **E2E（Playwright）**：`admin/llm-providers` CRUD + 連線測試 + `model-settings` 指派 + 合規勾選。

---

## 14. 風險與技術債務

| 項目 | 說明 |
|------|------|
| 無 Key Vault | 憑證靠 app 層 `aes-256-gcm` + env 主金鑰（SP 僅 Contributor）；金鑰輪替需人工 |
| AI SDK lock-in | 抽象綁 Vercel AI SDK，升 major 版有 breaking change |
| Gemini schema 子集 | 複雜 schema 可能需降級到 generateText（§3.6） |
| Prompt 準確率漂移 | 非 Azure provider 核心提取需回歸把關（§6） |
| 遷移風險 | 7 處呼叫點逐一遷移 + 請求組裝快照防漂移 |
| 模型退役 | provider 模型清單需維護/淘汰機制（如 grok-4 已退役） |

---

## 版本資訊

- **建立/更新**：2026-07-09
- **版本**：0.3.0
- **狀態**：🟢 D1–D6 定案；待建 worktree 進實作；**未寫入 `sprint-status.yaml`**
- **v0.2.0 → v0.3.0 變更**：架構改 Vercel AI SDK（D5）；介面重設計補審視 G1–G10；新增 §6 Prompt 相容性（D6/A2）；§13 測試改「請求組裝快照 + 準確率回歸」（修正 C1 逐位元錯誤）；§4 加 per-環節指派 + `isDefault` partial unique index + `pricing`（修正 C2/C3）；§5 依賴改 `ai`+`@ai-sdk/*`。
- **格式依據**：`epic-22-enterprise-security/tech-spec-story-22-1.md`
