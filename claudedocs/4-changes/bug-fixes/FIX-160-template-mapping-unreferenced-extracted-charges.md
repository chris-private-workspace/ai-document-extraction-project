# FIX-160: 已提取的費用沒有任何 mapping 引用 —— 錢抽得到卻進不了 template

> **建立日期**: 2026-08-04
> **發現方式**: 375 份樣本全覆蓋驗證，12 個 template instance 逐列追溯（[TEST-REPORT-006](../../5-status/testing/reports/TEST-REPORT-006-full-sample-coverage-verification.md)）
> **影響範圍**: `template_field_mappings` → 模板實例列值 → 匯出報表金額
> **優先級**: 高（實測 17 種費用、約 **24,186** 金額在 262 列中未進入 template）
> **狀態**: 📋 規劃中（**尚未拍板修法** —— 改 mapping 會影響其他費用的去處，需逐項確認）
> **成因已量化（2026-08-07）**: 🔴 本 FIX 形態（無規則引用）在**本機佔 100%、Azure CEVA 37.4%、Azure 全庫僅 13.7%**；Azure 主因是 [FIX-150](FIX-150-nippon-charge-fields-lost-mapping-slot-contention.md) 的欄位互搶（四個來源共 489,675.60 搶同一個 `freight`）。見 §成因量化
> **相關**: [FIX-150](FIX-150-nippon-charge-fields-lost-mapping-slot-contention.md)（欄位互搶）、[FIX-158](FIX-158-mapping-field-definition-misalignment.md)（mapping 與定義不對齊）、[FIX-161](FIX-161-mapping-references-undefined-company-fields.md)（反方向：規則引用取不到的 key）

---

## 問題描述

Stage 3 成功提取出費用並寫入 `extraction_results.stage_3_result`，但該公司的 `template_field_mappings` **沒有任何規則引用該 key**。模板匹配時這筆錢不會被任何 `targetField` 取走，直接從帳上消失。

與 [FIX-150](FIX-150-nippon-charge-fields-lost-mapping-slot-contention.md) 的差別：FIX-150 是**兩個 key 搶同一個 slot**，這裡是 key **根本沒有 slot**。

---

## 實測清單（262 列中出現）

| 提取到的 key | 次數 | 金額合計 | 出現於 |
|---|---:|---:|---|
| `bl_fee` | 6 | **9,600.00** | Nippon Express Logistics / import |
| `destination_thc_terminal_handling_charge` | 3 | **5,490.55** | CEVA LOGISTICS (HONG KONG) / export |
| `seal_charge` | 6 | **3,250.00** | Nippon Express Logistics / import |
| `fuel_surcharge` | 12 | **2,703.97** | RICOH INTERNATIONAL LOGISTICS (HK) / import |
| `cfs_charge` | 3 | 827.90 | Nippon Express (HK) / export |
| `do_fee` | 1 | 650.00 | RICOH INTERNATIONAL LOGISTICS (HK) / export |
| `freight_charges` | 1 | 620.00 | CEVA LOGISTICS (HONG KONG) / export |
| `parking_charge` | 1 | 250.00 | RICOH INTERNATIONAL LOGISTICS (HK) / export |
| `destination_cfs_charges` | 1 | 200.00 | CEVA LOGISTICS (HONG KONG) / export |
| `airline_documentation_charges` | 8 | 120.00 | RICOH INTERNATIONAL LOGISTICS (HK) / import |
| `tunnel_fee` | 1 | 86.00 | RICOH INTERNATIONAL LOGISTICS (HK) / import |
| `o_gate_io_or_parking_chg` | 1 | 80.00 | Nippon Express (HK) / export |
| `destination_gate_fee` | 1 | 80.00 | CEVA LOGISTICS (HONG KONG) / export |
| `document_fee` | 2 | 70.00 | Toll Global Forwarder / import |
| `freight_charge` | 1 | 60.00 | Toll Global Forwarder / export |
| `customs_import_clearance_fee` | 1 | 50.00 | Toll Global Forwarder / import |
| `airport_terminal_fee_origin` | 2 | 47.82 | Toll Global Forwarder / import |
| **小計（金額欄位）** | | **24,186.24** | |

