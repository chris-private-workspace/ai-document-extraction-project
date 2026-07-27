# Epic 23 — AI 助手接手指引（Onboarding / Handoff）

> **這份文件是什麼**：給**任何新 AI 助手**（新 session / 新電腦 / 新 worktree）快速進入 Epic 23 狀況的**單一入口**。讀完這份 + 下方連結的文件，就能無縫接續，不必回溯對話歷史。
> **最後更新**：2026-07-27（規格 v0.4.0；Phase 0 spike 完成；**Story 23.1 step 1–5 + 4b 完成**；**Story 23.2 step 1–3 完成**：憑證/Provider CRUD 服務 + 管理 API（`/api/v1/llm-providers`）+ 後台頁 `admin/llm-providers`（列表/新增/編輯遮罩憑證/連線測試/非 Azure 合規勾選）+ `model-settings` id-based 擴充（`StageModelAssignment` 為指派真實來源、下拉改 DB 已啟用 provider 模型、非 Azure 核心環節準確率回歸警示；**Azure key-bridge 保留、非 Azure 實際執行留 23.3**）。仍剩：harness 實跑等價 + §6.1 per-model 校準（歸 23.3）+ **Story 23.2 E2E 完成**（2026-07-10：本專案首個 Playwright E2E 框架 — `playwright.config.ts`〔webServer 啟乾淨端口 dev server、覆蓋 AUTH_URL/清空 Azure AD 憑證恢復 dev 認證〕+ `tests/e2e/auth.setup.ts`〔dev 登入 globalAdmin → storageState〕+ `tests/e2e/llm-providers.spec.ts`〔provider+model 完整 CRUD 流程〕+ `@playwright/test` devDep + `test:e2e` script；**實跑綠燈 2 passed**〔dev server + 真 DB〕。重跑前置：worktree 需複製主 repo `.env`、chromium build 1200 已裝於全域 cache）；**Story 23.2 模型管理 UI 完成**（2026-07-10：provider 子頁 `admin/llm-providers/[id]/models` 完整 CRUD — 列表／新增／編輯／停用 isEnabled／刪除；補 `[modelId]` PATCH+DELETE route + service `updateModel`/`deleteModel` + 審計 resourceType=LlmModel + 6 service 測試；provider 列表加「管理模型」入口；新增 `models.*` i18n 子樹三語同步）；**Story 23.3 韌性骨架完成**（gateway per-provider circuit breaker〔預設 on、opt-out〕+ failover 骨架〔opt-in `FEATURE_LLM_FAILOVER`，切 isDefault〕+ 健康檢查複用 testConnection；出站限流屬 23.4；⚠️ 非 Azure failover 實際生效待非 Azure wired））；**Story 23.3 P1 完成**（2026-07-27：per-model 信心度路由閾值校準**地基** — `LlmModel.routingThresholds Json?` + `LlmModelConfigService.getRoutingThresholds(stage)`〔per-model → per-provider → null 三層 fallback，不合法設定 warn 不靜默〕+ `ConfidenceV3_1Service` `options.thresholds`〔Partial 覆蓋，未傳即全域 90/70〕+ `extraction-v3.service` Step 6 串接〔讀取失敗只記 warning 不阻斷〕；**未校準時行為零變**；D9-a 拍板方案 A + H1 approve 同日；15 unit test。⚠️ 實際校準值屬 **P2**，仍阻塞於 gold set〔OQ-A〕與非 Azure key〔OQ-B〕；上 Azure 前需補 `apply-schema-drift.js` 條目 → **✅ 2026-07-27 已補，且發現缺口比預期大得多**：不只缺 `routing_thresholds` 欄位，**`llm_providers` / `llm_models` / `stage_model_assignments` 三張表在 Azure 根本不存在** —— `bootstrap-db.js:57-59` 對非空 DB 直接 skip，而**空庫套的 `init.sql` 裡也沒有這三張表**，兩條路徑都不會建。已在 `apply-schema-drift.js` 補上完整 10 條（enum + 3 表 + 7 index + 2 FK + routing_thresholds 欄位），DDL 由 `prisma migrate diff --from-empty --to-schema` 生成後逐字對齊；**已在臨時空庫實跑驗證**：10/10 OK、重跑冪等、`migrate diff` 反向比對殘餘差異中無任何 `llm_*` 項目）；**Story 23.3 首個非 Azure provider 接線完成**（2026-07-27：裝 `@ai-sdk/anthropic@4.0.21`〔H2 批准〕；gateway `buildModel` 加 `ANTHROPIC` 分支〔`buildAnthropicModel`：用 **modelKey** 非 deployment 名、無 api-version、baseUrl 留空即官方預設〕；`PreparedCall.model` 由 Azure 專屬型別放寬為 AI SDK `LanguageModel`；`llm-provider.service.probe()` 加 Anthropic 連線測試〔`GET {base}/models` + `x-api-key` + `anthropic-version: 2023-06-01`〕；**順帶修一個真 bug**：`resolveModel` 的 `baseUrl` 原本無條件 fallback 到 `AZURE_OPENAI_ENDPOINT`，非 Azure provider 未填 baseUrl 會被導向 Azure 端點 → 改為僅 Azure 適用；spike harness 加 `buildAnthropicCaller()` + `SPIKE_PROVIDER=anthropic` 開關〔預設仍 azure〕。8 unit test。⚠️ **Anthropic 三個踩雷點**：Opus 4.7+ 移除 sampling 參數〔送 `temperature` 直接 400〕、thinking 預設開啟且與回應共用 `max_tokens`〔harness 用 32000 避免思考完就截斷〕、structured output 必須走 native tool-mode〔OpenAI-compat 端點會失效〕。⚠️ **尚未實跑**：需 `.env`〔DB/Azure/storage〕+ ANTHROPIC_API_KEY + 本地 DB；**核心提取 Stage 1-3 仍全走 Azure**〔`getStageModel` 未動，D6/D9 gate 未解〕）｜ **維護**：每完成一個 Story 或重大決策後更新本檔。

