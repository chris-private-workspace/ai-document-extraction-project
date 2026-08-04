# FIX-158: mapping 與 field definition 不對齊 —— RIL 欄位重複致金額時而遺失、CEVA 規則指向未定義欄位

> **建立日期**: 2026-08-03
> **發現方式**: template instance 逐欄追溯核對（2026-08-03 對 12 個 instance 執行）
> **影響頁面/功能**: `template_field_mappings` / `field_definition_sets` → 模板實例的欄位值
> **優先級**: 高（RIL 已實測造成 **1,355.07 金額遺失**；CEVA 為潛伏風險，目前未發作）
> **狀態**: ✅ 已完成（2026-08-03，兩項設定變更皆已以 gated 腳本寫入**本機與 Azure DEV**。**問題一已實機驗證通過**，見 §實機驗證。**問題二已於 2026-08-04 驗證通過** —— 以 375 份樣本第二批在本機重跑，四個欄位全部命中真實發票，推導的 aliases 確實有效，技術債務結清，見 §技術債務已結清。🔴 **問題二的根因描述經 Azure 實測更正**：該環境一直都有這四個欄位定義，缺的是本機，見 §Azure 實測更正）
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

## 問題二：CEVA 的 mapping 引用了本機未定義的欄位

> 🔴 **標題與下述根因限於本機**。2026-08-03 Azure DEV 實測後確認：**該環境一直都有這四個欄位定義**，缺的是本機。詳見下方 §Azure 實測更正 —— 這推翻了「設定缺陷」的框架，真正的成因是跨環境同步殘缺。

### 現象

`CEVA_RCIM250325_17865` 的列**結果正確**（合計 2,873.08 = `total_amount`），但有四條 mapping 規則在本機永遠不可能生效。

### 根因（本機）

`CEVA LOGISTICS (HONG KONG) LTD`（companyId `0d02b680-165b-4cfd-8c1b-7ebfa6da8424`）的 mapping 引用了四個 key，但**本機**該公司的 `field_definition_sets`（`f13aaf3b-ec74-4750-8036-a27dbb554792`，17 個欄位）**都沒有定義**：

| mapping 規則 | 引用的 key | 欄位定義 |
|---|---|---|
| `handling` ← | `destination_truck_servicing_fee` | 🔴 缺 |
| `ebs` ← | `emergency_fuel_surcharge` | 🔴 缺 |
| `gate_charge` ← | `destination_gate_fee` | 🔴 缺 |
| `cfs` ← | `destination_cfs_charges` | 🔴 缺 |

欄位沒有定義 → 不會進 Stage 3 prompt → 模型不會抽取 → 規則永遠取不到值。目前無害純粹是因為抽樣到的發票沒有這些費用；一旦出現，金額會像 RIL 那樣靜靜遺失。

**使用者 2026-08-03 確認：這些費用會出現在 CEVA 發票上**，因此應補上欄位定義（而非刪除規則）。

### 三項待確認事項的處置（2026-08-03 定案）

| # | 事項 | 決定 |
|---|---|---|
| 1 | **要補哪一間？** 本地有兩間 CEVA 帶配置 | **只補 `CEVA LOGISTICS (HONG KONG) LTD`（0d02b680）**，17 → 21 欄。**不動** `CEVA LOGISTICS (HONG KONG) LIMITED（CEVA Logistics）`（7448b7c5） |
| 2 | **aliases 要填什麼？** | 依「X at Destination」書寫模式推導。資料佐證：全庫同一筆 THC 存在兩種寫法（×34 / ×6），顯示 forwarder 在同型費用上確有 destination 後綴的慣例 |
| 3 | 是否造成語意重疊 | 正是**不動第二間**的原因 —— 7448b7c5 已有 `cfs` 與 `gate_charge`，再補 `destination_cfs_charges` / `destination_gate_fee` 會製造出第二組雙胞胎，等於在 CEVA 複製 RIL 的問題 |

實際寫入（`scripts/fix-158-ceva-add-field-definitions.ts`，2026-08-03 06:45 UTC）：

| key | label | aliases |
|---|---|---|
| `destination_truck_servicing_fee` | Destination Truck Servicing Fee | `Truck Servicing Fee at Destination` |
| `emergency_fuel_surcharge` | Emergency Fuel Surcharge | `EBS`、`Emergency Bunker Surcharge`、`Emergency Fuel Surcharge at Destination` |
| `destination_gate_fee` | Destination Gate Fee | `Gate Fee at Destination`、`Gate Charge at Destination`、`Gate Charge` |
| `destination_cfs_charges` | Destination CFS Charges | `CFS Charges at Destination`、`CFS Charges`、`Container Freight Station Charge at Destination` |

### 🔴 Azure 實測更正（2026-08-03）：Azure 一直都有這四個定義，缺的是本機

同步到 Azure DEV 前跑 `inspect`，結果與上述根因相反：

