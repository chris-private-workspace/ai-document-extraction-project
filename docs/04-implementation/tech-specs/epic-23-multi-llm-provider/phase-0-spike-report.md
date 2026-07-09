# Epic 23 — Phase 0 先導驗證（Spike）報告

> **Date**: 2026-07-09 ｜ **狀態**: Azure 基準完成；非 Azure 對比待 key（D8 決策的一半）
> **Harness**: `scripts/epic-23-spike/stage3-model-comparison.ts`（+ 診斷 `check-blobs.ts`）
> **目的**（依 `senior-review-v0.3.1.md` §六 Phase 0）：在最小投資點驗證最大不確定性——兩顆炸彈裡「可量測」的部分，用結果決定投資規模。
> **原始資料**（含發票欄位值）：留 scratchpad，不進 repo（H4）。本報告只放聚合數據。

---

## 1. 方法

- **接縫**：不 import 深層服務。讀回每份文件當初送 GPT 的完整 prompt（`extraction_results.stage_3_ai_details.prompt`），原封重送；比對基準 = 該文件原始 GPT 回應（`stage_3_ai_details.response`，原始 JSON）。
- **重放**：Azurite 取原檔 → `PdfConverter` 轉圖 → Azure Stage-3 部署（json_schema，由基準結構推導）→ 解析 → 欄位級比對 + 抓 confidence。
- **量測**：每份文件跑 3 次（測非確定性）；欄位一致率（正規化後值比對）+ 自評 confidence 分佈 + 用 `overallConfidence` 套現行硬編 90/70 模擬路由。
- **樣本**：N=15 抽樣（跨 7 公司分層），1 份因 blob 缺失跳過 → **14 份 × 3 次 = 42 次執行，0 失敗**。

---

## 2. 資料現況（重要前提）

| 項目 | 事實 |
|------|------|
| 本地歷史文件 | 71 份，全 `v3.1`、全 `COMPLETED`、全有 `stage3Result` |
| 原檔圖片 | 70/71 可從 Azurite 取回（1 份舊檔缺失） |
| **人工 ground truth** | 🔴 **0**（`APPROVED`=0、`corrections`=0）→ 準確率只能「與基準一致性」代理，無法算真準確率 |
| 樣本多樣性 | 14 份實際只涵蓋約 **5 份不同發票**（MTL×3、Fairate×5、CEVA×4、DHL×3 多為同檔重複） |
| 原始基準模型 | 71 份 `model` 欄皆記 `gpt-5.2`（此為模型 key） |

**環境限制**：`gpt-5.2` 與 `gpt-5.4-mini` 在 `llm-models.ts` **共用同一部署 env `AZURE_OPENAI_DEPLOYMENT_NAME`**；本地 Azure 只有 2 個實體部署（full + nano）。目前 full = `gpt-5.4-mini-aidocprocessing`。故「本地 Azure Stage-3 基準」實體上就是目前的 full 部署，**無法在本地區分 gpt-5.2 vs gpt-5.4-mini**。

---

## 3. 🔴 炸彈①（信心度 per-model 校準）— 確認且量化

| 指標（42 次執行） | min | avg | p50 | max |
|---|---|---|---|---|
| `overallConfidence` | **92** | 96.7 | 97 | 99 |
| 欄位 confidence（非空欄位） | ~90 | — | 98 | 99 |
| 與基準一致率（%） | **58.3** | 89.9 | 91.7 | 100 |
| 路由模擬（套 90/70） | — | — | — | **42/42 全 AUTO_APPROVE** |

**確鑿證據——confidence 與實際正確性脫鉤**：
- 同一份 MTL 文件、同一模型、跑 3 次，欄位一致率在 **58% ↔ 92%** 間跳動（欄位在「有值 ↔ null」間反覆），但 `overallConfidence` **始終 92–95**。
- 全部 42 次沒有一次 `overallConfidence` < 92 → **100% 會自動通過**，即使該次實際上有 42% 欄位與基準不符。

**含義**：路由總分 65% 來自這個近乎飽和（92–99）的自評 confidence，配硬編 90/70。此訊號在現行單一 Azure 模型下**已幾乎無鑑別力**。換 provider（自評習性不同，如 Claude 偏保守、有些恆回 95-100）→ 分佈平移 → 靜默錯誤路由（漏審或人工爆量）。**senior review 的頭號炸彈在真實資料上成立，且機制比理論更嚴重（同模型內 confidence 就已不可靠）。**

