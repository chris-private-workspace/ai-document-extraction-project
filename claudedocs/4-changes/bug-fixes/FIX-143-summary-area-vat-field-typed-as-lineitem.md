# FIX-143: 印在總額下方的 VAT 欄位被設為 lineItem 型，導致永遠提取不到

> **建立日期**: 2026-07-29
> **發現方式**: 使用者 Azure DEV 測試回報「Nippon 的 VAT 7% 拿不到」（`NEX_RCIM250001_202.pdf`）
> **影響頁面/功能**: Stage 3 欄位提取 → 模板實例欄位值
> **優先級**: 中（該欄位在任何情況下都不可能有值，且下游公式靜默算成 0）
> **狀態**: ✅ 已修復並驗證（2026-07-29 Azure DEV 設定資料修正 + 實機重跑取得 `vat_7 = 1617`；2026-08-01 本機同步完成，兩環境一致。同日撤回本文原記載的 CEVA「同型問題」判斷 —— 查證後證實方向相反，見 §「同型問題」的判斷已撤回）

---

## 問題描述

`NEX_RCIM250001_202.SIGNED..pdf` 的 VAT 7% 印在**發票總金額下方**（summary 區），不在費用明細行內。提取結果中該欄位恆為空：

```json
"vat_7": { "value": null, "confidence": 0 }
```

注意 `source` 屬性缺席 —— 表示 GPT 沒填，確定性回填也沒接手，兩條路都沒碰到它。同次提取的 8 筆 `lineItems` 全是明細行費用，沒有任何 VAT 項。

下游連鎖影響在模板實例可以直接看到。該文件在 `Logistics Cost - Inbound Template (Full List)` 的映射規則是：

```
handling ← {handling_charge} + {empty_container_placement} + {vat_7}
```

而 `template_instance_rows.transform_diagnostics`（FIX-128 加的診斷）明確記著：

```json
"handling": ["empty_container_placement", "vat_7"]
```

`FormulaTransform.replaceVariables` 把缺失值視為 0，所以 `handling` 算出 500（只有 `handling_charge`），VAT 靜默消失、不報錯。

---

## 根本原因

該欄位在 `Nippon Express Logistics - 自訂費用欄位集` 中被定義為 **`fieldType: 'lineItem'`**：

```json
{ "key": "vat_7", "label": "VAT 7%", "category": "charges",
  "dataType": "currency", "required": false, "fieldType": "lineItem", "aliases": [] }
```

`fieldType: 'lineItem'` 的欄位只有兩條填值路徑，**兩條都限定 line items**：

| 路徑 | 位置 | 行為 |
|------|------|------|
| Prompt 指示（CHANGE-094） | `stage-3-extraction.service.ts:1026-1036` | `For EACH line item whose charge corresponds to one of the charge field keys below...` + 尾端列出 charge field keys 清單 |
| 確定性回填（FIX-108） | `backfillLineItemCharges`（第 1505 行） | `chargeDefs = fieldDefinitions.filter(d => d.fieldType === 'lineItem')`，只掃 `lineItems` 認領 |

印在 summary 區的稅額不會出現在 `lineItems`，因此兩條路都走不到。這不是模型能力問題 —— 是欄位被歸錯類，等於明確告訴 GPT「只在明細行裡找它」。

該欄位集 21 個欄位**全部**是 `lineItem` 型，可見建立時是整批套用，沒有區分「明細行費用」與「總結區金額」。

---

## 修復方式

把 `vat_7` 的 `fieldType` 由 `lineItem` 改為 `standard`（`FieldDefinitionFieldType = 'standard' | 'lineItem'`，`standard` 為預設值）。

改為 `standard` 後的實際差異：

| 面向 | 改前 | 改後 |
|------|------|------|
| Optional Fields 清單（prompt） | 有列出 | 有列出（不變） |
| structured output schema | 包含（`generateOutputSchema` 不看 fieldType） | 包含（不變） |
| 「從 line items 填」清單 | **列在其中** → 誤導 GPT 只找明細行 | 不再列入 |
| `backfillLineItemCharges` | 會被回填 / 被 FIX-127 清除邏輯納入 | 不再處理 |

### 執行方式

此欄位定義是 Azure DEV 的設定資料，非程式碼。透過 Kudu 於 VNet 內連私有 PostgreSQL 執行單筆 `UPDATE`，帶三重保護：

- **數量閘**：`vat_7` 必須剛好 1 個且目前為 `lineItem`，否則中止不寫入
- **樂觀鎖**：`WHERE id = $1 AND updated_at = $2`（讀取當下的值），並要求 `rowCount === 1`
- **前置快照**：完整 `fields` JSON 於變更前輸出保存

實際結果（2026-07-29T01:55:41Z）：

```
rowCount: 1, totalFields: 21 (不變), lineItemFields: 21 → 20, standardFields: 0 → 1
vat_7.fieldType: "lineItem" → "standard"（label / aliases / category / dataType / required 原樣保留）
```

