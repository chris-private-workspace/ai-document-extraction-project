# FIX-154: GLOBAL prompt 的幣別註記污染行項描述 —— 短 label 費用欄位被鄰近欄位吃掉

> **建立日期**: 2026-08-02
> **發現方式**: CHANGE-115 換模型後，使用者驗收 Nippon 模板實例時發現總額異常（83,690 vs 應為 66,940）
> **影響頁面/功能**: Stage 3 費用回填（`backfillLineItemCharges`）→ 模板實例列金額
> **優先級**: 高（**金額錯誤**：同一筆費用同時進入兩個欄位，模板加總後虛增。**未被對帳閘攔截** —— 行項合計本身正確，錯的是 `fields` 層的歸戶）
> **狀態**: ✅ 已完成（方案 B + E 皆實作並**實機驗證通過** —— 模板實例合計由 83,690 修正為 66,940；本地 `type-check` / `lint` / `test` **458 通過**零回歸；**2026-08-03 已部署 Azure DEV** —— 方案 B 隨映像 `dev-sync20260803b-20260803164326` 上線，方案 E 以 `prisma/sync-config-20260803.js` 步驟 1 寫入該環境的 GLOBAL prompt，v3→v4 並回讀確認舊句已消失）
> **相關**: [CHANGE-115](../feature-changes/CHANGE-115-switch-all-llm-stages-to-gpt56-luna.md)（換模型使問題顯現）、[FIX-108](FIX-108-stage3-lineitem-backfill-description-matching.md) / [FIX-126](FIX-126-charge-label-matching-fragility.md) / [FIX-127](FIX-127-stage3-misattribution-and-dual-source.md)（回填比對規則的歷次調整）、[FIX-150](FIX-150-nippon-charge-fields-lost-mapping-slot-contention.md)（同一公司的費用歸戶問題）

---

## 問題描述

模板實例 `NEX_RCIM250001_202.SIGNED..pdf - 20260802 - 6:42pm` 的合計為 **83,690**，發票實際 GRAND TOTAL 為 **66,940**。

| 模板欄位 | 值 | 正確值 |
|---|---:|---:|
| freight | 42,223 | 42,223 ✅ |
| **thc** | **16,750** | 16,750 ✅ |
| **handling** | **17,250** | **500** ❌ |
| docs_fee | 1,650 | 1,650 ✅ |
| others_local_charge | 4,200 | 4,200 ✅ |
| vat | 1,617 | 1,617 ✅ |
| **合計** | **83,690** | **66,940** |

`17,250 = 500 + 13,950 + 2,800` —— 兩筆 THC 被算進 `handling_charge`，而 `thc` 欄位同時持有同樣的 16,750。**同一筆錢進了兩個欄位**，`83,690 − 16,750 = 66,940` 精確吻合。

### 提取本身沒有錯

行項目 8 筆合計 65,323，與 `subtotal` 完全相等，對帳通過：

```
lineItemTotalReconciliation: { checked: true, mismatch: false, difference: 0,
                               lineItemSum: 65323, totalSource: "subtotal" }
```

錯的是 `fields` 層的**歸戶**，不是明細金額。這也是本問題**繞過對帳閘**的原因 —— FIX-147／FIX-151 的閘門只驗行項合計與發票總額是否相符，不驗每筆錢歸進了哪個欄位、是否歸了兩次。

---

## 根本原因（兩層，缺一不會發生）

### 第一層：GLOBAL prompt 要求把幣別寫進 description

`prompt_configs` 中 `V3.1 Stage 3 - Field Extraction`（id `cmo197zi9000cnsxgcjg5dh8v`）的 systemPrompt：

```
Currency Rule (company-specific):
- Each line item on this company's invoices may list amounts in more than one currency
  (e.g. the original currency alongside its HKD equivalent).
- For every line item, populate the "amount" field with the HKD value ONLY.
- If a given line has no HKD amount, then fall back to the original-currency amount
  and note the original currency in the "description".      ← 問題來源
```

| 項目 | 值 |
|---|---|
| scope | **GLOBAL**（`companyId = null`） |
| isActive / version | true / 3（最後更新 2026-07-10） |
| Nippon 自有 prompt config | **無**（該公司名下 0 筆 → 直接吃這份 GLOBAL） |

規則本文自稱 `company-specific`、`this company's invoices`、以 HKD 為基準，**但它掛在 GLOBAL scope**，套用於所有公司的所有文件。任何沒有 HKD 金額的發票（THB／JPY／USD…）**每一行都會觸發** fall back 分支，於是每個 description 都被要求附上幣別。