### 兩項需排除的誤判

驗證工具的忽略清單只涵蓋 `total_amount` / `subtotal` / `currency` 等，未涵蓋以下非金額欄位，故被誤計入：

| key | 值 | 說明 |
|---|---:|---|
| `gross_weight` | 310.00 | 重量，不是金額 |
| `customer_address` | 63.00 | 地址欄位被填入數字，本身是另一個提取品質問題 |

`customer_address = 63` 值得單獨注意 —— 地址欄位不該是數字，代表 Stage 3 有欄位錯填，但不在本 FIX 範圍。

---

### 查證後排除：稅額（`vat` / `vat_7`）不屬於本 FIX

2026-08-05 曾懷疑稅額也是「提取到卻無 mapping 引用」的一員，查證後**不成立**：

- 8 條啟用中的規則有引用稅額 key（Nippon 以 `vat_7 → vat` DIRECT，其餘 6 家併入 handling 的 FORMULA）
- 依各 formula 實際引用的 key 逐條重算 844 列，**稅額去向不明 = 0 筆**

最初判定的「25 列無去處」是**判準缺陷**：該檢查用「row 的 handling 欄 = **同名**提取值 + 稅額」比對，但 formula 的 sourceField 與 targetField 不同名且另有他項。

稅額真正的問題是**各公司口徑不一致**，已另立 [FIX-168](FIX-168-vat-mapping-inconsistent-across-companies.md)。

---

## 對帳影響

53 列的列合計低於發票總額，**短少合計 59,500.72**。本 FIX 的 24,186 是其中可直接歸因的部分，其餘由 [FIX-161](FIX-161-mapping-references-undefined-company-fields.md) 涵蓋。

| instance | 列數 | 短少 |
|---|---:|---:|
| Nippon Express (HK) / import | 5 | 14,630.96 |
| Nippon Express Logistics / import | 6 | 12,850.00 |
| RICOH INTERNATIONAL LOGISTICS (HK) / import | 17 | 8,647.14 |
| CEVA LOGISTICS (HONG KONG) / export | 5 | 7,321.88 |
| RICOH INTERNATIONAL LOGISTICS (HK) / export | 5 | 6,585.18 |
| Nippon Express (HK) / export | 3 | 5,843.90 |
| DHL Express / import | 2 | 1,516.69 |
| Nippon Express Logistics / export | 1 | 810.00 |
| DHL Express / export | 3 | 708.50 |
| Toll Global Forwarder / import | 5 | 522.27 |
| Toll Global Forwarder / export | 1 | 64.20 |

---

## 尚未確認的關鍵問題（修法前必須逐項回答）

每一個 key 都要分辨屬於哪一種，處置完全不同：

| 情況 | 判準 | 處置 |
|---|---|---|
| A. 該費用**應該**進表，但漏了規則 | 模板有語意對應的 `targetField` 且目前是空的 | 新增規則 |
| B. 該費用**已經**由別的 key 進表 | 同一筆錢有另一個 key 已被引用 → 加規則會**重複計費** | 不動 |
| C. 該費用**不該**進這個模板 | 業務上不屬於該模板的欄位範圍 | 不動，記錄為預期行為 |

🔴 **B 是最危險的情況**。`bl_fee` 在 [FIX-150](FIX-150-nippon-charge-fields-lost-mapping-slot-contention.md) 已知承載 70 筆 / 114,000，與其他費用 key 有互搶史。貿然新增規則可能造成同一筆錢被計兩次 —— 那正是 [FIX-162](FIX-162-row-total-exceeds-invoice-amount.md) 記錄的另一個方向的問題。

---

## 建議修法（待使用者拍板）

