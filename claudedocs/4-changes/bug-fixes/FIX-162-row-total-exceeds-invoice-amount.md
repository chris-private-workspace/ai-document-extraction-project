# FIX-162: 列合計高於發票總額 —— 同一筆錢被重複計入

> **建立日期**: 2026-08-04
> **發現方式**: 375 份樣本全覆蓋驗證，12 個 template instance 逐列追溯（[TEST-REPORT-006](../../5-status/testing/reports/TEST-REPORT-006-full-sample-coverage-verification.md)）
> **影響範圍**: `template_field_mappings` → 模板實例列值 → 匯出報表金額**虛增**
> **優先級**: 高（9 列超出合計 **20,638.44**，方向與漏帳相反，會高估成本）
> **狀態**: 📋 規劃中
> **相關**: [FIX-152](FIX-152-dhl-multi-shipment-aggregate-amount-leak.md)（DHL 多筆併單的合計外洩）、[FIX-160](FIX-160-template-mapping-unreferenced-extracted-charges.md)（反方向：漏帳）

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

## 尚未確認的根因

以下三種都會造成列合計偏高，需逐份追溯才能分辨：

| 假設 | 檢查方式 |
|---|---|
| **兩條規則指向同一筆錢** | 驗證工具的 [F] 徵狀（規則互搶）在本次為 0，但那只檢查 `targetField` 重複，**不檢查兩個不同 targetField 引用同一個 sourceField** |
| **彙總欄位與明細同時計入** | 例如 `total_charges` 與其組成項都被引用 |
| **FORMULA 重複相加** | 公式引用的 key 與另一條 DIRECT 規則的 key 重疊 |

🔴 第一項是本次驗證工具的**已知盲點** —— [F] 徵狀 0 次不代表沒有重複引用。判定時不可把「[F] 為 0」當成「沒有互搶」。

---

## 建議調查步驟

1. 對這 9 份逐一列出：該公司所有規則的 `sourceField` 清單，找出被兩條以上規則引用的 key
2. 比對超出金額與個別費用金額，定位是哪一筆被算了兩次
3. `RIL_RHIM260091` / `260092` 兩份超出金額相同，優先從這組入手 —— 固定金額最容易反推
4. 確認 DHL 三份是否與 [FIX-152](FIX-152-dhl-multi-shipment-aggregate-amount-leak.md) 的多筆併單合計外洩同源（檔名 `RCEX250035,0036` 與 `RCEX250146` 皆為多單號）

### 與 FIX-152 的可能關聯

DHL 三份中有兩份檔名含多個單號（`250035,0036`、`250410,0411,0412` 型態）。[FIX-152](FIX-152-dhl-multi-shipment-aggregate-amount-leak.md) 記錄過 DHL 多筆併單的合計外洩，需確認是否為同一機制在模板層的表現。

---

## 驗證方式

重建 instance 後確認這 9 列的列合計等於 `total_amount`（容差 0.05）。

⚠️ 修正時要同時盯著漏帳方向 —— 移除重複引用可能讓某筆錢失去唯一去處，變成 [FIX-160](FIX-160-template-mapping-unreferenced-extracted-charges.md) 的形態。變更前後必須跑 `scripts/snapshot-template-values.js` 比對，關鍵訊號是「欄位由有值變為空白」。

---

**建立者**: AI 助手
**最後更新**: 2026-08-04
