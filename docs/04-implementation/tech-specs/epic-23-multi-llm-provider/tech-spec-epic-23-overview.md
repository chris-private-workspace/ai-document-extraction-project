# Tech Spec: Epic 23 - 多 LLM Provider 整合管理系統

> **Version**: 0.4.0（三輪審視：資深審視補硬缺口）
> **Created**: 2026-07-09 ｜ **Updated**: 2026-07-09
> **對準 SDK 版本**: Vercel AI SDK **v6**
> **Status**: 🟢 D1–D11 定案（D9 暫緩至 spike 後）；**下一步 = Phase 0 spike**，之後照完整 scope 排 Story 23.1–23.4（**尚未寫入 `sprint-status.yaml`**）
> **Epic Key**: EPIC-23（暫定）
> **前置**: CHANGE-099（已完成）
> **配套審視**: `design-review-v0.2.0.md`（一/二輪）+ `senior-review-v0.3.1.md`（三輪，本版據其 §8 無爭議項補強）

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
| **D7** | 多 provider 真正動機（2026-07-09 定案） | **備援/避免鎖定 + 能力（難文件用更強模型）+ 彈性**（**非省成本**）→ provider 韌性/failover 列為正式 scope；成本計價優先級降 |
| **D8** | 是否先 spike（2026-07-09 定案） | **是** — 進 Story 23.1 前先做 Phase 0 先導驗證（1-2 天，真實發票 × 2-3 provider 量準確率 + confidence 分佈），用結果決定投資規模 |
| **D10** | scope 縮減（2026-07-09 定案） | **不縮減** — 照 v0.4.0 做完整後台 CRUD 憑證系統（`admin/llm-providers` + 加密 + 審計 + 遮罩）；視為 spike 後的預設方向，可依 spike 結果調整 |
| **D11** | 營運骨架歸屬（2026-07-09 定案） | **納入 Epic 23** — 用量持久化 + 結構化 logging 提前到 Story 23.1；韌性/failover 進 Story 23.3（見 §11.5） |

> **D9**（confidence per-model 校準做法，見 §6.1）**暫緩**：高度依賴 spike 跑出的 confidence 分佈資料，待 Phase 0 spike 完成或 Phase 2 開工前再定。

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

**非目標**：不做 billing 對帳｜不做自動 A/B 路由｜不改三層映射 Tier 1/2｜不引入 LangChain｜不建重量級合規審批 workflow。

> ⚠️ v0.4.0 變更：因 D7「備援」動機，**provider failover / 熔斷改列為目標**（見 §11.5），不再是非目標。

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

> ⚠️ `createAzure` 官方主推 `resourceName`（與 `baseURL` 二擇一）；新 Azure v1 API 下 `apiVersion` 預設 `'v1'`（**非**舊式 `2024-xx-preview` 日期字串），播種既有部署時留意。

### 3.4 統一呼叫介面（重設計，補審視 G1–G10）

