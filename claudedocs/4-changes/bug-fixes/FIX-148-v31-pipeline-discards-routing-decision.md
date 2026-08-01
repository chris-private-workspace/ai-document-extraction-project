# FIX-148: V3.1 管線丟棄算好的路由決策，改用分數重推 —— 5 個既有降級機制與 per-model 閾值全部失效

> **建立日期**: 2026-07-31
> **發現方式**: FIX-147 的對帳閘在 Azure DEV 實測「偵測到了但沒降級」，逐段追透傳鏈時發現
> **影響範圍**: `src/services/extraction-v3/extraction-v3.service.ts`（V3.1 主管線 Step 7）
> **優先級**: 高（多個安全網長期無聲失效），但**修復本身是行為變更**，需先評估審核量衝擊
> **狀態**: ⏳ 待實作（使用者 2026-07-31 決定：FIX-147 先以最小範圍繞過，本 FIX 另行評估）。**影響評估已於 2026-08-01 完成**，見 §影響評估結果 —— 驗收 1 達成，尚待使用者裁決是否啟用
> **相關**: FIX-053（統一路由策略，本缺陷是它沒涵蓋到的第三條路徑）、FIX-147（發現本缺陷的契機）、FIX-124（`isNewFormat` 旗標的修復者，直接決定本評估的有效資料範圍）

---

## 缺陷

`extraction-v3.service.ts` Step 7（原 631-638 行）：

```typescript
// 根據信心度決定路由
let routingPath: 'AUTO_APPROVE' | 'QUICK_REVIEW' | 'FULL_REVIEW';
if (confidenceResult.overallScore >= 90) {
  routingPath = 'AUTO_APPROVE';
} else if (confidenceResult.overallScore >= 70) {
  routingPath = 'QUICK_REVIEW';
} else {
  routingPath = 'FULL_REVIEW';
}
```

上一步（595 行）才剛呼叫 `ConfidenceV3_1Service.calculate()`，它內部已經算出完整的
`routingDecision`（含所有覆蓋與降級）。但這裡**只用分數重推一次**，把它整個丟掉。

`grep` 證實：`confidenceServiceResult` 全檔只被引用 4 次 —— `.success`、`.error`、
`.result` ×2。**`.routingDecision` 從未被讀取。**

---

## 一併失效的機制

`applyRoutingStrategy()`（`confidence-v3-1.service.ts`）裡的邏輯全部算了但沒人用：

| # | 機制 | 引入來源 |
|---|---|---|
| 1 | 新公司 → AUTO_APPROVE 降 QUICK_REVIEW | CHANGE-025 |
| 2 | 新格式 → AUTO_APPROVE 降 QUICK_REVIEW | CHANGE-025 |
| 3 | 配置來源 `LLM_INFERRED` → 降級 | CHANGE-025 |
| 4 | >3 項需分類 → 降級 | CHANGE-025 |
| 5 | 任一 Stage 失敗 → 強制 FULL_REVIEW | FIX-053 |
| 6 | 行項合計不符 → 強制 FULL_REVIEW | FIX-147 |

另有第 7 項：第 587 行才剛查完 per-model 路由閾值、603 行傳進 `calculate()`，
632 行卻硬寫死 90/70 —— **Epic 23 Story 23.3 的 per-model 閾值校準在本路徑上也是失效的**。

> ⚠️ **不可過度延伸**：`newCompanyDetected` / `needsConfigReview` 等旗標**仍有回傳**
> （665-674 行），下游可能另有用途。本 FIX 確認的是「**路由決策本身**沒有套用它們」，
> 不等於「這些旗標完全沒作用」。修復前應先盤點下游實際消費者。

---

## 為何長期沒被發現

1. **90/70 與預設閾值相同** —— 沒有任何降級條件成立時，兩種算法結果完全一致。差異只在該降級時才顯現，而那正是最不容易注意到的時候（本該進人工審核的文件靜靜地自動放行了）。
2. **信心度在 Azure 上恆高** —— Epic 23 Phase 0 spike 實測 42/42 全 `AUTO_APPROVE`、confidence 92-99 且與正確性脫鉤（見 memory `project_epic23_phase0_spike` 與 OQ-Q5）。分數幾乎永遠 ≥ 90，於是「有沒有套用降級」在日常觀察中看不出區別。
3. **FIX-053 只統一了兩條路徑** —— `generateRoutingDecision()` 與 `getSmartReviewType()`。這第三條路徑（管線自己重推）當時沒被納入盤點。

---

## 證據

