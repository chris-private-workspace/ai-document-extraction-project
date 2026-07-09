# Epic 23 資深工程師全面審視（Senior Review of Tech Spec v0.3.1）

> **Date**: 2026-07-09
> **對象**: `tech-spec-epic-23-overview.md` v0.3.1
> **方法**: 3 個並行 code 調查（模型耦合/下游相依、營運韌性/成本/可觀測、憑證安全/加密）+ 架構與產品層批判。所有技術結論附 `file:line`。
> **與前兩輪的差異**: 前兩輪（`design-review-v0.2.0.md`）聚焦「介面缺口 G1–G10」與「AI SDK API 正確性」。本輪打**系統性風險**：與現有系統的耦合、營運骨架、scope 與投資回報。

---

## 總判決（Verdict）

計劃**方向正確、規格細節扎實**，但**風險評估嚴重低估**。v0.3.1 把「提取準確率」（D6）當最大商業風險，但真正會決定成敗的兩顆炸彈它**完全沒提**：**(1) 信心度路由 per-model 校準**、**(2) 營運骨架缺失/斷裂**。

**核心建議**：不要照 v0.3.1 的 scope 直接全做。**先 spike 驗證**（他家 provider 在真實發票上的準確率 + confidence 分佈），用結果決定投資規模與 roadmap。這不是拖延，是「在最小投資點驗證最大不確定性」。

---

## 一、先肯定：計劃做得好的地方

- 向後相容的 fallback 鏈（Azure 為預設、行為零變）設計正確。
- 兩輪審視 + 修正的嚴謹（G1–G10、AI SDK API 查證）。
- **選 GCM 而非 CBC 加密**是正確判斷（見 §三）。
- per-環節指派（比全域一組更貼近真實需求）。
- 誠實標註部分風險（Azure 非零風險、Gemini schema 子集、AI SDK lock-in、無 Key Vault）。

---

## 二、🔴 P0 發現（決定成敗，v0.3.1 未涵蓋）

### 2.1 信心度路由 per-model 校準 —— 頭號炸彈

**證據**（調查 A）：
- 路由閾值 `AUTO_APPROVE:90 / QUICK_REVIEW:70` 是**硬編 magic number、無模型維度**（`confidence-v3-1.service.ts:112-119`）。
- 五維權重中 **STAGE_1(20%)+STAGE_2(15%)+STAGE_3(30%) = 65% 的總分直接來自模型自評 confidence**（`confidence-v3-1.service.ts:220,231,242`；值取自 GPT 回傳 `stage-1-company.service.ts:363`、`stage-3-extraction.service.ts:222`）。
- model-flavored magic number：`DEFAULT_CONFIDENCE = 85`（模型不附 confidence 時替它假設，`stage-3-extraction.service.ts:1175`）、啟發式 `60 + 填充率*30`（`:1561`）——都是針對「GPT 通常自評 80-95」的分佈調的。

**風險**：不同模型自評習性差異極大（Claude 保守、有些模型恆回 95-100）。換模型 → 分數分佈平移 → **大量文件錯誤 AUTO_APPROVE（漏審）或灌爆 FULL_REVIEW（人工爆量）**。**不報錯、靜默失準**，直接打穿「90-95% 自動化率」核心機制。這是 code 結構決定的**必然**，非理論風險。

**必要防護**：
1. 把 90/70 視為「模型耦合常數」→ 做成 **per-model / per-provider 閾值配置**（延伸 `LlmModelConfigService`，加 provider 維度）。
2. 換模型前用**已標註校準集**量測新模型 confidence 分佈，重新定閾值。
3. 中長期：降低對模型自評 confidence 的依賴，STAGE 維度改倚重確定性訊號（FIELD_COMPLETENESS、跨欄位驗證、金額對帳）——因為模型自評本質**不可跨模型比較**。

### 2.2 營運骨架缺失/斷裂 —— 多 provider 的「地基」不存在

**證據**（調查 B）：

| 面向 | 現況 | 證據 |
|------|------|------|
| **成本歸帳** | 🔴 **斷的**：`aiCostService.logUsage()` **全 codebase 零呼叫端**；主管線 token 只塞進 `document.extractionResult` JSON。成本儀表板實際只反映 term-validation | `ai-cost.service.ts:819`（無呼叫端）；唯一寫入在 `ai-term-validator.service.ts:566` |
| 定價表 | 三套互不相容硬編 Azure：token-based `DEFAULT_PRICING`、placeholder `GPT52_PRICING`、**per-page** `COST_CONFIG` | `ai-cost.service.ts:74`、`ai-term-validator.service.ts:68`、`processing-router.service.ts:94` |
| **provider 韌性** | 🔴 **零**：無 circuit breaker、無 failover、無健康檢查；provider 掛掉整批**空燒 retry** | `batch-processor.service.ts:1147-1277`；CHANGE-098 fail-stop 只保 DB（`unified-document-processor.service.ts:262`） |
| retry/timeout | 各自為政：gpt-caller 有（`:247-277`）、gpt-vision SDK **兩者皆無** | `gpt-vision.service.ts:748` |
| **可觀測性** | token/latency 埋在 JSON blob + `console.*`；結構化 `logger.service` AI 呼叫端沒接 | `gpt-caller.service.ts:400`；`logging/logger.service.ts` 未被 AI 端使用 |
| **出站 rate limit** | 幾乎無：只有批次內硬編 `PQueue`（`10/s`）；無 per-provider 配額、無 429/`Retry-After` 退避 | `batch-processor.service.ts:222`；`rate-limit.service.ts` 是**入站**限流 |

