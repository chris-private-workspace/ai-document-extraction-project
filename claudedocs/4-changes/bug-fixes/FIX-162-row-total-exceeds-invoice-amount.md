# FIX-162: 列合計高於發票總額 —— 同一筆錢被重複計入

> **建立日期**: 2026-08-04
> **發現方式**: 375 份樣本全覆蓋驗證，12 個 template instance 逐列追溯（[TEST-REPORT-006](../../5-status/testing/reports/TEST-REPORT-006-full-sample-coverage-verification.md)）
> **影響範圍**: `template_field_mappings` → 模板實例列值 → 匯出報表金額**虛增**
> **優先級**: 高（9 列超出合計 **20,638.44**，方向與漏帳相反，會高估成本）
> **狀態**: 🚧 部分完成（2026-08-04。根因已確認並經發票原文證實；**A 類已執行「合併欄位定義」但刻意不重新提取**，見 §A 類已執行；B 類原訂修法經全母體模擬後**否決**，見 §B 類）
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

mapping 寫成：

```
freight ← {express_worldwide_nondoc} + {fuel_surcharge}
```

→ 14,419.88 + 3,060.93 = 17,480.81，重複計入 3,060.93，與超出金額完全相等。

| 文件 | 超出 | `fuel_surcharge` |
|---|---:|---:|
| `DHL_RCEX250035,0036_6800` | 3,060.93 | **3,060.93** |
| `DHL_RCEX250146_09847` | 4,662.63 | **4,662.63** |
| `DHL_RCEX250212_24745` | 1,574.28 | 不等於單一 fuel_surcharge（混合情況） |

與 [FIX-152](FIX-152-dhl-multi-shipment-aggregate-amount-leak.md) 無關 —— 那是多筆併單的合計外洩，本案是彙總與明細重複計入。

#### 🔴 但 mapping 沒有寫錯 —— 錯的是提取不一致

發票該列有**三個數字**：

```
EXPRESS WORLDWIDE NONDOC   Standard 11,452.95   Extra 2,966.93   Total 14,419.88
```

Stage 3 把哪一個放進 `express_worldwide_nondoc` **並不一致**：

| 抽到的值 | 份數 | 加 `fuel_surcharge` 之後 |
|---|---:|---|
| Standard（不含 extra） | 22 | ✅ 正確 —— 這正是公式要補的 |
| Total（已含 extra） | 3 | 🔴 重複 |

模擬「移除 `+ {fuel_surcharge}`」對全部 26 份 DHL 文件的影響：

```
改善 3 份 / 變差 22 份 / 不變 1 份
```

| 文件 | `total_amount` | 現行列合計 | 移除後 |
|---|---:|---:|---:|
| `DHL_RCIM250341_44357` | 24,538.03 | **24,538.03** ✅ | 18,660.10（-5,877.93） |
| `DHL_RCIM250291_20411` | 25,947.21 | **25,947.21** ✅ | 19,997.85（-5,949.36） |
| `DHL_RCEX250035,0036_6800` | 14,913.88 | 17,974.81（+3,060.93） | **14,913.88** ✅ |

**移除公式中的 `fuel_surcharge` 會把 22 份原本正確的文件變成漏帳。** 同一個 key 承載了兩種語意，mapping 層無法分辨，因此**改 mapping 解決不了這個問題**。

🔴 這一段是修法**執行前的模擬**擋下來的。若只看那 3 份超出的文件，「移除 fuel_surcharge」看起來完全正確 —— 3 份全部歸零。**修法驗證必須跑全母體，不能只驗出問題的那幾份。**

---

## 修法選項（待拍板）

### B 類（DHL）—— ❌ 原訂修法已否決

原本計畫移除 `freight` 公式中的 `+ {fuel_surcharge}`，執行前的全母體模擬顯示會**改善 3 份、破壞 22 份**，已放棄。

問題在 Stage 3：同一個 `express_worldwide_nondoc` 有時裝 Standard Charge、有時裝含 extra 的 Total。mapping 層看不到差別，**改 mapping 無法解決**。

可行方向（皆未執行）：

