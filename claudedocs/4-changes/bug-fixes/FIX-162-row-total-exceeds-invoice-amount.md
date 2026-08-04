# FIX-162: 列合計高於發票總額 —— 同一筆錢被重複計入

> **建立日期**: 2026-08-04
> **發現方式**: 375 份樣本全覆蓋驗證，12 個 template instance 逐列追溯（[TEST-REPORT-006](../../5-status/testing/reports/TEST-REPORT-006-full-sample-coverage-verification.md)）
> **影響範圍**: `template_field_mappings` → 模板實例列值 → 匯出報表金額**虛增**
> **優先級**: 高（9 列超出合計 **20,638.44**，方向與漏帳相反，會高估成本）
> **狀態**: 📋 規劃中（**根因已確認並經發票原文證實**，見 §根因；修法待拍板 —— 其中一項需回頭修正 [FIX-158](FIX-158-mapping-field-definition-misalignment.md) 的決策）
> **相關**: [FIX-158](FIX-158-mapping-field-definition-misalignment.md)（🔴 其修法的核心假設被本案推翻）、[FIX-152](FIX-152-dhl-multi-shipment-aggregate-amount-leak.md)（DHL 多筆併單的合計外洩）、[FIX-160](FIX-160-template-mapping-unreferenced-extracted-charges.md)（反方向：漏帳）

---

## 問題描述

模板實例的列合計**高於**來源發票的 `total_amount`，代表同一筆錢被多條 mapping 規則放進不同的 `targetField`，或某個彙總欄位與其明細同時被計入。

這與漏帳是反方向的問題，但同樣破壞對帳。且更隱蔽 —— 漏帳會讓總額偏低而容易被發現，虛增則可能被誤認為「抓得比較全」。

---

## 實測清單

| 來源文件 | 列合計 | 發票總額 | 超出 | instance |
|---|---:|---:|---:|---|
| `RIL_RCIM250010_14103.pdf` | 23,411.04 | 18,716.52 | **4,694.52** | RICOH (HK) / import |
| `DHL_RCEX250146_09847.pdf` | 25,830.11 | 21,167.48 | **4,662.63** | DHL Express / export |
| `DHL_RCEX250035,0036_6800.signed..pdf` | 17,974.81 | 14,913.88 | **3,060.93** | DHL Express / export |
| `RIL_RCIM250312_22019.pdf` | 15,552.46 | 13,141.96 | 2,410.50 | RICOH (HK) / import |
| `RIL_RHIM260115_26575.pdf` | 12,448.30 | 10,822.92 | 1,625.38 | RICOH (HK) / import |
| `DHL_RCEX250212_24745.pdf` | 10,319.46 | 8,745.18 | 1,574.28 | DHL Express / export |
| `RIL_RHIM260098_25831.pdf` | 6,305.51 | 5,421.45 | 884.06 | RICOH (HK) / import |
| `RIL_RHIM260091_25830.pdf` | 5,913.81 | 5,050.74 | 863.07 | RICOH (HK) / import |
| `RIL_RHIM260092_25826.pdf` | 5,866.32 | 5,003.25 | 863.07 | RICOH (HK) / import |
| **合計** | | | **20,638.44** | |

集中在兩家：**RICOH INTERNATIONAL LOGISTICS (HK)** 6 列、**DHL Express** 3 列。

### 一個可能的規律

`RIL_RHIM260091` 與 `RIL_RHIM260092` 超出金額完全相同（863.07），且兩份是連號文件。若同一條規則對這兩份都多算了同一筆固定費用，指向的是**規則層面**的重複，不是個別文件的資料問題。

---

## 根因（已確認，兩類，皆以發票原文佐證）

### A 類 —— RICOH / SBS 6 列：欄位定義重複，模型把同一筆錢填進兩個 key

以 `RIL_RHIM260091_25830.pdf` 為例。**發票原文**（掃描件，轉圖判讀）：

| 發票項目 | 金額 |
|---|---:|
| `(AIR) LOCAL CHARGE IN USA` (ORIGIN CHARGE) | **1,263.07** ← 只有一筆 |
| `(AIR) AIRLINES DOCUMENT CHARGE` (DEST) | **15.00** ← 只有一筆 |
| `(AIR) TERMINAL CHARGE` (DEST) | 400.00 |
| G. TOTAL | 5,050.74 |

