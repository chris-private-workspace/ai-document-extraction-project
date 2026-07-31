# FIX-147: Stage 3 錯拼「換行的費用描述」→ 費用分類錯誤，且可能整筆金額消失且無人察覺

> **建立日期**: 2026-07-30
> **發現方式**: 使用者回報 Azure DEV 個案（CEVA / Inbound / 7/28）—— 「470.06 HKD categorised wrong to THC, should be handling cost」
> **根因確認方式**: 從 Azure Blob 取回原始 PDF，用 pdfjs 抽取**帶座標**的文字層，與三次提取結果逐筆對照
> **影響範圍**: `src/services/extraction-v3/stages/stage-3-extraction.service.ts`、`src/services/extraction-v3/confidence-v3-1.service.ts`
> **優先級**: 高（金額分類錯誤直接影響成本歸屬；且存在**靜默漏帳**路徑）
> **狀態**: 🚧 已實作（本地四閘通過），待 Azure DEV 端到端驗證
> **相關**: CHANGE-094（費用提取非確定性，同一缺陷家族）、FIX-108 / FIX-126 / FIX-127（backfill 比對規則累積）

---

## 使用者回報

| 欄位 | 內容 |
|---|---|
| 公司 | CEVA |
| 方向 | Inbound |
| 日期 | 7/28/2026 |
| 問題 | 470.06 HKD categorised wrong to THC, should be handling cost (`CEVA_RCIM260069_37388.pdf`) |
| 狀態 | Not Solved |
| 補充 | 文件上的 DESTINATION HANDLING 費用在進行 template instance 時，錯誤匹配到 THC 欄位中 |

**回報屬實。** 以下為查證過程與根因。

---

## 事實基準：PDF 原文（唯一權威）

該檔的 Azure Blob（`HKG/1785210612663-CEVA_RCIM260069_37388.pdf`，194,451 bytes，與 `documents.file_size` 相符）已取回本機，用 pdfjs 抽取文字層並保留座標：

```
y=341.9  x= 36.5  "DESTINATION THC - TERMINAL HANDLING CHARGE - 1"
y=341.9  x=283.3  "THB"      x=312.3  "7,089.00"   x=444.8  "1,751.99"
y=333.3  x= 36.5  "20GP @ THB 4350.00/CN + 1 40GP @ THB 2739.00/CN"      ← 續行

y=323.1  x= 36.5  "DESTINATION HANDLING - 1 20GP @ THB 1128.00/CN +"
y=323.1  x=283.3  "THB"      x=312.3  "1,902.00"   x=451.5  "470.06"
y=314.5  x= 36.5  "1 40GP @ THB 774.00/CN"                                ← 續行
```

`470.06` 與 `DESTINATION HANDLING` **同一 y 座標（323.1）**。這一行在發票上的名稱毫無疑義是 **DESTINATION HANDLING**。

發票實際五行（合計與 PDF 的 `TOTAL TO PAY BEFORE 30-May-26 HKD 14,579.50` 完全相符）：

| # | 費用 | CUR | AMOUNT | HKD |
|---|---|---|---|---|
| 1 | BASIC FREIGHT CHARGE | USD | 1,100.00 | 8,681.96 |
| 2 | DESTINATION HANDLING（3 TEU @ USD 130.00/TEU） | USD | 390.00 | 3,078.15 |
| 3 | DESTINATION THC - TERMINAL HANDLING CHARGE | THB | 7,089.00 | 1,751.99 |
| 4 | **DESTINATION HANDLING**（20GP THB1128 + 40GP THB774） | THB | 1,902.00 | **470.06** |
| 5 | DELIVERY ORDER FEE | THB | 2,417.00 | 597.34 |
| | **TOTAL** | | | **14,579.50** |

---

## 缺陷一：Stage 3 把上一行的費用名稱接到下一行的續行文字上

系統提取出來的第 4 筆是：

```json
{
  "description": "DESTINATION THC - TERMINAL HANDLING CHARGE - 1 20GP @ THB 1128.00/CN + 1 40GP @ THB 774.00/CN",
  "classifiedAs": "Terminal Handling Charge",
  "amount": 470.06,
  "confidence": 96
}
```