| 選項 | 作法 | 考量 |
|---|---|---|
| **B1** | 欄位定義拆成兩個 key（如 `express_worldwide_nondoc_standard` 與 `_total`），並給明確 aliases | 治本，但要同步改 mapping，且需確認發票版面是否穩定 |
| **B2** | 在該公司的 Stage 3 prompt 明確指示「取 Standard Charge 欄，不要取 Total」 | 改動小，但 prompt 對模型的約束力需實測 |
| **B3** | 維持現狀，接受 3/26 的誤差 | 不建議 —— 那 3 份分別高估 3,060.93 / 4,662.63 / 1,574.28 |

兩套模板（Inbound `db4ac18b-…`、Outbound `87b9bffd-…`）**都有**同一條公式，修法時須一併處理。

另註：`DHL_RCIM250268_01010.pdf` 現行列合計為 **0**（發票 159.64 完全沒進 template），屬 [FIX-160](FIX-160-template-mapping-unreferenced-extracted-charges.md) 的漏帳形態，不在本 FIX 範圍。

### A 類（RICOH / SBS）—— 需回頭修正 FIX-158

**全母體模擬**（53 份 RICOH/SBS 文件，兩個 key 同時有值者 5 份）：

| 方案 | 完全吻合 | 變好 | 變差 |
|---|---:|---:|---:|
| 現行（兩個 key 相加） | 25 | — | — |
| **A1a** 只取 `air_local_charge_in_usa_origin_charge` | 23 | 5 | **6** |
| **A1b** 只取 `air_local_charge_usa_origin` | 23 | 5 | **2** |
| **A2** 取兩者最大值 | 25 | 5 | **0** |

A1a／A1b 都會破壞其他文件 —— 有些發票模型只填了其中一個 key。A1b 破壞的兩份之一正是 `RIL_RCIM250313_22084`，即 [FIX-158](FIX-158-mapping-field-definition-misalignment.md) 當初用來驗證的那份，證實「只填另一個 key」的情況確實存在。

**相加與只取其一都會錯一批；取最大值兩種情況都對。**

#### 🔴 但 A2 技術上不可行

`formula.transform.ts` 的白名單（FIX-072 為消除 RCE 攻擊面而收緊）只允許：

```
SAFE_FORMULA_PATTERN = /^[\d\s\+\-\*\/\.\(\)]+$/
```

沒有 MAX 函式，而 `max(a,b)` 無法用純算術表達：兩值相同時 `(a+b)/2` 正確，只有一個有值時就錯。要支援 MAX 得改 transform 引擎 —— 那是架構變更（H1），不在本 FIX 範圍。

#### 剩下 A3：合併欄位定義

| key | label | aliases |
|---|---|---|
| `air_local_charge_usa_origin` | `(Air) Local Charge in USA (Origin Charge)` | `[]` |
| `air_local_charge_in_usa_origin_charge` | `Air local charge in usa origin charge` | `[]` |

發票原文是 `(AIR) LOCAL CHARGE IN USA` / `ORIGIN CHARGE` —— 第一個 label 更貼近。兩者都沒有 aliases，模型無從區分，才會兩個都填。

合併後模型只看得到一個 key，效果等同 A2（零破壞）。

**但有一個連帶條件**：欄位定義只影響**未來**的提取。既有的 `extraction_results` 仍然是兩個 key，若 mapping 同時改成 DIRECT，那 2 份「只填了被移除的 key」的舊文件會變成漏帳。

因此完整方案必須包含**重新提取**：

| 步驟 | 動作 | 影響範圍 |
|---|---|---|
| 1 | `field_definition_sets` 合併兩個定義（保留 `air_local_charge_usa_origin`，把另一個的 label 收為 alias） | 影響 Stage 3 prompt |
| 2 | `template_field_mappings` 的 `handling_at_origin` 改 DIRECT 指向保留的 key | 記錄 `cmrn8gbe1000101mlw86c4baw`，規則 id `1cwj_bz-628yROh9Rzo1t` |
| 3 | **重新提取** RICOH/SBS 全部文件 | 🔴 會**覆蓋** `extraction_results`（對 document 有唯一約束，系統無處理歷史） |

🔴 第 3 步是不可逆的：覆蓋後，本次驗證所依據的診斷資料就消失了。動手前須確認不再需要現有的提取結果作為證據。

**若不執行第 3 步**，則只能維持現狀（繼續高估那 5 份），或接受改 DIRECT 後那 2 份轉為漏帳 —— 兩者都是已知取捨，不是修好。

