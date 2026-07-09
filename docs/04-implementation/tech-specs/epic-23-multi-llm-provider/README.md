# Epic 23 — 多 LLM Provider 整合管理系統

> **狀態**: 🟡 **Draft 提案**（規劃階段，**尚未寫入 `sprint-status.yaml`**、尚未進實作）
> **提案 PR**: [#96](https://github.com/chris-private-workspace/ai-document-extraction-project/pull/96)
> **前置**: CHANGE-099（LLM 模型選擇管理，已完成）
> **最後更新**: 2026-07-09

把目前硬綁 Azure OpenAI、散落 7 處的 LLM 呼叫，經 **Vercel AI SDK** 收斂為統一 gateway，並讓用戶在後台**自行配置多家 LLM provider（OpenAI / Gemini / Claude / Grok 等）與模型**。

---

## 📄 文件導覽

| 文件 | 內容 |
|------|------|
| [tech-spec-epic-23-overview.md](./tech-spec-epic-23-overview.md) | **主 Tech Spec（v0.3.1）** — 架構、資料模型、介面、Story 拆分、風險 |
| [design-review-v0.2.0.md](./design-review-v0.2.0.md) | **設計審視報告** — 兩輪獨立查證（呼叫點缺口 G1–G10、provider 能力、AI SDK API）與修正記錄 |

> 審視方法：第一輪 2 個 agent（7 處呼叫點介面缺口 + provider 能力/替代方案 WebSearch）；第二輪 1 個 agent（AI SDK 官方 API 查證）+ 架構自審。修正歷程見兩份文件的「版本資訊 / 決策更新」段。

---

## 🧭 關鍵決策（D1–D6，2026-07-09 定案）

| # | 問題 | 定案 |
|---|------|------|
| D1 | 資料模型 | 新增 Prisma model（`LlmProvider` + `LlmModel`） |
| D2 | 支援 provider | OpenAI / Google Gemini / Anthropic Claude / xAI Grok 等（可擴充） |
| D3 | 是否先只做 Phase 1 | 否 — 直接做完整、用戶可自行配置的系統 |
| D4 | VNet egress / 資料合規 | egress = infra 前置；Azure 為預設合規基準 + `allowSensitiveData` 護欄 + 組織 sign-off |
| D5 | 自建 adapter vs Vercel AI SDK | **Vercel AI SDK**（審視證實自建對 Anthropic/Gemini 有破口） |
| D6 | Prompt 相容性 / 準確率 | 低風險環節先開放他家；核心提取（Stage 3）切非 Azure 前需準確率回歸通過 |

---

## 🗂️ 實作 Story 拆分（尚未開工）

| Story | 範圍 | 約束 |
|-------|------|------|
| 23.1 | Gateway + `LlmProvider`/`LlmModel` model + `@ai-sdk/azure` 接上 extraction 三階段 | H1+H2 |
| 23.2 | 憑證加密 + Provider 管理 API + 後台 UI（用戶自配置） | H1+H4 |
| 23.3 | 接上多 provider（OpenAI/Claude/Gemini/Grok）+ 準確率回歸框架 | H1+H2 |
| 23.4 | 其餘 5 處呼叫點遷移 + 各環節指派 + 跨 provider 成本計價 + 測試 | H1 |

---

## ⚠️ 關鍵前提與風險

- **H1/H2/H4** 觸發：新增 Prisma model + gateway（H1）、安裝 `ai` + `@ai-sdk/*`（H2）、憑證加密 + 合規（H4）—— 方向已 approve，Story 開工逐項確認。
- **VNet egress**：非 Azure provider 上線前需 infra 開通對外網路。
- **資料合規**：發票資料送非 Azure provider 前需 IT/security 組織層 sign-off。
- **Prompt 準確率漂移**：核心提取切非 Azure provider 需通過準確率回歸。
- **無 Key Vault**：憑證靠 app 層 `aes-256-gcm` + env 主金鑰（部署 SP 僅 Contributor）。

---

## ▶️ 進度與接續（供換電腦跟進）

**今日進度（2026-07-09）**：規劃提案從 v0.1 迭代到 **v0.3.1**，經兩輪獨立審視（呼叫點缺口 G1–G10、provider 能力查證、AI SDK API 查證）+ 修正，決策 **D1–D6 全數定案**。規劃已**收斂**，尚未進實作。

**當前狀態**：🟡 Draft 提案，全部文件在 PR [#96](https://github.com/chris-private-workspace/ai-document-extraction-project/pull/96)（分支 `docs/epic-23-multi-llm-provider-proposal`）。

**下一步**：於獨立 git worktree 開 **Story 23.1** 實作（Gateway + `LlmProvider`/`LlmModel` model + `@ai-sdk/azure` 接上 extraction 三階段），不影響現行版本。開工觸發 **H1**（Prisma model + gateway）/ **H2**（裝 `ai` + `@ai-sdk/*`），需逐項確認。

**換電腦接續步驟**：
1. `git fetch origin` — ⚠️ remote 已搬到 `chris-private-workspace/ai-document-extraction-project`；若本機 `origin` 仍指舊 `laitim2001`，先 `git remote set-url origin https://github.com/chris-private-workspace/ai-document-extraction-project.git`
2. 讀規劃：`git checkout docs/epic-23-multi-llm-provider-proposal`，看本目錄三份文件 + PR #96。
3. 要實作時：`git worktree add ../ai-doc-epic23 -b feature/epic-23-multi-llm-provider main`，在 worktree 開 Story 23.1（勿在共用 working tree 上與其他 session 併行操作）。
