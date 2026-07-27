# Story 23.3 — 信心度路由 per-model 校準：設計文件（待拍板）

> **這份文件是什麼**：把 tech-spec §6.1（信心度路由 per-model 校準，三輪審視 P0）落地為**可實作的設計**，並把 **D9（校準的具體做法）** 從「暫緩」推進到「可拍板」。
> **狀態**：✅ **D9-a 已拍板（2026-07-27，採方案 A：per-model 為主 + per-provider fallback）；P1 已實作**（H1 同日 approve）。P2（實際校準值）仍待 gold set + 非 Azure key；P3 未開工。
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
>
> ⚠️ **2026-07-27 更新**：(a) 已到位；但**本節的流程前提已被實測推翻**——步驟 2「收集 `overallScore` 分佈 vs 實際正確性」的產物顯示兩者相關性近乎零，步驟 3「定 `autoApprove` 使精度達標」因此無解。**執行本節前必須先解 OQ-E（§7.1）**。

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
| **P1** ✅ **已完成（2026-07-27）** | schema 加 `routingThresholds`（nullable）+ threshold resolver + confidence `options.thresholds` + D9-b fallback + 單元測試 | 無 | **零變**（全落全域 90/70） |
| **P2** ⚠️ **前提待重評** | 校準流程腳本 + gold set 實測 + 逐一填 per-model 閾值 + §6.2 準確率回歸整合 | 🔴 gold set（非 Azure key 已到位）；**且需先解 OQ-E** | 換模型時生效 |
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

> ✅ **H1 approve 記錄**：使用者於 **2026-07-27** 批准 confidence 路由邏輯改動，並選定 D9-a **方案 A**（per-model 為主 + per-provider fallback）。P1 已於同日實作完成。

### P1 實際落點（實作後補記）

| 落點 | 檔案 | 說明 |
|------|------|------|
| schema | `prisma/schema.prisma` + `migrations/20260727030000_add_routing_thresholds_to_llm_models/` | `LlmModel.routingThresholds Json?`（nullable，向後相容） |
| resolver | `src/services/llm-model-config.service.ts` | `getRoutingThresholds(stage)`：per-model → per-provider → **null**（第 3 層刻意回 null，讓「全域 90/70」的唯一來源留在 confidence service，避免本服務反向依賴 extraction 層）；格式不合法（型別錯／值域倒置／超界）視為未設定並 `aiLogger.warn`，不靜默 |
| confidence | `src/services/extraction-v3/confidence-v3-1.service.ts` | `options.thresholds`（Partial 語意）+ `resolveThresholds()`；`determineLevel` / `generateRoutingDecision` / `applyRoutingStrategy` 改用傳入值，預設參數仍為 `ROUTING_THRESHOLDS_V3_1` → **未傳即行為零變**。`getSmartReviewType` 未串（外部簡化 API，維持全域閾值） |
| 呼叫端 | `src/services/extraction-v3/extraction-v3.service.ts` | Step 6 前解析 stage3 閾值；讀取失敗只記 `warnings`、不阻斷提取 |
| 測試 | `tests/unit/services/routing-thresholds-calibration.test.ts` | 15 個：resolver fallback 三層 + 不合法格式 + 停用情境；邊界 90/89.9/70/69.9 行為零變；覆蓋生效 + Partial 語意 |

---

## 7. 開放問題（Open Questions）

| # | 問題 | 現況 |
|---|------|------|
| OQ-A | gold set 來源與規模 | 🟡 **定位已改**：非交付前提，僅選項 A 強制需要（見 §7.1 更正）。本地實測**無法建立**（僅 9 份可用、2 間公司、全 AUTO_APPROVE）；投入標註前應先查 Azure DEV 的審核記錄是否已有累積 |
| OQ-B | ~~非 Azure API key 何時到位（H4 已批方向，實際 key 未提供）~~ | ✅ **已解決**（2026-07-27 key 到位，spike 已對 claude-opus-5 實跑 18 回合） |
| OQ-C | ~~閾值粒度最終採 per-model（D9-a A）還是保留 per-provider 覆蓋層~~ | ✅ **已解決**（2026-07-27 拍板方案 A：per-model 主 + per-provider fallback） |
| OQ-D | 監控哨兵複用 `ApiUsageLog` 還是另立 | 待 P3 定 |
| **OQ-E** | **P2 的前提已被實測推翻。根因（自評不可靠）已拆出為 [OQ-Q5](../../../open-questions.md)；本 OQ 收斂為「Epic 23 側該如何處置」** | 🔴 **待拍板**（詳見下方 §7.1） |

