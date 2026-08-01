# FIX-151: 行項對帳拿含稅總額比不含稅明細 —— 每張含 VAT 的發票都被誤判為漏帳

> **建立日期**: 2026-08-01
> **發現方式**: 使用者回報「有些文件信心度高於 90% 仍顯示為 FULL_REVIEW」，逐份歸因後查出
> **影響頁面/功能**: 信心度路由 → 文件審核佇列
> **優先級**: 中高（誤報佔全部對帳不符的 **2/3**，虛增人工審核量；但不影響金額正確性）
> **狀態**: ✅ 已實作（2026-08-01，本地 `type-check` / `lint` / `test` 452 通過、對帳測試 25 項全過；⏳ 待部署 Azure DEV —— 部署後既有文件仍需**重新處理**才會套用新判定）
> **相關**: [FIX-147](FIX-147-stage3-wrapped-line-description-misjoin.md)（本閘的引入者）、[FIX-148](FIX-148-v31-pipeline-discards-routing-decision.md)（路由決策被丟棄，本閘是目前唯一實際生效的降級機制）、[FIX-143](FIX-143-summary-area-vat-field-typed-as-lineitem.md)（VAT 印在總結區）

---

## 問題描述

使用者觀察到「信心度明明 97、98 分，文件卻進了完整審核」。

Azure DEV 全量歸因（2026-08-01，802 份有路由結果的文件）：

```
路由分佈    AUTO_APPROVE 703 / QUICK_REVIEW 55 / FULL_REVIEW 44
信心度 ≥90 卻走 FULL_REVIEW：34 份 —— 100% 是行項對帳不符，其他原因 0 份
對帳不符 36 份，其中未走 FULL_REVIEW 的 0 份（閘門本身 100% 生效）
```

把 36 份逐份拆解後，**24 份是誤報**：

| 類別 | 份數 | 特徵 |
|---|---:|---|
| **誤報** | **24** | 行項合計 **等於** `subtotal`，差額 **恰等於** `vat_7` |
| 真問題 | 9 | 行項合計與 `subtotal` 也對不上 |
| 無從判斷 | 3 | 沒有 `subtotal` 可比 |

誤報 24 份全屬 `Nippon Express Logistics`，形態完全一致：

```
NEX_RCEX240692,0692A,0692B_9898.pdf
   行項合計 = 6700 = subtotal 6700      total_amount = 7169      差額 -469 = vat_7
NEX_RCEX250017_0394.pdf
   行項合計 = 11250 = subtotal 11250    total_amount = 12037.5   差額 -787.5 = vat_7
NEX_RCEX250106,0106A_1891.pdf
   行項合計 = 8200 = subtotal 8200      total_amount = 8774      差額 -574 = vat_7
```

明細一分不差，卻被判為漏帳。

---

## 根本原因

`reconcileLineItemTotal`（`stage-3-extraction.service.ts`）選比較基準時 **`total_amount` 優先，缺值才退到 `subtotal`**：

```typescript
const candidates = [
  ['total_amount', toReconcilableAmount(fields?.total_amount ?? standardFields?.totalAmount)],
  ['subtotal',     toReconcilableAmount(fields?.subtotal ?? standardFields?.subtotal)],
];
const hit = candidates.find(([, value]) => value !== null);
```

`total_amount` 是**含稅**的，而 `lineItems` 只有各項費用、**不含稅**（VAT 印在總結區，不會出現在明細行 —— 見 FIX-143）。於是：

```
凡是有 VAT 且 total_amount 讀得到的發票，必然對不上，差額恆等於稅額。
```

### 原設計的取捨與其失效之處

原註解記載了刻意的取捨：

> `subtotal` 在含稅發票上不等於行項合計，但誤報的代價只是多一次人工審核，漏報的代價是漏帳 —— 兩者不對等。

**取捨的方向正確，但前提與資料不符**。24 份誤報**全部**是 `行項合計 == subtotal`，精確吻合（差 0）。也就是說在含稅發票上，`subtotal` 恰恰是與行項合計對得上的那一個。既然如此，就不需要在「誤報」與「漏報」之間二選一。

