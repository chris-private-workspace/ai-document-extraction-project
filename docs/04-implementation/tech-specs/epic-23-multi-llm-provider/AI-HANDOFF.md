# Epic 23 — AI 助手接手指引（Onboarding / Handoff）

> **這份文件是什麼**：給**任何新 AI 助手**（新 session / 新電腦 / 新 worktree）快速進入 Epic 23 狀況的**單一入口**。讀完這份 + 下方連結的文件，就能無縫接續，不必回溯對話歷史。
> **最後更新**：2026-07-09 ｜ **維護**：每完成一個 Story 或重大決策後更新本檔。

---

## 0. 先讀這裡（30 秒進入狀況）

- **在做什麼**：把目前硬綁 Azure OpenAI、散落 7 處的 LLM 呼叫，經 **Vercel AI SDK** 收斂為統一 gateway，並讓用戶在後台自行配置多家 LLM provider（OpenAI / Gemini / Claude / Grok 等）與模型。
- **現在到哪**：**規劃已完成並收斂**（Tech Spec v0.3.1，經兩輪獨立審視），🟡 **Draft 提案、尚未進實作**。
- **下一步**：在 worktree `feature/epic-23-multi-llm-provider` 開 **Story 23.1**（Gateway + Prisma model + `@ai-sdk/azure` 接上 extraction 三階段）。
- **權威文件**（同目錄）：
  - `tech-spec-epic-23-overview.md` — **主規格 v0.3.1**（架構/資料模型/介面/Story/風險，實作照這份）
  - `design-review-v0.2.0.md` — 設計審視（**為何**這些決策；兩輪查證證據）
  - `README.md` — Epic 導覽 + 換電腦接續步驟

---

## 1. 背景（為何做）

- CHANGE-099（已完成）讓後台能選 LLM 模型，但**只有 2 個 Azure OpenAI 模型**（`gpt-5-nano` / `gpt-5.2`）。
- 現況痛點：LLM 呼叫**完全綁 Azure**；client 初始化**散落 7 處**（5× `new AzureOpenAI` + 2× 原生 `fetch`）；api-version **6 種**不一致。
- 用戶要求：系統化管理不同 LLM provider，讓用戶**自行配置**、決定用哪家的模型。

## 2. 目標

統一 `LlmGatewayService`（基於 Vercel AI SDK）→ 收斂 7 處呼叫 → 後台用戶自配置多 provider + 模型 → 各處理環節可指定 provider+model → 憑證加密 → 支援 OpenAI/Gemini/Claude/Grok 且可擴充。

## 3. 關鍵決策（D1–D6，2026-07-09 全數定案）

| # | 決策 |
|---|------|
| D1 | 資料模型 = **新 Prisma model**（`LlmProvider` + `LlmModel`） |
| D2 | 支援 **OpenAI / Gemini / Claude / Grok 等**（可擴充） |
| D3 | **不做** Phase-1 閘門，直接做完整、用戶可自配置的系統 |
| D4 | VNet egress = infra 前置；Azure 為**預設合規基準** + `allowSensitiveData` 護欄 + 組織 sign-off |
| D5 | 用 **Vercel AI SDK**（`ai` + `@ai-sdk/*`），**非**自建 adapter |
| D6 | **低風險環節**（分類/驗證）先開放他家；**核心提取（Stage 3）**切非 Azure 前需**準確率回歸**通過 |

## 4. 架構藍圖

```
呼叫方（7 處）→ LlmGatewayService →（Vercel AI SDK）→ @ai-sdk/{azure,openai,anthropic,google,xai}
                      │ resolve(modelId)→provider+model+capability；解密憑證；generateText/Object；capability gate
```
- 資料：`LlmProvider`（type/baseUrl/apiKeyEnc 加密/isDefault/allowSensitiveData）+ `LlmModel`（modelKey/capability/pricing）。
- 各環節指派存 `SystemConfig(AI_MODEL/GLOBAL)`，value = `LlmModel.id`；缺失 fallback → isDefault provider → 硬編 Azure 預設（行為零變）。
- 統一介面 `LlmCallInput`（modelId / messages / images? / output 三態 / maxOutputTokens / temperature / providerOptions / abortTimeoutMs）→ `LlmCallResult`。
- **細節看 overview §3–§4，勿在此重述。**

## 5. 待完成工作（Roadmap — 全部未開工）

| Story | 範圍 | 約束 |
|-------|------|------|
| **23.1** | Gateway + `LlmProvider`/`LlmModel` model + migration + `@ai-sdk/azure` 接 extraction 三階段 + Azure provider 播種 | H1+H2 |
| 23.2 | 憑證加密 + Provider 管理 API（`/api/v1/llm-providers`）+ 後台 UI（`admin/llm-providers`）+ i18n | H1+H4 |
| 23.3 | 接上多 provider（OpenAI/Claude/Gemini/Grok）+ 各能力/降級 + 準確率回歸框架 | H1+H2 |
| 23.4 | 其餘 5 處呼叫點遷移 + 各環節指派 UI + 跨 provider 成本計價 + 測試/觀測 | H1 |

**現在該做**：Story 23.1。

## 6. 🔴 需要注意的地方（踩過的坑 / 紅旗）