Stage 3 卻抽出兩份：

```
air_local_charge_usa_origin            1263.07
air_local_charge_in_usa_origin_charge  1263.07   ← 同一筆費用，兩個 key 都填了
```

而 [FIX-158](FIX-158-mapping-field-definition-misalignment.md) 問題一把 mapping 改成 FORMULA **兩者相加**：

```
handling_at_origin ← {air_local_charge_usa_origin} + {air_local_charge_in_usa_origin_charge}
```

→ 1,263.07 被計入兩次。

同時 `(AIR) TERMINAL CHARGE` 400.00 **完全沒被抽到**（RICOH 定義集有 `air_terminal_charge_dest`，所以是提取遺漏，不是定義缺失）。

三者相加剛好對得起來：

```
重複計入 LOCAL CHARGE     +1,263.07
漏抽 TERMINAL CHARGE        -400.00
                          ──────────
淨超出                        863.07   ← 與實測完全吻合
```

`AIRLINES DOCUMENT CHARGE` 的 15 元同樣被填進兩個 key，但那兩個 key 都沒有 mapping 引用（[FIX-160](FIX-160-template-mapping-unreferenced-extracted-charges.md) 的項目），所以沒進 template，未計入超出。

#### 🔴 這推翻了 FIX-158 的核心假設

FIX-158 選擇「不動欄位定義，改用 FORMULA 兩個 key 都接」，理由是：

> **不動欄位定義** —— 依 §樣本 ≠ 母體 紀律，不因「看起來重複」就刪除既有定義。且**同一時間只會有一個 key 有值，相加不會造成重複計費**。

實測資料顯示 **5 份文件的兩個 key 同時有值且金額相同**，合計重複 7,712.80：

| 文件 | `usa_origin` | `in_usa_origin_charge` |
|---|---:|---:|
| `RIL_RCIM250312_22019` | 2,262.22 | 2,262.22 |
| `RIL_RHIM260091_25830` | 1,263.07 | 1,263.07 |
| `RIL_RHIM260092_25826` | 1,263.07 | 1,263.07 |
| `RIL_RHIM260098_25831` | 1,284.06 | 1,284.06 |
| `RIL_RHIM260115_26575` | 1,640.38 | 1,640.38 |

當時的驗證只看了 `RIL_RCIM250313_22084` 一份、兩次提取各填一個 key，因而得出「只會有一個有值」。**一份文件不足以支撐這個假設**。

同型的欄位對還有 `airline_documentation_charges` ⇄ `air_airline_document_charge_dest`（6 份、90.00），目前未被 mapping 引用而未發作。

> ⚠️ 另有 `sea_cfs` ⇄ `sea_thc`（2 份、743.98）同額，但兩者語意不同（CFS vs THC），同額可能是巧合，**不可**當成重複處理。

### B 類 —— DHL 3 列：把彙總項的分解明細再加一次

`DHL_RCEX250035,0036_6800.signed..pdf` 的發票結構：

```
EXPRESS WORLDWIDE DOC      Standard    382.20   Extra    111.80   Total    494.00
EXPRESS WORLDWIDE NONDOC   Standard 11,452.95   Extra  2,966.93   Total 14,419.88
Total                      Standard 11,835.15   Extra  3,078.73   Total 14,913.88

Analysis of Extra Charges:
   FUEL SURCHARGE                3,060.93
   DEMAND SURCHARGE                  0.00
   GOGREEN PLUS - CARBON REDUCED    17.80
   Total Extra Charges           3,078.73
```

`EXPRESS WORLDWIDE NONDOC` 的 14,419.88 **已經包含 Extra Charges**。而「Analysis of Extra Charges」是對這些 extra 的**分解**，不是額外的費用。

mapping 卻寫成：

```
freight ← {express_worldwide_nondoc} + {fuel_surcharge}
```

→ 14,419.88 + 3,060.93 = 17,480.81，重複計入 3,060.93，與超出金額完全相等。