→ **結論**：任何非 Azure 模型接核心提取前，**per-model confidence 校準（D9）為硬前提**；中長期應降低對模型自評 confidence 的依賴，改倚重確定性訊號（欄位完整率、跨欄位/金額對帳）。

---

## 4. 非確定性（附帶量化）

- 同文件 3 次執行，欄位一致率標準差可觀（單份最差 58%↔92%）；主要來源是**部分欄位在「抽取到值 ↔ 回 null」間反覆**（confidence 隨之 0 ↔ 90+）。
- 這是 LLM 本質非確定性，且**confidence 不反映它**——再次佐證 §3。
- 對 Epic 的含義：任何準確率/一致率量測都必須跑多次取統計（本 harness 已內建 RUNS）。

---

## 5. 炸彈②（準確率）— 本階段無法定論

- 無人工 ground truth → 只能量「與現行 Azure 基準一致率」（avg 89.9%），這**混入了模型非確定性**、也**不是真準確率**。
- 真正的準確率回歸需要：(a) 一個非 Azure provider（待 key，D8 的另一半）+ (b) 有正確答案的 gold set（本地目前沒有）。
- 故炸彈②**維持未決**，屬 Phase 2 / 待 key。

---

## 6. Harness 狀態（可重用）

- 端到端驗證通過；`callModel` 已抽象為可替換。
- **接非 Azure**：只要在 `buildAzureCaller` 旁加一個 AI SDK caller（`generateObject` 天生解決 §7 的 json_schema 結構問題），其餘（取樣/取圖/比對/統計）不動。
- 建置中順帶修的兩個保真問題已記錄於程式註解：模型部署對齊、json_schema 強制結構。

---

## 7. 限制與 caveat（誠實標註）

1. **樣本薄**：14 份實約 5 份不同發票；confidence 分佈與一致率**不足以代表全量**。若要嚴謹 go/no-go，需更多不同發票。
2. **無 ground truth**：準確率為一致性代理，非真值。
3. **共用部署**：本地無法區分 gpt-5.2/mini；基準 = 目前 full 部署。
4. **推導 schema**：json_schema 由基準回應結構推導（僅鎖結構、不鎖值），非生產的 `generateOutputSchema` 原件。
5. **字型警告**：`pdf-to-img` 缺 `LiberationSans` 標準字型（非致命，圖片文字渲染可能略有差異；轉圖仍成功）。

---

## 8. 對投資規模的建議（Phase 0 的目的）

| 判斷 | 依據 |
|------|------|
| **炸彈①確認 → per-model 校準是硬前提** | §3；Story 23.3 的 confidence 校準框架維持 P0，不可省 |
| **炸彈②仍未決，且被兩件事卡住** | §5：待非 Azure key（D8 另一半）+ 本地缺 gold set/多樣本 |
| **Gateway 收斂 + 營運地基（Story 23.1，全 Azure）與上述無關、可先做** | 低風險、交付技術債紅利 + 營運地基，不賭在未驗證假設上 |

**建議路線**：
1. **可先推進 Story 23.1**（gateway 收斂 + 用量持久化 + logging + feature flag，全 Azure、行為零變）——它的價值不依賴非 Azure 是否過關。
2. **非 Azure 對比（炸彈② + 真正的 per-model confidence 分佈）** 等兩件事到位再做：(a) 使用者提供非 Azure key；(b) 補一批**不同發票 + 少量人工 gold set**（否則準確率結論不夠力）。
3. **confidence 校準框架** 確認為接任何非 Azure 核心提取的 gate。

---

## 附錄：關鍵檔案

- Harness：`scripts/epic-23-spike/stage3-model-comparison.ts`
- Blob 診斷：`scripts/epic-23-spike/check-blobs.ts`
- 原始逐筆結果（含發票值，不進 repo）：scratchpad `spike-baseline-*.json`
- 相關規格：`tech-spec-epic-23-overview.md` §6.1（D9）、`senior-review-v0.3.1.md` §2.1