把它拆開看，這個描述是**兩筆不同費用的混合體**：

| 片段 | 真實來源 |
|---|---|
| `DESTINATION THC - TERMINAL HANDLING CHARGE - 1` | 第 3 筆（y=341.9）的**名稱行** |
| `20GP @ THB 1128.00/CN + 1 40GP @ THB 774.00/CN` | 第 4 筆（y=323.1 / 314.5）的**明細** |

### 為何會錯拼

這兩行的版面結構幾乎相同 —— 都是 `<名稱> - 1` 在行尾被截斷、續行都以 `20GP @ THB ****/CN + 1 40GP @ THB ***/CN` 開頭：

```
第 3 筆：  DESTINATION THC - TERMINAL HANDLING CHARGE - 1
           20GP @ THB 4350.00/CN + 1 40GP @ THB 2739.00/CN
第 4 筆：  DESTINATION HANDLING - 1 20GP @ THB 1128.00/CN +
           1 40GP @ THB 774.00/CN
```

模型在重建被換行截斷的描述時，把第 3 筆的名稱前綴接到了第 4 筆的續行上。**金額本身讀對了**（470.06 正確），錯的是它被冠上的名稱。

### 錯誤如何一路傳到模板

| 層級 | 機制 | 實際 | 應為 |
|---|---|---|---|
| Stage 3 `classifiedAs` | 依（錯誤的）description 分類 | `Terminal Handling Charge` | `Destination Handling` |
| `fields` 回填 | `backfillLineItemCharges` 依 `classifiedAs` 對 label/aliases | `destination_thc_terminal_handling_charge` = 1751.99 + 470.06 = **2,222.05** | 1,751.99 |
| | | `destination_handling` = **3,078.15** | 3,548.21 |
| 模板 `thc` | 規則 DIRECT `thc ← destination_thc_terminal_handling_charge` | **2,222.05** | 1,751.99 |
| 模板 `handling` | 規則 FORMULA `{destination_handling} + {vat_7_percent} + {sadao_border} + {apdc_ior} + {destination_truck_servicing_fee}` | **3,078.15** | 3,548.21 |

🔴 **映射設定完全正確，不需要改。** 啟用中的 `CEVA LOGISTICS (HONG KONG) LTD - Inbound Template (Full List)`（13 條規則）兩條規則都對，欄位定義集的 label 與 aliases 也對（`destination_handling` label = `Destination Handling`）。映射層只是忠實搬運上游的錯值。**修錯層會白費工。**

---

## 缺陷二（更嚴重）：同一份文件三次處理結果不一致，其中一次整筆金額消失

該文件於 2026-07-28 被處理三次：

| 時間 (UTC) | 行項數 | 行項合計 | `total_amount` | 差額 | 第 4 筆的下場 |
|---|---|---|---|---|---|
| 03:06 | 5 | 14,579.50 | 14,579.50 | 0 | 錯標為 THC |
| **03:30** | **4** | **14,109.44** | 14,579.50 | **−470.06** | **整筆消失**，其明細文字被接到 `DELIVERY ORDER FEE` 上 |
| 03:50 | 5 | 14,579.50 | 14,579.50 | 0 | 錯標為 THC |

同一個錯拼機制，有時造成**錯誤分類**，有時直接**吞掉一整筆費用**。

### 為何沒有被攔下來

`total_amount` 三次都正確讀到 **14,579.50**（confidence 98）。系統手上同時握有正確總額與短少 470.06 的明細 —— **但管線沒有任何一處把兩者相比**。03:30 那次因此照樣走完全程：`overallConfidence` 98、路由 `AUTO_APPROVE`、狀態 `MAPPING_COMPLETED`，無任何警示。

這才是本 FIX 的重點：**分類錯誤靠人眼還看得出來；金額憑空消失、帳面卻「正常」，看不出來。**

---

## 證據鏈