| 文件 | 超出 | `fuel_surcharge` |
|---|---:|---:|
| `DHL_RCEX250035,0036_6800` | 3,060.93 | **3,060.93** |
| `DHL_RCEX250146_09847` | 4,662.63 | **4,662.63** |
| `DHL_RCEX250212_24745` | 1,574.28 | 需個別確認（不等於單一 fuel_surcharge） |

與 [FIX-152](FIX-152-dhl-multi-shipment-aggregate-amount-leak.md) 無關 —— 那是多筆併單的合計外洩，本案是彙總與明細重複計入。

---

## 修法選項（待拍板）

### B 類（DHL）—— 明確、低風險

移除 `freight` 公式中的 `+ {fuel_surcharge}`：

| 項目 | 值 |
|---|---|
| 資料表 | `template_field_mappings` |
| 記錄 | DHL Express - Logistics Cost - **Outbound** Template (Full List) |
| 規則 | `freight ← {express_worldwide_nondoc} + {fuel_surcharge}` → `freight ← express_worldwide_nondoc` |

⚠️ 動手前須確認 **Inbound** 模板是否有同樣寫法，以及 `fuel_surcharge` 是否為別的 targetField 的唯一來源（移除後會不會變成 [FIX-160](FIX-160-template-mapping-unreferenced-extracted-charges.md) 的漏帳形態）。

### A 類（RICOH / SBS）—— 需回頭修正 FIX-158

| 選項 | 作法 | 風險 |
|---|---|---|
| **A1** | mapping 改為只取其一（回到 FIX-158 之前） | 模型只填另一個 key 時會漏帳 —— 那正是 FIX-158 要解的問題 |
| **A2** | 公式改為取最大值而非相加 | 需確認 FORMULA 是否支援非加法運算；語意上「同一筆費用取其一」是對的 |
| **A3** | 合併兩個欄位定義為一個，給完整 aliases | 治本。但屬刪除既有定義，需確認兩者確實指同一筆費用 |

**傾向 A2 或 A3**。A3 最徹底 —— 兩個定義都沒有 aliases，模型無從區分，才會兩個都填。但刪定義須格外謹慎：本案的理由不是「現有文件沒這種寫法」（那會違反 §樣本 ≠ 母體），而是「**實測證明兩者承載同一筆費用**」，證據強度不同。

### 附帶問題（不在本 FIX 範圍）

`(AIR) TERMINAL CHARGE` 400.00 漏抽 —— 定義集有 `air_terminal_charge_dest`，屬 Stage 3 提取遺漏，需另開 FIX 追蹤。

---

## 驗證方式

重建 instance 後確認這 9 列的列合計等於 `total_amount`（容差 0.05）。

⚠️ 修正時要同時盯著漏帳方向 —— 移除重複引用可能讓某筆錢失去唯一去處，變成 [FIX-160](FIX-160-template-mapping-unreferenced-extracted-charges.md) 的形態。變更前後必須跑 `scripts/snapshot-template-values.js` 比對，關鍵訊號是「欄位由有值變為空白」。

🔴 A 類修好後，`RIL_RHIM260091` 的列合計會變成 **4,650.74**，仍比 `total_amount` 5,050.74 少 400 —— 那是漏抽的 `(AIR) TERMINAL CHARGE`，屬另一個問題。**不要把「還差 400」當成修法失敗**而回頭加碼調整 mapping。

---

## 這次學到的判準

| 判準 | 說明 |
|---|---|
| **一份文件不足以支撐「只會有一個 key 有值」這種假設** | FIX-158 據此選了相加，5 份文件證明兩個 key 會同時有值 |
| **[F] 徵狀為 0 不代表沒有重複引用** | 驗證工具只檢查 `targetField` 重複，不檢查兩個不同 targetField 引用同一個 sourceField |
| **超出金額恰等於某個欄位時，優先懷疑「彙總 + 明細」** | DHL 的 fuel surcharge 是 extra charges 的分解，不是額外費用 |
| **掃描件要轉圖判讀** | 本案兩份關鍵發票，一份無文字層（RIL）、一份有（DHL），都必須看原文才能定案 |

---

**建立者**: AI 助手
**最後更新**: 2026-08-04