| | 欄位數 | 四個 key | aliases | label |
|---|---|---|---|---|
| **本機**（修復前） | 17 | 🔴 全缺 | — | — |
| **Azure DEV** | **21** | ✅ **全在** | 🔴 全空 | 由 key 自動衍生的 sentence case（`Destination truck servicing fee`） |

欄位集 id 兩邊相同（`f13aaf3b-…`，`import-dev-data.js` 匯入時保留 id），但內容不同。

**這改變了問題的性質**：不是「設定缺陷」，而是 **[CHANGE-108](../feature-changes/CHANGE-108-azure-to-local-config-sync.md) 那次 azure-to-local 同步的殘缺** —— 只帶了 mapping，沒帶欄位定義，於是本機的 mapping 引用了本機不存在的 key。Azure 那邊四條規則其實**能**生效，只是沒有 aliases 導引，模型僅能靠 label 猜。

因此同一個 FIX 在兩個環境要做的事**不同**：

| 環境 | 動作 |
|---|---|
| 本機 | 新增 4 個欄位定義（含 aliases） |
| Azure DEV | **只補 aliases**（欄位與數量不變，21 → 21） |

> **連帶修正腳本缺陷**：`prisma/sync-config-20260803.js` 步驟 4 原本的冪等判斷只比對「key 是否存在」，會把 Azure 這種「有欄位但 aliases 全空」誤判為已達目標狀態而跳過。已改為比對 aliases，合併策略為**只增不減**（既有 aliases 一律保留，label 不動）。
>
> 教訓與 [FIX-143](FIX-143-summary-area-vat-field-typed-as-lineitem.md) 同型：**文件寫的「同型問題」是推論，跨環境執行前必須查該環境的實際資料**。若照本文件原本的描述直接在 Azure 新增欄位，會建出四組重複定義 —— 正是問題一（RIL 雙胞胎）的成因。

### ✅ 技術債務已結清（2026-08-04）：四個欄位全部取得真實實例

原記錄如下（保留，作為判斷過程的紀錄）：

> `destination_gate_fee` 與 `destination_truck_servicing_fee` 的 aliases 是**推導**而非**觀察**得來 —— 全庫 88 份 CEVA 提取結果、33 種行項描述中，這兩類費用**一個實例都沒有**。前兩者尚有旁證（`emergency_fuel_surcharge` 有 DHL 的 `FUEL SURCHARGE` ×34；`destination_cfs_charges` 有 `(SEA) CFS (DEST)`、`CFS CHARGES` 各 ×1），後兩者只有其他 forwarder 的同類欄位可參考。
>
> 依 §樣本 ≠ 母體 紀律，**沒有實例不等於不存在**（使用者已確認這些費用會出現），所以照補；但 aliases 用字是否命中真實發票，**必須等一張含該費用的 CEVA 發票才能驗證**。

**2026-08-04 以使用者提供的 375 份樣本在本機跑第二批（197 份、CEVA 系 46 份有結果），四個欄位全部命中真實發票：**

| 欄位 | 有值份數 | 發票上的實際原文 |
|---|---:|---|
| `destination_gate_fee` | 3/46 | `DESTINATION GATE FEE--car park + gate fee`、`GATE CHARGE`、`Gate Fee at Destination` |
| `destination_cfs_charges` | 2/46 | `DESTINATION CFS CHARGES`、`CFS-Minimum HKD 200.00` |
| `emergency_fuel_surcharge` | 1/46 | `OTHER SURCHARGE (Emergency Fuel Surcharge)` |
| `destination_truck_servicing_fee` | 1/46 | `DESTINATION TRUCK SERVICING FEE` |

**推導出來的 aliases 確實命中**，其中兩項值得記錄：

- `Gate Fee at Destination` —— 這正是當初依「X at Destination」書寫模式推導的寫法，真實發票確實這樣印
- `Gate Charge`、`CFS Charges` 等**無 destination 後綴**的寫法也被接住，證明保留無後綴變體是必要的

最有價值的單一樣本是 `CEVA_RHIM260059_34014.pdf`，一份即命中三個欄位。

> ⚠️ 命中率偏低（1-3/46）是因為這些費用在 CEVA 發票上本就少見，不是 aliases 失準 —— 46 份的 55 種行項描述中，相關關鍵字僅出現 7 筆。母體稀少與 aliases 失效是兩回事，勿混為一談。

> ⚠️ 跨公司觀察：`Gate Fee at Destination` 也出現在 **`NEX_RHIM250096_28812.pdf`**（Nippon，非 CEVA）。同一寫法跨 forwarder 出現，意味這批 aliases 可能對其他公司同樣適用 —— 也可能造成跨公司的欄位競爭（[FIX-150](FIX-150-nippon-charge-fields-lost-mapping-slot-contention.md) 的形態）。尚未查證，記錄待辦。