**可複用資產（正面）**：**百分比灰度機制已存在**（`FEATURE_EXTRACTION_V3_PERCENTAGE` + fileId 雜湊，`unified-document-processor.service.ts:210`）→ 可直接複用於 provider rollout；另 `logger.service`（結構化/寫 DB/SSE）、Upstash Redis（可挪作出站配額）、`pipeline-config` scope 分層皆可複用。

**結論**：多 provider 的核心賣點（自動切換、熔斷降級、分別計價、A/B 品質比較）**目前零地基**。v0.3.1 §12 的 Story 拆分嚴重低估這塊工作量。

---

## 三、🔴 P1 發現：憑證安全的真實等級（調查 C）

- **GCM 實作健全**：authenticated、每筆隨機 IV（`:356`）、per-record 隨機 salt（`:354`，FIX-070）、fail-closed 載入金鑰（`:322`）。**明顯優於** SharePoint/Outlook clientSecret 用的 CBC。選 GCM 正確。
- 🔴 **真實安全等級 = 中等（僅防 DB 層外洩）**：主金鑰 `CONFIG_ENCRYPTION_KEY` 與 app 同在 App Service env（無 Key Vault，SP 僅 Contributor）→ **能讀 Web App config 或進容器者即同時取得密文+金鑰**。有效保護 ≈「防 DB dump 外流」，**不等於「provider key 能抵禦 app/infra 層入侵」**。
- 🔴 **無金鑰輪替**：單一不可變主金鑰、無 key version（`.env.example:49` 明寫「不可變更」）。一旦需輪替 → 所有 provider key + 既有加密 SystemConfig 全失效，需人工離線雙金鑰重加密（工具鏈不存在）。加 provider key **擴大爆炸半徑**。→ **建議現在就在 `LlmProvider` 加 `keyVersion` 欄位**（成本極低、前向相容）。
- 🔴 **播種陷阱**：GCM `encryptValue/decryptValue` 是 **module-private**（`system-config.service.ts:353`，未 export）→ Azure 容器的 raw-pg 種子腳本 import 不到；且加密 SystemConfig 種子**從未在 Azure 容器路徑跑過**。→ **必須把加密 helper 抽成共用可 import 模組**（供 app + 編譯種子共用，杜絕第四套加密）。
- 🔴 **審計缺口**：v0.3.1 §9 **完全沒提** provider 憑證的審計。既有 `SharePointConfig`/`ApiKey` 憑證變更**無審計**；只有 `SystemConfig` 有（AuditLog + ConfigHistory，前後值遮罩）。→ `LlmProvider` create/update/delete/test 應掛 AuditLog + 遮罩版本歷史（歷史內永不存明文/密文）。
- 🔴 **解密 fail-open**：`decryptIfNeeded` 解密失敗**吞錯、回傳原始密文**（`:422`）→ gateway 若沿用，錯金鑰會靜默把亂碼當「key」送 provider。→ gateway 對憑證解密失敗須視為**硬錯誤**。
- **回應遮罩**：`getConfigByKey` 回明文（`:621`）→ 新 provider API 須只回遮罩值，明文僅 gateway 內部用。

---

## 四、🟠 產品與 Scope 批判

### 4.1 Scope 膨脹 vs 真正動機
用戶原話是「**不是只有 2 個選擇**」。被放大成「完整多 provider 配置系統 + 憑證 CRUD UI + 5 provider + per-環節指派 + 成本計價」。這可能**過度工程**（違反 Karpathy「不加未要求的 configurability」）。正確 scope 取決於**真正動機**：
- 省成本 → 不需完整憑證管理 UI
- 避免鎖定/備援 → 需切換，但不需 day-1 就 5 家
- 能力（難文件用更強模型）→ per-環節指派才有意義

→ **新開放問題 D7：真正動機是哪個？**

### 4.2 投資回報押在未驗證假設
D6 說核心提取切非 Azure 前要過準確率回歸。但 prompt 為 GPT 調校——**若他家準確率不過關（很可能），核心提取實際上還是只能用 Azure**，只有次要環節能用他家。那「完整多 provider 系統」建完、核心場景用不上。
→ **先 spike（1-2 天）**：真實文件 × Claude/Gemini 跑 Stage 3，量測**準確率 + confidence 分佈變化**（同時驗證 §2.1 炸彈）。**用結果決定投資規模。**

### 4.3 誠實 push back D3（不做 Phase 1）
D3 是你的決定，但作為資深工程師我必須誠實：閘門式分階段不是拖延，是把「完整 UI/憑證系統」的投資**延到不確定性解決之後**。真正不確定的是準確率 + confidence 失準——應在投入完整系統**之前**驗證。見 §六重構 roadmap。