---

## 0. 先讀這裡（30 秒進入狀況）

- **在做什麼**：把目前硬綁 Azure OpenAI、散落 7 處的 LLM 呼叫，經 **Vercel AI SDK** 收斂為統一 gateway，並讓用戶在後台自行配置多家 LLM provider（OpenAI / Gemini / Claude / Grok 等）與模型。
- **現在到哪**：**Tech Spec v0.4.0** + **Phase 0 spike（Azure 基準）已完成**（見 `phase-0-spike-report.md`）；🔴 **炸彈①在真實資料確認**（同模型內 confidence 92–99 幾乎恆定、與正確性脫鉤，42/42 全 AUTO_APPROVE）。非 Azure 對比待 key。**Story 23.1 進行中**：step 1（資料模型 `LlmProvider`/`LlmModel`/`StageModelAssignment` + 播種）、step 2（抽共用加密模組 `src/lib/config-encryption.ts`）、step 3（`LlmGatewayService`，`src/services/llm/`，只接 `@ai-sdk/azure`）、step 4（extraction 接 gateway：專屬 flag `FEATURE_LLM_GATEWAY_ENABLED` 全域硬切換，切入 `gpt-caller.service.call()` 單一 chokepoint）、step 5（gateway 觀測性：`aiLogger` 結構化 log + `usageContext.documentId`→反查 cityCode→`aiCostService.logUsage` 寫 `ApiUsageLog`，fire-and-forget，Stage3 已串）**已完成**；**step 4b 已完成**（2026-07-10，用戶批選項 B）：image `detail` 轉發（`providerOptions.openai.imageDetail`）+ 一致性百分比灰度（`shouldUseLlmGateway(fileId)` + `FEATURE_LLM_GATEWAY_PERCENTAGE`，專屬 fileId 串三階段）+ `LlmCallPlan.assembledMessages` 請求組裝快照 + offline 影子 harness（`scripts/epic-23-spike/stage3-shadow-comparison.ts`）。共 **29 unit test**（18 gateway + 5 routing + 6 flag）。flag 預設 OFF → 管線仍走既有直接 fetch、行為零變。**仍待**：跑影子 harness 做 AI SDK→wire 實跑等價（需真實 Azure 憑證）；§6.1 per-model confidence 校準（僅換非 Azure 時觸發，歸 **Story 23.3**，本批全 Azure 不觸發）。
- **🔴🔴 三輪審視揪出兩顆炸彈（必讀 `senior-review-v0.3.1.md`）**：
  1. **信心度路由會靜默失準** — 路由分數 65% 來自模型自評 confidence + 硬編 90/70 閾值（`confidence-v3-1.service.ts:112-119`）→ 換 provider 即使提取一樣準，路由也會壞（漏審/人工爆量）、且不報錯。**必須 per-model 重新校準才能安全換模型。**
  2. **營運骨架缺失/斷裂** — 成本歸帳斷裂（`logUsage` 零呼叫端）、無 provider 韌性/failover、無出站限流。多 provider 核心賣點零地基。