1. 逐一比對每個 key 在該公司模板中**是否已有語意對應的 targetField**，以及該 targetField 目前由哪條規則供給
2. 屬於情況 A 者，以 gated 腳本（inspect / dryrun / write）新增規則
3. 每次變更前後跑 `scripts/check-orphan-charge-keys.js` 與 `scripts/snapshot-template-values.js`，確認沒有「欄位由有值變為空白」
4. 變更後重建 instance 驗證列合計是否收斂

### 變更範圍（🔴 修法確定後須精確指名）

| 項目 | 值 |
|---|---|
| 資料表 | `template_field_mappings`（**不是** `data_templates`，後者影響全部共用公司） |
| 記錄 | 依公司逐筆指名，待修法確定後填入 |
| 不動 | `field_definition_sets`（樣本 ≠ 母體，不因看似重複而刪定義） |

---

## 驗證方式

```bash
node scripts/check-orphan-charge-keys.js --save=before.json
# 變更後
node scripts/check-orphan-charge-keys.js --baseline=before.json
```

重建 instance 後以 `verify-instances.js` 確認：目標公司的 [B] 徵狀歸零，且 [E] 合計不符的列數下降。

---

## 成因量化：本 FIX 的形態只佔一部分，且各環境比例相反（2026-08-07）

🔴 **本節推翻了本 FIX 的一個隱含前提**：原文假設漏接主要來自「提取到了卻無規則引用」，
實測後只有**本機**如此。Azure 上該形態僅佔 13.7%，主因另有其事。

### 已量測

| 項目 | 值 | 來源 |
|---|---|---|
| Azure 全庫漏接 | 586,302.84（多算 8,014.58），607 份參與對帳 | `RUN_ORPHAN_CHECK=inspect`，2026-08-06 |
| 其中 CEVA 漏接 | **189,073.28** | 同上 |
| CEVA export 實例列取到值的欄位 | 僅 5 個：`shipment_number` 48、`document_fee` 42、`thc` 26、`seal_fee` 23、`vgm` 13 | 48 列實測 |
| 該模板的 number 欄位總數 | **36** | `data_templates` 實測 |

即 36 個費用欄位中只有 4 個真正承載金額。缺口顯著。

### 已排除的一個成因

[FIX-161](FIX-161-mapping-references-undefined-company-fields.md) 修好的 `cfs_charge` /
`gate_charge` **不是**原因 —— 重新匹配後 `transformDiagnostics` 顯示
`destination_cfs_charges` / `destination_gate_fee` 在 **48/48 列**都不存在於提取結果，
即這批發票沒有這兩項費用（母體未覆蓋）。修復正確，但對這個缺口毫無貢獻。

### 為什麼需要專用工具才能歸類

`transformDiagnostics` 只記錄「**規則引用了但取不到值**」，**不記錄**「提取到了但沒有規則引用」——
而後者正是本 FIX 的形態。所以現有證據**看不見**本 FIX 的徵狀，缺口成因可能是：

| 可能 | 判別方式 |
|---|---|
| (a) 本 FIX 形態：提取到了但無規則引用 | 比對 `extraction_results.field_mappings` 的 key 與 mapping 引用的 key |
| (b) 母體未覆蓋：這批發票本來就沒那些費用 | 同上——差別在提取結果**有沒有**那些 key |
| (c) 欄位定義集缺 key，Stage 3 根本沒提取 | 比對定義集 key 與提取結果 |

三者的處置完全不同（(a) 補 mapping、(b) 不處理、(c) 補定義集並重新提取），
**不查清楚就動手會修錯地方**。

### 判別工具

`prisma/diagnose-orphan-cause-20260807.js`，旗標 `RUN_ORPHAN_CAUSE=inspect`（唯讀）。
A / B 的定義與 `check-orphan-charge-keys.js` **逐字相同** —— 本機全庫跑出的漏接總額
`38946.27` 與該腳本實測值完全吻合，兩支的數字可互相解釋。

對每個「計入 A 但未落地」的 key，依有無規則引用分成三類：

