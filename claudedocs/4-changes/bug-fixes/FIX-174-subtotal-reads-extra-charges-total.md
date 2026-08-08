# FIX-174: `subtotal` 讀成「Extra Charges 合計」—— 與同樣不完整的明細互相吻合，使對帳閘失效

> **建立日期**: 2026-08-08
> **發現方式**: 追查 [FIX-162](FIX-162-row-total-exceeds-invoice-amount.md) §複驗 登記的待查訊號（`DHL_RCEX240640_53822` 超出 19,110.75），以發票原文文字層確認
> **影響範圍**: Stage 3 欄位提取（`subtotal`）+ `lineItems`；後果落在對帳閘與模板實例金額
> **優先級**: 高（**單筆漏帳 19,886.20**，為目前已知最大；且 3/3 完全繞過對帳閘，無任何訊號）
> **狀態**: 📋 規劃中（影響面已量化：全庫 DHL 3 筆、漏帳合計 20,268.40；根因經發票原文證實；修法未拍板）
> **相關**: [FIX-162](FIX-162-row-total-exceeds-invoice-amount.md)（🔴 **同根因、反方向** —— 其 §B 類是同一個三欄式版面選錯欄造成的**虛增**，本 FIX 是**漏帳**）、[FIX-151](FIX-151-reconcile-uses-tax-inclusive-total.md)（🔴 其新增的 `subtotal` 分支正是本問題隱形的原因）、[FIX-166](FIX-166-vat-extracted-as-line-item-charge.md)（另一種繞閘機制，走 `total_amount` 分支）、[FIX-152](FIX-152-dhl-multi-shipment-aggregate-amount-leak.md)（已排除 —— 那是合計洩漏到首組明細）

---

## 問題描述

DHL 發票的費用表是**三欄式**（Standard / Extra / Total）：

```
                            Weight  Shpm   Standard      Extra       Total
Service Sub Total - EXPRESS WORLDWIDE doc    0.50  1     191.10      50.65      241.75
Service Sub Total - EXPRESS WORLDWIDE nondoc 120.50 6  19,695.10   5,781.82   25,476.92
Total                                        121.00 7  19,886.20   5,832.47   25,718.67

Analysis of Extra Charges
   FUEL SURCHARGE                 5,057.02
   GOGREEN PLUS - CARBON REDUCED    774.30
   DEMAND SURCHARGE                   1.15
   Total Extra Charges            5,832.47

Total Amount (HKD)                25,718.67
```

Stage 3 把 **`subtotal` 讀成 5,832.47** —— 那是 **Extra 欄的合計**，不是發票小計。

同時 `lineItems` 的 8 筆**全部**取自「Analysis of Extra Charges」段落（FUEL SURCHARGE ×5、GOGREEN PLUS ×2、DEMAND SURCHARGE ×1），**主運費那兩列完全沒有進入明細**。

`total_amount` = 25,718.67 **是正確的**。

---

## 🔴 為什麼這比「抽錯一個數字」嚴重

### 兩個錯誤互相吻合，且吻合是**結構必然**

`lineItems` 與 `subtotal` **取自同一個區塊**。模型讀了「Analysis of Extra Charges」，就會同時得到它的明細與它的合計 —— 兩者當然精確吻合。

於是對帳閘看到：

```json
{"checked":true,"mismatch":false,"tolerance":0.08,"difference":0,
 "lineItemSum":5832.47,"totalSource":"subtotal","documentTotal":5832.47,"lineItemCount":8}
```

`difference: 0`。**主運費 19,886.20 憑空消失，而系統認為一切正常。**

這與 [FIX-166](FIX-166-vat-extracted-as-line-item-charge.md) 的「條件機率為 1」是同型論證：發生機率低，但**每一次發生都必然使閘失效**，因為錯誤的兩邊來自同一個來源。

### `total_amount` 明明是對的，卻沒被用上

| 若基準取 | 結果 |
|---|---|
| `subtotal`（5,832.47） | 差額 0 → 放行 🔴 |
| `total_amount`（25,718.67） | 差額 **19,886.20** → 立即攔下 ✅ |

[FIX-151](FIX-151-reconcile-uses-tax-inclusive-total.md) 新增的分支是「若 `subtotal` 存在且行項合計與它吻合，即以 `subtotal` 為基準判定相符」。該分支的設計理由是：

> 新分支只在**明細與不含稅小計精確吻合**時才成立。那正是「明細完整無誤」的直接證據 —— 漏一行或多一行都會使 `lineItemSum ≠ subtotal`，立刻落回原邏輯被攔下。