- **下一步**：Phase 0 spike 的 Azure 基準已跑完（harness = `scripts/epic-23-spike/`）。**非 Azure 對比（炸彈② + 真 per-model confidence 分佈）待兩件事**：(a) 非 Azure API key（H4 已批：少量真實發票；H2 已批：用 AI SDK）；(b) 補**不同發票 + 少量人工 gold set**（本地 71 份無 ground truth、實約 5 份不同發票，準確率結論不夠力）。**Story 23.1（gateway 收斂 + 營運地基，全 Azure、行為零變）與非 Azure 是否過關無關、可先做**。D9 校準框架確認為接非 Azure 核心提取的硬 gate。
- **權威文件**（同目錄，閱讀順序）：
  1. `senior-review-v0.3.1.md` — **三輪資深審視**（兩顆炸彈 + 營運/憑證缺口 + 重構 roadmap + D7–D11）← **先讀這份**
  2. `phase-0-spike-report.md` — **Phase 0 spike 結果**（炸彈①真實資料確認 + harness + 資料現況 + 投資建議）
  3. `tech-spec-epic-23-overview.md` — **主規格 v0.4.0**（架構/資料模型/介面/Story/風險，實作照這份）
  4. `design-review-v0.2.0.md` — 一/二輪審視（介面 G1–G10 + AI SDK API 查證）
  5. `README.md` — Epic 導覽 + 換電腦接續步驟

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
| D7 | 真正動機 = **備援/避免鎖定 + 能力 + 彈性**（**非省成本**）→ provider 韌性/failover 列為正式目標 |
| D8 | **先做 Phase 0 spike**（1-2 天）驗證準確率 + confidence 分佈，再進 Story 23.1 |
| D10 | **不縮減 scope** — 照 v0.4.0 完整後台 CRUD 憑證系統（spike 後預設方向，可依結果調整） |
| D11 | 營運骨架**納入 Epic 23**（用量持久化 + logging 進 23.1；韌性/failover 進 23.3） |

> **D8–D11 已於 2026-07-09 定案**（見上表）。**D9**（confidence per-model 校準做法）**暫緩**：依賴 spike 的 confidence 分佈資料，待 spike 完或 Phase 2 前再定。

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

> ⚠️ v0.4.0 已把三輪審視的硬缺口納入各 Story。建議先 **Phase 0 spike**（D8）再開工。

| Story | 範圍（含三輪審視補強） | 約束 |
|-------|------|------|
| **23.1** | Gateway + model(+`keyVersion`) + **抽共用加密模組** + `@ai-sdk/azure` 接 extraction + 播種 + **主管線用量持久化 + 結構化 logging + feature flag/shadow mode** | H1+H2 |
| 23.2 | 憑證（gateway 解密硬錯誤）+ Provider 管理 API（回遮罩）+ **AuditLog + 遮罩歷史** + 後台 UI + i18n | H1+H4 |
| 23.3 | 多 provider 接上〔✅ Anthropic 已接上 gateway + spike 實跑驗證 2026-07-27〕 + **per-model confidence 校準（P0）**〔✅ P1 地基完成；⚠️ P2 方向需重評——見 §6 炸彈① 實測〕 + 準確率回歸框架 + **circuit breaker/failover**〔✅ 骨架完成〕 | H1+H2 |
| 23.4 | 其餘 5 處遷移 + per-環節指派 UI + 出站限流 + 成本計價（低優先）+ 測試/觀測 | H1 |

**現在該做**：Phase 0 spike（D8 已定），再照完整 scope（D10）做 Story 23.1；營運骨架納入本 Epic（D11）。

## 6. 🔴 需要注意的地方（踩過的坑 / 紅旗）