| # | 事實 | 取得方式 |
|---|---|---|
| 1 | PDF 第 4 行的名稱是 `DESTINATION HANDLING` | 從 Blob 取回原檔 + pdfjs 文字層**帶座標**，金額 470.06 與名稱同在 y=323.1 |
| 2 | 提取出的 description 是兩筆費用的混合體 | `extraction_results.stage_3_result->'lineItems'`，逐字比對 PDF 兩行 |
| 3 | 錯誤源頭在 Stage 3、不在映射 | 映射規則與欄位定義（含 aliases）皆正確；`fields.destination_thc_...` 已是 2222.05，模板只是搬運 |
| 4 | 存在靜默漏帳路徑 | 03:30 那次 4 筆、合計 14,109.44、`total_amount` 14,579.50、差 470.06，狀態仍 `MAPPING_COMPLETED` |
| 5 | 非確定性確認 | 同一檔（同一 `blob_name`）三次處理，行項數 5 / 4 / 5 |
| 6 | prompt 未提供任何換行處理指引 | `gpt_prompt` 全文檢視：`--- Required Output Format ---` 只要求 `description` 為 `<item description>`，無多行/續行規則 |

---

## 修復方案（使用者 2026-07-30 決定採 B + A）

### B（主力，確定性防線）— 行項合計對帳閘

在 Stage 3 完成解析後，比對 `sum(lineItems[].amount)` 與 `fields.total_amount`（缺 `total_amount` 時退而用 `subtotal`）：

- 兩者皆存在且差額超過容差 → 標記 `lineItemTotalMismatch`，帶上 `expected` / `actual` / `diff`
- 該旗標傳入路由策略，**強制 `FULL_REVIEW`**
- 差額寫入 `Stage3ExtractionResult`，供 UI 與事後查證

容差取 **0.01 × 行項數**（吸收逐行四捨五入），並設下限 0.05。CEVA 這筆差 470.06，遠超任何合理容差。

**為何 B 是主力**：它不依賴模型穩定性。無論模型怎麼錯拼、漏行，只要金額對不上就攔下來。而且對**所有公司通用**，不是只修 CEVA。

> 🔴 **H1 觸發點（需明確確認）**：新增一個「強制 FULL_REVIEW」的觸發條件，屬於 CLAUDE.md §H1 列舉的「改信心度路由邏輯（…智能降級）」。
> 現行 `applyRoutingStrategy()`（`confidence-v3-1.service.ts:479-546`）已有三個 Stage 失敗的強制 `FULL_REVIEW`，本次是在同一機制**增加第四個同類條件**，不動五維權重、不動 `CONFIG_SOURCE_BONUS`、不動 90/70 閾值。
> 使用者已於 2026-07-30 指示採 B —— 但**實作前需就「新增強制降級條件」本身取得明確確認**，因為它會改變既有文件的路由結果分布。

### A（輔助，降低發生率）— Prompt 明示續行歸屬

`stage-3-extraction.service.ts` 的 `--- Required Output Format ---` 段落（約 1096-1113 行）目前對 `description` 只寫 `<item description>`，對「一筆費用在版面上被折成兩行」毫無指引。

擬在該段之後補上規則，要求：
1. 一筆費用的名稱**必須**取自與其金額同一橫列的文字；續行只是該筆的明細延續，不得跨筆借用
2. 兩筆相鄰費用的續行格式相近時，以金額所在列為準判斷歸屬
3. 每一個在金額欄有數字的橫列都必須產出**恰好一筆** lineItem，不得合併或遺漏

**A 只降低機率、不保證。** 這正是 B 必須存在的理由 —— 前次 CHANGE-094 的教訓已證明「靠 prompt 約束模型一致性」不可靠。

### 刻意**不**做的事

| 項目 | 為何不做 |
|---|---|
| 改 CEVA 的映射規則或 aliases | 它們是對的。改了只會把一個正確設定改成錯的，且無法涵蓋其他公司 |
| 改 `backfillLineItemCharges` 的比對邏輯 | 它依 `classifiedAs` 比對 label/aliases，行為正確；輸入是錯的 |
| Stage 3 改用帶座標的文字層取代視覺判讀 | 架構變更（H1），且影響所有公司所有文件。屬另案評估 —— 見 §後續建議 |

---

## 實作內容（2026-07-30）