---

## 五、🟠 架構批判

- **資料模型指派耦合**：指派存 `SystemConfig.value = LlmModel.id`（字串軟外鍵、無 FK）。既然都在加 Prisma model，指派也該 model 化（`StageModelAssignment`，FK + onDelete）以獲得 referential integrity，比塞字串健全。
- **AI SDK lock-in**：核心提取管線綁 Vercel AI SDK v6（版本演進快、每 major 有 breaking change）。緩解須明確：gateway 薄封裝隔離、pin 版本、關注 changelog。
- **測試策略太理想化**：「準確率回歸」缺落地——**哪來 labeled 測試集？怎麼量（欄位級 exact / 金額容差）？通過門檻？** LLM 非確定性 → 要跑多次取統計。§13 需補具體方法。
- **rollout 安全缺失**：核心管線改動卻無 feature flag / shadow mode / rollback。**好消息**：§2.2 的百分比灰度已存在可複用 → 建議 gateway 走 feature flag + shadow mode（新舊並行比對 confidence 分佈）再灰度切換。

---

## 六、建議的重構 Roadmap（取代 v0.3.1 §12 的直接全做）

| Phase | 內容 | 目的 | 規模 |
|-------|------|------|------|
| **Phase 0（新增）Spike** | 真實文件 × 2-3 provider 手動跑 Stage 3，量準確率 + confidence 分佈 | **決定整個 Epic 是否/如何做** | 1-2 天 |
| **Phase 1 Gateway 收斂（仍 Azure）** | AI SDK gateway + 抽共用加密模組 + **主管線用量持久化**（修 §2.2 成本斷裂）+ 結構化 logging + feature flag/shadow mode | 技術債紅利 + 營運地基，**低風險** | 中 |
| **Phase 2 第 2 provider + 校準框架** | 1 個非 Azure provider（env 憑證先，輕量）+ **per-model confidence 校準**（修 §2.1 炸彈）+ 準確率回歸框架 + circuit breaker/failover | 驗證多 provider 真可行 | 大 |
| **Phase 3 完整治理（僅在確認需要時）** | 完整後台 CRUD 憑證 UI + keyVersion + 審計 + 出站限流 + 成本 per-provider + 其餘呼叫點遷移 | 完整產品化 | 大 |

> 關鍵差異：**營運地基（用量持久化、logging、feature flag）提前到 Phase 1**（即使只 Azure 也該有）；**confidence 校準與 provider 韌性是 Phase 2 的一等公民**，非事後補。完整憑證 CRUD UI 延到確認有多人要配置才做。

---

## 七、需要你拍板的新開放問題

| # | 問題 | 為何要問 |
|---|------|----------|
| **D7** | 多 provider 的**真正動機**？省成本 / 備援 / 能力 | 決定正確 scope（§4.1） |
| **D8** | 是否先做 **1-2 天 spike** 驗證準確率 + confidence 分佈，再定投資規模？ | 最大不確定性應先解（§4.2） |
| **D9** | 信心度路由 **per-model 校準**怎麼做？（per-model 閾值配置 + 校準集）—— 這是安全換模型的前提 | P0 炸彈（§2.1） |
| **D10** | scope 縮減：先 gateway + 少量 provider（env 憑證），還是照 v0.3.1 直接完整 CRUD 憑證系統？ | 避免過度工程（§4.1/§六） |
| **D11** | 營運骨架（用量持久化、韌性、可觀測、出站限流）納入 Epic 23，還是拆獨立治理 Epic？ | §2.2 工作量大 |

---

## 八、我建議直接改進規格的項目（待你同意後落到 v0.4.0）

無爭議、有 code 證據支持、可直接補：
1. §風險 + §Story 補 **confidence per-model 校準**（P0）。
2. §資料模型加 **`keyVersion`** 欄位（前向相容）。
3. §憑證補 **抽共用加密模組**、**審計（AuditLog + 遮罩歷史）**、**gateway 解密硬錯誤（不 fail-open）**、**回應遮罩**。
4. §Story/§測試補 **主管線用量持久化**（修成本斷裂）+ **結構化 logging** + **feature flag/shadow mode rollout**。
5. §測試落地 **準確率量測方法 + labeled 測試集來源 + 通過門檻**。
6. §Roadmap 改為 §六的 Phase 0–3。

（需你決策的 scope/動機/分階段 = D7–D11，不逕改。）

---

## 附錄：三份 code 調查證據索引

- **調查 A（模型耦合）**：confidence 65% 模型自評 + 90/70 硬編（`confidence-v3-1.service.ts:112-119`）；下游 template `classifiedAs`/FX 內容耦合；傳輸協定散佈 5+ 呼叫點（`unified-gpt-extraction` 未走白名單）。
- **調查 B（營運）**：`logUsage` 零呼叫端；三套硬編定價；無 circuit breaker；批次空燒 retry；灰度機制可複用。
- **調查 C（憑證）**：GCM 健全但僅防 DB 外洩；無 keyVersion；加密 helper private；§9 無審計；`decryptIfNeeded` fail-open（`:422`）。