| # | 事實 | 取得方式 |
|---|---|---|
| 1 | 對帳閘確實偵測到不符 | Azure 容器 log：`01:26:46 [Stage3] FIX-147 line item total mismatch: sum=14109.44 vs total_amount=14579.5 (diff=-470.06, tolerance=0.05, items=4)` |
| 2 | 但文件仍為 AUTO_APPROVE | `documents.processing_path = 'AUTO_APPROVE'`（文件 `e39e2b17-c84f-4f45-840f-1ade94c65326`） |
| 3 | 路由決策被丟棄 | `grep -n confidenceServiceResult` → 只有 `.success` / `.error` / `.result`，無 `.routingDecision` |
| 4 | 回傳的 `routingDecision` 是本地重建的 | 640-645 行以 `decision: routingPath` 自行組裝，717 行回傳的是它 |

---

## 修復方案（待評估後實作）

把 631-638 改為採用已算好的決策：

```typescript
const routingPath = confidenceServiceResult.routingDecision?.decision
  ?? /* fallback：維持既有分數推導 */;
```

並讓 `routingDecision` 直接沿用 `confidenceServiceResult.routingDecision`
（其 `reasons` 已含各降級原因，比目前用維度分數當 reasons 有意義得多）。

### 🔴 這是行為變更，不是純 bug fix

修好之後，**所有新公司、新格式、LLM 推斷配置的文件會突然開始降級**，進人工審核的量會明顯上升。實作前必須：

1. ✅ **已完成（2026-08-01）** 以現有 Azure 資料估算：若啟用，過去 N 天有多少文件會從 `AUTO_APPROVE` 變成 `QUICK_REVIEW` / `FULL_REVIEW` → 見 §影響評估結果
2. ⏳ 與使用者確認審核量可承受，或決定分階段啟用（例如先只啟用 Stage 失敗與 mismatch 兩項強制條件）
3. ⏳ 確認 per-model 閾值啟用後的實際落點（Epic 23 Story 23.3）

---

## 影響評估結果（2026-08-01，驗收 1）

### 方法與可信度

在 Azure DEV 上重放 `applyRoutingStrategy`，以 `stage_1/2/3_result` 的旗標為輸入，逐份算出「若啟用會是什麼路由」，再與 `documents.processing_path` 比對。

**先驗證讀對了資料**：用「現況邏輯」（分數 + mismatch，即本文件 §缺陷 那段程式碼）重放一次，與資料庫實際值比對 —— **802 / 802 完全吻合**。欄位理解無誤，後續數字才有意義。

### 🔴 初版評估被舊資料污染 —— 過程記錄

全量 802 份的初版結果是 `AUTO_APPROVE` 703 → 296、需人工介入 **99 → 506**（12.3% → 63.1%，+411%），且 407 份降級**全部**由「新格式」觸發。

該數字**不可用**。追查發現：471 份被判 `isNewFormat = true` 之中，370 份的 `formatId` 指向**早已存在**的格式，最久的相隔 30 天 —— 同一個已建檔格式被反覆判為「新」。

但這**不是現行缺陷**。逐日切分後：

| 事實 | 值 |
|---|---|
| 「格式早已建立（>1 小時）卻標記為新」的**最近一筆** | **2026-07-21 08:55** |
| FIX-124 完成日 | **2026-07-21** |
| 該日之後至 2026-08-01（11 天）的同類記錄 | **0 筆** |

`resolveFormatId` 第 5 步無條件回傳 `isNewFormat: true`，而 FIX-124 之前的 `jitCreateFormat` 撞唯一鍵時會**沿用既有格式的 id**，於是產生「有 formatId、卻標記為新」的組合。FIX-124 改為回傳無 id 後，這個組合不再出現（近期樣本全部是「格式與提取同一分鐘建立」的真新建）。

> **教訓**：`isNewFormat` 的歷史值跨越了一次語義修復。任何依賴該旗標的統計，**必須以 FIX-124 為界切分**，否則會把已修復的缺陷算成現行衝擊 —— 誤差達 3 倍。

### 有效結果（僅 2026-07-22 起的 400 份）

| 路由 | 現況 | 啟用後 | 變化 |
|---|---:|---:|---:|
| `AUTO_APPROVE` | 334 | 253 | **−81** |
| `QUICK_REVIEW` | 30 | 111 | **+81** |
| `FULL_REVIEW` | 36 | 36 | 0 |

| 指標 | 現況 | 啟用後 |
|---|---:|---:|
| 需人工介入（QUICK + FULL） | 66 份 | **147 份** |
| 佔全部比例 | 16.5% | **36.8%** |
| 路由結果改變 | — | 81 份（20.3%） |

