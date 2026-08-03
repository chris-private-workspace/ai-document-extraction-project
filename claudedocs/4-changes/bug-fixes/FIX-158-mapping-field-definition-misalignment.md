# FIX-158: mapping 與 field definition 不對齊 —— RIL 欄位重複致金額時而遺失、CEVA 規則指向未定義欄位

> **建立日期**: 2026-08-03
> **發現方式**: template instance 逐欄追溯核對（2026-08-03 對 12 個 instance 執行）
> **影響頁面/功能**: `template_field_mappings` / `field_definition_sets` → 模板實例的欄位值
> **優先級**: 高（RIL 已實測造成 **1,355.07 金額遺失**；CEVA 為潛伏風險，目前未發作）
> **狀態**: 📋 規劃中（RIL 修法已由使用者拍板；CEVA 範圍待確認）
> **相關**: [FIX-150](FIX-150-nippon-charge-fields-lost-mapping-slot-contention.md)（同型的欄位互搶）、[FIX-156](FIX-156-dhl-prompt-omits-subtotal-definition.md)（模型在兩個合法選項間搖擺）、[FIX-128](FIX-128-mapping-source-field-validation.md)（transform 診斷）

---

## 問題一：RIL 有兩個語意相同的欄位定義，模型隨機二選一

### 現象

`RIL_RCIM250313_22084` 同一份 PDF、同一個模型（gpt-5.6-luna）、相隔 4.5 小時的兩次提取：

| 提取時間 | 模型填入的 key | 值 | 結果 |
|---|---|---:|---|
| 2026-08-03 01:27 | `air_local_charge_usa_origin` | 1,355.07 | 🔴 對不上 mapping → 列合計 3,735.10 vs `total_amount` 5,090.17，**短少 1,355.07** |
| 2026-08-03 06:03 | `air_local_charge_in_usa_origin_charge` | 1,355.07 | ✅ 列合計 5,090.17，完全吻合 |

### 根因

`field_definition_sets` 中 **`SBS INTERNATIONAL LOGISTICS - 自訂費用欄位集`**（companyId `2bad90a8-2611-4c85-bb5a-2e381a1487f4`）同時定義了兩個語意相同的欄位：

| key | label | aliases |
|---|---|---|
| `air_local_charge_usa_origin` | `(Air) Local Charge in USA (Origin Charge)` | `[]` |
| `air_local_charge_in_usa_origin_charge` | `Air local charge in usa origin charge` | `[]` |

兩者都沒有 aliases，模型無從判斷該用哪一個，於是每次自行決定。而 `template_field_mappings` 的 `cmrn8gbe1000101mlw86c4baw`（SBS INTERNATIONAL LOGISTICS - Inbound）**只引用後者**：

```json
{
  "id": "1cwj_bz-628yROh9Rzo1t",
  "order": 13,
  "sourceField": "air_local_charge_in_usa_origin_charge",
  "targetField": "handling_at_origin",
  "transformType": "DIRECT",
  "transformParams": null
}
```

模型填前者時，這條規則取不到值，錢就消失。

### 修法（使用者 2026-08-03 拍板）

把該規則改為 FORMULA，兩個 key 都接：

```
handling_at_origin ← {air_local_charge_usa_origin} + {air_local_charge_in_usa_origin_charge}
```

**不動欄位定義** —— 依 §樣本 ≠ 母體 紀律，不因「看起來重複」就刪除既有定義。且同一時間只會有一個 key 有值，相加不會造成重複計費。

### 變更範圍（🔴 精確指名）

| 項目 | 值 |
|---|---|
| 資料表 | `template_field_mappings` |
| 記錄 | `cmrn8gbe1000101mlw86c4baw`（SBS INTERNATIONAL LOGISTICS - Logistics Cost - **Inbound** Template） |
| 規則 | `mappings` 陣列中 id = `1cwj_bz-628yROh9Rzo1t` 的那一條 |
| 不動 | `cmrofifwq001l01mlg81inpc0`（同公司的 **Outbound** 模板，無此規則） |
| 不動 | `field_definition_sets` 的任何欄位 |

---

## 問題二：CEVA 的 mapping 引用了從未定義的欄位

### 現象