這與回填機制直接衝突：

- Currency Rule 要求：往 description **加**幣別註記
- `backfillLineItemCharges` 要求：用 description **精確比對** field definition 的 label

一邊污染，一邊要求乾淨。

#### 規則的原始意圖（使用者於 2026-08-02 說明）

部分公司的發票金額非 HKD，因此本專案希望「以 HKD 金額為主；文件上完全沒有 HKD 金額時，觸發貨幣轉換流程」。這條 prompt 規則就是承接前半段（**優先取 HKD 值**）而寫的。

**前半段有實際作用，應予保留** —— 對同時印出原幣與 HKD 等值的發票，它決定 `amount` 取哪一個。有問題的只有 fall back 分支的**後半句**「在 description 註明原幣」。

#### ⚠️ 查證發現：幣別資訊已有承載處，而註記無人讀取

| 事實 | 依據 |
|---|---|
| 匯率轉換讀的是**發票層級** `standardFields.currency` | `exchange-rate-converter.service.ts:85` |
| 轉換服務**完全不讀** lineItem 的 description | 同上，全檔無相關存取 |
| 本案 `fields.currency` = `"THB"`（信心度 99） | 提取結果 |
| 全專案無任何程式碼解析 description 中的幣別註記 | —— |

也就是說：**幣別註記寫進 description 對系統沒有任何程式化用途**，幣別已由 `currency` 欄位完整承載。它唯一的實際效果就是破壞回填比對。

#### 🔴 附帶查證：使用者預期的轉換流程實際上未啟用

使用者理解為「沒有 HKD 金額 → 觸發貨幣轉換功能流程」。查 `pipeline_configs`（全庫**僅 1 筆**，GLOBAL）：

```
fxConversionEnabled = false
fxTargetCurrency    = null
fxSourceCurrency    = null
```

`ExchangeRateConverterService.convert()` 第一件事就是檢查 `config.fxConversionEnabled`，false 即直接回傳 `{ enabled: false, conversions: [] }`。

**因此 CHANGE-032／Epic 21 的匯率轉換從未對任何文件生效**，THB 發票的金額至今都是 THB 原值、未轉為 HKD。這**不是** FIX-154 的根因（本問題與金額是否換算無關），但它是理解那條 prompt 規則的必要背景 —— 該規則實質上是在「代替」一個沒有啟用的功能做事，而它做的那一半（註記幣別）恰好無人接手。

此落差本身是否需要處理，見下方未決問題。

### 第二層：`matchLabel` 的短詞保護讓帶後綴的短 label 完全無法命中

`classify-normalizer.ts` 的子字串判定要求**目標** ≥ 8 字元且 ≥ 2 詞（CHANGE-094 為擋掉 `"Fee"` / `"Charge"` 這類通用短詞而設）：

```typescript
if (isWordBounded && b.length >= 8 && b.split(' ').length >= 2) return 'substring';
```

於是同樣被加了 `(THB)` 後綴，命運完全不同：

| description | 目標 label | 正規化後 | 結果 |
|---|---|---|---|
| `OCEAN FREIGHT (THB)` | `Ocean Freight` | `ocean freight`（13 字元、2 詞）| ✅ substring 命中 |
| `THC (THB)` | `THC` | `thc`（3 字元、1 詞）| ❌ 門檻不過 → **完全無命中** |

`THC (THB)` 的 description 認領失敗後，退回 `classifiedAs` fallback。GPT 給的分類名是 `Terminal Handling Charge`，它以完整詞結尾包含 `handling charge`（15 字元、2 詞，通過門檻）→ **唯一命中 `handling_charge`** → THC 的 16,750 被歸進 handling。

### 完整鏈路

```
GLOBAL Currency Rule  →  description 變成 "THC (THB)"
                              ↓
matchLabel 短詞門檻   →  對 label "THC" 無命中，description 認領失敗
                              ↓
classifiedAs fallback →  "Terminal Handling Charge" 唯一命中 handling_charge
                              ↓
handling_charge = 500 + 13,950 + 2,800 = 17,250
thc = 16,750（GPT 自行填寫，未被回填覆蓋，無 source 標記）
                              ↓
模板兩欄相加  →  THC 重複計入 16,750
```

### 為何 FIX-127 的金額指紋沒有攔住

