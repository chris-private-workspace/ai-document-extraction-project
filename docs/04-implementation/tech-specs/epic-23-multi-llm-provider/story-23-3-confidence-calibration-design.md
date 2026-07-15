# Story 23.3 — 信心度路由 per-model 校準：設計文件（待拍板）

> **這份文件是什麼**：把 tech-spec §6.1（信心度路由 per-model 校準，三輪審視 P0）落地為**可實作的設計**，並把 **D9（校準的具體做法）** 從「暫緩」推進到「可拍板」。**本文件不含 code**——待使用者拍板設計選項後才進實作。
> **狀態**：🟡 設計提案，待使用者拍板（D9-a ~ D9-e）
> **關聯**：`tech-spec-epic-23-overview.md` §6.1 / §11.5、`phase-0-spike-report.md`（炸彈①）、`senior-review-v0.3.1.md`（頭號風險）
> **H1 聲明**：實作階段會動 `confidence-v3-1.service.ts` 路由邏輯 → 觸發 H1，需 approve（見 §6）
> **建立**：2026-07-15

---

## 1. 背景與問題

信心度路由分數**約 65% 來自模型自評 confidence**（Stage 1+2+3），配 `confidence-v3-1.service.ts:112-119` 的**硬編 90/70 閾值**，而這組閾值是針對 **GPT-5 自評分佈**校準的。

- **炸彈①（Phase 0 spike 真實資料確認）**：同模型內 confidence 恆在 92–99、與正確性脫鉤，42/42 全 `AUTO_APPROVE`。
- **風險**：換 provider/model 後自評習性一變 → **靜默**造成大量錯誤 `AUTO_APPROVE`（漏審）或灌爆 `FULL_REVIEW`（人工爆量），直接打穿「90–95% 自動化率」，且**不報錯**。
- **§6.1 定調**：換任何非 Azure 模型做核心提取前，**必須** per-model 重新校準閾值——這是**實作前提**，非事後補。

---

## 2. 現況分析（實作落點）

### 2.1 閾值消費點 — `confidence-v3-1.service.ts`

```
ROUTING_THRESHOLDS_V3_1 = { AUTO_APPROVE: 90, QUICK_REVIEW: 70, FULL_REVIEW: 0 }  // 硬編 const（:112-119）
calculate(input, options)   // static 純函數；options 已支援 weights 覆蓋，但無 thresholds
  ├─ determineLevel(overallScore)              // 用閾值決定 level
  └─ generateRoutingDecision(input, overallScore)  // 用閾值 + 智能降級生成路由
```

- **關鍵**：`calculate` 是 **static 純函數、不查 DB**，input 僅三階段結果（`stage1/2/3Result`）——**不含** model/provider 資訊。
- **有利點**：`options.weights` 已是「呼叫端傳入覆蓋值」的成熟 pattern，`thresholds` 可循同一路徑注入，**維持純函數**（不在 confidence 層查 DB）。

### 2.2 模型指派來源 — `LlmModelConfigService`

- `getStageModel(stage)` 回 modelKey；fallback 鏈 `StageModelAssignment → SystemConfig → DEFAULT_STAGE_MODELS`。
- 已能解析「stage3 實際用哪個 `LlmModel`（含 provider）」——是取 per-model 閾值的天然入口。

### 2.3 資料模型（`prisma/schema.prisma`）

| model | 可用於掛閾值的欄位 |
|-------|-------------------|
| `LlmModel` | 已有 `capability Json` / `pricing Json?` 先例 → 可加 `routingThresholds Json?`（nullable） |
| `LlmProvider` | 已有 `extraConfig Json?` → 可作 provider 級 fallback |
| `StageModelAssignment` | stageKey → llmModelId（校準是 per-model 而非 per-stage，故不掛這裡） |

> 加 nullable Json 欄位屬 **H1 例外**（「純加 nullable 欄位除外」），且專案 db-push 驅動、向後相容。

---

## 3. 設計提案（待拍板決策 D9-a ~ D9-e）

### D9-a — 閾值的儲存位置與粒度

| 選項 | 方案 | 優 | 缺 |
|------|------|----|----|
| **A（建議）** | 主粒度 **per-model**：`LlmModel.routingThresholds Json?` = `{ autoApprove, quickReview }`；provider 級用 `LlmProvider.extraConfig.routingThresholds` 作 fallback | 最貼合 §6.1「per-model」；同 provider 不同模型（mini vs nano）自評習性不同，需分別校準 | 需加 schema 欄位（nullable，低風險） |
| B | 只做 **per-provider**（`LlmProvider.extraConfig`） | 不改 schema | 粒度太粗，同 provider 多模型共用一組閾值不安全 |
| C | 存 `SystemConfig`（軟外鍵 model.id → thresholds） | 不改 schema | 失去 FK 完整性；與既有 id-based 指派體系不一致 |

**建議 A**：per-model 為主、per-provider 為輔 fallback。

### D9-b — fallback 鏈（確保行為零變）

```
per-model routingThresholds（LlmModel）
  → per-provider routingThresholds（LlmProvider.extraConfig）
    → 全域預設 ROUTING_THRESHOLDS_V3_1（90/70）  ← 現值，未配置時行為零變
```

- **未校準的模型（含現有 Azure gpt-5.4）** → 落到全域 90/70 → **Azure 行為完全零變**。
- 這是「地基先行、資料後填」的安全設計：機制先上，per-model 閾值待 gold set 到位再逐一填。

