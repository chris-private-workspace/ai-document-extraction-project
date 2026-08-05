# FIX-168: 稅額在 mapping 的歸屬各公司不一致 —— 有的獨立成欄，有的併進 handling

> **建立日期**: 2026-08-05
> **發現方式**: 追查 `vat_7` 是否被 mapping 引用（起於 [TEST-REPORT-006 §8.5](../../5-status/testing/reports/TEST-REPORT-006-full-sample-coverage-verification.md) 的盲讀副帶發現）
> **影響範圍**: `template_field_mappings` 中 8 條啟用規則 → 模板實例列值 → 匯出報表的成本欄位
> **優先級**: 中（金額規模小，但**欄位名與內容不符**會讓報表被誤讀，且各公司口徑不一致無法橫向比較）
> **狀態**: 📋 規劃中（待一句業務確認 —— **不是要業務設計口徑，是要確認「6 家沒照模板既有設計走」是否為刻意**，見 §模板本來就有 vat 欄）
> **相關**: [FIX-160](FIX-160-template-mapping-unreferenced-extracted-charges.md)（費用無 mapping 引用）、[FIX-161](FIX-161-mapping-references-undefined-company-fields.md)（規則引用不存在的 key）、[FIX-166](FIX-166-vat-extracted-as-line-item-charge.md)（稅額被抽成明細列，**提取層**的問題，與本 FIX 不同層）

---

## 問題描述

稅額（`vat` / `vat_7` / `vat_7_percent`）在各公司的 `template_field_mappings` 中有**兩種完全不同的處理方式**，且並存於線上啟用規則：

| 方式 | 公司 | 規則 |
|---|---|---|
| **A. 獨立成欄** | Nippon Express Logistics（Inbound + Outbound） | `vat_7 → vat`（DIRECT） |
| **B. 併進 handling** | Nippon Express (HK) | `handling_charge = {vat_7}+{handling_charge}` |
| | Toll Global Forwarder（Outbound） | `handling_charge = {handling_fee_origin} + {vat} + {handling_fee_origin_incl_pu} + {handling_fee_destination} + {emergency_fuel_surcharge}` |
| | Toll Global Forwarder（Inbound） | `handling = {handling_fee_destination} + {food_grade_container_charge} + {vat} + {food_grade_container_surcharge}` |
| | DSV Air & Sea（Inbound） | `handling = {handling} + {enviromental_fee} + {vat} + {handling_import} + {port_security_delvery_order_and_handling_charges}` |
| | DSV Air & Sea（Outbound） | `handling_charge = {handling} + {enviromental_fee} + {vat} + {shipment_coordination_fee} + {loading_charge}` |
| | CEVA LOGISTICS (HONG KONG) LTD（Inbound） | `handling = {destination_handling} + {vat_7_percent} + {sadao_border} + {apdc_ior}+{destination_truck_servicing_fee}` |

共 8 條啟用規則引用稅額 key。**同一份報表裡，Nippon 的稅獨立列出，Toll／DSV／CEVA 的稅藏在 handling 裡** —— 跨公司的 handling 成本無法直接比較。

---

## 實測（本機 844 列模板實例列）

依各條 formula 實際引用的 key 逐條重算，與模板列的 targetField 值比對：

| 分類 | 次數 | 金額 |
|---|---:|---:|
| 稅額進入自己的 `vat` 欄（方式 A，設計內） | 71 | — |
| 稅額併入 handling，**占其中一部分** | 25 | 579.01 |
| 🔴 稅額併入 handling，**整欄 100% 都是稅** | **13** | **193.43** |
| 模板值與 formula 應得不符 | **0** | — |
| 目標欄為空但有稅額（稅額無去處） | **0** | — |

### 🔴 13 列的 handling 欄位一分錢 handling 都沒有

| 公司 / 欄位 | 列數 | 合計 | 例 |
|---|---:|---:|---|
| Toll Global Forwarder / `handling` | 7 | 168.23 | `TOLL_RHIM260037_78679.PDF`、`TOLL_RHIM250289_75773.PDF` |
| Toll Global Forwarder / `handling_charge` | 6 | 25.20 | `TOLL_RCEX250018_56933.PDF`、`TOLL_RCEX260038_76870.pdf` |

