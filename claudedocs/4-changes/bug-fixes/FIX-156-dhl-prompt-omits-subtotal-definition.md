# FIX-156: DHL 的 COMPANY prompt 未定義 subtotal —— 模型每次自行推斷，同一張發票取出三種值

> **建立日期**: 2026-08-02
> **發現方式**: FIX-155 盤點 `subtotal` 提取率時發現同一張發票的 `subtotal` 前後不一致；使用者指出根因並非模型隨機性，而是 DHL 發票上沒有這個欄位名稱、prompt 又未指明位置，模型只能猜
> **影響頁面/功能**: Stage 3 提取 `fields.subtotal` → FIX-151 的對帳基準選擇
> **優先級**: 中（目前**未造成對帳誤判** —— 這幾張發票的 `total_amount` 恰好等於行項合計，兩種基準結論相同。但含稅發票一旦遇上，基準飄移會直接翻轉對帳結論）
> **狀態**: ✅ 已完成（2026-08-02 本機寫入 version 2→3 並重跑驗證，六項驗收全數達標；**2026-08-03 已同步 Azure DEV**，該環境 version 1→2，以 `prisma/sync-config-20260803.js` 步驟 2 寫入，重跑 inspect 確認「已含 Amount summary 段落」。**2026-08-04 本機以 26 份 DHL 樣本驗證取值** —— `subtotal` 覆蓋率 **26/26**，且有一份 `subtotal ≠ total_amount` 證明非照抄，見 §取值驗證。⏳ Azure 端仍未以真實發票驗證）
> **相關**: [FIX-151](FIX-151-reconcile-uses-tax-inclusive-total.md)（對帳基準依賴 `subtotal`）、[CHANGE-113](../feature-changes/CHANGE-113-line-item-mode-group-expand.md)（建立本 prompt 的變更）、[FIX-155](FIX-155-line-item-amount-currency-unstable.md)（本問題的發現脈絡）、[FIX-152](FIX-152-dhl-multi-shipment-aggregate-amount-leak.md)（同一張 DHL 發票的聚合列問題）

---

## 問題描述

DHL 發票 `HKGIR02794867`（檔名 `DHL_RCIM250246_94867.pdf`）在本地被處理三次，全部由 gpt-5.6-luna 執行，`total_amount` 三次都正確且一致（14,929.98），但 `subtotal` 取出**三種不同的值**：

| 處理時間 | subtotal | total_amount | 行項合計 | 對帳基準 |
|---|---:|---:|---:|---|
| 2026-08-02 10:19 | **11,484.60** | 14,929.98 | 14,929.98 | total_amount |
| 2026-08-02 10:41 | **14,929.98** | 14,929.98 | 14,929.98 | subtotal |
| 2026-08-02 13:38 | **null** | 14,929.98 | 14,929.98 | total_amount |

### 11,484.60 不是亂數，是「運費小計」

窮舉 8 筆行項的全部子集，只有一種組合湊得出 11,484.60：

```
EXPRESS WORLDWIDE doc      191.10
EXPRESS WORLDWIDE doc      191.10
EXPRESS WORLDWIDE nondoc 3,700.20
EXPRESS WORLDWIDE nondoc 7,402.20
                        ─────────
                        11,484.60   ← 運費合計，不含燃油附加費

FUEL SURCHARGE ×4        3,445.38
                        ─────────
總計                     14,929.98
```

模型取的是一個**在發票上真實成立的中間合計**，只是與系統期待的定義不同。這排除了「隨機亂填」，指向定義缺失。

---

## 根本原因

### 第一層：DHL 的 prompt 完全沒有提到 subtotal

`prompt_configs` 中 `DHL Express - Stage 3 (multi-shipment detail table)`（id `change113-dhl-stage3-001`，scope COMPANY，companyId `eedf4065-653b-4fd0-8bfb-f71c78bb2ae5`，版本 2）的 **`mergeStrategy = "OVERRIDE"`** —— 它**完全取代** GLOBAL prompt，而非疊加。

兩者的「Invoice basics」要求正好差在這一項：

| 來源 | userPromptTemplate 的必抽欄位 |
|---|---|
| GLOBAL `V3.1 Stage 3 - Field Extraction` | invoice number, invoice date, due date, currency, **subtotal**, total amount |
| DHL（OVERRIDE 掉 GLOBAL） | invoice number, invoice date, currency, total amount —— **無 subtotal** |