### 7.1 OQ-E 詳述：P2 前提的實測推翻與方向選項

> **提出日期**：2026-07-27（Anthropic 首次實跑後）
> **決策者**：使用者
> **影響**：決定 P2 的交付物是什麼，以及 Story 23.4「打通非 Azure」的安全閘該由誰擔任

#### 🔴 2026-07-27 重要拆解：根因不屬於 Epic 23

追問「為了支援多 provider，到底為什麼需要 gold set」之後，重新檢視推論鏈：

```
Epic 23 目標：能換 LLM provider
   ↓
炸彈①：路由 65% 依據是模型自評，90/70 切點是照 Azure 調的
   ↓
擔憂：換模型 → 自評分佈變 → 該人審的被自動放行
   ↓
處方：per-model 重新校準閾值
   ↓
校準需要知道哪些提取是錯的 → 需要 gold set
```

gold set 與「切換 provider」之間隔了三層推導。而實測結果顯示，**第二層的前提本身就錯了**：不是「Azure 校準過、其他模型沒有」，而是**兩個 provider 的自評都與正確性脫鉤**（Azure 92–99 恆定、Claude 96–97 恆定）。

**結論：這是現行 Azure 流程即存在的問題，換 provider 只是把它照出來。**

因此於 2026-07-27 把「信心度路由主要依據不可靠」**自 Story 23.3 子項提升為獨立議題 → [OQ-Q5](../../../open-questions.md)**。理由：

| 判準 | 說明 |
|---|---|
| 影響範圍 | 影響**每日實際處理的 Azure 流程**，不是未來的 provider 切換 |
| 成因歸屬 | 非 Epic 23 產物；Epic 23 只是發現者 |
| 優先級 | 論影響面其實**高於**換 provider |
| 若綁在 Epic 23 | 會讓一個獨立的既有問題**阻塞**一個已經可交付的能力 |

#### 兩件被綁在一起、應該拆開的事

| | 需要 gold set？ | 現況 |
|---|---|---|
| **(a) 切換能力本身**——provider 設定、憑證加密、呼叫路由、連線測試、熔斷、failover | ❌ 完全不需要 | **基本完成**（2026-07-27 實測 Anthropic 由 UI 一路通到對方 API） |
| **(b) 核心提取實際跑在非 Azure 上** | ⚠️ 僅在要**量化**安全性時需要 | 被 `getStageModel` 的 Azure 閘門擋著 |

gold set 只與 (b) 相關，且非必要條件——見下方「各選項是否真的需要 gold set」。

#### 原本的假設

D9-d 的校準流程建立在一個假設上：**不同模型的自評分佈不同，但各自具有鑑別力**——好的給高分、差的給低分，只是刻度不同。若成立，則 per-model 重定切點即可修正錯誤路由。

#### 實測結果（claude-opus-5，9 份文件 × 2 回合 = 18 回合，0 失敗）

| 該文件與 Azure 基準的欄位一致率 | 模型自評 `overallConfidence`（兩回合） |
|---|---|
| 100%（3 份） | 96 / 96、96 / 97、97 / 96 |
| 96% | 96 / 96 |
| 92%（2 份） | 97 / 96、97 / 96 |
| 88% | 96 / 96 |
| 82.6% | 96 / 96 |
| 80% | 96 / 97 |

準確率橫跨 **20 個百分點**，自評分數恆定於 **96–97**。模擬路由：**18/18 全數 AUTO_APPROVE**。

#### 為何「調閾值」救不了

關鍵區別在於**分佈位移**與**分佈退化**：

