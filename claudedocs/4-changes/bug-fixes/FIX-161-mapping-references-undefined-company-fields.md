# FIX-161: mapping 引用了該公司欄位定義集沒有的 key —— 9 條規則永遠取不到值

> **建立日期**: 2026-08-04
> **發現方式**: 375 份樣本全覆蓋驗證，12 個 template instance 逐列追溯（[TEST-REPORT-006](../../5-status/testing/reports/TEST-REPORT-006-full-sample-coverage-verification.md)）
> **影響範圍**: `template_field_mappings` 的 `sourceField` → 模板實例列值
> **優先級**: 高（CEVA export 有 5 條規則在 **31/31 列**全部落空）
> **狀態**: 📋 規劃中
> **相關**: [FIX-158](FIX-158-mapping-field-definition-misalignment.md)（同型，已修 RIL 與 CEVA 各一例）、[FIX-160](FIX-160-template-mapping-unreferenced-extracted-charges.md)（反方向：提取到卻無規則引用）

---

## 問題描述

`template_field_mappings` 的規則引用了某個 `sourceField`，但該 key **不在該公司自己的 `field_definition_sets` 裡**。Stage 3 不會產出這個 key，規則因此永遠取不到值，對應的 `targetField` 恆為空。

這是 [FIX-158](FIX-158-mapping-field-definition-misalignment.md) 問題二的同型復發 —— 該 FIX 修的是 CEVA 的四個欄位，本次在更大樣本上驗出另外 9 項。

---

## 判準：必須用「該公司自己的」定義集

這一點決定結論對錯。若用全部 23 組定義集的**聯集**比對，30 個落空的 key 只有 1 個判為缺陷（`documentation_fee_destination`，任何定義集都沒有）；改用逐公司比對後，真缺陷是 **9 項** —— 另外 8 個 key 存在於別家公司，但不在引用它的那家。

---

## 實測清單

| # | 公司 / 方向 | `targetField` ← `sourceField` | 落空比例 | 判定 |
|---|---|---|---:|---|
| 1 | CEVA (HK) / export | `document_fee` ← `awb_fee` | 31/31 | 該公司定義中沒有（別家有） |
| 2 | CEVA (HK) / export | `delivery` ← `pick_up_at_origin` | 31/31 | 同上 |
| 3 | CEVA (HK) / export | `x_ray_fee` ← `x_ray` | 31/31 | 同上 |
| 4 | CEVA (HK) / export | `cfs_charge` ← `cfs` | 31/31 | 同上 |
| 5 | CEVA (HK) / export | `gate_charge` ← `gate_charge` | 31/31 | 同上 |
| 6 | Nippon Express (HK) / export | `thc` ← `t_h_c` | 3/3 | 同上 |
| 7 | Nippon Express (HK) / export | `handling_charge` ← `vat_7` | 3/3 | 同上 |
| 8 | Nippon Express (HK) / export | `telex_release` ← `surrender_bl` | 3/3 | 同上 |
| 9 | Toll Global Forwarder / import | `docs_fee` ← `documentation_fee_destination` | 26/26 | **任何定義集都沒有** —— key 拼錯或定義缺失 |

### 對照：21 種不是缺陷

另有 21 個 key 也出現「來源不存在」，但它們**在該公司自己的定義集裡**，代表這批發票剛好沒有這筆費用 —— 屬母體未覆蓋，不是缺陷。多集中在 Toll Global Forwarder / export（`airway_bill_fee_origin`、`vgm_fee_origin`、`telex_fees_origin` 等 1/14 列）。

🔴 依 §樣本 ≠ 母體 紀律，**不可**因為這批樣本沒出現就提議刪除這些定義。

---

## 兩種成因，處置不同

| 成因 | 徵狀 | 處置 |
|---|---|---|
| **命名不一致** | 該公司定義集有語意相同但拼法不同的 key（如 `gate_charge` vs `destination_gate_fee`） | 改規則指向正確的 key，或用 FORMULA 兩者都接 |
| **定義缺失** | 該公司確實會收這筆費用，但定義集沒有這個欄位 | 補欄位定義（含 aliases，會進 Stage 3 prompt） |

第 9 項 `documentation_fee_destination` 任何定義集都沒有，最可能是拼錯 —— 需比對 Toll 定義集中是否有 `documentation_fee_origin` 之類的近似 key。

⚠️ 注意第 7 項 `handling_charge ← vat_7`：把稅額映射到 handling charge 在語意上可疑，需確認是否為設定錯誤而非單純的 key 不存在。

---

## 建議修法（待使用者拍板）

1. 對 9 項逐一查該公司定義集中是否有語意對應的 key
2. 有 → 改 `sourceField`；語意相同但兩種寫法並存 → 改 FORMULA 兩者相加（同一時間只會有一個有值，不會重複計費，作法同 [FIX-158](FIX-158-mapping-field-definition-misalignment.md) 問題一）
3. 沒有且該費用確實存在 → 補欄位定義 + aliases
4. 一律走 gated 腳本（inspect / dryrun / write），變更前後跑 `snapshot-template-values.js` 對帳

### 變更範圍（🔴 修法確定後須精確指名）

| 項目 | 值 |
|---|---|
| 資料表 | `template_field_mappings`（改 sourceField）／`field_definition_sets`（補定義） |
| 記錄 | 依公司逐筆指名，待修法確定後填入 |
| 不動 | `data_templates`（影響全部共用公司） |

---

## 驗證方式

重建 instance 後以 `verify-instances.js` 確認目標公司的 [D] 徵狀歸零。注意：**[D] 歸零不代表金額正確** —— 還要看 [E] 合計是否收斂，因為規則取到值之後才會進入對帳。

---

**建立者**: AI 助手
**最後更新**: 2026-08-04