具體形態：

```
TOLL_RHIM260037_78679   handling        = 22.31   其中稅額 22.31（100%）
TOLL_RCEX250018_56933   handling_charge = 4.20    其中稅額 4.20（100%）
```

formula 的其餘項（`handling_fee_destination`、`food_grade_container_charge` 等）在這些文件上都取不到值，**只有 `vat` 有值**，於是整個 handling 欄變成純稅額。

報表上顯示「手續費 22.31」，實際上手續費是 0、稅是 22.31。

對照正常情形：

```
TOLL_RCIM250334_77227   handling = 355.76  其中稅額 15.79（4%）
```

---

## 🔑 模板本來就有 `vat` 欄 —— 這不是設計缺口，是 6 家沒照設計走

2026-08-05 追查這 8 條規則的來源時發現的關鍵事實：

| 模板 | 欄數 | 稅額欄 | handling 欄 |
|---|---:|---|---|
| Logistics Cost - **Inbound** Template (Full List) | 46 | **`vat`** | `yard_handling`, `handling`, `handling_at_origin` |
| Logistics Cost - **Outbound** Template (Full List) | 38 | **`vat`** | `handling_charge` |

**兩個模板都設計了獨立的 `vat` 欄。** 但只有 Nippon Express Logistics 的兩條規則在用它 —— 其餘 6 家把稅塞進 handling，那個 `vat` 欄就空著。

（另兩個較舊的 GLOBAL 模板 `Logistics Cost - Inobund Template` / `Outbound Template` 沒有稅額欄，但本 FIX 涉及的 8 條規則全部指向 Full List 版本。）

### 規則來源：全部由 `dev-user-1` 陸續配置，無業務簽核痕跡

| 建立日期 | 公司 / 模板 | 方式 |
|---|---|---|
| 2026-07-09 | DSV（Outbound） | 併入 handling |
| 2026-07-09 | Nippon Express (HK)（Outbound） | 併入 handling |
| 2026-07-09 | **Nippon Express Logistics（Inbound）** | **獨立成欄** |
| 2026-07-09 | Toll（Outbound） | 併入 handling |
| 2026-07-09 | Toll（Inbound） | 併入 handling |
| 2026-07-23 | CEVA（Inbound） | 併入 handling |
| 2026-07-28 | DSV（Inbound） | 併入 handling |
| 2026-07-31 | **Nippon Express Logistics（Outbound）** | **獨立成欄** |

同一天（07-09）建立的 5 條裡就有兩種做法並存，且每個 mapping 中**引用稅額的都只有 1 條規則**（其餘 6–16 條與稅無關）。這比較像逐家配置時各自處理，而非依循某個共同的會計口徑決定。

### 🔴 因此本 FIX 的定性要修正

初版寫「這是業務口徑問題，需業務拍板」。**證據顯示模板設計已經給了答案** —— 設計者規劃了 `vat` 欄，意圖就是讓稅獨立列出。6 家沒用它，更可能是配置偏差而非刻意選擇。

問題因此從「要不要改設計」降級為「**要不要讓 6 家對齊模板既有的設計**」。

⚠️ 但仍不可由技術端逕行修改 —— 模板有欄不等於一定要填。需要一句確認（見下方 §需要業務回答的一句話）。

---

## 🔴 判準修正記錄：一個不成立的「無去處」

追查過程中兩度誤判，兩次都是**檢查本身有缺陷**而非資料有問題：

| # | 誤判 | 真相 |
|---|---|---|
| 1 | 「近 200 個實例中無任何列的稅額欄位帶值」 | `TemplateInstance.rows` 是 **relation**（`TemplateInstanceRow[]`）不是 JSON 欄位。`Array.isArray(inst.rows)` 恆為 false，**迴圈一次都沒執行** —— 那個「✅ 無」是空迴圈的產物 |
| 2 | 「25 列的稅額既無獨立欄也未併入 → 無去處，與 FIX-160 同型」 | 判準用「row 的 handling 欄 = **同名**提取值 + 稅額」，但 formula 的 sourceField（`handling_fee_origin`）與 targetField（`handling_charge`）**不同名**，且 formula 另有他項。依 formula 實際引用的 key 重算後，**稅額去向不明 = 0** |