**🔴🔴 最高風險（三輪審視，實作前提）**：
- **信心度路由 per-model 校準（P0）**：勿假設換模型只影響準確率——路由分數 65% 是模型自評 confidence + 硬編 90/70，換模型會靜默錯誤路由。換任何非 Azure 模型做核心提取前，**必須**用校準集重定 per-model 閾值（overview §6.1）。
- 🔴 **炸彈①（confidence 與正確性脫鉤）在 Claude 上同樣成立**（2026-07-27 首次非 Azure 實跑，harness `SPIKE_PROVIDER=anthropic`，claude-opus-5，9 份文件 × 2 回合 = 18 回合，0 失敗）：

  | 指標 | 結果 |
  |------|------|
  | 與 Azure 基準欄位一致率 | min 80% / p50 92% / max 100%（跨 20 個百分點） |
  | `overallConfidence` | min 96 / p50 96 / max 97（**恆定，無區分度**） |
  | 模擬路由（硬編 90/70） | AUTO_APPROVE 18/18 |
  | 重跑一致性 | 每份文件兩回合 `agreementRate` **完全相同**，confidence 僅差 1–2 點 |
  | `fieldConfidence`（n=446） | **雙峰**：不是 0 就是 93–99（Claude 用 0 表示「找不到」；Azure 對所有欄位一律 92–99） |

  **對 D9 的意涵**：一致率 80% 與 100% 的文件拿到**相同的 96–97 分**，相關性近乎零 → **per-model 閾值校準（P2）救不了這件事**，因為分佈本身無區分度，調閾值只會讓全部一起過或一起不過。P1 地基（per-model 閾值可覆寫）仍有價值，但**不足以**作為換 provider 的安全閘；需要的是「不依賴模型自評」的訊號（如欄位級交叉驗證 / 雙模型比對）。
  > 🔴 **已立案為 OQ-E**（`story-23-3-confidence-calibration-design.md` §7.1）：含完整實測數據、「分佈位移 vs 退化」的分析、三個方向選項（A 照原計畫 / B 重新定義 P2 / C 兩件事脫鉤，**建議 C**）與決策所需輸入。**P2 開工前須先拍板 OQ-E。**
  >
  > 🔴🔴 **2026-07-27 拆解——根因不屬於 Epic 23**：兩個 provider 的自評**都**與正確性脫鉤（Azure 92–99 恆定 / Claude 96–97 恆定），代表這是**現行 Azure 流程即存在**的問題，換 provider 只是把它照出來。已提升為獨立議題 **[OQ-Q5](../../../../open-questions.md)**（專案層，影響每日實際處理量，論優先級高於換 provider）。
  > **對 Epic 23 的意涵**：切換能力本身（provider 設定 / 憑證 / 路由 / 熔斷 / failover）**不需要 gold set，且已基本完成**；gold set 只與「核心提取實際跑在非 Azure 上」有關，且僅選項 A 強制需要。**勿讓一個既有的獨立問題阻塞一個已可交付的能力。**
  - **樣本限制（勿過度外推）**：9 份中 8 份為 CEVA，1 份 NEX；其餘取樣文件的 blob 在本地 Azurite 已 404。「一致率」比對的是 **Azure 原始回應**（非人工 ground truth），故只能讀作「與現行產出的差異」，不等於誰對誰錯。
- **營運骨架先補**：用量持久化（`logUsage` 目前零呼叫端）、結構化 logging、provider circuit breaker/failover、出站限流——多 provider 的地基，Story 23.1/23.3 已納入（overview §11.5）。
- **憑證真實安全等級**：GCM 健全但**只防 DB 外洩**（無 Key Vault，進得了容器即拿到明文）；gateway 解密失敗**必須硬錯誤**（現行 `decryptIfNeeded` 會 fail-open 回原始密文）；加密 helper 要抽共用模組；provider 變更要掛審計（overview §11）。

**AI SDK 正確用法**（v0.3.0 曾寫錯，已修，別再犯）：
- 「要 JSON 但無 schema」→ **`generateObject({ output: 'no-schema' })`**（`generateText` **沒有**裸 JSON mode）。
- 圖片用 **v6 `FilePart`**：`{ type:'file', mediaType:'image/png', data }`（`ImagePart` 已 deprecated）。
- token 上限 = `maxOutputTokens`；usage = `inputTokens/outputTokens/totalTokens`；reasoning = `providerOptions:{ openai:{ reasoningEffort:'low' } }`；逾時 = `abortSignal: AbortSignal.timeout(ms)`。
- 🔴 **system 訊息不得放進 `messages`**（2026-07-27 實跑抓到，**曾是生產缺陷**）：實際安裝的是 **`ai@7.0.18`**（本檔原記「對準 v6」已過時），v7 的 `standardizePrompt` 只要見到 `role: 'system'` 就丟 `InvalidPromptError`（"Use the instructions option instead"），且**與 provider 無關——Azure 也一樣炸**。Stage 3 prompt 必帶 system 段，故 gateway 灰度一開即全數失敗。已修：`toAiMessages` 抽出 system → `instructions` 參數，多則以空行合併；`llm-gateway.service.test.ts` 補 4 個回歸測試。
  - **為何既有測試沒抓到**：gateway 測試整包 `vi.mock('ai')`，`standardizePrompt` 從未執行 → 涉及 AI SDK 契約的改動，**必須有一條真實呼叫路徑驗證**（spike harness 即扮演此角色）。