> UI 亦支援此變更（`FieldEntryEditor.tsx:145-162` 有欄位類型下拉），本次採腳本執行是為了帶上數量閘與樂觀鎖。

---

## 驗證結果（2026-07-29）✅ 已取得

改設定不回溯既有提取結果，故由使用者在 Azure DEV 重新上傳同一份 PDF 處理一次（`NEX_RCIM250001_202.SIGNED. (1).pdf`，文件 `a8e2b366-c814-43f6-98f9-6c73950467c3`，提取於 `2026-07-29T02:50:53Z`）。原 7/23 那份未被觸碰，成為天然對照組。

| 項目 | 7/23（改前） | 7/29（改後） |
|------|-------------|-------------|
| `vat_7` | `null` / 信心度 0 / 無 `source` | **`1617`** / 信心度 95 / **無 `source`** |
| `subtotal` | 66223 | **65323** |
| `total_amount` | 66940 | 66940 |
| 平均信心度 | 97.55 | 96.80 |

`vat_7` 沒有 `source` 標記，代表值來自 **GPT 直接提取**而非 `backfillLineItemCharges` 回填 —— 正是改為 `standard` 後預期的路徑。`field_mappings` 同步落地：

```json
"vat_7": { "value": 1617, "source": "unified", "rawValue": "1617",
           "confidence": 97, "extractionMethod": "DIRECT" }
```

**未使用 `extractionHints`** —— 原本預備的「若仍為 null 就補提示」這一步不需要了。單純移除「只在明細行找」的誤導就足以讓模型正確歸戶。

### 意外收穫：`subtotal` 一併變準

```
lineItems 加總 = 500 + 1650 + 13950 + 2100 + 2100 + 2800 + 36191 + 6032 = 65323
65323 (subtotal) + 1617 (vat_7) = 66940 (total_amount)  ✓ 完全閉合
```

改前的 `subtotal` 66223 是錯值（66940 − 717）—— 那是模型在 VAT 無處可歸的情況下湊出來的。`vat_7` 有了正確去處之後，summary 區的數字不再互相擠壓，整張發票的加總關係自洽。

> 這是把欄位歸錯類的隱性代價：不只該欄位取不到，**相鄰欄位也會被連累失準**，而後者不會有任何錯誤訊號。

> 附帶一提：label 是「VAT 7%」但 1617 / 65323 ≈ 2.5%。標籤與實際稅率對不上屬資料面問題，不影響提取正確性 —— 取到的數字與發票上印的一致。

### 下游尚未確認

該文件目前未加入任何模板實例（`templateRowCount: 0`）。依現有值，Inbound 映射的 `{handling_charge} + {empty_container_placement} + {vat_7}` 應算出 **2117**（500 + 0 + 1617），對比 7/23 的 500；`transform_diagnostics.handling` 應只剩 `empty_container_placement`，`vat_7` 會從缺失清單消失。待該文件加入實例後可確認。

---

## 🔴 「同型問題」的判斷已撤回（2026-08-01）

### 原判斷（2026-07-29，本節初版）

> CEVA 兩個欄位定義集的 `vat_7_percent` 同樣是 `fieldType: 'lineItem'`，屬同型問題，
> 待確認該公司是否真有此欄位需求後比照修正。

**此判斷不成立，已撤回。** 依據只是「欄位設定長得一樣」，未查證 VAT 在文件上的實際位置 —— 而那正是本 FIX 的判準所在。

### 查證結果（Azure DEV + 本機，唯讀）

CEVA 與 Nippon 是**相反**的情況，不是同型：

| | Nippon `vat_7`（本 FIX 的案例） | CEVA `vat_7_percent` / DSV `vat` / Toll `vat` |
|---|---|---|
| VAT 印在哪 | 總金額**下方**的 summary 區 | **明細行內** |
| `lineItems` 是否含 VAT 項 | 無 | **有** |
| `fieldType: 'lineItem'` 是否合適 | ❌ 錯（等於指示模型只在明細行找） | ✅ **正確** |
| 修改前的取值狀況 | 恆為 `null` | **正在正常取值** |

直接證據（Azure DEV）：

```
CEVA_RCEX250462_51143.pdf  lineItem "LOCAL VAT 7%" = 252.34            → vat_7_percent = 252.34
DSV_RCEX250153_25559.pdf   lineItem "VAT - 7.00% of USD 267.38" = 18.72 → vat = 18.72
```

取到非零值的份數：CEVA `vat_7_percent` 1 份、**DSV `vat` 22 份**、**Toll `vat` 42 份**。

CEVA 316 份文件幣別全為 HKD；265 份可判斷小計與總額，其中僅 2 筆有差額且均來自同一檔名的不同次提取（其一 `小計=1259.64 / 總額=12859.64` 為少讀一位數的提取錯誤，非稅額）。**CEVA 不存在「summary 區 VAT 取不到」的情形。**

### 若照原判斷執行會造成的損害

