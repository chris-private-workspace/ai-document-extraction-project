# FIX-148: V3.1 管線丟棄算好的路由決策，改用分數重推 —— 5 個既有降級機制與 per-model 閾值全部失效

> **建立日期**: 2026-07-31
> **發現方式**: FIX-147 的對帳閘在 Azure DEV 實測「偵測到了但沒降級」，逐段追透傳鏈時發現
> **影響範圍**: `src/services/extraction-v3/extraction-v3.service.ts`（V3.1 主管線 Step 7）
> **優先級**: 高（多個安全網長期無聲失效），但**修復本身是行為變更**，需先評估審核量衝擊
> **狀態**: ⏳ 待實作（使用者 2026-07-31 決定：FIX-147 先以最小範圍繞過，本 FIX 另行評估）
> **相關**: FIX-053（統一路由策略，本缺陷是它沒涵蓋到的第三條路徑）、FIX-147（發現本缺陷的契機）

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

1. 以現有 Azure 資料估算：若啟用，過去 N 天有多少文件會從 `AUTO_APPROVE` 變成 `QUICK_REVIEW` / `FULL_REVIEW`
2. 與使用者確認審核量可承受，或決定分階段啟用（例如先只啟用 Stage 失敗與 mismatch 兩項強制條件）
3. 確認 per-model 閾值啟用後的實際落點（Epic 23 Story 23.3）

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
| 1 | 影響評估 | 產出「若啟用，過去 N 天各路由結果變化」的量化報告，經使用者確認 | High |
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
