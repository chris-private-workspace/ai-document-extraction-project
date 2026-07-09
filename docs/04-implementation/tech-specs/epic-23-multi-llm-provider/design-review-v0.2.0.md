# Epic 23 設計審視報告（Design Review of Tech Spec v0.2.0）

> **Date**: 2026-07-09
> **對象**: `tech-spec-epic-23-overview.md` v0.2.0
> **方法**: 2 個獨立 agent 查證（(1) 7 處呼叫點 vs 統一介面缺口；(2) provider 能力 + 替代方案 WebSearch 查證）+ 架構批判
> **結論**: 方向正確，但**核心假設被查證推翻、一項重大業務風險漏掉、統一介面有 10 處設計缺陷、另有提案自身錯誤**。照 v0.2.0 現狀實作會踩雷，需修訂至 v0.3.0。

---

## 決策更新（本次審視觸發）

| # | 問題 | 狀態 | 定案 / 說明 |
|---|------|------|-------------|
| **D5** | 自建 adapter vs Vercel AI SDK | ✅ **定案（2026-07-09 用戶 approve）** | **採用 Vercel AI SDK**（`ai` + `@ai-sdk/*`）。用戶同意 H2 多套件成本可接受 |
| **D6** | Prompt 相容性 / 準確率策略 | ✅ **定案（2026-07-09 用戶選 a+b）** | 低風險環節先開放他家；核心提取（Stage 3）切非 Azure 前需準確率回歸通過（見 A2） |

---

## A. 重大方案問題

### 🔴 A1 — 「一個 OpenAI-compat adapter 打天下」假設被推翻 → 改採 Vercel AI SDK（D5）

WebSearch 官方文件查證結果：