DHL 的 systemPrompt 全文 2,472 字元，**一次都沒出現 subtotal**。模型只能從系統提供的 JSON schema 看到有這個欄位，卻沒有任何關於它該裝什麼的指引。

### 第二層：prompt 主動把模型推離發票上的小計

DHL systemPrompt 的 line item 規則第 2 條：

```
NEVER emit aggregate rows as line items. Ignore "Service Sub Total ...", "Total: HKD",
and the per-row total printed in the rightmost "Total" column.
```

這條的用意是防止聚合列被當成 line item 而重複計費（CHANGE-113／FIX-152 的脈絡），**針對的是 lineItems**。但模型讀到「Service Sub Total 要忽略」後，填 `fields.subtotal` 時也避開了發票上那個真正的小計，改為自行從行項湊一個。

**兩層合起來**：沒有定義（第一層）＋ 明確要求忽略發票上的小計（第二層）＝ 每次自行推斷，結果不定。

---

## 修復方案

### 定義（使用者 2026-08-02 拍板：採「甲」）

> **`subtotal` = 所有費用的合計（含燃油附加費），不含稅**，亦即等於本次提取的 `lineItems[].amount` 總和。

選它的理由：不依賴發票版面、可自我驗證（等於行項合計）、且正好是 FIX-151 拿來當對帳基準時需要的值。相對地，「取發票上印的 Service Sub Total」會在 DHL 按服務分組印出多個小計時再度變得不明確。

### 變更範圍（🔴 精確指名）

**`prompt_configs` 表的單一一筆：`change113-dhl-stage3-001`**（DHL Express，COMPANY scope）。

- **不動** GLOBAL `V3.1 Stage 3 - Field Extraction`（`cmo197zi9000cnsxgcjg5dh8v`）
- **不動** 其他 5 筆 COMPANY scope 的 Stage 3 prompt（Cargo Partner／Fairate／Ningbo／Redlines／Kintetsu）
- 因 `mergeStrategy = OVERRIDE` 且綁定 `companyId`，本變更對其他公司**零影響**

### 擬新增的段落

```
## Amount summary

- subtotal: the sum of ALL charges you emitted as line items, including fuel
  surcharges, before tax. It must equal the total of your lineItems[].amount.
- The instruction to ignore "Service Sub Total" applies to LINE ITEMS only. It does
  not mean fields.subtotal should be left empty, nor computed from a subset of the
  charges (for example freight without fuel surcharge).
```

同時在 userPromptTemplate 的「Must extract」補上 subtotal。

### 執行方式

依 §不可逆資料操作紀律，以三段式 gated 腳本執行，五項措施齊備：前置快照（寫入 `.snapshots/`）、單一交易、數量閘（`rowCount === 1`）、樂觀鎖（`WHERE updated_at = 讀取當下值`）、冪等（已含該段落即跳過）。版本號 2 → 3。

---

## 驗收標準與結果（2026-08-02 執行）

| # | 判準 | 結果 |
|---|---|---|
| 1 | 重跑 `DHL_RCIM250246_94867.pdf` 3 次，`subtotal` 皆為 14,929.98 | ✅ **3/3 皆 14,929.98**（原為 11,484.60 / 14,929.98 / null 三種） |
| 2 | 重跑 `DHL_RCIM250119_13447.pdf` 3 次，`subtotal` 一致且等於行項合計 | ✅ **3/3 皆 5,857.43**（原為 5,857.43 / null 兩種） |
| 3 | `total_amount` 與 `lineItems` 不因本次變更而改變 | ✅ `diff` 確認：幣別、`total_amount`、行項數、行項合計全部未動 |
| 4 | 對帳 `totalSource` 穩定取 `subtotal`，`mismatch` 維持 false | ✅ 六次全部 `totalSource: "subtotal"`、`mismatch: false`、`difference: 0` |
| 5 | `diff` 比對前後，除 `subtotal` 外無其他退步訊號 | ✅ 13 筆 DHL 中僅 2 筆變動（正是目標文件），**退步訊號 0** |
| 6 | 非 DHL 公司不受影響 | ✅ 見下 |

### 第 6 項的判定依據

重跑 Nippon `NEX_RCIM250001_202.SIGNED..pdf` 作為對照組，日誌顯示：

```
[Stage3] Applied variable replacement for PromptConfig (scope: GLOBAL)
```

Nippon 名下無 COMPANY prompt，走的是 GLOBAL 那份 —— 本次變更未觸及，故不受影響。