| # | 檔案 | 內容 |
|---|---|---|
| 1 | `src/types/extraction-v3.types.ts` | 新增 `LineItemTotalReconciliation` 介面；`Stage3ExtractionResult` 加可選欄位 `lineItemTotalReconciliation` |
| 2 | `src/services/extraction-v3/stages/stage-3-extraction.service.ts` | 新增模組層級導出函式 `reconcileLineItemTotal()` 與內部 `toReconcilableAmount()`；解析與回填完成後（步驟 4d）呼叫，不符時 `console.warn` 並寫入回傳結果 |
| 3 | 同上 | **A**：`--- Required Output Format ---` 後新增 4 條換行歸屬規則 |
| 4 | `src/services/extraction-v3/confidence-v3-1.service.ts` | `applyRoutingStrategy()` flags 新增 `lineItemTotalMismatch` / `lineItemTotalMismatchReason`，於 Stage 失敗檢查之後強制 `FULL_REVIEW`；`generateRoutingDecision()` 由 `stage3Result.lineItemTotalReconciliation` 取值 |

### 設計決策

| 決策 | 理由 |
|---|---|
| `reconcileLineItemTotal` 做成**模組層級導出的純函式**，而非 class private method | 與同檔既有的 `buildGroupCandidateSection`（CHANGE-113）一致，可直接單元測試而不需建構整個 service |
| 對帳結果放在 `Stage3ExtractionResult` 上，而非另外傳參給路由 | `generateRoutingDecision()` 本來就收 `stage3Result`，不必新增參數穿透；舊資料無此欄位 → `undefined` → 不觸發，天然向後相容 |
| `toReconcilableAmount` 解析失敗回 `null` 而非 `0` | 回 0 會被當成一個有效總額，讓對帳誤判成「差額等於行項合計」而全面誤報 |
| 強制 `FULL_REVIEW`（覆蓋）而非降一級 | 快速確認的人看到的仍是一份「看起來正常」的明細，差額不會自己浮現。實測案例正是信心度 98 |
| `getSmartReviewType()` 不接對帳旗標 | 簡化 API 的輸入不含行項目與總額，無從對帳。與該 API 既有的 `stageNSuccess = true` 預設同一取態 |
| 用 `console.warn` 而非 logger | 與同檔既有 `[Stage3]` log 慣例一致；FIX-146 的經驗顯示容器 stdout 是部署後排查的最短路徑。ESLint 的 `no-console` 只擋 `console.log`，未新增 warning |

### 本地驗證結果

| 閘 | 結果 |
|---|---|
| `npm run type-check` | ✅ 通過 |
| `npm run lint` | ✅ 0 error（新增 0 warning；既有 331 warning 未變） |
| `npm run test` | ✅ **420 通過 / 2 跳過**（基線 392 + 新增 28，無回歸） |
| `npm run build` | ✅ 通過 |

新增測試：
- `tests/unit/services/stage-3-line-item-total-reconciliation.test.ts`（18 案例）—— 以 CEVA 真實資料形狀為主案例，涵蓋容差、雙向比較、`checked: false` 分界、來源優先序、金額字串解析
- `tests/unit/services/routing-line-item-total-mismatch.test.ts`（10 案例）—— 涵蓋強制 `FULL_REVIEW`、reason 內容、相符/無從對帳/舊資料的零回歸、簡化 API 不受影響

---

## 第一輪 Azure 部署結果（2026-07-31 01:26 UTC）—— A 生效、B 偵測到但沒攔下

映像 `dev-fix147-20260731090920`（ACR run `ck1q`）上線後重新處理同一份文件。

### A（prompt 續行規則）：已送達，但沒解決問題

`gpt_prompt` 四項檢查全 `true`，長度 7,119 → **7,927**。**驗收 7 通過。**

但模型照樣讀錯，且錯法與 7/28 03:30 那次完全相同：

```
"DELIVERY ORDER FEE - 1 20GP @ THB 1128.00/CN + 1 40GP @ THB 774.00/CN"   597.34
```

470.06 那行的續行文字被接到**下方**的 `DELIVERY ORDER FEE` 上，整筆 470.06 消失，只剩 4 行。

