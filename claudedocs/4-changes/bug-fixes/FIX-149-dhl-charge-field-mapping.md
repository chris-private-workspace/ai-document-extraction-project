# FIX-149: DHL 費用映射錯配 —— doc 被混進 freight、fuel surcharge 不該獨立成欄

> **建立日期**: 2026-07-31
> **發現方式**: 使用者回報（Template Instance 匹配結果與預期不符）
> **根因確認方式**: 直接查 Azure DEV 的 `template_field_mappings`、`data_templates.fields`、`field_definition_sets` 與 3 份 DHL 文件的實際提取結果
> **影響範圍**: 設定資料（DHL Express 的 `template_field_mappings`）——**不改任何程式碼**
> **優先級**: 中（金額歸屬錯誤影響成本分類，但不造成金額遺失）
> **狀態**: 🚧 已實作（本機與 Azure DEV 皆已寫入並驗證；既有 instance 列需重新匹配才會套用）
> **相關**: CHANGE-101（批量建 template field mapping 的做法與 gated 腳本模式）、FIX-143（同為 CEVA/DHL 的設定資料修正）

---

## 使用者回報

> for the DHL charges, if for express worldwide doc fee then straightly whole amount can put in doc fee, and the non-doc fee can straightly put in freight charge, no need to divide to doc and fuel surcharges

澄清後的需求（2026-07-31）：

1. `FUEL SURCHARGE` **不要**單獨拆出來放進一個欄位，直接**加總到 express worldwide 的金額**中
2. 出現 `EXPRESS WORLDWIDE doc` → 匹配到 **doc fee**
3. 出現 `EXPRESS WORLDWIDE nondoc` → 匹配到 **freight charge**

**回報屬實。** 以下為查證結果。

---

## 事實基準：Azure DEV 現況

### 公司與欄位定義集

| 項目 | 值 |
|---|---|
| DHL Express | `eedf4065-653b-4fd0-8bfb-f71c78bb2ae5`（ACTIVE，**無重複公司**） |
| 欄位定義集 | 「DHL Express - 自訂費用欄位集」，3 個欄位 |
| 欄位 | `express_worldwide_doc` / `express_worldwide_nondoc` / `fuel_surcharge` |

### 模板目標欄位（查 `data_templates.fields`，屬性名是 `name` 不是 `key`）

| 模板 | id | 模式 | Freight | Doc fee 的實際 key |
|---|---|---|---|---|
| Logistics Cost - Inbound Template (Full List) | `cmrbi0ktk033201o3rivrxb6h` | `GROUP` | `freight` | **`docs_fee`**（label「Docs Fee」） |
| Logistics Cost - Outbound Template (Full List) | `cmrbhjbl4033101o3n77yg0sh` | `PIVOT` | `freight` | **`document_fee`**（label「Document fee」） |

> ⚠️ **兩個模板的 doc fee key 不同**（`docs_fee` vs `document_fee`）。寫映射時對錯會靜默失效 —— 目標欄位不存在不會報錯，只是那一欄永遠空白。

### 現行映射（錯配所在）

**Outbound（PIVOT）**

| target | source | type |
|---|---|---|
| `shipment_number` | `_ref_number` | DIRECT |
| `document_fee` | `express_worldwide_doc` | DIRECT |

→ **缺口**：`express_worldwide_nondoc` 與 `fuel_surcharge` **完全沒有映射**，nondoc 的錢無處可去。

**Inbound（GROUP）**

| target | source | type | formula |
|---|---|---|---|
| `shipment_number` | `_ref_number` | DIRECT | — |
| `freight` | `express_worldwide_nondoc` | **FORMULA** | `{express_worldwide_nondoc} + {express_worldwide_doc}` |
| `fuel_surcharge_at_origin` | `fuel_surcharge` | DIRECT | — |

→ **錯配 1**：`express_worldwide_doc` 被加進 `freight`，應該去 `docs_fee`。
→ **錯配 2**：`fuel_surcharge` 單獨成欄，應併入 express worldwide 的金額。

### 實際提取資料（3 份文件，2026-07-31 03:16）

```
DHL_RHIM250034_74315.pdf
  EXPRESS WORLDWIDE nondoc   7,445.85      FUEL SURCHARGE   2,277.91
  EXPRESS WORLDWIDE nondoc     482.30      FUEL SURCHARGE     141.07
  EXPRESS WORLDWIDE nondoc   6,114.00      FUEL SURCHARGE   1,788.35
  EXPRESS 12:00 nondoc       1,207.05      FUEL SURCHARGE     367.69
  ADDRESS CORRECTION           100.00      PREMIUM 12:00       50.00
  → express_worldwide_nondoc = 14,042.15    fuel_surcharge = 4,575.02

DHL_RCIM250268_07412.pdf   → nondoc 273.50,    fuel 82.05
DHL_RCIM250291_20411.pdf   → nondoc 32,981.10, fuel 5,949.36
```