這 81 份由**真實的**新格式／新公司信號觸發，不是假信號。`FULL_REVIEW` 完全未變，因為其兩個觸發條件中，mismatch 已由 FIX-147 暫行措施套用、Stage 失敗則不會留下 `extraction_results`。

### 評估未涵蓋之處（誠實記錄）

| 項目 | 狀況 | 後果 |
|---|---|---|
| `configSource` | `stage_2_result` 中 **802/802 全部缺漏** | 「配置由 LLM 推斷」降級**未被評估到**，真實衝擊 **≥ 上表數字** |
| `stage1Success` / `stage2Success` | `stage_1/2_result` 無 `success` 欄位 | Stage 失敗降級未評估；但失敗文件多半不會留下提取結果，影響應有限 |
| `itemsNeedingClassification` | 依賴 `lineItems[].needsClassification`，缺值計 0 | 「>3 項需分類」降級可能被低估 |
| per-model 閾值 | 一律以預設 90/70 重放 | Epic 23 Story 23.3 的實際落點未涵蓋（驗收 4 仍待做） |

### 結論與待決事項

`isNewFormat` 旗標在 FIX-124 後是可信的，**啟用 FIX-148 沒有「先修旗標」的前置阻塞**。剩下的是純業務裁決：

**每 5 份文件約多 1 份需要人工看**（需人工介入比例 16.5% → 36.8%），換得新公司／新格式／LLM 推斷配置這幾類文件不再靜默自動放行。

可選路徑：
1. **全量啟用** —— 直接採用 `confidenceServiceResult.routingDecision`
2. **分階段啟用** —— 先只採用強制條件（Stage 失敗、mismatch），暫不套用三項「降一級」條件；待審核量觀察後再開
3. **先補資料再評估** —— 先讓 `configSource` 正確寫入 `stage_2_result`，把上表未涵蓋的那項也量化出來，再決定

---

## FIX-147 採取的暫行措施

使用者 2026-07-31 決定：**FIX-147 先以最小範圍繞過，本 FIX 另行評估**。

`extraction-v3.service.ts` 在分數推導之後，只額外套用 mismatch 一項：

```typescript
const reconciliation = threeStageResult.stage3?.lineItemTotalReconciliation;
if (reconciliation?.mismatch) {
  routingPath = 'FULL_REVIEW';
  warnings.push(...);
}
```

**刻意不改用 `confidenceServiceResult.routingDecision`** —— 範圍最小、可獨立驗證、不觸及既有行為。程式碼中已加註解指向本 FIX。

---

## 驗收標準（本 FIX 實作時）

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|---|---|---|
| 1 | 影響評估 | ✅ **已完成（2026-08-01）** —— 見 §影響評估結果。需人工介入 16.5% → 36.8%（+81 份／400 份）。⏳ 尚待使用者裁決是否啟用 | High |
| 2 | 決策採用 | `routingPath` 來自 `confidenceServiceResult.routingDecision.decision` | High |
| 3 | reasons 有意義 | 回傳的 `routingDecision.reasons` 為降級原因，非維度分數列表 | Medium |
| 4 | per-model 閾值生效 | 設定 per-model 閾值後，路由落點依其變化 | High |
| 5 | FIX-147 暫行措施移除 | 改用統一決策後，移除 mismatch 的單獨處理與其註解 | Medium |
| 6 | 零回歸 | 無任何降級條件成立時，路由結果與修復前完全相同 | High |

---

## 教訓

**單元測試綠燈不代表整條鏈通。** FIX-147 的 28 個單元測試全過（測純函式與直接呼叫
`calculate()`），但真實管線根本沒用 `calculate()` 的結論。這與 FIX-146 的教訓同源：

> 靜態產物／單元測試能證明「這一段是對的」，不能證明「整條鏈是通的」。

新增任何「會影響管線輸出」的欄位或決策時，必須逐段查證透傳鏈 —— 本專案已累積
FIX-092（`referenceNumberMatch`）、CHANGE-113（`lineItemGroups`）、FIX-146（step `data`）、
FIX-147（`lineItemTotalReconciliation`，一次補了 3 個型別層）四次同型漏接。

---

## 相關

- FIX-053 — 統一 `generateRoutingDecision` 與 `getSmartReviewType`；本缺陷是它沒涵蓋的第三條路徑
- FIX-147 — 發現本缺陷的契機；已採暫行措施繞過
- Epic 23 Story 23.3 — per-model 路由閾值校準，在本路徑上同樣失效
- OQ-Q5 — 信心度自評不可靠（本缺陷讓「分數是唯一路由依據」的風險更高）