> 這在預期之內 —— 規劃時已寫明「A 只降低機率、不保證」。但也確認了一件事：
> **A 對本案例幾乎沒有效果**，B 才是唯一可靠的防線。

### 為何第一條 DESTINATION HANDLING 讀得到、第二條讀不到

關鍵不在名稱，在**版面是否換行**：

```
y=354.3  "DESTINATION HANDLING - 3 TEU @ USD 130.00/TEU"      3,078.15   ← 單行
y=341.9  "DESTINATION THC - TERMINAL HANDLING CHARGE - 1"     1,751.99
y=333.3  "20GP @ THB 4350.00/CN + 1 40GP @ THB 2739.00/CN"                ← 續行
y=323.1  "DESTINATION HANDLING - 1 20GP @ THB 1128.00/CN +"     470.06
y=314.5  "1 40GP @ THB 774.00/CN"                                         ← 續行
y=304.4  "DELIVERY ORDER FEE"                                   597.34   ← 單行
```

第一條**不換行**，第二條**換行**。規律：被吃掉的一定是換行的那一行，其續行會被併進相鄰的某一筆。單行費用不受影響。

### B（對帳閘）：偵測正確，但結論被上游丟棄

容器 log 證實偵測邏輯完全正確：

```
01:26:46  [Stage3] FIX-147 line item total mismatch:
          sum=14109.44 vs total_amount=14579.5 (diff=-470.06, tolerance=0.05, items=4)
```

但 `documents.processing_path` 仍是 `AUTO_APPROVE`，`stage_3_result` 也沒有
`lineItemTotalReconciliation`（只有 7 個 key）。

🔴 **根因不在本 FIX 的邏輯，在 V3.1 管線**：`extraction-v3.service.ts` Step 7
只用分數重推路由，把 `ConfidenceV3_1Service.calculate()` 算好的 `routingDecision`
整個丟掉 —— 連帶讓 5 個既有降級機制與 Epic 23 per-model 閾值在該路徑上全部失效。
**已另立 FIX-148 記錄。**

### 這是我的實作缺陷，不是意外

28 個單元測試全綠，但它們測的是**純函式**與**直接呼叫 `calculate()`**，兩者都繞過了真實管線。加完欄位就跑測試、沒有逐段查證透傳鏈 —— 這正是 FIX-146 記錄過的教訓（「能證明這一段對，不能證明整條鏈通」），又犯了一次。

本專案已累積四次同型漏接：FIX-092（`referenceNumberMatch`）、CHANGE-113（`lineItemGroups`）、FIX-146（step `data`）、本次（`lineItemTotalReconciliation`）。

---

## 第二輪修復（2026-07-31，使用者決定採 C + B）

使用者選擇：**FIX-147 用最小範圍繞過（B），路由丟棄缺陷另立 FIX-148 評估（C）**。

| # | 檔案 | 內容 |
|---|---|---|
| 5 | `extraction-v3.service.ts` | Step 7 分數推導後，**只**額外套用 mismatch 一項強制 `FULL_REVIEW`，並寫入 `warnings`。刻意不改用 `confidenceServiceResult.routingDecision`（會一次啟用 5 個既有降級 → 行為變更，見 FIX-148），程式碼中已加註解指向 FIX-148 |
| 6 | `extraction-v3.service.ts` | 回傳的 `result` 加上 `lineItemTotalReconciliation` 透傳 |
| 7 | `unified-document-processor.service.ts` | `convertV3Result` 的 `stage3Result` 重建加上該欄位（此處逐欄位重建、未列出即丟棄 —— 已加註解警告後人） |
| 8 | `unified-processor.ts` / `extraction-v3.types.ts` | 兩處型別補上該欄位（透傳鏈**共三個型別層**都要補，這正是它脆弱的證據） |