```typescript
interface LlmCallInput {
  modelId: string;                     // G1: LlmModel.id → gateway 解析 provider+model+capability
  messages: LlmMessage[];              // G7: 保真訊息（system/user/assistant，多段）
  images?: LlmImagePart[];             // G2: optional（純文字呼叫不傳，空值不視為錯）；映射 AI SDK v6 FilePart（見 §3.5）
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
- **圖片 part（AI SDK v6）**：用 `{ type: 'file', mediaType: 'image/png', data: base64/DataURI/Uint8Array/URL }`（v6 的 `ImagePart` 已 deprecated，改用 `FilePart`；`mimeType` 亦更名 `mediaType`；跨 OpenAI/Anthropic/Google/xAI 統一）。

### 3.6 結構化輸出策略（G3/G10）— v0.3.1 修正（AI SDK 官方查證）

> ⚠️ v0.3.0 誤寫「`generateText` 設 JSON mode」— AI SDK 的 `generateText` **沒有**裸 JSON 模式旗標。修正如下：

| output.mode | 實作（AI SDK v6 正確寫法） | 對應現況 |
|-------------|------|----------|
| `text` | `generateText(...)` | #2/#5/#7（無 response_format） |
| `json` | **`generateObject({ output: 'no-schema' })`**（只保證合法 JSON、不驗結構）；呼叫端保留既有容錯解析 | #3/#4/#6（json_object） |
| `object` | `generateObject({ schema: jsonSchema(rawJsonSchema) })` | #1（json_schema strict） |

- **Anthropic**：`@ai-sdk/anthropic` 的 `structuredOutputMode:'auto'`（預設）→ 新 Claude（Sonnet 4.5+）走原生 structured output，較舊者 fallback `jsonTool` 模式，皆由 SDK 自動處理。
- **降級（G10）**：`generateObject`（含 `object` / `no-schema`）失敗（如 Gemini schema 子集不支援）→ gateway 退回 `generateText` + prompt 指示 JSON，呼叫端自 parse（保留 #1 現行 json_schema→json_object 回退精神）。

### 3.7 韌性與業務 fallback 保留（G9）

- gateway 提供**技術層** retry（預設 2 + 遞增 delay，呼叫端可覆蓋）+ `abortTimeoutMs`。
- **業務層 fallback 留在呼叫端**：如 `ai-term-validator` 失敗時退回 rule-based 判斷（`ai-term-validator.service.ts:406-468`）—— gateway 只回 `success:false`，**不吞掉**呼叫端的業務降級。

### 3.8 遷移策略（審視 C1 修正 + 第二輪自審）

- **不要求 LLM 回應逐位元一致**（LLM 非確定性）。改以**請求組裝快照比對**：對每個呼叫點，快照 gateway 產生的 AI SDK 呼叫參數（model / messages / options），確保遷移**送出的內容**與遷移前等價。
- 🔴 **Azure 路徑也非「零風險」**：遷到 AI SDK 後，連 Azure 路徑的 wire request 都改由 AI SDK 組（不再是現有手寫 `fetch`）。函數簽章不變，但實際 HTTP 內容組法變了 → 請求組裝快照**只保證 gateway 層等價，保證不了** AI SDK→wire 與現行手寫版逐一相同。故 extraction 三階段遷移**須納入行為驗證**（含準確率回歸 + 實測比對），不可標為零風險重構。
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
  keyVersion         Int             @default(1) // 三輪審視: 前向相容金鑰輪替（現無輪替工具，先留欄位）
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

- **`isDefault` 唯一性（C2）**：✅ **Story 23.1 定案：走應用層**（`setDefault` 用 transaction 清除其他，Story 23.2 實作）。原提議的 partial unique index **不採用**——本專案 db-push 驅動（見下方 Migration），手動 partial index 會被後續 `db push` 當 drift 移除。
- **per-環節指派（C3）**：延續 `SystemConfig(AI_MODEL/GLOBAL)`，value = `LlmModel.id`，key 擴充：`extraction.model.stage1/2/3`（既有）+ `vision.model` / `termClassification.model` / `termValidation.model` / `v2Extraction.model`。
  - ✅ **C3 Story 23.1 定案：採獨立 `StageModelAssignment` model**（FK 到 `LlmModel`、`onDelete: SetNull`，取得 referential integrity），取代 SystemConfig 字串軟外鍵。`stageKey` 沿用 CHANGE-099 命名（`extraction.model.stage1/2/3`），供 step 4 遷移對齊。step 1 播種只寫入（shadow data），管線仍讀 SystemConfig → 行為零變；step 4 才切換讀取來源。
- **Fallback 鏈**：環節指派缺失/無效 → 取該環節的**預設 model key**（如 `DEFAULT_STAGE_MODELS.stage3`）在 `isDefault` provider 下比對 `modelKey` 的 `LlmModel` → 仍無則硬編 Azure 預設（CHANGE-099 現行行為，零變）。
- **播種**：migration 後以既有 `AZURE_OPENAI_*` 建一筆 `isDefault` Azure provider + 既有模型，並把各環節預設指派（`SystemConfig` value）寫成**新建 `LlmModel` 的 id**，用戶原設定即刻可用。
- **capability 維護**：`capability` 手填 JSON 易錯 → 內建常見模型（gpt-5-nano / gpt-5.2 / claude / gemini / grok 等）的 capability **預設模板**，新增模型時帶入可改，降低手填錯誤。
- **Migration（Story 23.1 實測修正）**：本專案 **db-push 驅動**——`prisma/migrations/` 僅殘留 10 檔、與實際 122-model DB 差距甚大；`prisma migrate dev` 會誤判整庫 drift、互動下恐提議 reset（清空資料）。→ 改用 **`npx prisma db push`**（套用前先 `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` **唯讀預覽**確認純新增無 DROP），**不建 migration 檔**（與既有 122 model 存在方式一致）。DB 連線靠 `prisma.config.ts` 讀 `DATABASE_URL`；worktree 無 `.env` 時用 `DOTENV_CONFIG_PATH` 指向主 repo `.env`。新 model id 用 `@default(uuid())`（專案新標準，非上方範例的 cuid）。

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
>
> **Story 23.1 step 3 實裝（2026-07-09）**：本 step gateway 只接 Azure，故只裝 `ai@7.0.18` + `@ai-sdk/azure@4.0.9`（後者已 transitive 帶入 `@ai-sdk/openai`/`provider`/`provider-utils`）；其餘 native provider 套件（`@ai-sdk/anthropic`/`google`/`xai`）延後至 Story 23.3 擴充時再裝。`ai@7` engines 要求 **node>=22** → CI `quality-checks.yml`/`security-deps.yml` 的 node 20→22（Dockerfile 已 node:26，本機 v25）；zod `^4.2.1` 滿足 peer `^3.25.76 || ^4.1.8`。`package-lock.json` 於 **node:22 容器**以 `--package-lock-only` 重生（FIX-075：避免 Windows 生成缺 Linux 條目；實測純新增、無原生 churn、`npm ci --dry-run` 通過）。

---

## 6. 模型相容性：準確率 + 信心度校準（D6 + 三輪審視 P0）

### 6.1 🔴 信心度路由 per-model 校準（三輪審視頭號風險，D9）

**這是換 provider 最危險、且最隱形的風險。** 信心度路由分數**約 65% 來自模型自評 confidence**（Stage 1+2+3），配**硬編 90/70 閾值**（`confidence-v3-1.service.ts:112-119`），且閾值是針對 GPT-5 自評分佈校準的。換模型自評習性一變 → **靜默**造成大量錯誤 AUTO_APPROVE（漏審）或灌爆 FULL_REVIEW（人工爆量），直接打穿「90–95% 自動化率」。

**必要防護**（實作前提，非事後）：
- 把 90/70 做成 **per-model / per-provider 閾值配置**（延伸 `LlmModelConfigService` 加 provider 維度）。
- 換模型前用**已標註校準集**量測新模型 confidence 分佈，重定閾值（與 §6.2 準確率回歸同一批文件一起做）。
- 中長期：降低對模型自評 confidence 依賴，改倚重確定性訊號（FIELD_COMPLETENESS、跨欄位驗證、金額對帳）。
- **監控**：上線後盯 AUTO_APPROVE 率 / FULL_REVIEW 率漂移作為 provider 品質哨兵。

### 6.2 Prompt 準確率（D6，審視 A2）

現有 prompt 針對 GPT 調校（Epic 14）。換 Claude/Gemini/Grok **不保證等價準確率**。策略（D6 a+b）：
- **低風險環節**（term-classification / ai-term-validator 分類/驗證）：可直接切非 Azure。
- **核心提取（Stage 3）**：切非 Azure 前**必須通過準確率回歸**（見 §13）。
- UI 指派「核心環節 × 非 Azure」顯示警示。
- 未採 per-provider prompt 覆蓋層（維護成本高，暫不做）。
- **下游內容耦合**（三輪審視）：費用 `classifiedAs` 用詞穩定度驅動 template 匹配（`li_*` key）、幣別/金額填出驅動 FX；換模型會放大既有漂移（CHANGE-094）。回歸須含「template 匹配空格率」「FX 略過率」為訊號。

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

## 11. 安全與合規（三輪審視強化）

| 風險 | 緩解 |
|------|------|
| API key 外洩 | `aes-256-gcm` 加密（`CONFIG_ENCRYPTION_KEY`, fail-closed）；API 只回**遮罩**值（勿沿用 `getConfigByKey` 回明文）；不 log |
| 🔴 解密失敗 fail-open | 現行 `decryptIfNeeded` 解密失敗會**回原始密文**（`system-config.service.ts:422`）→ gateway **必須視為硬錯誤**，不可把亂碼當 key 送 provider |
| 🔴 加密實作漂移 | 現已有 GCM/CBC/SHA-256 三套；**把 GCM helper 抽成共用可 import 模組**（供 app + 編譯種子共用），杜絕第四套 |
| 🔴 憑證變更無審計 | provider create/update/delete/test 掛 `AuditLog`（actor + resourceType=`LlmProvider`）+ 遮罩版本歷史（歷史內**永不存明文/密文**）；§9 補此需求 |
| 金鑰輪替 | 無 Key Vault（SP Contributor）→ 真實保護僅防 DB 層外洩；`keyVersion` 欄位先留（§4），輪替工具鏈另案 |
| 敏感發票資料送外部 | Azure 為預設基準；`allowSensitiveData` + UI 確認；**非 Azure 生產前需組織 sign-off** |
| SSRF | 自訂 `baseUrl` 僅 globalAdmin |
| egress 未開 | 部署前置；`testConnection` 驗證；明確報錯 |

> **真實安全等級**（三輪審視）：GCM 原語健全，但主金鑰與 app 同在 App Service env → 進得了容器即取得明文。有效保護 ≈「防 DB dump 外流」，非「抵禦 app/infra 層入侵」。
> **播種陷阱**：Azure prod seed 走 raw `pg`、加密 helper 是 module-private → 播種加密憑證須先抽共用模組 + gated 一次性種子（比照 `RUN_*` 範式，啟動時讀 `AZURE_OPENAI_API_KEY`+`CONFIG_ENCRYPTION_KEY`）。

---

## 11.5 營運骨架與 Rollout（三輪審視新增，D11）

多 provider 的核心賣點（備援/切換）**目前零地基**（審視調查 B）。上線前必須補：

| 項目 | 現況缺口 | 要做 |
|------|----------|------|
| **用量持久化** | 🔴 `aiCostService.logUsage()` **零呼叫端**；主管線 token 只進 JSON blob → 成本儀表板只反映 term-validation | gateway 每次呼叫寫 `ApiUsageLog`（帶 `provider`/`model`/tokens/latency/success）；擴 `ApiProviderType` enum |
| **結構化 logging** | AI 呼叫用 `console.*`，`logger.service` 沒接 | gateway 統一走 `logger.service`，標 provider/model/latency/tokens |
| **provider 韌性（D7 備援）** | 🔴 無 circuit breaker / failover / 健康檢查；provider 掛掉整批空燒 retry | gateway 加 per-provider circuit breaker + 可選 failover（切 `isDefault`）+ `testConnection` 健康檢查 |
| **出站 rate limit** | 只有批次內硬編 `PQueue`；無 per-provider 配額 / 429 退避 | per-provider 出站限流（可複用 Upstash Redis）+ 辨識 429/`Retry-After` |
| **Rollout 安全** | 核心管線改動無 feature flag / shadow mode / rollback | **複用既有百分比灰度**（`FEATURE_EXTRACTION_V3_PERCENTAGE` + fileId 雜湊）；gateway 走 flag；shadow mode 新舊並行比對 confidence 分佈後再灰度切換 |
| **成本計價（D7 非驅動 → 降優先）** | 三套硬編 Azure 定價 | 用 `LlmModel.pricing` 分 provider 計價；因非動機，可延後 |

---

## 12. 實作 Story 拆分

> ✅ **D8 已定案（2026-07-09）：先做 Phase 0 spike**（1-2 天，真實文件 × 2-3 provider 量準確率 + confidence 分佈）決定投資規模，再進以下 Story。以下 Story 已納入三輪審視補的硬缺口。

| Story | 範圍 | 約束 | 依賴 |
|-------|------|------|------|
| **23.1 Gateway + 資料模型 + 營運地基** | `LlmProvider`/`LlmModel`(+`keyVersion`) model + migration + `LlmGatewayService`（AI SDK）+ **抽共用加密模組** + `@ai-sdk/azure` 接 extraction 三階段（行為驗證）+ Azure 播種 + **主管線用量持久化 + 結構化 logging + feature flag/shadow mode** | H1+H2 | 無 |
| **23.2 憑證 + Provider 管理 + UI + 審計** | 憑證加解密（gateway 解密硬錯誤）+ `/api/v1/llm-providers`（回遮罩）+ **AuditLog + 遮罩版本歷史** + `admin/llm-providers` + `model-settings` 擴充 + i18n | H1+H4 | 23.1 |
| **23.3 多 provider + confidence 校準 + 韌性** | `@ai-sdk/{openai,anthropic,google,xai}` 接上 + 各能力/降級 + **per-model confidence 校準（P0）** + 準確率回歸框架 + **circuit breaker/failover（D7 備援）** | H1+H2 | 23.1 |
| **23.4 全面遷移 + 治理** | 其餘 5 處遷 gateway + per-環節指派 UI + per-provider 出站限流 + 成本 per-provider 計價（低優先）+ 測試/觀測 | H1 | 23.1–23.3 |

---

## 13. 測試策略（審視 C1 修正 + 三輪落地）

- **請求組裝快照**：對每個呼叫點快照 gateway 產生的 AI SDK 參數，確保遷移不改變 gateway 層送出內容（**非**要求 LLM 回應逐位元一致）。⚠️ 保證不了 AI SDK→wire 與現行手寫版相同（§3.8），故 Azure 路徑（含 extraction 三階段）也須配合行為/準確率驗證。
- **準確率回歸（D6）落地方法**（三輪審視補）：
  - **測試集來源**：從既有已審核通過（AUTO_APPROVE / 人工確認）的歷史文件抽樣為 labeled 集（已有正確答案）。
  - **量測**：欄位級比對——文字欄 normalized match、金額欄容差（如 ±0.01）、幣別/日期正規化後比對；輸出 per-field 準確率 + 整體。
  - **通過門檻**：新 provider 核心提取準確率 ≥ 現行 Azure 基準 −（可接受 delta，Story 定，如 2%）。
  - **confidence 分佈**：同批量測新模型 confidence 分佈，供 §6.1 重定閾值。
  - **非確定性**：每份文件跑 N 次（如 3）取統計，避免單次偶然。
- **Unit**：gateway 解析 / capability gate / fallback 鏈 / 憑證加解密 round-trip（含 keyVersion）/ 三態 output 降級 / **解密失敗硬錯誤**。
- **Integration**：gateway → AI SDK → mock provider；provider CRUD + test API + 審計寫入。
- **E2E（Playwright）**：`admin/llm-providers` CRUD + 連線測試 + `model-settings` 指派 + 合規勾選。

---

## 14. 風險與技術債務

| 項目 | 說明 |
|------|------|
| 🔴 信心度路由校準 | 65% 分數來自模型自評 + 硬編 90/70 → 換模型靜默失準；需 per-model 校準（§6.1，P0） |
| 🔴 營運骨架缺失 | 成本歸帳斷裂、無 provider 韌性、無出站限流（§11.5）；工作量大 |
| 無 Key Vault / 金鑰輪替 | 憑證僅防 DB 外洩；無輪替工具，`keyVersion` 先留 |
| AI SDK lock-in | 抽象綁 Vercel AI SDK，升 major 版有 breaking change；gateway 薄封裝隔離 + pin 版本 |
| Gemini schema 子集 | 複雜 schema 可能需降級到 generateText（§3.6） |
| Prompt 準確率漂移 + 下游內容耦合 | 非 Azure 核心提取需回歸；template `classifiedAs`/FX 內容耦合（§6.2） |
| 遷移風險 | 7 處呼叫點逐一遷移 + 行為驗證 |
| 模型退役 | provider 模型清單需維護/淘汰機制 |

---

## 版本資訊

- **建立/更新**：2026-07-09
- **版本**：0.4.0
- **狀態**：🟢 D1–D11 定案（D9 暫緩至 spike 後）；下一步 = Phase 0 spike；**未寫入 `sprint-status.yaml`**
- **v0.2.0 → v0.3.0 變更**：架構改 Vercel AI SDK（D5）；介面重設計補審視 G1–G10；新增 §6 Prompt 相容性（D6/A2）；§13 測試改「請求組裝快照 + 準確率回歸」（修正 C1 逐位元錯誤）；§4 加 per-環節指派 + `isDefault` partial unique index + `pricing`（修正 C2/C3）；§5 依賴改 `ai`+`@ai-sdk/*`。
- **v0.3.0 → v0.3.1 變更（第二輪審視：AI SDK 官方查證 + 自審）**：修正 §3.6「要 JSON 但無 schema」→ `generateObject({output:'no-schema'})`（原 `generateText` JSON mode 寫法錯誤）；§3.5 圖片改 v6 `FilePart`（`ImagePart` v6 已 deprecated）；§3.3 註記 `createAzure` `resourceName` 與 `apiVersion:'v1'` 新語意；§3.8+§13 誠實化「Azure 路徑亦非零風險、wire 由 AI SDK 組、須行為驗證」；§4 明確 fallback 鏈 + capability 預設模板 + 播種指派綁定。
- **v0.3.1 → v0.4.0 變更（三輪資深審視，§8 無爭議項）**：新增 §6.1 信心度 per-model 校準（P0）；新增 §11.5 營運骨架（用量持久化/logging/韌性 failover/出站限流/rollout 灰度）；§11 憑證強化（抽共用加密模組/審計/解密硬錯誤/回應遮罩/真實安全等級/播種陷阱）；§4 加 `keyVersion` + 指派 model 化建議；§13 準確率量測方法落地；§12 Story 納入上述 + spike 註記；決策加 D7（動機=備援+能力+彈性，非省成本）；D8–D11 待用戶拍板。
- **格式依據**：`epic-22-enterprise-security/tech-spec-story-22-1.md`