### ⚠️ 更正：上述三份文件的觀察不足以代表全體

初查時只看了 3 份文件的 `field_mappings`，得出「DHL 全部只有 nondoc、沒有 doc」的結論並據此向使用者說明 —— **該結論是錯的**。

改查 `template_instance_rows.transform_diagnostics`（FIX-128 加的診斷欄位，記錄「formula 引用但該列不存在的來源 key」）後，全體 106 列的實況是：

| 類型 | 判定依據 | 列數 | 備註 |
|---|---|---|---|
| nondoc | 診斷含 `express_worldwide_doc`（缺 doc） | 84 | |
| **doc** | 診斷含 `express_worldwide_nondoc`（缺 nondoc） | **8** | 金額合計 **3,057.60**，原被錯放進 `freight` |
| **doc + nondoc 混合** | 診斷兩者皆無 | **8** | **混合發票實際存在** |
| 兩者皆缺 | 診斷含兩者 | 6 | 無 express worldwide 費用 |

> **教訓**：3 份文件的樣本不足以支撐「全體都是如此」的結論，而該結論又成了「混合發票暫不處理」這個決策的前提。系統自留的診斷欄位（`transform_diagnostics`）才是全量事實 —— 應該先查它，而不是抽樣看幾份文件。

---

## 修復內容

僅改 `template_field_mappings` 的 `mappings` JSON，**不動程式碼、不動 schema、不動欄位定義集**。

### Inbound Template (Full List)

| target | source | type | formula |
|---|---|---|---|
| `shipment_number` | `_ref_number` | DIRECT | —（不變） |
| `freight` | `express_worldwide_nondoc` | FORMULA | **`{express_worldwide_nondoc} + {fuel_surcharge}`** |
| `docs_fee` | `express_worldwide_doc` | DIRECT | **（新增）** |
| ~~`fuel_surcharge_at_origin`~~ | ~~`fuel_surcharge`~~ | — | **（移除）** |

### Outbound Template (Full List)

| target | source | type | formula |
|---|---|---|---|
| `shipment_number` | `_ref_number` | DIRECT | —（不變） |
| `document_fee` | `express_worldwide_doc` | DIRECT | —（不變） |
| `freight` | `express_worldwide_nondoc` | FORMULA | **`{express_worldwide_nondoc} + {fuel_surcharge}`（新增）** |

### 修復後的預期結果（以 `DHL_RHIM250034_74315.pdf` 為例）

| 欄位 | 修復前 | 修復後 |
|---|---|---|
| `freight` | 14,042.15 | **18,617.17**（= 14,042.15 + 4,575.02） |
| `docs_fee` | —（無此映射） | —（該份無 doc 費用） |
| `fuel_surcharge_at_origin` | 4,575.02 | **—（不再單獨成欄）** |

---

## 設計決策

| # | 決策 | 理由 |
|---|---|---|
| 1 | 用 `FORMULA` 而非 `AGGREGATE` 做多對一 | 沿用 CHANGE-101 既有做法，與現行 `freight` 那條一致 |
| 2 | `fuel_surcharge` 併入 `freight` 而非 `docs_fee` | `fuel_surcharge` 是**整張發票的加總**，不分 doc/nondoc；84/106 列為 nondoc，併入 freight 覆蓋絕大多數情況 |
| 3 | 混合發票（同張同時有 doc 與 nondoc）暫不處理 | 使用者 2026-07-31 明示「暫時不用處理」。**⚠️ 該決策當時是基於「目前沒有混合發票」的前提，而該前提後來被證實有誤 —— 實際有 8 列**。這 8 列的 fuel 會全部落在 `freight`，doc 部分不分攤到 fuel。已回報使用者，待其決定是否另案處理 |
| 4 | 只改設定資料，不碰程式碼 | 錯的是映射規則本身，非引擎邏輯 |
| 5 | 用 gated 腳本（`inspect` → `dryrun` → `write`） | 沿用 CHANGE-101 模式；`template_field_mappings` 無 rollback 機制，寫入前必須先看到 before/after |

---

## 執行方式與環境狀態

腳本：`scripts/fix-149/update-dhl-charge-mapping.js`（三段式 gated）

```bash
node scripts/fix-149/update-dhl-charge-mapping.js inspect   # 只讀，印現況
node scripts/fix-149/update-dhl-charge-mapping.js dryrun    # 只讀，印 before/after
node scripts/fix-149/update-dhl-charge-mapping.js write     # 寫入（單一交易 + 最多 2 筆的數量閘）
```