改為 `standard` 會使該欄位**退出** `backfillLineItemCharges` 的回填範圍（見上方 §修復方式 對照表第 4 列）—— 而那正是 CEVA / DSV / Toll 目前取到值的來源。等於為了修一個不存在的問題，弄壞三家公司共 65 份文件上運作正常的欄位。

### 稅類欄位的 `fieldType` 現況（2026-08-01 全庫掃描，Azure DEV）

| 欄位定義集 | 公司狀態 | 欄位 | `fieldType` | 判定 |
|---|---|---|---|---|
| `Nippon Express Logistics - 自訂費用欄位集` | ACTIVE | `vat_7` | `standard` | ✅ 本 FIX 已修，正確 |
| `CEVA Logistics - 自訂費用欄位集` | ACTIVE | `vat_7_percent` | `lineItem` | ✅ 正確，**不應更動** |
| `CEVA Logistics Hong Kong Limited - 自訂費用欄位集` | MERGED | `vat_7_percent` | `lineItem` | ✅ 同上 |
| `DSV Air & Sea Ltd. - 自訂費用欄位集` | ACTIVE | `vat` | `lineItem` | ✅ 同上 |
| `Toll Global Forwarder Limited - 自訂費用欄位集` | ACTIVE | `vat` | `lineItem` | ✅ 同上 |

### 通用教訓

**欄位設定的結構相似，不等於同一個問題。** 判斷 `fieldType` 是否設對，唯一依據是該費用在**文件版面上的實際位置**（明細行 vs 總結區），而這只能從提取結果的 `lineItems` 與 `field_mappings` 讀出來，無法從欄位定義本身推得。

本節初版把「兩者都是 `lineItem`」當成同型的證據，是把**現象的相似**誤當**成因的相同**。對照 memory `feedback_code_shows_possible_data_shows_actual`：設定證明「可能」，資料證明「實際」。

---

## 環境漂移（✅ 已於 2026-08-01 修正）

本 FIX 原只在 Azure DEV 執行（見 §執行方式），本機未同步：

| 環境 | Nippon `vat_7` 的 `fieldType` | 2026-08-01 後 |
|---|---|---|
| Azure DEV | `standard` ✅ | 不變 |
| 本機 | `lineItem` ❌ | **`standard`** ✅ |

### 動手前的前提驗證（不因「Azure 改了」就照做）

`lineItem` ↔ `standard` 是**會反轉方向**的修正：若 VAT 其實印在明細行內，改為 `standard` 會使該欄位退出 `backfillLineItemCharges` 的回填範圍，反而弄壞正常運作的欄位（CEVA / DSV / Toll 即屬此類，見上節）。故先以本機資料驗證：

| 判準 | 結果 | 意義 |
|---|---|---|
| 明細行含 VAT 項 | **0 份**（共 5 份提取結果） | 改為 `standard` 不失去任何既有回填 |
| `subtotal + vat = total` | **1 份完全閉合** | 證明 VAT 是總結區的獨立加項 |

閉合樣本：`NEX_RCEX240705,0705A_008.signed..pdf` → `9750 + 682.5 = 10432.5`

> 另一份 `NEX_RCIM250001_202.SIGNED..pdf` 本機的 `subtotal` 為 42323（`42323 + 1617 ≠ 66940`），正是 §意外收穫 所述「VAT 無處可歸時總結區數字互相擠壓」的徵狀；Azure 改後同一份為 `65323 + 1617 = 66940` 完全閉合。

### 執行結果

以 gated 腳本 `scripts/fix-143/sync-local-vat7-fieldtype.js`（`inspect` / `dryrun` / `write` 三段式）執行：

```
vat_7.fieldType : lineItem → standard      rowCount = 1
回讀確認        : standard，lineItem 型欄位數 21 → 20（總數 21 不變）
冪等驗證        : 再跑 inspect → 「已是 standard，無需變更」
```

保護措施：前置快照（`scripts/fix-143/snapshots/local-vat7-before.json`，**唯一還原依據**）、單一交易、數量閘（定義集剛好 1 個 / `vat_7` 剛好 1 個 / `rowCount` 必須為 1）、樂觀鎖（`WHERE updated_at = 讀取當下值`）、冪等。另加第六道：**偵測到明細行有 VAT 項即中止不寫**——本次為 0 份、未觸發。

### 尚未反映

改設定不回溯既有提取結果。本機那 5 份需**重新處理**才會取得 VAT——但重新處理會**覆蓋**上一次的提取結果（`extraction_results.document_id` 唯一約束，系統無提取歷史，見 [CHANGE-114](../feature-changes/CHANGE-114-extraction-result-version-history-and-file-hash.md)）。是否重跑由使用者決定。

---

## 相關

- CHANGE-045 — `fieldType` 欄位的引入
- CHANGE-094 / FIX-108 / FIX-127 — line item 費用的確定性回填與清除邏輯
- FIX-128 — `transform_diagnostics`（本次診斷的關鍵證據來源）