**AI SDK 正確用法**（v0.3.0 曾寫錯，已修，別再犯）：
- 「要 JSON 但無 schema」→ **`generateObject({ output: 'no-schema' })`**（`generateText` **沒有**裸 JSON mode）。
- 圖片用 **v6 `FilePart`**：`{ type:'file', mediaType:'image/png', data }`（`ImagePart` 已 deprecated）。
- token 上限 = `maxOutputTokens`；usage = `inputTokens/outputTokens/totalTokens`；reasoning = `providerOptions:{ openai:{ reasoningEffort:'low' } }`；逾時 = `abortSignal: AbortSignal.timeout(ms)`。
- 對準 **AI SDK v6**。

**Provider 差異**：
- **Anthropic** 的 OpenAI-compat 端點 structured output 失效 → 用 native `@ai-sdk/anthropic`（SDK 自動 tool-mode）。
- **Gemini** structured output 只支援 JSON schema 子集 → 需降級處理。

**遷移風險**：
- 遷到 AI SDK 後**連 Azure 路徑的 wire request 都由 AI SDK 組**（非現有手寫 fetch）→ extraction 三階段遷移**非零風險**，須做行為/準確率驗證（不能只靠請求組裝快照）。
- 保留呼叫端**業務 fallback**（如 `ai-term-validator` 失敗退回 rule-based）；`term-classification`/`ai-term-validator`/`gpt-mini-extractor` 是**純文字無圖**。

**安全/合規/部署**：
- 憑證加密複用 `aes-256-gcm` + `CONFIG_ENCRYPTION_KEY`（**無 Key Vault**，部署 SP 僅 Contributor）。
- 非 Azure provider 上線前：infra 需開 **VNet egress**；發票資料送外部需 **IT/security 組織層 sign-off**。
- Azure 部署**只手動** `az acr build` + `az webapp config container set`（無自動部署）。

**協作/git**：
- **絕不多個 session 共用同一 working tree**（本 session 踩過：commit 落到別人分支、被 rebase 丟棄）→ 用 **worktree 隔離**。
- **repo 已搬到 `chris-private-workspace`**（舊 `laitim2001` 靠重定向不保證永久）；新電腦先 `git remote set-url`。
- git 操作：commit 前**分支斷言**、push 後 `git ls-remote` 核對、終端有渲染雜訊要獨立驗證。

**專案規範**（standing）：
- 全程**繁體中文**回應；遵守 CLAUDE.md 的 **Hard Constraints H1–H6** 與 Karpathy 四守則。
- 開工前 H1（Prisma model + gateway 改 LLM 底層）/ H2（裝 `ai`+`@ai-sdk/*`）/ H4（憑證+合規）**逐項向用戶確認**。
- UI 字串走 i18n 三語言；新 namespace（如 `llmProviders`）註冊 `src/i18n/request.ts`。

## 7. 現有 LLM 呼叫點（遷移目標，7 處）

| 環節 | 檔案 | 輸入 |
|------|------|------|
| extraction Stage 1-3 | `src/services/extraction-v3/stages/gpt-caller.service.ts` | 文字+圖片 |
| Vision OCR / 分類 | `src/services/gpt-vision.service.ts` | 文字+單圖 |
| 術語分類（Tier 3） | `src/services/term-classification.service.ts` | 純文字 |
| AI 術語驗證 | `src/services/ai-term-validator.service.ts` | 純文字（有 rule-based fallback） |
| V2 輕量提取 | `src/services/extraction-v2/gpt-mini-extractor.service.ts` | 純文字（reasoning 模型） |
| V3 單次提取 | `src/services/extraction-v3/unified-gpt-extraction.service.ts` | 文字+圖片 |
| 測試 API（2 處） | `src/app/api/v1/prompt-configs/test/`、`src/app/api/test/extraction-compare/` | 文字+圖片 |

CHANGE-099 現有雛形：`src/lib/constants/llm-models.ts`（白名單）、`src/services/llm-model-config.service.ts`（Stage 指派）。

## 8. 環境與工作方式

- **開發 worktree**：`…/GitHub/ai-doc-epic23`，分支 `feature/epic-23-multi-llm-provider`（含全部規劃 + code）。
- 首次跑 code 前：`npm install` + `npx prisma generate`（worktree 不帶 `node_modules`）。
- 分支尚未 push；在 worktree commit 後 `git push -u origin feature/epic-23-multi-llm-provider`。
- 提案 PR：[#96](https://github.com/chris-private-workspace/ai-document-extraction-project/pull/96)（分支 `docs/epic-23-multi-llm-provider-proposal`）。
- **狀態未寫入 `sprint-status.yaml`**（Draft，勿污染排程真實來源；正式排入實作才寫）。

## 9. 建議的接手動作

1. 讀本檔 → `tech-spec-epic-23-overview.md`（v0.3.1）→（想懂決策脈絡）`design-review-v0.2.0.md`。
2. 與用戶確認要不要開工 Story 23.1；開工前逐項確認 H1/H2/H4。
3. 依 overview §3–§4 實作 Gateway + 資料模型，先讓 Azure 路徑等價（行為驗證），再接其他 provider。