**這個推理的前提是 `subtotal` 本身正確。** 本案中 `subtotal` 與明細同源、同時錯誤，於是「精確吻合」不再是「明細完整無誤」的證據 —— 它只證明兩者讀了同一個區塊。

⚠️ 這不是說 FIX-151 該回退。它消除的 24 筆誤報是真實的收益，而本形態僅 3 筆。但**該分支的成立條件需要補一道防線**，見 §修法選項。

---

## 已量化：全庫 DHL 3 筆，3/3 繞過對帳閘

香港 DHL 發票無 VAT，`subtotal` 理應等於 `total_amount`。以此為判準掃描全部 DHL（各檔名最新一筆提取）：

| 項目 | 份數 |
|---|---:|
| DHL 文件 | 45 |
| `subtotal` 與 `total_amount` 皆有值 | 42 |
| 兩者相等（正常） | 39 |
| 🔴 兩者不等 | **3** |
| 🔴 且「行項合計 == `subtotal`」且對帳判定相符 | **3（100%）** |

| 檔案 | `subtotal`（誤） | `total_amount`（正確） | 漏掉 | 行項數 |
|---|---:|---:|---:|---:|
| `DHL_RCEX240640_53822.pdf` | 5,832.47 | 25,718.67 | **19,886.20** | 8 |
| `DHL_RCEX250138_96978.pdf` | 108.75 | 299.85 | 191.10 | 2 |
| `DHL_RCEX250410,0411,0412_69413.pdf` | 111.64 | 302.74 | 191.10 | 2 |
| **合計** | | | **20,268.40** | |

三筆的 `totalSource` **全部**是 `subtotal`、`mismatch` 全部為 `false`。

兩筆 191.10 是 `EXPRESS WORLDWIDE doc` 的固定金額（在 `DHL_RCEX240709_99161`、`DHL_RCEX250347_61464` 等其他 DHL 文件中重複出現），即這兩份漏掉的是整條 doc 服務列。

### 每一筆都算術自證，不需要看發票原文

```
DHL_RCEX240640_53822:  19,886.20 + 5,832.47 = 25,718.67 = total_amount ✓
DHL_RCEX250138_96978:     191.10 +   108.75 =    299.85 = total_amount ✓
DHL_RCEX250410…_69413:    191.10 +   111.64 =    302.74 = total_amount ✓
```

漏掉的金額**恰好**補平 `total_amount` 與 `subtotal` 的差 —— 三筆皆然。主案例另有發票原文文字層佐證（見 §問題描述）。

---

## 與 FIX-162 §B 類的關係：同一個根因，兩個方向

[FIX-162](FIX-162-row-total-exceeds-invoice-amount.md) §B 類已經記載這個三欄式版面，並指出：

> Stage 3 把哪一個放進 `express_worldwide_nondoc` **並不一致** —— 22 份抓 Standard（正確）、3 份抓 Total（造成重複）。

**本 FIX 是同一個「三欄選錯」作用在另一個欄位上**：

| | 選錯的欄位 | 抓成 | 後果 | 方向 |
|---|---|---|---|---|
| FIX-162 §B 類 | `express_worldwide_nondoc` | Total（已含 extra） | 與 `fuel_surcharge` 重複相加 | **虛增** |
| **本 FIX** | `subtotal` | Extra 欄合計 | 明細與基準同時只剩 extra | **漏帳** |

兩者分立記錄的理由：方向相反、繞閘機制不同（前者走 `total_amount` 分支、後者走 `subtotal` 分支）、修法也不同。但**若要從 Prompt 層根治，兩者應一併處理** —— 都是「同一列有三個數字時該取哪一個」。

### 已排除 FIX-152

[FIX-152](FIX-152-dhl-multi-shipment-aggregate-amount-leak.md) 是多 shipment 發票的**合計洩漏到第一組明細**（行項首筆被填成全發票合計）。本案的明細沒有任何一筆是合計，而是整批主運費未進入明細。**兩者無關。**

（本 FIX 建立前，FIX-162 §複驗 曾把 `DHL_RCEX240640_53822` 記為「疑似 FIX-152 形態」，該猜測已由本次查證推翻，並已於同一次修訂中更正。）

---

## 影響評估

