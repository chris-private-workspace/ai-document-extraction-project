# FIX-166: VAT 被抽成一筆費用明細 —— 使合計恰好等於總額，從內部繞過對帳閘

> **建立日期**: 2026-08-05
> **發現方式**: 掃描件抽樣核對，對發票原文逐項比對（[TEST-REPORT-006 §8.4](../../5-status/testing/reports/TEST-REPORT-006-full-sample-coverage-verification.md)）
> **影響範圍**: Stage 3 欄位提取（`stage-3-extraction.service.ts` + Stage 3 Prompt）；後果落在 `lineItems` 與對帳閘
> **優先級**: 高（不是金額抽錯，是**讓唯一生效的品質閘失效**）
> **狀態**: 📋 規劃中（發生率未量化，見 §待量化）
> **相關**: [FIX-147](FIX-147-stage3-wrapped-line-description-misjoin.md)（對帳閘）、[FIX-148](FIX-148-v31-pipeline-discards-routing-decision.md)（其餘降級全部失效，對帳閘是唯一實際作用者）、[FIX-151](FIX-151-reconcile-uses-tax-inclusive-total.md)（對帳基準改用 `subtotal`）

---

## 問題描述

Stage 3 把發票的**稅額**當成一筆費用列進 `lineItems`。

實例 `NEX_RCIM250007_2168.pdf`（Nippon Express Logistics 泰國）：

| | 發票原文 | 系統抽出 |
|---|---|---|
| 明細筆數 | **6** | **7** |
| 多出的那筆 | — | `VAT 7% = 1,421` |
| NON-TAXABLE + TAXABLE | 36,674 + 20,300 = **56,974** | `subtotal = 56974` ✅ |
| 明細合計 | 應為 56,974 | **58,395** ❌ |
| GRAND TOTAL | 58,395 | `total_amount = 58395` ✅ |

標準欄位（`subtotal` / `total_amount`）全部正確，**只有 `lineItems` 多了一筆**。

---

## 🔴 為什麼這比「抽錯一個數字」嚴重

後果有兩層，第二層才是重點。

### 第一層：稅額進入費用明細

`VAT 7%` 被歸為一筆運費費用。若該列被 template mapping 引用，稅額會計入運費成本。

### 第二層：對帳閘被從內部繞過

[FIX-147](FIX-147-stage3-wrapped-line-description-misjoin.md) 的行項對帳在合計與發票總額不符時**強制 FULL_REVIEW**。依 [FIX-148](FIX-148-v31-pipeline-discards-routing-decision.md)，V3.1 管線 Step 7 丟棄了 `calculate()` 算好的 `routingDecision`，因此**對帳閘是目前線上唯一實際生效的降級機制**。

把 VAT 併進明細後：

```
明細合計 56,974 + 1,421(VAT) = 58,395  ==  total_amount 58,395
                                        ↓
                              對帳判定「相符」→ 閘不觸發
```

換言之，**這個錯誤自己製造了通過檢查的條件**。

依 [FIX-151](FIX-151-reconcile-uses-tax-inclusive-total.md)，對帳優先以 `subtotal` 為基準；本例明細合計（58,395）與 `subtotal`（56,974）差 1,421，會退回比對 `total_amount` 而恰好吻合。**正確的行為應該是以 `subtotal` 為準並判定不符。**

⚠️ 這種形態在 [TEST-REPORT-006](../../5-status/testing/reports/TEST-REPORT-006-full-sample-coverage-verification.md) §1–§6 的內部一致性驗證中**永遠不會被標記** —— 因為它「相符」。它只能靠對發票原文核對才發現。

---

## 已量化：低發生率，且**不侷限於原案例**

2026-08-05 以 `scripts/tmp-quantify-stage3-nondeterminism.ts` 重跑 Stage 3 各 10 次（Stage 1/2 固定，只重跑 Stage 3，不持久化）：

| 檔案 | 版面 | 明細筆數分佈 | 含稅額列 |
|---|---|---|---:|
| `NEX_RCIM250007_2168.pdf`（**本 FIX 原案例**） | Nippon 泰國雙欄 | 6 筆 ×10 | **0 / 10** |
| `NEX_RCIM250001_202.pdf`（對照） | 同版面 | 8 筆 ×10 | 0 / 10 |
| `NEX_RCEX240692,0692A,0692B_9898.pdf` | Nippon 泰國 | 4 筆 ×9、**5 筆 ×1** | **1 / 10** |

三點修正初版的判斷：

1. **原案例現在重現不出來**（0/10，穩定為正確的 6 筆 / 56,974）。DB 中那筆 7 筆含 VAT 的結果是**歷史記錄**。
2. **但缺陷確實存在** —— 在另一份（`_9898`）以 1/10 的頻率出現，形態完全相同：多一筆 `VAT 7%`，合計由 6,700 變 7,169（= 6,700 + 469 VAT），**恰好等於 GRAND TOTAL**。
3. 因此這**不是特定文件的問題，是 Nippon 泰國版面（帶 `VAT 7%` 行）的通用風險**。原案例的「已修好」是假象，只是抽樣沒抽中。

### 🔴 一個必須併記的干擾因素