> 刪定義本應格外謹慎。本案的依據不是「現有文件沒這種寫法」（那會違反 §樣本 ≠ 母體），而是「**5 份文件實測證明兩者承載同一筆費用，且發票上只有一行**」，證據性質不同。

---

## A 類已執行（2026-08-04）：只做步驟 1，不重新提取

使用者選擇「讓問題停止擴大且完全可逆」的路徑 —— 合併欄位定義，但**不動 mapping、不重新提取**。

### 變更範圍（🔴 精確指名）

| 項目 | 值 |
|---|---|
| 資料表 | `field_definition_sets` |
| 記錄 | `548326fa-5981-4e1b-9c98-19d0358a32a4`（SBS  INTERNATIONAL LOGISTICS - 自訂費用欄位集） |
| 變更 | 移除 `air_local_charge_in_usa_origin_charge`；保留 `air_local_charge_usa_origin` 並加入 2 個 aliases |
| 欄位總數 | 47 → 46 |
| **不動** | `template_field_mappings` —— 公式維持 `{air_local_charge_usa_origin} + {air_local_charge_in_usa_origin_charge}` |
| **不動** | `extraction_results` —— 不重新提取 |

新的 aliases：`"Air local charge in usa origin charge"`（被移除者的 label，確保既有寫法仍被辨識）、`"Local Charge in USA"`（發票上的實際寫法）。

腳本：`scripts/fix-162-merge-ricoh-duplicate-field.js`（三段式，五項措施齊備）

### 為什麼刻意不動 mapping

公式保留對兩個 key 的引用是**有意的向後相容**：

| 資料 | 公式行為 |
|---|---|
| 未來提取 | 被移除的 key 不再出現 → 公式等於「只取保留的 key」→ 正確 |
| 既有結果 | 仍帶著兩個 key → 公式照舊取得到值 → 不會突然漏帳 |

若同時把公式改成 DIRECT，那 2 份「只填了被移除 key」的舊文件會立刻轉為漏帳（全母體模擬已量化）。

### 驗證結果

| 檢查 | 結果 |
|---|---|
| `snapshot-template-values` diff | **變空 0、值改變 0、變有值 0**，exit 0 —— 既有模板值完全未受影響 |
| `check-orphan-charge-keys` | RICOH 漏接 3,809.97 → 3,749.97 |

### ⚠️ 一個會誤導的帳面現象

變更後 `check-orphan-charge-keys` 對 RICOH 新增了 **⚠️ 多算 10,329.64** 的標記，合計「多算」從 2,616.87 跳到 12,946.51。

**這不是資料變壞** —— 模板值 diff 全部為 0 已經證實。原因是該腳本「**只計入 `field_definition_sets` 定義的費用欄位**」（見其檔頭註解）：

```
A = 提取結果中「已定義為費用欄位」且有值的金額總和
B = 該文件模板實例列上所有數值欄位的總和
```

移除定義後，既有結果裡 `air_local_charge_in_usa_origin_charge` 的值不再計入 A，但它仍透過公式進入 B → 差額變負 → 標為「多算」。

換句話說，**這個標記正是原本就存在、但先前被隱藏的重複計費**。定義集與既有資料不同步期間都會如此，重新提取後會消失。

🔴 日後看到這個數字時不要誤讀為「合併定義造成了重複計費」——因果相反。

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
| **修法驗證必須跑全母體，不能只驗出問題的那幾份** | 「移除 fuel_surcharge」對那 3 份是完美解，對其餘 22 份是破壞。執行前的模擬擋下了它 |
| **一份文件不足以支撐「只會有一個 key 有值」這種假設** | FIX-158 據此選了相加，5 份文件證明兩個 key 會同時有值 |
| **同一個 key 承載兩種語意時，mapping 層無解** | DHL 的 `express_worldwide_nondoc` 有時含 extra、有時不含，加或不加都會錯一批 |
| **[F] 徵狀為 0 不代表沒有重複引用** | 驗證工具只檢查 `targetField` 重複，不檢查兩個不同 targetField 引用同一個 sourceField |
| **超出金額恰等於某個欄位時，優先懷疑「彙總 + 明細」** | DHL 的 fuel surcharge 是 extra charges 的分解，不是額外費用 |
| **掃描件要轉圖判讀** | 本案兩份關鍵發票，一份無文字層（RIL）、一份有（DHL），都必須看原文才能定案 |

---

**建立者**: AI 助手
**最後更新**: 2026-08-04