FIX-127 會清除「未被任何行項認領、但金額與已認領金額相同」的欄位。本案 `thc = 16,750` 確實未被認領，但指紋清單裡只有各 key 的加總（`17,250`、`42,223`…）與被認領行的個別金額（`13,950`、`2,800`…）—— **`16,750` 這個「兩筆之和」不在其中**，故比對不到、不清除。

---

## 證據

### 對照組：同一份發票、同一份 prompt、不同模型

`git diff --no-index` 確認兩次的 Stage 3 prompt **逐字元完全相同**（皆 6,849 字元），差異純粹來自模型行為：

| 提取時間 | 模型 | description | `handling_charge` | `subtotal` |
|---|---|---|---:|---:|
| 08-01 11:43 | gpt-5.4-mini | `"THC"` | **500** ✅ | 65,223 ❌ |
| 08-01 15:41 | gpt-5.4-mini | `"THC"` | **500** ✅ | 66,940 ❌ |
| 08-02 10:19 | gpt-5.6-luna | `"THC (THB)"` | **17,250** ❌ | 65,323 ✅ |
| 08-02 10:42 | gpt-5.6-luna | `"THC (THB)"` | **17,250** ❌ | 65,323 ✅ |

luna 兩次結果**完全一致**（確定性錯誤，非隨機抖動），且該次 8 行 description **全部**帶幣別後綴 —— 這是「有沒有遵守 Currency Rule」的差別，不是抖動。

> 🔴 **luna 並未出錯，它比舊模型更嚴格地執行了 prompt。** 且它在 `subtotal` 上反而更準：5.4-mini 兩次都錯（一次差 100、一次填成 GRAND TOTAL），luna 兩次都正確。兩者的失誤落在不同位置，不能簡化為「新模型較差」。

### 實機重現

以**實際的** `matchLabel`（非複刻邏輯）餵入該發票的 8 筆行項，回填結果與資料庫逐項吻合：

```
handling_charge = 17250   ← 資料庫實際值 17250
ocean_freight   = 42223
do_fee          =  1650
other_charges   =  2100
cleaning_container = 2100
合計 65323
```

驗證腳本：`scripts/verify-nippon-thc-match.ts`（`.gitignore` 的 `scripts/verify-*` 已涵蓋，不入版本庫）。

---

## 影響範圍

### 不限於 Nippon，也不限於 THC

觸發條件是「description 帶後綴」×「目標 label 短於門檻」。前者對**所有非 HKD 發票**成立（GLOBAL 規則），後者在 Nippon 這組 20 個費用欄位裡至少有 4 個：

| key | label | 正規化 | 字元 / 詞 | 狀態 |
|---|---|---|---:|---|
| `thc` | `THC` | `thc` | 3 / 1 | ❌ 本次受害 |
| `t_h_c` | `T.H.C` | `t h c` | 5 / 3 | ❌ 現行規則下**永不可能命中** |
| `do_fee` | `D/O Fee` | `d o fee` | 7 / 3 | ❌ 本次靠 classifiedAs 僥倖命中對了 |
| `bl_fee` | `B/L fee` | `b l fee` | 7 / 3 | ❌ 同上風險 |

`do_fee` 這次結果正確**純屬僥倖** —— 它同樣走 classifiedAs fallback，只是 `D/o Fee` 剛好唯一命中自己。若哪天有更長的欄位（如 `Delivery Order Fee`）加入，它也會被吃掉。

### ⚠️ 尚未量化

以下三項需要查資料才能回答，**不應憑推測填入**：

1. 全庫有多少份文件的 description 帶幣別後綴（＝有多少次提取踩到第一層）
2. 其中多少份的費用欄位實際發生誤歸戶（需逐份比對 `fields` 與 `lineItems`）
3. 有多少已匯出的模板實例含虛增金額

查詢前須先讀 `claudedocs/reference/data-semantic-breakpoints.md` —— 本問題的顯現與模型切換日期強相關，跨時間統計需以 CHANGE-115 部署日切分。

---

## 修復方案（待拍板）

