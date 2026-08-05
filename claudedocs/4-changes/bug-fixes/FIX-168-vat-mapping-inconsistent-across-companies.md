# FIX-168: 稅額在 mapping 的歸屬各公司不一致 —— 有的獨立成欄，有的併進 handling

> **建立日期**: 2026-08-05
> **發現方式**: 追查 `vat_7` 是否被 mapping 引用（起於 [TEST-REPORT-006 §8.5](../../5-status/testing/reports/TEST-REPORT-006-full-sample-coverage-verification.md) 的盲讀副帶發現）
> **影響範圍**: `template_field_mappings` 中 8 條啟用規則 → 模板實例列值 → 匯出報表的成本欄位
> **優先級**: 中（金額規模小，但**欄位名與內容不符**會讓報表被誤讀，且各公司口徑不一致無法橫向比較）
> **狀態**: 📋 規劃中（**待業務拍板** —— 這不是技術缺陷，是口徑問題）
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

## 🔴 判準修正記錄：一個不成立的「無去處」

追查過程中兩度誤判，兩次都是**檢查本身有缺陷**而非資料有問題：

| # | 誤判 | 真相 |
|---|---|---|
| 1 | 「近 200 個實例中無任何列的稅額欄位帶值」 | `TemplateInstance.rows` 是 **relation**（`TemplateInstanceRow[]`）不是 JSON 欄位。`Array.isArray(inst.rows)` 恆為 false，**迴圈一次都沒執行** —— 那個「✅ 無」是空迴圈的產物 |
| 2 | 「25 列的稅額既無獨立欄也未併入 → 無去處，與 FIX-160 同型」 | 判準用「row 的 handling 欄 = **同名**提取值 + 稅額」，但 formula 的 sourceField（`handling_fee_origin`）與 targetField（`handling_charge`）**不同名**，且 formula 另有他項。依 formula 實際引用的 key 重算後，**稅額去向不明 = 0** |

第 1 項尤其值得記：**一個回報「沒有問題」的檢查，可能根本沒有執行。** 零結果必須先證明檢查跑得到資料，再讀它的結論。

因此原本計畫補進 [FIX-160](FIX-160-template-mapping-unreferenced-extracted-charges.md) 的「稅額無去處」**不成立，未補**。

---

## 待業務拍板的問題

這不是程式缺陷 —— 每條規則都按設定正確執行了。要決定的是**口徑**：

| # | 問題 | 影響 |
|---|---|---|
| 1 | 稅額應獨立成 `vat` 欄，還是併入 handling 成本？ | 決定要改哪一邊：把 B 改成 A，或把 A 改成 B |
| 2 | 若併入，欄位名為 `handling` 而內容含稅是否可接受？ | 若不可接受，需要新的 targetField（如 `handling_incl_tax`） |
| 3 | 各公司口徑是否必須一致？ | 若報表要跨公司比較 handling 成本，不一致就不可比 |
| 4 | 13 列「handling 100% 是稅」是否應顯示為 0 + 稅另計？ | 目前的顯示會讓人誤以為收了手續費 |

### 我的建議

**傾向統一為方式 A（稅額獨立成 `vat` 欄）**，理由：

- 稅額在會計上與服務費性質不同，混入成本欄會妨礙後續的稅務處理
- 模板已有 `vat` 這個 targetField（Nippon 在用），不需新增欄位
- 「handling 100% 是稅」這種顯示只會出現在方式 B，統一為 A 即自然消失

但這牽涉 6 家公司的既有報表口徑，**不應由技術端單方決定**。

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
**最後更新**: 2026-08-05