| Provider | OpenAI-compat（改 baseURL）可行性 | 證據 |
|----------|-----------------------------------|------|
| OpenAI | ✅ vision + structured output 同時可用 | [Structured Outputs](https://openai.com/index/introducing-structured-outputs-in-the-api/) |
| xAI Grok | ✅ OpenAI schema mirror；vision base64 支援（模型相依）；structured output 可用 | [xAI API](https://x.ai/api) |
| Google Gemini | 🟡 端點存在、vision base64 可用，但 **compat 層仍 beta**，structured output 只支援 **JSON schema 子集**（複雜 schema 觸發 400），Gemini 特有參數需 `extra_body` | [Gemini OpenAI compat](https://ai.google.dev/gemini-api/docs/openai) |
| **Anthropic Claude** | ❌ compat 端點 **`response_format` 與 tool `strict` 均被 Ignored**；官方明言相容層「非 production-ready」，structured output **必須用 native `@anthropic-ai/sdk`** | [Anthropic OpenAI SDK compat](https://platform.claude.com/docs/en/api/openai-sdk) |

**推論**：自建「單一 adapter」實際會退化成「openai-compat 主線 **+** Anthropic native 分支 **+** Gemini schema 降級」三叉，遠比 v0.2.0 描述複雜。

**替代方案查證 — Vercel AI SDK**（`ai` + `@ai-sdk/openai`/`anthropic`/`google`/`xai`/`azure`）：
- 統一跨 provider 的 vision + structured output（`generateObject`）+ tool calling；**對 Anthropic 自動改用 tool-mode 達成 `generateObject`** —— 正好封裝 A1 的破口。
- 原生支援 Azure（`@ai-sdk/azure`，含 API key / Entra ID / 自訂 api-version）；可自訂 baseURL 接任意 OpenAI-compatible 端點。
- 已知坑：`@ai-sdk/azure` 對「非 Azure 自訂 gateway」的 baseURL 解析模式需用對（[issue #13956](https://github.com/vercel/ai/issues/13956)）；AI SDK 6「tool-loop 末端再加 structured output」目前僅 OpenAI 模型支援（本專案「vision 抽取 + `generateObject`」主場景不受影響）。
- 取捨：**新增約 6 個 npm 套件（H2，已 approve）** + 呼叫層從 raw `openai` 遷到 `generateObject`/`generateText` + 抽象 lock-in（升版有 breaking change）。
- 被否決的替代：LiteLLM（獨立 Python gateway，為單一 vision pipeline 引入整個 proxy 偏重）、LangChain（orchestration 導向，殺雞用牛刀）。

**來源**：[AI SDK 介紹](https://ai-sdk.dev/docs/introduction)、[AI SDK 6](https://vercel.com/blog/ai-sdk-6)、[AI SDK Azure provider](https://ai-sdk.dev/providers/ai-sdk-providers/azure)、[AI SDK xAI](https://ai-sdk.dev/providers/ai-sdk-providers/xai)

### 🔴 A2 — Prompt 相容性 = 準確率風險（v0.2.0 最大業務遺漏，D6 待定）

現有 prompt 是**針對 GPT 調校的**（Epic 14 prompt 系統）。換 Claude/Gemini/Grok **不是換 API 就等價** —— 同一 prompt 在不同模型上的提取準確度可能明顯不同，直接衝擊專案核心 **90–95% 準確率目標**。v0.2.0 完全未提。

**D6 定案（2026-07-09 用戶選 a+b）**：
- **低風險環節**（分類 / 驗證等）可直接用非 Azure provider。
- **核心提取（Stage 3 欄位提取）**切換到非 Azure provider 前，**必須用既有測試文件集通過準確率回歸**才准用。
- （未採 (c) per-provider prompt 覆蓋層 —— 維護成本高，暫不做。）

---

## B. 統一介面缺口清單（`LlmChatRequest` 撐不住 7 處實況）

> v0.2.0 介面：`LlmChatRequest { systemPrompt, userPrompt, imageBase64Array(必要), imageDetailMode?, jsonSchema?, maxTokens, temperature? }`
> 註：採 Vercel AI SDK 後，多數缺口改由 SDK 的 `ModelMessage` / `generateObject` 承載，但**下列語意差異仍須在 gateway 設計中明確處理**，不會自動消失。

| # | 缺口 | 證據（file:line） |
|---|------|-------------------|
| **G1** | 請求端**無 model 欄位**，但每處都在選模型（stage1/2=nano、stage3=5.2、#5 依模型分路）；本專案「模型 key」與「Azure 部署名」刻意分離 | `llm-models.ts:100-103` |
| **G2** | `term-classification`、`ai-term-validator`、`gpt-mini-extractor` **純文字無圖**，但 image 設為必要；#1/#6 遇空陣列**直接回錯 `'沒有提供圖片'`** | `gpt-caller:210-219`、`unified-gpt-extraction:217-223` |
| **G3** | `response_format` **三態**（json_schema / json_object / 完全不傳），介面只表達兩態，且無法帶 `strict`/`name` | `gpt-caller:362-371` vs #2/#5/#7 不傳 |
| **G4** | reasoning 模型（o-series/gpt-5-nano/mini）需 **`reasoning_effort`**（消耗 max_completion_tokens 額度），介面無 | `gpt-mini-extractor:377` |
| **G5** | `temperature` 的「模型不支援（nano 傳了會 400）」vs「呼叫端選擇」語意，介面 `temperature?` 無法承載；需攜帶模型能力做 gate | `gpt-caller:253,381`、`gpt-mini-extractor:373` |
| **G6** | `max_tokens`（舊欄位，#3/#4）vs `max_completion_tokens`（其餘）分裂，`maxTokens:number` 掩蓋差異 | `term-classification:298`、`ai-term-validator:362` |
| **G7** | 訊息結構**三種**：system+user / **`developer`+user**（#5 reasoning）/ 單一 user 無 system（#2/#7a 刻意）；硬拆兩段會改行為（H6） | `gpt-vision:750-764`、`gpt-mini-extractor:354` |
| **G8** | api-version **6 種**分裂（`2024-12-01-preview`/`2025-03-01-preview`/`2024-02-15-preview`/`2024-06-01`/`2024-08-01-preview`）；schema 支援度與版本綁定 | 各檔 |
| **G9** | 韌性/降級各異；**`ai-term-validator` 失敗 fallback 到 rule-based 非 AI 判斷**（業務降級，不可被通用 retry 取代） | `ai-term-validator:406-468` |
| **G10** | `gpt-caller` 有 **json_schema→json_object 的 400 協商回退**（per-provider 相容性邏輯），統一層需保留對應降級機制 | `gpt-caller:398-404` |
| **G11** | （非即時）目前全 src **無** tools / function calling / streaming / embeddings；但作為「唯一介面」，日後 agentic 抽取 / 串流 UI / 向量相似度需擴充 → **建議 Tech Spec 明標「刻意不支援」** | grep 全 src 確認 |

**次要**：7 處回應解析容錯邏輯差異極大（regex / fenced block / 平衡括號 / 找陣列）；gateway **只回原始 content、不代解析**，parse 留呼叫端，須明確界定。

---

## C. 提案自身錯誤（自糾）

1. **「golden test 逐位元一致」對 LLM 不成立**：LLM 回應非確定性，不可能 byte-identical。能保證一致的是**送出的 wire request 組裝**，而非回應。v0.2.0 §12 措辭錯誤 → v0.3.0 改為「請求組裝快照比對 + 準確率回歸」。
2. **指派粒度「全域一組」偏簡**：各環節（stage1/2/3、term-classification、vision）需求不同，本應 **per-環節指派**（CHANGE-099 已是 per-stage）；§4 fallback 鏈需對齊。
3. **`isDefault` 唯一性**：Prisma schema 無法直接保證「只有一個 `isDefault=true`」，需 partial unique index 或應用層強制 —— v0.2.0 未寫。

---

## D. 其他遺漏

- **成本追蹤**跨 provider：既有 `ai-cost.service` 綁 Azure 定價，多 provider 需各自 token 定價表。
- **模型退役維護**：查證發現 grok-4 已於 2026-08 退役 → 模型清單需維護/淘汰機制；`capability` 手動填 JSON 易錯。
- **rate limiting / 憑證輪替** per provider 未談。

---

## E. 對 Tech Spec v0.3.0 的修訂方向（據本審視）

1. **架構章節（§3）改寫為 Vercel AI SDK**：`LlmGatewayService` 內用 `generateText`/`generateObject` + `@ai-sdk/{openai,azure,anthropic,google,xai}`；移除自建 adapter 三叉。
2. **重設計呼叫介面**：補 G1（model）、G2（image optional）、G3/G10（結構化輸出策略）、G4（reasoning_effort）、G5（能力 gate）、G6/G8（tokens/version 由 provider 設定承載）、G7（訊息結構保真）、G9（保留 per-caller 韌性/業務 fallback）。
3. **新增 §Prompt 相容性與準確率**（A2 / D6）。
4. **修正 §12 測試**（C1：請求組裝快照 + 準確率回歸，非逐位元）。
5. **修正 §4 資料模型**：per-環節指派、`isDefault` 唯一性、成本定價表、模型淘汰。
6. **更新 §5 依賴**：`ai` + `@ai-sdk/*`（列具體套件，安裝時確認版本，H2）。

---

## F. 下一步

- 用戶決定：**worktree 中**規劃 + 實作此 module（避免影響現行版本）。worktree 從 `main` 開新 `feature/epic-23-*` 分支。
- 待辦：(1) 定 **D6**；(2) 據 D5/D6 修訂 Tech Spec 至 v0.3.0；(3) 建 worktree 進 Story 23.1。

---

## 附錄：審視方法與可信度

- Agent 1（呼叫點缺口）：逐行讀 7 處呼叫點 + `llm-models` 白名單 + 全 src grep 驗證（無 streaming/tools/embeddings）。
- Agent 2（provider 能力 + 替代方案）：WebSearch 官方文件查證，結論標「成立/部分成立/不成立」附來源；xAI 各模型 vision 支援建議實作前逐一核對模型卡。
- 本文所有 file:line 與外部連結均來自上述查證，未臆測。
