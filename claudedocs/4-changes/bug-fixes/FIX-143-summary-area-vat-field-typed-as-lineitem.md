# FIX-143: 印在總額下方的 VAT 欄位被設為 lineItem 型，導致永遠提取不到

> **建立日期**: 2026-07-29
> **發現方式**: 使用者 Azure DEV 測試回報「Nippon 的 VAT 7% 拿不到」（`NEX_RCIM250001_202.pdf`）
> **影響頁面/功能**: Stage 3 欄位提取 → 模板實例欄位值
> **優先級**: 中（該欄位在任何情況下都不可能有值，且下游公式靜默算成 0）
> **狀態**: ✅ 已修復（2026-07-29，Azure DEV 設定資料修正）

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

## 尚待驗證

**改設定不會回溯既有提取結果** —— 需重新處理一份 Nippon 文件才會生效。

且本次修復只移除了「只在明細行找」的誤導，**沒有主動指示 GPT 去總額下方找**。若重新處理後 `vat_7` 仍為 null，下一步是替該欄位填 `extractionHints`（`FieldDefinitionEntry.extractionHints`，會由 `buildFieldDefinitionsSection` 第 939-941 行以 `(Hints: ...)` 注入 prompt），例如「印在發票總金額下方的稅額，不在費用明細行內」。

---

## 同型問題（未處理）

CEVA 兩個欄位定義集的 `vat_7_percent` 同樣是 `fieldType: 'lineItem'`：

| 欄位集 | 公司狀態 | 欄位 |
|--------|---------|------|
| `CEVA Logistics - 自訂費用欄位集` | ACTIVE | `vat_7_percent[lineItem]` |
| `CEVA Logistics Hong Kong Limited - 自訂費用欄位集` | MERGED | `vat_7_percent[lineItem]` |

CEVA Inbound 映射的 `handling` 公式同樣引用了 `{vat_7_percent}`，`transform_diagnostics` 也同樣記錄它缺失。本次未動 —— CEVA 測試文件（HKD 計價，`subtotal` 等於 `total_amount`）本身可能就沒有 VAT，需先確認該公司是否真有此欄位需求再決定。

---

## 相關

- CHANGE-045 — `fieldType` 欄位的引入
- CHANGE-094 / FIX-108 / FIX-127 — line item 費用的確定性回填與清除邏輯
- FIX-128 — `transform_diagnostics`（本次診斷的關鍵證據來源）