### D9-c — confidence 層注入點（保持純函數）

- `ConfidenceV3_1Service.calculate` 的 `options` 加 `thresholds?: { autoApprove; quickReview }`；`determineLevel` / `generateRoutingDecision` 改用「傳入值 ?? `ROUTING_THRESHOLDS_V3_1`」。
- 新增 **threshold resolver**（建議放 `LlmModelConfigService.getRoutingThresholds(modelIdOrStage)`），執行 D9-b fallback 鏈、回具體閾值。
- **呼叫端串接**：Stage 3 / orchestrator / `unified-processor` 的 confidence 計算步驟，解析 stage3 實際 model → resolver → 傳 `options.thresholds`。
- **好處**：confidence service 維持不查 DB 的純函數（可測試性不變）；DB 存取集中在 resolver。

### D9-d — per-model 閾值怎麼校準得出（依賴 gold set，目前阻塞）

> 🔴 **此步被外部資源阻塞**：需 (a) 非 Azure API key、(b) 已標註 gold set（本地 71 份無 ground truth）。與 §6.2 準確率回歸**同一批文件**一起做。

校準流程（設計）：
1. 對目標 model 跑 gold set（每份 N 次取統計，避非確定性）。
2. 收集 `overallScore` 分佈 vs 實際正確性（欄位級比對）。
3. 定 `autoApprove` 使該閾值以上的精度達標（如 ≥ 現行 Azure 基準）；定 `quickReview` 為可接受人工負載的下界。
4. 寫入該 `LlmModel.routingThresholds`。
5. 上線後用 D9-e 監控驗證分佈未漂移。

### D9-e — 監控哨兵（provider 品質漂移）

- 記錄 per-model/provider 的 `AUTO_APPROVE` / `QUICK_REVIEW` / `FULL_REVIEW` 率。
- 可複用 Story 23.1 step 5 的用量持久化管道（`ApiUsageLog` / `aiLogger`）附掛路由結果，或另立輕量計數。
- 率值偏離校準預期 → 告警，作為換 provider 後的第一道防線。

---

## 4. 分階段實作建議

| Phase | 範圍 | 前置 | 行為影響 |
|-------|------|------|----------|
| **P1（現在可做）** | schema 加 `routingThresholds`（nullable）+ threshold resolver + confidence `options.thresholds` + D9-b fallback + 單元測試 | 無 | **零變**（全落全域 90/70） |
| **P2** | 校準流程腳本 + gold set 實測 + 逐一填 per-model 閾值 + §6.2 準確率回歸整合 | 🔴 非 Azure key + gold set | 換模型時生效 |
| **P3（中長期）** | 監控哨兵 + 降低 confidence 自評依賴（改倚重 FIELD_COMPLETENESS / 跨欄位驗證 / 金額對帳等確定性訊號） | P1/P2 | 路由演算法演進（H1） |

> **本次「先出設計文件」交付 = 本文件**。P1 實作為下一個獨立工作單元（需 H1 approve）。

---

## 5. 測試策略（P1）

- **Unit**：resolver fallback 三層（model→provider→全域）各命中；confidence `determineLevel` 邊界（90.0 / 89.9 / 70.0 / 69.9）在「傳入 thresholds」與「預設」下皆正確。
- **行為零變回歸**：未配置 `routingThresholds` 時，`calculate` 對既有輸入產出與現行完全一致的 level/路由。
- **型別**：`thresholds` 選項與 `weights` 一致的 `Partial` 覆蓋語意。

---

## 6. 🔴 H1 影響聲明

| 改動 | 是否觸發 H1 | 說明 |
|------|------------|------|
| `LlmModel` 加 `routingThresholds Json?`（nullable） | ❌ 否 | H1 例外「純加 nullable 欄位」 |
| `confidence-v3-1.service.ts` 加 `options.thresholds` + `determineLevel`/`generateRoutingDecision` 改用傳入值 | ✅ **是** | 動信心度路由邏輯 → P1 實作前需 approve |
| threshold resolver（`LlmModelConfigService` 加方法） | ❌ 否 | 新增 helper、不改既有邏輯 |

**P1 實作啟動前，須就「confidence 路由邏輯改動」取得 H1 approve。** 本設計以「fallback 保持 90/70、Azure 行為零變」把 H1 風險降到最低。

---

## 7. 開放問題（Open Questions）

| # | 問題 | 現況 |
|---|------|------|
| OQ-A | gold set 來源：從既有 AUTO_APPROVE/人工確認歷史文件抽樣標註？規模多少？ | 待定（§13 建議此法；本地 71 份無 ground truth） |
| OQ-B | 非 Azure API key 何時到位（H4 已批方向，實際 key 未提供） | 阻塞 P2 |
| OQ-C | 閾值粒度最終採 per-model（D9-a A）還是保留 per-provider 覆蓋層 | 建議 A，待拍板 |
| OQ-D | 監控哨兵複用 `ApiUsageLog` 還是另立 | 待 P3 定 |

---

## 8. 版本資訊

- **建立**：2026-07-15（v0.1，設計提案）
- **下一步**：使用者拍板 D9-a ~ D9-e → 開 P1 實作工作單元（含 H1 approve）→ 更新 `AI-HANDOFF.md`