---

## 修復方案

**若 `subtotal` 存在且行項合計與它吻合（容差內），即以 `subtotal` 為基準判定相符；否則維持原有的 `total_amount` 優先邏輯。**

```
1. 算出 lineItemSum
2. 若 subtotal 可解析 且 |lineItemSum − subtotal| ≤ tolerance
      → totalSource = 'subtotal'，mismatch = false
3. 否則 → 原邏輯（total_amount 優先，缺值退 subtotal）
```

### 為何這樣不會削弱偵測能力

新分支只在**明細與不含稅小計精確吻合**時才成立。那正是「明細完整無誤」的直接證據 —— 漏一行或多一行都會使 `lineItemSum ≠ subtotal`，立刻落回原邏輯被攔下。

以真問題對照：

| 文件 | 行項合計 | `subtotal` | 新邏輯 |
|---|---:|---:|---|
| `CEVA_RCIM260069_37388.pdf` | 14109.44 | 14579.5 | 差 470.06 → **仍攔下** ✅ |
| `NEX_RCEX250182,0182A_2886.pdf` | 11100 | 11200 | 差 100 → **仍攔下** ✅ |
| `DHL_RCIM250291_20411.pdf` | 38930.46 | 19997.85 | 差 18932.61 → **仍攔下** ✅ |
| `NEX_RCEX240692...9898.pdf` | 6700 | 6700 | 吻合 → 放行（本次修正目標） |

### 不採用的替代方案

| 方案 | 不採用的理由 |
|---|---|
| 改為 `subtotal` 優先 | `subtotal` 常缺、也可能被模型讀錯（實測 `NEX_RCIM250001_202` 的 `subtotal` 少了 100）。無條件優先等於把基準押在較不可靠的欄位上 |
| 對帳時加回稅額欄位 | 需枚舉各公司的稅欄位 key（`vat_7` / `vat` / `vat_7_percent`…），是設定耦合；且稅欄位本身可能沒被提取到 |
| 放寬容差 | 容差要大到吸收 7% 稅額，就大到吸收任何真實漏行，等於廢掉這道閘 |

---

## 影響範圍

| 項目 | 說明 |
|---|---|
| 程式碼 | `reconcileLineItemTotal` 單一函式；`applyRoutingStrategy` 與呼叫端**不動** |
| 行為變更 | 約 24 份文件由 `FULL_REVIEW` 變為 `AUTO_APPROVE`（信心度本就 ≥90） |
| 既有資料 | **不回溯** —— 既有 `extraction_results` 的對帳結果不會改變，需重新處理才會套用新判定 |
| 資料庫 | 無變更 |
| i18n | 無新增使用者可見字串 |

> ⚠️ 這是**放寬**的行為變更。放寬的部分僅限「明細與不含稅小計精確吻合」，該條件本身即為明細正確的證據。

---

## 驗收標準

- [x] 行項合計等於 `subtotal`、但不等於含稅 `total_amount` → `mismatch = false`，`totalSource = 'subtotal'`
- [x] 行項合計與 `subtotal` 皆不吻合 → 維持 `mismatch = true`（CEVA 470.06 案例不得放行）
- [x] 無 `subtotal` 時行為與修改前完全相同（CEVA 主案例走 `total_amount`）
- [x] `subtotal` 存在但明細與之不符、卻與 `total_amount` 相符 → 仍判相符（不得反向誤報）
- [x] FIX-147 既有 18 個測試全數通過（零回歸）—— 對帳測試檔 25 項全過
- [x] `type-check` / `lint` / `test` 通過（全庫 452 passed / 2 skipped）
- [ ] ⏳ 部署 Azure DEV 後，以實際文件重新處理驗證誤報消失、真問題仍被攔下

---

## 相關

- FIX-147 — 引入本對帳閘；其偵測價值不受本次修改影響
- FIX-148 — 路由決策被丟棄，導致本閘是目前**唯一**實際生效的降級機制，因此其誤報會直接反映為審核量
- FIX-143 — VAT 印在總結區、不在明細行，是本問題的前提事實