DB 的歷史結果與本次重跑**不是同一套 Prompt / 後處理**。重跑的 log 顯示現在會執行 `FIX-108 backfill`（由行項回填費用欄位）與 `FIX-127 cleared duplicate amount(s)`，這些在舊結果產生時未必存在。

因此「DB 裡是錯的、現在跑是對的」**不可直接讀成「缺陷已消失」**，也可能是中間某個 FIX 已部分改善。要區分這兩者，需查明該文件的提取時間與其後的相關變更 —— 本 FIX 尚未做。

### 副帶觀察：`vat_7` 以**欄位**形式存在 —— 已查證，屬設計內

盲讀核對（[TEST-REPORT-006 §8.5](../../5-status/testing/reports/TEST-REPORT-006-full-sample-coverage-verification.md)）發現，Nippon 泰國版面的文件即使 `lineItems` **正確不含 VAT**，`fields` 中仍會有 `vat_7` 這個費用欄位（來自 `FIX-108 backfill`）。

2026-08-05 查證：`vat_7` **確實被 mapping 引用，且是刻意設計** —— Nippon Express Logistics 的 Inbound 與 Outbound 模板都有 `vat_7 → vat`（DIRECT）規則，實測 71 列金額吻合。稅額有正當去處，**此路徑不是缺陷**。

但同一次查證發現稅額在各公司的歸屬**不一致**（6 家併入 handling、1 家獨立成欄），已另立 [FIX-168](FIX-168-vat-mapping-inconsistent-across-companies.md)。那是 mapping 配置層的口徑問題，與本 FIX 的提取層問題不同層 —— **本 FIX 的範圍僅限「稅額被抽成 `lineItems` 的一列」**。

---

## 仍待量化

1. 擴大樣本 —— 目前僅 3 份 ×10 次；1/10 這個數字的信賴區間很寬
2. 涵蓋其他帶稅額行的版面（不限 Nippon 泰國）
3. 釐清上述 Prompt 版本干擾：查明歷史結果的產生時間與其後的相關變更

⚠️ **不可用「重新處理文件」的方式重跑** —— `extraction_results` 對 document 有唯一約束且採 upsert，會**覆蓋**既有結果並銷毀證據。應直接呼叫 Stage 3、不持久化（`Stage3ExtractionService.execute()` 在**不傳 `documentId`** 時為純讀取，其唯一寫入路徑 `recordExtractionFeedback` 的守衛即為 `input.documentId`）。

⚠️ 每次重跑都會產生 Azure OpenAI 費用。

---

## 修法選項（待量化後拍板）

| 選項 | 作法 | 風險 |
|---|---|---|
| **A. Prompt 明確排除稅額列** | Stage 3 Prompt 加入「稅額（VAT／GST／WHT）不得列入 `lineItems`，應歸入稅額欄位」 | 對非確定性錯誤，Prompt 約束不保證每次生效；需以 §待量化 的重跑驗證改善幅度 |
| **B. 後處理過濾** | 提取後以規則剔除描述匹配稅額字樣的列 | 規則式過濾可能誤刪真的叫「VAT Handling Fee」之類的服務費；需白名單 |
| **C. 對帳改為只認 `subtotal`** | 不再退回比對 `total_amount` | 治標且會誤傷 —— 有些發票確實只有 `total_amount`，見 FIX-151 的原始情境 |
| **D. 對帳增設「明細含稅額字樣」檢查** | 合計相符但明細含稅額列時仍降級 | 直接堵住繞過路徑，與 A 可並行 |

### 建議

**D 優先，A 次之。**

量化顯示發生率低（1/10）但不侷限於單一文件。低頻率恰恰是 D 更重要的理由：

- 低頻代表**不會在測試中穩定重現**，靠 Prompt 約束（A）無法驗證是否真的修好 —— 改完跑 10 次全對，可能只是又沒抽中
- D 是**確定性的規則檢查**，不依賴模型行為：合計相符但明細含稅額字樣時仍降級。它的效果可被單元測試覆蓋
- A 仍值得做（降低發生率、順帶處理 `vat_7` 欄位的歸類），但**不可作為唯一防線**

⚠️ D 的實作要留意誤傷：`VAT Handling Fee`、`GST Clearance Charge` 這類含稅字樣的**服務費**是真的費用，需以「是否等於 `total_amount − subtotal`」作為輔助判準，而非純字串比對。

---

## 證據強度說明

本 FIX 的證據來自單次視覺核對，方法上有兩項限制須併同記錄：

1. 核對時先看到系統輸出再看發票圖像，存在確認偏誤；本案因「多出一筆」屬增量差異、且金額關係（56,974 + 1,421 = 58,395）可算術自證，受偏誤影響較小
2. 核對者與被核對的提取皆為視覺模型，非獨立第三方來源

金額關係可自證，故根因判定成立；**發生率則完全未知**。

---

## 驗證方式

1. §待量化 的重跑基準先建立（修正前的發生率）
2. 套用修法後以**相同的 N 次重跑**比較發生率
3. 確認 `NEX_RCIM250007_2168.pdf` 的明細為 6 筆、合計 56,974、對帳以 `subtotal` 為基準判定相符
4. 確認對照組 `NEX_RCIM250001_202.pdf` 未因修改而退化（8 筆、含 NON-TAXABLE 欄兩筆）

---

**建立者**: AI 助手
**最後更新**: 2026-08-05