| 型態 | 現象 | 調閾值有效？ |
|---|---|---|
| **位移**（原假設） | Claude 普遍比 Azure 高 5 分，但好的 98 / 差的 88 | ✅ 切點從 90 移到 95 即修正 |
| **退化**（實測） | 好的 96、差的也 96 | ❌ **不存在任何切點能分開**——切在 96 全過（含 80% 那份），切在 98 全退（含 100% 三份） |

#### 這不是 Claude 的問題

Phase 0 在 **Azure** 上量到同樣現象：`confidence` 恆定 92–99、與正確性脫鉤、42/42 全 AUTO_APPROVE。兩個 provider 表現一致，指向的是**「以模型自評作為路由主要依據」這個設計本身**。

而自評的權重佔比不小——`extraction-v3.types.ts:1282-1289` 的五維權重中，Stage 1（20%）+ Stage 2（15%）+ Stage 3（30%）**全部來自模型自評，合計 65%**；其餘 35% 才是確定性訊號（FIELD_COMPLETENESS 20% + CONFIG_SOURCE_BONUS 15%）。

#### 方向選項

| 選項 | 做法 | 優點 | 代價 / 風險 |
|---|---|---|---|
| **A. 照原計畫** | 等 gold set 出來，照 D9-d 算出 per-model 數字 | 不動架構；已完成的 P1 直接可用 | **只能修正位移，無法處理退化**——校準完的安全閘實質上仍擋不住錯誤路由，等於給了虛假的安心感 |
| **B. 重新定義 P2** | 把路由主要依據從模型自評換成不依賴自評的訊號（跨欄位驗證、金額對帳、跨模型比對等） | 治本；同時改善 Azure 現況 | 動信心度演算法 → **觸發 H1**；工作量大；仍需 gold set 驗證 |
| **C. 兩件事脫鉤（建議）** | P1 機制保留為「可調旋鈕」不再宣稱是安全閘；換 provider 的把關另設機制（P3 的監控哨兵前移，或雙模型比對） | 不阻塞任何進度；P1 已完成且零風險；把「校準」與「換 provider 安全性」兩個被混在一起的問題拆開 | 需要另行設計把關機制；短期內非 Azure 仍不得用於核心提取 |

**建議 C**。理由：A 的問題不是做不出來，而是做出來也擋不住該擋的東西；B 方向正確但一次要動的東西太多。C 讓已完成的 P1 保持其真實價值（吸收真正的分佈位移），同時誠實地承認它不足以擔任換 provider 的安全閘。

#### ⚠️ 更正：各選項是否**真的**需要 gold set

本文件 v0.3 曾寫「無論選哪個方向都需要 gold set」。逐一重新推導後，**該敘述過度概化，僅對選項 A 成立**：

| 選項 | 真的需要人工標註嗎 | 理由 |
|---|---|---|
| **A** | ✅ **必須** | 閾值的定義即「該分數以上精度達標」，沒有正確答案就算不出精度 |
| **B** | ⚠️ 部分 | **驗證**新訊號好壞需要；但部署一組確定性檢查（金額加總對帳、幣別一致、日期合法、參考編號匹配）**不需要**——這些不需知道正確答案即可判定異常 |
| **C** | ❌ **不需要** | 若把關機制為「兩模型不一致即不自動放行」，該閘門**天生只會讓路由更保守**，不可能把原本該人審的變成自動通過 → **不需 ground truth 即可安全上線**。gold set 只用於量化誤擋率 |

即：**本文件建議的選項 C，恰是唯一不強制需要 gold set 的**。

#### 第三條路：讓 ground truth 自己長出來

審核工作流（Epic 3）的人工修正**本身就是標註**——`corrections` / `field_correction_history` / `review_records` 記錄的正是「人看過之後認為正確答案是什麼」。

| 環境 | 筆數 | 查核日期 |
|---|---|---|
| 本地 | `corrections` **0** / `field_correction_history` **0** / `review_records` **0** | 2026-07-27 |
| Azure DEV | **尚未查** | — |

若 Azure DEV 上已有累積，gold set 可能**不需另辦標註活動**即存在。此為投入標註前應先查核的事項。