同一支腳本兩環境通用：`dotenv` 以 try/catch 載入（Azure 容器由平台注入環境變數且映像不含 dotenv），SSL 依連線目標**自動判斷**（本機 docker PostgreSQL 不支援 SSL、Azure 私有端點需要）—— 刻意不用環境變數控制，因為忘記設定時得到的錯誤訊息與 SSL 無關、難以聯想。

Azure 執行方式：經 Kudu 上傳後 `env PG_MODULE_PATH=/home/node_modules/pg node /home/fix149.js <mode>`（Kudu 的 command API 不支援 `VAR=value cmd` 前綴，需用 `env`）。

### 兩環境狀態

| 環境 | 狀態 | 說明 |
|---|---|---|
| **Azure DEV** | ✅ 已更新（2026-07-31） | 單一交易寫入 2 筆，回查確認內容正確、`id`/`order`/`isRequired`/`description` 全保留、非 DHL mapping 零波及 |
| **本機** | ✅ 已更新（2026-07-31） | 同一支腳本執行 `write`，回查結果與 Azure **逐項一致**（含 `id`/`order` 結構），非 DHL mapping 零波及 |

> 兩者是各自獨立的資料庫，Azure 的寫入**不會**同步到本機（見 `docs/07-deployment/local-vs-azure-differences.md`），必須各自執行一次。

### ⚠️ 覆寫陷阱（實作時差點踩到）

`mappings` 陣列的每個項目除了 `targetField` / `sourceField` / `transformType` / `transformParams`，還帶 **`id`**（如 `eedf4065-i-1`，公司 ID 前 8 碼 + `i`/`e` + 序號）、**`order`**、**`isRequired`**、**`description`**。

腳本初版採整批替換，會把這四項連同 CHANGE-113 留在 `description` 裡的設計理由一起抹掉。**是在寫入前做快照時才發現的** —— 若照初版直接 `write`，資料已不可回復。改為在現況上做精確增修後才執行。

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|---|---|---|
| 1 | Inbound freight | `freight` 的 formula 為 `{express_worldwide_nondoc} + {fuel_surcharge}` | High |
| 2 | Inbound docs_fee | 新增 `docs_fee` ← `express_worldwide_doc`（DIRECT），且 key 為 `docs_fee` 非 `document_fee` | High |
| 3 | Inbound 移除 | `fuel_surcharge_at_origin` 那條不再存在 | High |
| 4 | Outbound freight | 新增 `freight` ← FORMULA `{express_worldwide_nondoc} + {fuel_surcharge}` | High |
| 5 | Outbound document_fee | 維持 `document_fee` ← `express_worldwide_doc`，key 為 `document_fee` | High |
| 6 | 目標欄位存在 | 所有 `targetField` 都能在對應模板的 `fields[].name` 中找到 | High |
| 7 | 端到端 | 重新處理 `DHL_RHIM250034_74315.pdf`，`freight` = 18,617.17、`fuel_surcharge_at_origin` 為空 | High |
| 8 | 零波及 | 其他公司（CEVA 等）的映射完全未變動 | High |

---

## 測試場景

| # | 場景 | 預期 |
|---|---|---|
| 1 | 只有 nondoc + fuel 的發票 | `freight` = nondoc + fuel；`docs_fee` 空 |
| 2 | 只有 doc + fuel 的發票 | `docs_fee` = doc；`freight` = fuel（已知限制，見設計決策 3） |
| 3 | 無 fuel surcharge 的發票 | `freight` = nondoc（formula 缺項以 0 計） |
| 4 | 其他公司的文件 | 映射與修復前完全相同 |

---

## 不在本 FIX 範圍（查證時發現，需另案決定）

| 項目 | 說明 |
|---|---|
| `EXPRESS 12:00 nondoc` 未被計入 | `DHL_RHIM250034_74315.pdf` 的 `express_worldwide_nondoc` = 14,042.15 = 7,445.85 + 482.30 + 6,114.00，**1,207.05 被漏掉** —— 欄位定義集只有 `express_worldwide_nondoc`，匹配不到 `EXPRESS 12:00 nondoc` |
| `ADDRESS CORRECTION` / `PREMIUM 12:00` 無對應欄位 | 同一份文件的 100 + 50 也沒有進入任何模板欄位 |

兩項都會造成金額短少，但屬**欄位定義集覆蓋不足**，與本 FIX 的映射錯配是不同問題。使用者 2026-07-31 已知悉，尚未決定是否處理。

---

## 相關

- CHANGE-101 —— 批量建 template field mapping；本 FIX 沿用其 gated 腳本模式與 `sourceField` 命名慣例
- FIX-143 —— 同為設定資料修正（非程式碼缺陷）
- CHANGE-113 —— DHL 一張發票多 shipment 的分組機制（`GROUP` 模式的由來）