該次重跑確實出現一項差異（行項 9 筆 → 8 筆，合計 66,940 → 65,323），`diff` 將它標為退步。**但這與本 FIX 無關**，原因有二：

1. Nippon 用的是 GLOBAL prompt，本次變更只動 `change113-dhl-stage3-001`（COMPANY + `OVERRIDE` + 綁定 DHL companyId）
2. 差異的內容是「VAT 是否被當成 line item」。依 [FIX-143](FIX-143-summary-area-vat-field-typed-as-lineitem.md)，`vat_7` 已由 `lineItem` 改為 `standard`（屬摘要區欄位），因此 **8 筆才是正確的**，先前的 9 筆才是異常

`diff` 的「行項變少 = 退步」是啟發式判準，此處為誤判 —— 判準用於**提示人工檢視**，不能當作結論。

---

## 取值驗證（2026-08-04，本機 26 份 DHL 樣本）

2026-08-02 的驗收證明了 prompt 已寫入且同一張發票重跑取值一致，但樣本只有數份。以使用者提供的 375 份樣本在本機分兩批重跑（第一批抽樣 2 份 + 第二批 24 份），DHL 共 **26 份**取得提取結果：

| 判準 | 份數 |
|---|---:|
| `subtotal` 有值 | **26 / 26** |
| 其中 `subtotal` **≠** `total_amount` | **1** |
| 其中 `subtotal` **=** `total_amount` | 25 |

**覆蓋率 100%** —— prompt 加上 Amount summary 段落後，模型每一份都取得到 `subtotal`，不再出現 FIX-155 記錄的「時有時無」。

**區辨力的唯一實例**：

```
DHL_RCEX250138_96978.pdf     subtotal = 108.75     total_amount = 299.85
```

這一份證明 `subtotal` **不是照抄** `total_amount`，模型確實在辨識稅前金額。其餘 25 份兩值相等 —— 若那些發票本就不含稅則屬正常，但也因此**驗不到區辨力**。

> ⚠️ 上述唯一實例的差額為 191.10，佔 total 的 63.7%，遠高於一般稅率。這不像單純的稅前／含稅關係，可能涉及多筆 shipment 的結構（參見 [FIX-152](FIX-152-dhl-multi-shipment-aggregate-amount-leak.md)）。**本文件不對該份的正確性下判斷** —— 它證明的是「`subtotal` 與 `total_amount` 會取到不同值」，不是「這個值算得對」。要確認需人工核對該張發票。

> ⚠️ 樣本偏差：25/26 為 `subtotal = total_amount`，意味 [FIX-151](FIX-151-reconcile-uses-tax-inclusive-total.md) 的對帳基準切換邏輯在這批樣本上**幾乎沒有被實際觸發**。要驗證那條路徑，需要一批確實含 VAT 的 DHL 發票。

---

## 驗證過程中觀察到的另一件事（不屬本 FIX，僅記錄）

Nippon `IAJ-K2027` 的 VAT 行項提取不穩定：同一份文件，2026-08-02 12:06 那次含 VAT（9 筆／66,940），14:22 這次不含（8 筆／65,323）。兩次的對帳都通過，但**基準不同**（`total_amount` vs `subtotal`）。

這與 FIX-155 記錄的 `subtotal` 不穩定屬同一類 —— 提取的非確定性會改變對帳基準的選擇。目前兩種結果的對帳結論都正確，尚未造成誤判。

---

## 待確認事項

| # | 事項 | 狀態 |
|---|---|---|
| 1 | subtotal 的業務定義 | ✅ 已拍板（甲） |
| 2 | 其他公司是否有同樣的「OVERRIDE 掉 subtotal 說明」問題 | 🔴 **未查** —— 另 5 筆 COMPANY prompt 皆為 `OVERRIDE`，需逐一確認是否也漏了 subtotal（Fairate 那份提取出 `subtotal = null`，最可疑） |
| 3 | Azure DEV 的同一筆 prompt 是否需要同步 | 🔴 **未決** —— 本地與 Azure 的 `prompt_configs` 各自獨立，本次只改本機 |

---

## 備註

- 本問題**不是**模型隨機性造成的。同一模型在其他 6 對可比發票上 `subtotal` 完全一致，不穩定只出現在 DHL 與另外兩張缺乏明確小計欄位的發票上
- `Kintetsu Stage 3 Field Extraction Test` 標為 COMPANY scope 但 `companyId = null`（與 FIX-154 發現的「GLOBAL prompt 自稱 company-specific」互為鏡像）。不屬本 FIX 範圍，僅記錄