#### 一個候選訊號（證據薄弱，尚不足以作為結論）

同一批資料中，**模型自評不隨品質變動，但「兩個模型之間的一致率」有變動**（80%→100%）。這暗示跨模型比對可能帶有自評所缺的鑑別力。

⚠️ **證據強度限制，勿過度外推**：
- 樣本僅 9 份，其中 **8 份為 CEVA**、1 份 NEX（其餘取樣文件的 blob 在本地 Azurite 已 404）。
- 「一致率」比對基準是 **Azure 的原始輸出**，非人工核對的 ground truth → 只能說明「兩模型看法差異的程度」，**不能說明誰對**。

#### OQ-A 的地位（已更正）

~~無論選 A、B 或 C 都需要 gold set，OQ-A 升級為所有方向的共同阻塞。~~ → 見上方「各選項是否真的需要 gold set」的更正：**只有選項 A 強制需要**。

OQ-A 現在的定位是：**量化工具，而非交付前提**。且在投入標註前應先查 Azure DEV 的審核記錄（可能已存在）。

**本地素材盤點結果（2026-07-27，`scripts/epic-23/gold-set-inventory.ts`）——本地無法建立 gold set：**

| 指標 | 數字 |
|---|---|
| DB 中 COMPLETED 提取結果 | 89 |
| **原始檔實際取得到** | **9**（Azurite 僅存 9 個 blob，其餘 80 份遺失） |
| 涵蓋公司 | 2（CEVA 8 / Nippon 1） |
| 處理路徑 | **全部 AUTO_APPROVE** |

三個獨立的否決理由：(1) 量少且偏斜；(2) 這 9 份**正是 spike 用的同一批**，構成循環論證；(3) **樣本形狀錯誤**——校準閾值需要「應該被擋下來」的案例，而這 9 份全在切點同一側。

#### 決策所需輸入

1. **核心提取是否真的需要換掉 Azure？** 若商業動機是成本／備援而非「Stage 3 必須用非 Azure」，則整條校準路線可不走——非 Azure 僅用於不影響路由的環節，本 OQ 降級。
2. 若確定要換：選 A / B / C（建議 C）。
3. 若選 C：換 provider 的把關機制由誰擔任（P3 監控哨兵前移？雙模型比對？）——可另開 CHANGE 設計。
4. 「自評不可靠」本身如何處置 → 已移交 **[OQ-Q5](../../../open-questions.md)**，與本 OQ 分開決策。

---

## 8. 版本資訊

- **建立**：2026-07-15（v0.1，設計提案）
- **v0.2**：2026-07-27 — D9-a 拍板方案 A + H1 approve + **P1 實作完成**（含實際落點表）
- **v0.3**：2026-07-27 — Anthropic 首次實跑後新增 **OQ-E（§7.1）**：P2 前提被實測推翻（自評分佈為**退化**而非位移，調閾值無解）；OQ-B 已解決
- **v0.4**：2026-07-27 — 🔴 **根因拆出**：「信心度路由自評不可靠」屬**現行 Azure 流程既有問題**、非 Epic 23 產物 → 提升為獨立議題 **[OQ-Q5](../../../open-questions.md)**。OQ-E 收斂為「Epic 23 側如何處置」。同時更正 v0.3 的過度概化（「所有方向都需要 gold set」實際僅對選項 A 成立）；補本地素材盤點結果（本地無法建立 gold set）
- **下一步**：先確認**核心提取是否真的需要換掉 Azure**；若不需要，本 OQ 可降級（多 provider 能力已具備，非 Azure 先用於不影響路由的環節）。期間所有模型落全域 90/70，行為零變；非 Azure 仍不得用於核心提取（`getStageModel` 的 Azure 閘門仍在）。
- ⚠️ **部署注意**：`routing_thresholds` 欄位若要上 Azure DEV，需先把該 migration 的 DDL 以冪等形式加入 `prisma/apply-schema-drift.js` 並帶 `RUN_SCHEMA_DRIFT_FIX=true`（容器 entrypoint 不跑 `migrate deploy`）。