| 選項 | 做法 | 影響面 | 風險 |
|---|---|---|---|
| **B（建議）** | 回填比對前先剝除候選字串尾端的括號後綴，再試一次 exact 比對 | 全公司受益；`"THC (THB)"` → `"THC"` 直接 exact 命中（exact 不受長度門檻限制） | 低 —— 只增加一次比對機會，不放寬既有門檻 |
| **E（建議並行）** | 修正 GLOBAL Currency Rule：**保留**「優先取 HKD 值」，**刪除**「在 description 註明原幣」該句 | 直擊污染源頭 | 低 —— 已查證幣別由 `currency` 欄位承載，且無任何程式碼讀取 description 中的註記（見上方查證表） |
| A | 給 `thc` 增補 alias `"THC (THB)"` | 僅該公司該欄位 | 治標；每種幣別都要各加一筆 |
| C | 放寬 `matchLabel` 的 `≥ 8` 字元門檻 | 全域 | **最高** —— 會讓 `"Fee"` / `"Charge"` 等通用短詞重新亂命中，等同回退 CHANGE-094 |

> 建議 **B + E 並行**：B 讓回填能抵抗後綴污染（不論後綴來自何處），E 移除本專案自己製造的污染源。兩者互不取代 —— 只做 E 仍無法擋住發票原文本身就帶後綴的情況。

### 🔴 不採取的做法

**不移除** `t_h_c`、`handling_charge` 等「競爭」欄位定義。依 FIX-150 的教訓：樣本 ≠ 母體，別的文件可能真的用該寫法；消除互搶要靠**給予專屬 alias**，不是移除競爭者。

---

## 實作內容（2026-08-02）

### 方案 B —— 剝除尾端括號註記後重試（代碼）

| 檔案 | 變更 |
|---|---|
| `src/services/extraction-v3/utils/classify-normalizer.ts` | 新增 `stripTrailingParenthetical()` |
| `src/services/extraction-v3/stages/stage-3-extraction.service.ts` | `resolveUniqueChargeKey` 加入第二輪比對；比對迴圈抽出為 `collectChargeMatches` |
| `tests/unit/services/stage-3-lineitem-backfill.test.ts` | 新增 `describe('FIX-154: ...')` 共 5 項 |

三個關鍵的設計約束：

1. **第二輪只採 exact** —— exact 不受 `≥ 8 字元` 門檻限制，而限定 exact 可確保即使剝掉的不是幣別（如 `(FCL)`），仍必須完全相等才認領。**不放寬**既有命中標準。
2. **方向集合恆取自原候選** —— 剝除後綴不得成為繞過 FIX-126 方向閘的途徑。
3. **僅在第一輪無法裁決時才觸發** —— 既有成功路徑完全不經過新邏輯，回歸風險為零。

### 方案 E —— 移除 GLOBAL 規則的 description 註記（資料庫）

腳本：`scripts/fix-154-remove-currency-description-note.ts`（inspect / dryrun / write 三段式）

```diff
- - If a given line has no HKD amount, then fall back to the original-currency amount
-   and note the original currency in the "description".
+ - If a given line has no HKD amount, then fall back to the original-currency amount.
```

其餘四行（含「優先取 HKD 值」）**完全未動**。配置 `cmo197zi9000cnsxgcjg5dh8v` version 3 → 4，字元數 1367 → 1315。

五項必備措施齊備：前置快照（`.snapshots/fix-154-prompt-before-*.json`）、單一交易、`rowCount !== 1` 即中止回滾、`updated_at` 樂觀鎖、冪等（重跑回報「已是目標狀態，無動作」）。

腳本另設兩道保護：原句**完整比對**（找不到即中止，不盲改被他人修改過的內容）、字串層數量閘（預期恰好出現 1 次）。

> ⚠️ **只改了本機資料庫**。Azure DEV 需另跑同一支腳本，且務必先 `inspect`。

---

## 驗收標準

- [x] 新增回歸測試：`"THC (THB)"` 能認領 label 為 `"THC"` 的欄位
- [x] 新增回歸測試：`"Terminal Handling Charge"` **不得**認領 `handling_charge`
- [x] 新增回歸測試：完整重現 NEX_RCIM250001_202 —— `handling_charge` = 500、`thc` = 16,750、六欄合計 = 65,323
- [x] 新增回歸測試：剝除後綴**只採 exact**，不放寬子字串門檻
- [x] 新增回歸測試：剝除後綴不得繞過 FIX-126 方向閘
- [x] 既有回填測試全數通過（CHANGE-094 / FIX-108 / FIX-126 / FIX-127 案例無回退）——**458 passed**（原 453，+5）
- [x] `type-check` / `lint` 通過
- [x] 方案 E 保留「優先取 HKD」該句，混幣發票的 `amount` 行為不變
- [x] **實機驗證通過**（2026-08-02 12:06，見下方）
- [ ] ⏳ Azure DEV 部署（代碼）+ 於該環境執行方案 E 腳本（資料庫）