`CEVA_RCIM250325_17865` 的列**結果正確**（合計 2,873.08 = `total_amount`），但有四條 mapping 規則永遠不可能生效。

### 根因

`CEVA LOGISTICS (HONG KONG) LTD`（companyId `0d02b680-165b-4cfd-8c1b-7ebfa6da8424`）的 mapping 引用了四個 key，但該公司的 `field_definition_sets`（`f13aaf3b-ec74-4750-8036-a27dbb554792`，17 個欄位）**都沒有定義**：

| mapping 規則 | 引用的 key | 欄位定義 |
|---|---|---|
| `handling` ← | `destination_truck_servicing_fee` | 🔴 缺 |
| `ebs` ← | `emergency_fuel_surcharge` | 🔴 缺 |
| `gate_charge` ← | `destination_gate_fee` | 🔴 缺 |
| `cfs` ← | `destination_cfs_charges` | 🔴 缺 |

欄位沒有定義 → 不會進 Stage 3 prompt → 模型不會抽取 → 規則永遠取不到值。目前無害純粹是因為抽樣到的發票沒有這些費用；一旦出現，金額會像 RIL 那樣靜靜遺失。

**使用者 2026-08-03 確認：這些費用會出現在 CEVA 發票上**，因此應補上欄位定義（而非刪除規則）。

### 🔴 待確認才能執行

| # | 事項 | 為何阻擋 |
|---|---|---|
| 1 | **要補哪一間？** 本地有兩間 CEVA 帶配置 —— `CEVA LOGISTICS (HONG KONG) LTD`（0d02b680，17 欄，引用全部 4 個）與 `CEVA LOGISTICS (HONG KONG) LIMITED（CEVA Logistics）`（7448b7c5，22 欄，引用其中 3 個，未引用 `destination_gate_fee`） | 兩間的 mapping 都有斷鏈，但補錯間等於沒補 |
| 2 | **aliases 要填什麼？** 發票上這四筆費用實際印的字樣 | aliases 會進 Stage 3 prompt，是模型辨識的依據；留空則只能靠 label 猜（RIL 的問題正是兩個欄位都沒有 aliases） |
| 3 | 第二間已有 `cfs` 與 `gate_charge` 欄位，再補 `destination_cfs_charges`、`destination_gate_fee` 是否會造成語意重疊 | 這正是問題一的成因 —— 兩個語意相同的欄位會讓模型搖擺 |

第 3 點特別要留意：**補欄位若製造出第二組「語意相同的雙胞胎」，等於在 CEVA 複製 RIL 的問題。**

---

## 驗收標準

### 問題一

1. 規則改為 FORMULA 後，重新匹配 `RIL_RCIM250313_22084`，`handling_at_origin` = 1,355.07
2. 列合計 = 5,090.17 = `total_amount`
3. 以模型另一次輸出（填 `air_local_charge_usa_origin`）的提取結果重新匹配，結果**同樣**得到 1,355.07 —— 這才證明兩條路都通
4. 該公司其他欄位值不受影響

### 問題二

1. 補上欄位定義後重新處理一張含這些費用的 CEVA 發票，`stage3Result.fields` 應出現對應 key
2. 重新匹配後 `ebs` / `gate_charge` / `cfs` / `handling` 取得數值
3. 列合計與 `total_amount` 吻合
4. 既有正確的欄位（`freight`、`thc`、`docs_fee`、`others_local_charge`）數值不變

---

## 執行方式

依 §不可逆資料操作紀律，兩項都以三段式 gated 腳本執行（inspect / dryrun / write），五項措施齊備：前置快照、單一交易、數量閘、樂觀鎖（比對 `updated_at`）、冪等。

---

## 備註

- 問題一與 [FIX-156](FIX-156-dhl-prompt-omits-subtotal-definition.md) 是**同一類**：當存在兩個都說得通的選項而系統沒有給出判準時，模型的選擇就是不穩定的。差別在 FIX-156 缺的是 prompt 定義，本問題缺的是欄位間的區辨依據（aliases）
- 這兩個問題都是靠**逐欄位追溯核對**發現的：RIL 的金額遺失有合計差額佐證（−1,355.07 恰等於遺失欄位的值），CEVA 的斷鏈則是在結果完全正確的情況下被查出來的 —— 純看結果不可能發現