第 1 項尤其值得記：**一個回報「沒有問題」的檢查，可能根本沒有執行。** 零結果必須先證明檢查跑得到資料，再讀它的結論。

因此原本計畫補進 [FIX-160](FIX-160-template-mapping-unreferenced-extracted-charges.md) 的「稅額無去處」**不成立，未補**。

---

## 需要業務回答的一句話

> Logistics Cost 模板裡有一個 `vat` 欄，目前只有 Nippon Express Logistics 的資料會填進去。Toll、DSV、CEVA、Nippon Express (HK) 這四家的稅被加進了 handling 欄。**請問稅應該填進 `vat` 欄，還是刻意要留在 handling 裡？**

兩種答案的後續完全不同：

| 答案 | 性質 | 後續 |
|---|---|---|
| **填進 `vat` 欄** | 配置修正，非設計變更 | 技術端可直接執行（三段式 gated 腳本），無需再等 |
| **刻意留在 handling** | 確認為現行口徑 | 需追問：那 Nippon 為何不同？是否該把 Nippon 也改成併入？ |

### 具體差異（實測資料）

| 檔案 | 現況 | 若改為獨立成欄 |
|---|---|---|
| `TOLL_RCIM250334_77227` | `handling` = 355.76 | `handling` = 339.97　`vat` = 15.79 |
| `TOLL_RHIM260037_78679` | `handling` = **22.31** | `handling` = **0**　`vat` = 22.31 |
| `NEX_RCIM250001_202` | `vat` = 1,617 | （不變，已是此形態） |

第二列最極端：報表顯示「手續費 22.31」，實際手續費是 0。

### 影響的三個層面

1. **跨公司不可比** —— 問「哪家 forwarder 手續費較貴」時，Nippon 的數字不含稅、其餘四家含稅，直接比較是錯的
2. **稅務處理** —— VAT 在多數地區可退抵或另行申報，混進成本欄後無法分離
3. **報表誤讀** —— 見上表第二列

### 我的建議

**統一為方式 A（填進 `vat` 欄）**：模板設計已預留該欄、Nippon 已在使用、「handling 100% 是稅」的顯示問題會自然消失。

但仍需上述那句確認才動手 —— 模板有欄不等於一定要填，且此變更會改變 4 家公司既有報表的欄位分佈。

---

## 變更範圍（拍板後須精確指名）

| 項目 | 值 |
|---|---|
| 資料表 | `template_field_mappings`（**不是** `data_templates` —— 後者會影響所有共用該模板的公司） |
| 記錄 | 上表 8 條規則中的 B 類 6 條，依公司逐筆指名 |
| 不動 | `field_definition_sets`（稅額欄位的**定義**沒有問題，5 家公司都定義正確） |

⚠️ 依 §不可逆資料操作紀律，變更須走 `inspect` / `dryrun` / `write` 三段式，並具備前置快照、單一交易、數量閘、樂觀鎖、冪等五項。

⚠️ 改 mapping 會影響 formula 中**其他費用**的去處 —— 移除 `{vat}` 後，`handling_fee_origin` 等項仍須維持原有行為，不可整條規則刪除。

---

## 驗證方式

```bash
node scripts/snapshot-template-values.js capture before.json
# 變更後
node scripts/snapshot-template-values.js capture after.json
node scripts/snapshot-template-values.js diff before.json after.json
```

關鍵判準是「**欄位由有值變為空白**」—— 那是「修 A 打破 B」的形態。

另需確認：

1. 13 列的 handling 欄由「純稅額」變為 0 或空，且稅額出現在 `vat` 欄
2. 25 列「稅額占一部分」者，handling 減少的金額**恰等於**該列稅額
3. 71 列既有的方式 A 未受影響

---

**建立者**: AI 助手
**最後更新**: 2026-08-05（新增 §模板本來就有 vat 欄 —— 定性由「業務設計口徑」修正為「6 家未照模板既有設計配置」；待確認的問題收斂為一句）