---

## 實機驗證結果（2026-08-02 12:06）

重新處理 `NEX_RCIM250001_202.SIGNED..pdf`（gpt-5.6-luna，19.4 秒，`AUTO_APPROVE`，信心度 0.983）。

### 方案 E 生效：description 不再帶幣別後綴

```
修復前： "HANDLING CHARGE (THB)"  "THC (THB)"  "OCEAN FREIGHT (THB)"
修復後： "HANDLING CHARGE"        "THC"        "OCEAN FREIGHT"
```

### 費用歸戶全部正確

| 欄位 | 修復前 | 修復後 | 判定 |
|---|---:|---:|---|
| `handling_charge` | **17,250** | **500** | ✅ |
| `thc` | 16,750 | 16,750 | ✅ |
| `ocean_freight` | 42,223 | 42,223 | ✅ |
| `do_fee` | 1,650 | 1,650 | ✅ |
| `other_charges` | 2,100 | 2,100 | ✅ |
| `cleaning_container` | 2,100 | 2,100 | ✅ |

六個欄位這次**全部**帶 `[lineItem-backfill]` 標記 —— 修復前 `thc` 是模型自行填寫（無標記），現已由回填確定性產生。

### 模板實例合計 = GRAND TOTAL

新建驗證用實例 `FIX-154 verification - NEX_RCIM250001_202`（id `cmsbrbepj0000ckxgeocxhf2x`）：

```json
{ "thc": 16750, "vat": 1617, "freight": 42223, "docs_fee": 1650,
  "handling": 500, "others_local_charge": 4200, "wh_container_facility_fee": 0 }
數值欄位合計 = 66,940   ✅ 等於 GRAND TOTAL（修復前 83,690）
```

> 原實例（`cmsbo8wbe...`，合計 83,690）狀態為 `COMPLETED`，API 拒絕再寫入 —— 該保護使錯誤證據完整保留，未被覆蓋。驗證改用新建實例。
>
> ⚠️ 該驗證用實例仍在資料庫中，名稱已標明用途；如需清理請自行刪除（未擅自刪除資料）。

### 一項與修復無關的變化

本次提取的行項目為 **9 筆**（前次 8 筆），多出 `"VAT 7%"` 1,617。對帳因而改以 `total_amount` 為基準：

```json
{ "checked": true, "mismatch": false, "difference": 0,
  "lineItemSum": 66940, "totalSource": "total_amount", "lineItemCount": 9 }
```

仍然 `mismatch: false`。這是模型輸出的差異（VAT 是否列為行項），非本次修復所致 —— FIX-151 的「行項合計與 `subtotal` 精確吻合時改以 `subtotal` 為準」在此正確地選了 `total_amount`。記錄於此以免日後誤讀為迴歸。

---

## 未決問題

| # | 問題 | 狀態 |
|---|---|---|
| 1 | Currency Rule 的來源與意圖 | ✅ **已釐清**（2026-08-02 使用者說明）：承接「以 HKD 為主、無 HKD 則轉換」的需求。前半段保留，只移除 description 註記 |
| 2 | 是否有發票仰賴這條規則？移除會不會破壞？ | ✅ **已釐清**：混幣發票仰賴的是「優先取 HKD」該句（**保留**）；被移除的註記無任何程式碼讀取，`currency` 欄位已承載幣別 |
| 3 | 是否回溯重新處理既有文件？ | ✅ **不回溯**（2026-08-02 使用者決定）：本階段目標為釐清原因與規劃解法 |
| 4 | **匯率轉換功能未啟用是否要處理？** | ⏳ **待決** —— `fxConversionEnabled = false`，Epic 21／CHANGE-032 的轉換從未生效。啟用需要 `fxTargetCurrency`、匯率資料與影響評估，屬獨立範圍，建議另開 CHANGE |

---

## 附註：與 CHANGE-115 的關係

本問題**不是** CHANGE-115 造成的，兩層根因都早於它存在：GLOBAL Currency Rule 最後更新於 2026-07-10，`matchLabel` 門檻自 CHANGE-094 即有。CHANGE-115 的作用是讓一個**原本潛伏**的缺陷穩定顯現 —— 舊模型忽略該規則而僥倖避開。

這正是 Epic 23 tech-spec §6.1 要求「核心提取環節換模型前做準確率回歸」的價值所在；CHANGE-115 未執行該回歸（已在該文件標為待辦），此缺陷因而由使用者在驗收時發現。