| 面向 | 說明 |
|---|---|
| **金額** | 已確認漏帳 **20,268.40**，其中單筆 19,886.20 為目前已知最大（超過 [FIX-110](FIX-110-lineitem-charge-alias-hit-rate-audit.md) §9.4 記載的任何一筆） |
| **路由** | 3/3 判定相符，**不觸發任何降級**。依 [FIX-148](FIX-148-v31-pipeline-discards-routing-decision.md)，對帳閘是線上唯一實際生效的降級機制，故這三份會一路走到底 |
| **模板實例** | 主運費未進 `lineItems`，但 `express_worldwide_nondoc` 等**欄位**有值（19,695.10）—— 即欄位層有資料、明細層沒有。兩層不一致本身也是問題訊號，目前無人檢查 |
| **偵測** | 現行機制**完全無法**發現。需要新的判準（見下） |

⚠️ 上表「模板實例」一列指出一個尚未追查的分歧：`field_mappings` 的 `express_worldwide_nondoc` = 19,695.10 是**對的**（取自 Standard 欄），而 `lineItems` 卻沒有對應行項。同一次提取中兩個層級取到不同的東西，值得單獨查明。

---

## 修法選項（未拍板）

| 選項 | 作法 | 評估 |
|---|---|---|
| **A. 恆等式交叉檢查** | 檢查 `subtotal` 是否與 `total_amount` 相容（無稅時應相等；有稅時 `subtotal + vat == total_amount`） | 便宜、確定性規則、可用既有資料驗證、不需重跑。本案 3 筆全部會被抓到。與 [FIX-173](FIX-173-numeric-field-single-digit-misread.md) §修法 B 是同一道防線，可合併實作 |
| **B. 欄位層與明細層交叉檢查** | 比對 `field_mappings` 的費用欄位合計與 `lineItems` 合計，差異過大即降級 | 可抓到本案（欄位 24,943.22 vs 明細 5,832.47）。但兩層本來就不總是一致（[FIX-110](FIX-110-lineitem-charge-alias-hit-rate-audit.md) 的未覆蓋會造成正常差異），需先定出容差，誤報風險待評估 |
| **C. Prompt 明確定義三欄版面** | 在 Stage 3 Prompt 中說明 Standard / Extra / Total 的語意與該取哪一個 | 治本，且同時處理 FIX-162 §B 類。但屬非確定性缺陷，Prompt 改動需重跑驗證，有費用；且改 Prompt 可能影響其他版面 |

### 傾向

**A 應優先** —— 它是確定性規則、成本最低、與 FIX-173 §修法 B 共用同一道恆等式檢查，且不觸碰 FIX-151 既有分支的判定結果（只是在其之前多一道 `subtotal` 合理性檢查）。

⚠️ **不建議動 FIX-151 的 `subtotal` 分支本身** —— 它消除的 24 筆誤報是真實收益，而本形態僅 3 筆。正確的方向是**在採信 `subtotal` 之前先驗證它**，而不是不採信它。

---

## 驗收標準（依 §Goal-Driven Execution，先定判準）

若採 A：

1. 以本 FIX 3 筆為正樣本：套用後全部須被標記
2. 以 39 筆 `subtotal == total_amount` 的 DHL 為負樣本：不得有任何一筆被誤標
3. 以 [FIX-151](FIX-151-reconcile-uses-tax-inclusive-total.md) §驗收 的四項為回歸基準，判定結果不得改變
4. 以含稅發票（泰國 7%）為對照：`subtotal + vat == total_amount` 成立者不得被誤標
5. 🔴 **必須跑全母體**，不得只驗這 3 筆 —— 依 [FIX-162](FIX-162-row-total-exceeds-invoice-amount.md) §B 類 的教訓（「移除 fuel_surcharge」對 3 份完美、對 22 份是破壞）

---

## 待確認事項

1. **確定性未測** —— 三筆各只有一次提取記錄可查。要測須直接呼叫 Stage 3 且不持久化（`Stage3ExtractionService.execute()` 不傳 `documentId`），且產生 Azure OpenAI 費用
2. **欄位層與明細層的分歧未查明** —— 見 §影響評估 的警示：同一次提取中 `field_mappings` 取到 Standard、`lineItems` 卻整批遺漏，機制不明
3. **是否只發生在 DHL 三欄版面** —— 本次判準（`subtotal ≠ total_amount` 且無稅）只掃了 DHL。其他無稅幣別的公司未掃
4. **與 FIX-162 §B 類是否合併** —— 若採修法 C（Prompt 層），兩者應一併處理

---

**建立者**: AI 助手
**最後更新**: 2026-08-08