⚠️ 上述驗證僅在**本機**完成。Azure DEV 的 aliases 內容與本機相同（2026-08-03 同步），但該環境未跑這批樣本。

---

## 驗收標準與結果

### 問題一 —— ✅ 全數通過

| # | 判準 | 結果 |
|---|---|---|
| 1 | 規則改為 FORMULA 後重新匹配，`handling_at_origin` = 1,355.07 | ✅ |
| 2 | 列合計 = 5,090.17 = `total_amount` | ✅ |
| 3 | 以模型**另一次輸出**的提取結果重新匹配，同樣得到 1,355.07 | ✅ 見下方對照 |
| 4 | 該公司其他欄位值不受影響 | ✅ `freight` 1,472.31 / `docs_fee` 148.46 / `handling` 538.88 皆未變 |

### 問題二 —— ✅ 本機驗證通過（2026-08-04）

| # | 判準 | 結果 |
|---|---|---|
| 1 | 重新處理一張含這些費用的 CEVA 發票，`stage3Result.fields` 出現對應 key | ✅ 四個欄位皆取得真實值，見 §技術債務已結清 |
| 2 | 重新匹配後 `ebs` / `gate_charge` / `cfs` / `handling` 取得數值 | ✅ 提取層已確認；模板層尚未建實例比對 |
| 3 | 列合計與 `total_amount` 吻合 | ⏳ 未查（需建模板實例） |
| 4 | 既有正確的欄位數值不變 | ✅ 已驗（重跑 `CEVA_RCIM250325_17865`，四個新欄位皆為 null、未搶走既有費用） |

判準 1 的關鍵樣本：`CEVA_RHIM260059_34014.pdf`（一份命中三欄）、`CEVA_RCIM260090_54835.pdf`（EBS）、`CEVA_RHEX250584_51396.pdf`（Gate / CFS 的無後綴寫法）。

---

## 執行方式

依 §不可逆資料操作紀律，兩項都以三段式 gated 腳本執行（inspect / dryrun / write），五項措施齊備：前置快照、單一交易、數量閘、樂觀鎖（比對 `updated_at`）、冪等。

| 腳本 | 目標 |
|---|---|
| `scripts/fix-158-ril-dual-key-formula.ts` | `template_field_mappings` 的 `cmrn8gbe1000101mlw86c4baw`，規則 `1cwj_bz-628yROh9Rzo1t` |
| `scripts/fix-158-ceva-add-field-definitions.ts` | `field_definition_sets` 的 `f13aaf3b-ec74-4750-8036-a27dbb554792`（17 → 21 欄） |

---

## 實機驗證（2026-08-03，問題一）

驗證的關鍵在於**找到對照組** —— 同一張 PDF `RIL_RCIM250313_22084` 恰好留有兩份提取結果，同一個模型（`gpt-5.6-luna`）卻挑了不同的 key。兩者分開建 instance 匹配（同一 `shipment_number` 放同一 instance 會被併成一列、金額翻倍）：

| 來源文件 | 模型輸出 | 修復前 | 修復後 |
|---|---|---|---|
| `a3caa157` | `air_local_charge_usa_origin` = 1355.07 | 🔴 `handling_at_origin` **欄位完全不存在**，列合計短少 1,355.07 | ✅ **1,355.07** |
| `f2227df7` | `air_local_charge_in_usa_origin_charge` = 1355.07 | ✅ 1,355.07（舊規則恰好命中） | ✅ **1,355.07** |

逐欄追溯的實際輸出：

```
變體 A:  handling_at_origin = 1355.07
           ← [FORMULA] air_local_charge_usa_origin=1355.07 + air_local_charge_in_usa_origin_charge=null
變體 B:  handling_at_origin = 1355.07
           ← [FORMULA] air_local_charge_usa_origin=null + air_local_charge_in_usa_origin_charge=1355.07
```

兩列合計皆為 5,090.17 = `total_amount`。核對工具（A–G 七類徵狀）判定「未發現徵狀」。

> 本次同時驗證 [FIX-157](FIX-157-formula-all-null-writes-zero.md)，兩者共用同一批重新匹配。驗證用 instance：`cmscxbw060000ksxg5keksbfl`、`cmscxbw7l0003ksxg4ls4itfl`（DRAFT，可刪）。

---

## 備註

- 問題一與 [FIX-156](FIX-156-dhl-prompt-omits-subtotal-definition.md) 是**同一類**：當存在兩個都說得通的選項而系統沒有給出判準時，模型的選擇就是不穩定的。差別在 FIX-156 缺的是 prompt 定義，本問題缺的是欄位間的區辨依據（aliases）
- 這兩個問題都是靠**逐欄位追溯核對**發現的：RIL 的金額遺失有合計差額佐證（−1,355.07 恰等於遺失欄位的值），CEVA 的斷鏈則是在結果完全正確的情況下被查出來的 —— 純看結果不可能發現