驗證：`type-check` ✅、`test` **420 通過 / 2 跳過** ✅、`lint` 0 error ✅、`build` ✅。

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|---|---|---|
| 1 ✅ | 對帳閘偵測 | 以 03:30 那次的資料形狀（4 筆、合計 14,109.44、total 14,579.50）為輸入，判定 mismatch 並回報 diff = −470.06 | High |
| 2 ✅ | 對帳閘放行 | 5 筆、合計 14,579.50、total 14,579.50 → 不觸發 | High |
| 3 ✅ | 容差 | 逐行四捨五入造成的微小差（≤ 0.01 × 行項數，下限 0.05）不觸發 | High |
| 4 ✅ | 缺值不誤判 | `total_amount` 與 `subtotal` 皆缺 → 不觸發、不報錯（無從對帳 ≠ 對不上） | High |
| 5 ✅ | 路由強制降級 | mismatch 為真時，即使 score ≥ 90 也回 `FULL_REVIEW`，且 `reasons` 含差額 | High |
| 6 ✅ | 零回歸 | 既有路由測試全數通過；無 mismatch 的文件路由結果與修復前完全相同 | High |
| 7 🔬 | Prompt 續行規則 | 新規則出現在實際送出的 `gpt_prompt` 中 | Medium |
| 8 🔬 | 端到端（Azure） | 重新處理 `CEVA_RCIM260069_37388.pdf`：470.06 落在 `destination_handling`、`thc` = 1,751.99、`handling` = 3,548.21 | High |
| 9 ✅ | 型別 / 規範 | `type-check`、`lint`、`test` 通過 | High |

> 驗收 1-6、9 已由單元測試涵蓋並通過（見 §實作內容）。7、8 需部署至 Azure DEV 後以實機驗證。

> ⚠️ 驗收 8 依賴 A 生效（模型要讀對名稱）。**若 A 未能穩定達成，B 仍必須讓該文件落入 `FULL_REVIEW`** —— 那是本 FIX 的底線，也是驗收 1/5 與 8 分開列的原因。

---

## 測試場景

| # | 場景 | 步驟 | 預期 |
|---|---|---|---|
| 1 | 漏行 | 行項 4 筆合計 14,109.44 vs total 14,579.50 | mismatch，diff −470.06，`FULL_REVIEW` |
| 2 | 完整 | 行項 5 筆合計 14,579.50 vs total 14,579.50 | 無 mismatch，路由不受影響 |
| 3 | 四捨五入 | 3 筆合計 100.02 vs total 100.00 | 容差內，不觸發 |
| 4 | 無 total | `total_amount` / `subtotal` 皆 null | 不觸發、不報錯 |
| 5 | 多出 | 行項合計大於 total（重複計列） | 同樣觸發（雙向比較，非只查短少） |
| 6 | 空行項 | `lineItems` 為空陣列 | 不觸發（無明細不等於對不上） |

---

## 現存錯誤資料的處理

Azure DEV 上該文件目前的模板列是錯的：

| 欄位 | 現值 | 正確值 |
|---|---|---|
| `thc` | 2,222.05 | 1,751.99 |
| `handling` | 3,078.15 | 3,548.21 |

三筆 `documents` 記錄（`e2117ae9…` / `9822eaae…` / `2dfa7dc8…`）都源自同一次上傳的重複處理。修復部署後需重新處理並確認，**不建議直接改 `field_values`** —— 那會掩蓋根因是否真的修好。

---

## 後續建議（不在本 FIX 範圍）

| 項目 | 說明 |
|---|---|
| Stage 3 改用 PDF 文字層（含座標）輔助視覺判讀 | 本案的 PDF **有可抽取的文字層**，名稱與金額的 y 座標對應關係是確定性的。若把文字層一併餵給模型（或用它做事後校驗），這類錯拼可根治。屬架構變更（H1），需另案評估影響面與成本 |
| 重複上傳同一檔案未被偵測 | `documents.file_hash` 為 `null`；同一份 PDF 產生 3 筆文件記錄。與本 FIX 無關，但值得單獨追 |

---

## 相關

- CHANGE-094 — 費用明細提取非確定性（同一家族：靠 prompt 約束模型一致性不可靠）
- FIX-108 / FIX-126 / FIX-127 — `backfillLineItemCharges` 的比對規則演進（本 FIX **不動**它們）
- FIX-143 — 同為 CEVA、同期回報的欄位歸類問題（已修復，屬設定資料修正，與本 FIX 根因不同）
- CHANGE-113 — 引入 `lineItemGroups`，與本 FIX 同在 Stage 3 解析後的處理鏈上