| 類別 | 意義 | 處置 |
|---|---|---|
| **[1]** 無任何規則引用 | 本 FIX 的形態 | 補 mapping |
| **[2]** 有規則但 targetField 非模板數值欄位 | 落到了欄位但不計入 B | 改模板欄位型別 |
| **[3]** 有規則且目標為數值欄位 | 規則在，未落地另有原因 | 需逐案查（互搶／FORMULA 合併／快照過期） |

搭配 `RECONCILE_COMPANY` 過濾公司、`RECONCILE_DOCS=true` 逐份列出。

### 實測結果：三個環境三種分布

| | 本機 CEVA | Azure CEVA | Azure 全庫 |
|---|---:|---:|---:|
| 參與判別文件 | 62 | 232 | 628 |
| 漏接總額 | 8,866.71 | 217,464.03 | 614,693.59 |
| **[1] 無規則引用** | **100%** | 37.4% | 13.7% |
| [2] targetField 非數值 | 0% | 0% | 0% |
| **[3] 有規則未落地** | 0% | **58.0%** | **95.6%** |
| 未歸類殘額 | 0.00 | +9,989.91 | −56,894.55 |

🔴 **三者結論都不同，拿任何一個推另一個都會錯。** 本機 CEVA 是乾淨的單一成因
（`destination_thc_terminal_handling_charge` 5,490.55 + `freight_charges` 3,376.16，殘額 0.00），
Azure CEVA 是混合，Azure 全庫幾乎全是 [3]。

### Azure 全庫的 [3] 集中在同一個 targetField

```
190395.40  19 筆  express_worldwide_nondoc → freight
138188.00   5 筆  ocean_freight            → freight
110666.76   8 筆  freight_charges          → freight
 50425.44  17 筆  fuel_surcharge           → freight
```

四個來源共 **489,675.60** 指向同一個 `freight` 欄位。一個欄位只能存一個值——
這是 [FIX-150](FIX-150-nippon-charge-fields-lost-mapping-slot-contention.md) 的**欄位互搶**形態，
不是本 FIX。補 mapping 對這部分無效。

### 同一個 key 可能同時落在兩類

```
[1]  19508.31   1 筆  freight_charges            ← 無規則引用
[3] 110666.76   8 筆  freight_charges → freight  ← 有規則
```

「CEVA」關鍵字涵蓋**多家**公司記錄，各有獨立的 mapping 與定義集。
所以 CEVA 的漏接不是單一問題，而是**跨公司的設定不一致**。

### 🔴 兩個必須標註的限制

**[3] 是高估的上限。** 未落地的判準是「該金額沒有出現在列的任何數值欄位裡」，
而 FORMULA 規則把多個 key 加總成一個 targetField，個別 key 的金額本就不會單獨出現——
會被誤判為未落地。Azure 全庫殘額 **−56,894.55**（負數）即分類總和超過實際漏接，證實有高估。

**[1] 不受影響，是可靠下限。** 沒有規則引用就一定沒落地，這是二元事實。
本機 CEVA 殘額 0.00 也印證了：不涉及 FORMULA 的公司完全對得上。

### 數字不可與 2026-08-06 的 baseline 直接相比

| | 08-06 baseline | 08-07 實測 |
|---|---:|---:|
| 全庫參與對帳 | 607 份 | 628 份 |
| 全庫漏接 | 586,302.84 | 614,693.59 |
| CEVA 漏接 | 189,073.28 | 217,464.03 |

期間多了 21 份文件進入實例，**分母變了**。不可據此宣稱「漏接增加」——
要做前後比較必須用同一時點的 baseline。

### 對修法的意義

本 FIX 的修法（補 mapping）能解決的比例：**本機 100%、Azure CEVA 37.4%、Azure 全庫 13.7%**。
剩下的 [3] 屬 FIX-150 形態或 FORMULA 部分落地，需先區分兩者才能決定處置——
那需要逐列重算 FORMULA，且實例列是快照（改設定不回溯），過期本身會造成假陽性。

---

**建立者**: AI 助手
**最後更新**: 2026-08-07（成因已量化 —— 本 FIX 形態在 Azure 僅佔 13.7%，主因為 FIX-150 的欄位互搶）