**Provider 差異**：
- **Anthropic** 的 OpenAI-compat 端點 structured output 失效 → 用 native `@ai-sdk/anthropic`（SDK 自動 tool-mode）。
- 🔴 **Anthropic structured output 吃不下本專案的 Stage 3 schema**（2026-07-27 實測）：grammar 編譯有硬上限——optional 參數 ≤24、union 型別參數 ≤16、且有總體積上限。`generateOutputSchema`（`stage-3-extraction.service.ts:644`）每個欄位定義產一個 `{value, confidence}` 物件，25–30 欄直接三項全破。**生產不會壞**（gateway G10 降級自動接住 → `generateText` + JSON 指示），代價是**每次提取多一次被拒的 API 呼叫，且 Claude 全程無 schema 約束**。實測 18/18 回合全走降級路徑。若要讓 Anthropic 走真正的 structured output，需另設計精簡 schema（Story 23.4 或後續 CHANGE）。
- **Gemini** structured output 只支援 JSON schema 子集 → 需降級處理。

**遷移風險**：
- 遷到 AI SDK 後**連 Azure 路徑的 wire request 都由 AI SDK 組**（非現有手寫 fetch）→ extraction 三階段遷移**非零風險**，須做行為/準確率驗證（不能只靠請求組裝快照）。
- 保留呼叫端**業務 fallback**（如 `ai-term-validator` 失敗退回 rule-based）；`term-classification`/`ai-term-validator`/`gpt-mini-extractor` 是**純文字無圖**。

**安全/合規/部署**：
- 憑證加密複用 `aes-256-gcm` + `CONFIG_ENCRYPTION_KEY`（**無 Key Vault**，部署 SP 僅 Contributor）。
- 非 Azure provider 上線前：infra 需開 **VNet egress**；發票資料送外部需 **IT/security 組織層 sign-off**。
- Azure 部署**只手動** `az acr build` + `az webapp config container set`（無自動部署）。
- 🔴 **Epic 23 的三張表要靠 `apply-schema-drift.js` 才會出現在 Azure**（2026-07-27 補上）：Prisma migration **不會**自動套到 Azure，而 `bootstrap-db.js` 對非空 DB 直接 skip、對空庫套的 `init.sql` 又不含這三張表 —— 兩條路徑都不建。**部署本分支時必須帶 `RUN_SCHEMA_DRIFT_FIX=true`**，否則任何觸及 `llm_providers` / `llm_models` / `stage_model_assignments` 的查詢一律 P2022/P2021。補完後把旗標設回 false。
- ⚠️ **建表 ≠ 可用**：drift script 只建結構，**不含資料**；essential seed 也**不含** LLM provider（`scripts/epic-23/seed-llm-providers.ts` 是 `.ts`，不在 runner 映像內）。表建好後三張表皆空 → `getStageModel` 走既有 fallback 鏈（SystemConfig → 硬編 Azure 預設），**行為零變、不會炸**，但後台 provider 列表會是空的、gateway 也無從啟用。要在 Azure 實際使用，需另比照 `prisma/grant-global-admin.js` 寫一支 `.js` seed + entrypoint gated flag（Story 23.4 或另開 CHANGE）。
- ⚠️ **`llm_providers.isDefault` 的 partial unique index 從未被建立**：`schema.prisma:4427` 註解寫「唯一性由 partial unique index 保證」，但全 repo 搜不到任何地方建它（`post-init-indexes.sql` / migration / drift script 皆無）→ 目前**可以存在多筆 `is_default = true`**，fallback 取哪一筆由查詢順序決定。本地與 Azure 同樣缺，屬 Story 23.1 的驗收缺口，未在 2026-07-27 的 drift 補丁中一併處理（超出該次 scope）。

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

1. 讀本檔 → **`senior-review-v0.3.1.md`（兩顆炸彈 + D7–D11）** → `tech-spec-epic-23-overview.md`（v0.4.0）→（想懂脈絡）`design-review-v0.2.0.md`。
2. 與用戶確認要不要開工 Story 23.1；開工前逐項確認 H1/H2/H4。
3. 依 overview §3–§4 實作 Gateway + 資料模型，先讓 Azure 路徑等價（行為驗證），再接其他 provider。
