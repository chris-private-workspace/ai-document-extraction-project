# FIX-161: mapping 引用了該公司欄位定義集沒有的 key —— 9 條規則永遠取不到值

> **建立日期**: 2026-08-04
> **發現方式**: 375 份樣本全覆蓋驗證，12 個 template instance 逐列追溯（[TEST-REPORT-006](../../5-status/testing/reports/TEST-REPORT-006-full-sample-coverage-verification.md)）
> **影響範圍**: `template_field_mappings` 的 `sourceField` → 模板實例列值
> **優先級**: 高（CEVA export 有 4 條規則在 **31/31 列**全部落空）
> **狀態**: 🚧 部分完成（2026-08-04，**2 項已修並驗證通過**，見 §已修正；原列的 9 項經逐條追查後為 **4 項誤報 + 5 項真缺陷**，其餘 3 項屬欄位定義缺失，待決策）
> **Azure DEV**: ✅ 2026-08-06 已同步並完成驗收 —— 規則修正正確，但該環境 48 份樣本**皆無**這兩項費用，故無可見效果、對帳金額不變（見 §Azure DEV 同步狀態）
> **相關**: [FIX-158](FIX-158-mapping-field-definition-misalignment.md)（同型，已修 RIL 與 CEVA 各一例）、[FIX-160](FIX-160-template-mapping-unreferenced-extracted-charges.md)（反方向：提取到卻無規則引用）

---

## 問題描述

`template_field_mappings` 的規則引用了某個 `sourceField`，但該 key **不在該公司自己的 `field_definition_sets` 裡**。Stage 3 不會產出這個 key，規則因此永遠取不到值，對應的 `targetField` 恆為空。

這是 [FIX-158](FIX-158-mapping-field-definition-misalignment.md) 問題二的同型復發 —— 該 FIX 修的是 CEVA 的四個欄位，本次在更大樣本上驗出另外 9 項。

---

## 判準：必須用「該公司自己的」定義集

這一點決定結論對錯。若用全部 23 組定義集的**聯集**比對，30 個落空的 key 只有 1 個判為缺陷（`documentation_fee_destination`，任何定義集都沒有）；改用逐公司比對後，真缺陷是 **9 項** —— 另外 8 個 key 存在於別家公司，但不在引用它的那家。

---

## 🔴 逐條追查後：9 項中有 4 項是誤報

診斷工具對 **FORMULA** 的**每一個** key 都會報一次「來源不存在」。但只要公式中另有一個 key 有值，`targetField` 就拿得到值 —— 那不是缺陷。真缺陷只有「公式中所有 key 都取不到值」或「DIRECT 的唯一 key 取不到值」。

判準改為看 **`targetField` 在實例中有幾列拿到非零值**：

| # | 公司 / 方向 | 規則 | 該欄位實際有值 | 判定 |
|---|---|---|---:|---|
| 1 | CEVA / export | `document_fee` ← `{origin_document_processing_fee} + {delivery_order_fee} + {awb_fee}` | **22/31** | ⚠️ 誤報 —— `origin_document_processing_fee` 有值 |
| 6 | Nippon (HK) / export | `thc` ← `{thc}+{t_h_c}` | **3/3** | ⚠️ 誤報 —— `thc` 有值 |
| 7 | Nippon (HK) / export | `handling_charge` ← `{vat_7}+{handling_charge}` | **3/3** | ⚠️ 誤報 —— `handling_charge` 有值 |
| 9 | Toll / import | `docs_fee` ← `{document_fee_destination} + {delivery_order_fee_destination} + {documentation_fee_destination}` | **17/26** | ⚠️ 誤報 —— `delivery_order_fee_destination` 有值 |
| 4 | CEVA / export | `cfs_charge` ← `cfs` `[DIRECT]` | 0/31 | 🔴 真缺陷 → **已修** |
| 5 | CEVA / export | `gate_charge` ← `gate_charge` `[DIRECT]` | 0/31 | 🔴 真缺陷 → **已修** |
| 2 | CEVA / export | `delivery` ← `pick_up_at_origin` `[DIRECT]` | 0/31 | 🔴 真缺陷 —— 欄位定義缺失 |
| 3 | CEVA / export | `x_ray_fee` ← `x_ray` `[DIRECT]` | 0/31 | 🔴 真缺陷 —— 欄位定義缺失 |
| 8 | Nippon (HK) / export | `telex_release` ← `surrender_bl` `[DIRECT]` | 0/3 | 🔴 真缺陷 —— 樣本僅 3 份，待確認 |

> ⚠️ 第 7 項雖為誤報，但公式 `{vat_7}+{handling_charge}` 把**稅額加進 handling charge** 在語意上可疑。本批 `vat_7` 無值所以未發作，屬潛在問題，需業務確認後另案處理。

---

## 已修正（2026-08-04）

### 根因：sourceField 誤填為 targetField 的名字

CEVA 的 **Inbound** mapping（`cmrwu7bqb001101miqgc5e989`）早就是正確寫法：

```
gate_charge ← destination_gate_fee
cfs         ← destination_cfs_charges
```

而 **Outbound**（`cmrin1af9000101r6gsv3674m`）寫成：

```
cfs_charge  ← cfs            ← 這是 Inbound 的 targetField 名，不是提取 key
gate_charge ← gate_charge    ← 同上
```

CEVA 的欄位定義集（`f13aaf3b-ec74-4750-8036-a27dbb554792`，21 個 key）沒有 `cfs` 也沒有 `gate_charge`，Stage 3 不可能產出，兩條規則因此全數落空。**同公司 Inbound 就是正解**，不是憑名稱猜測。

### 變更範圍（🔴 精確指名）

| 項目 | 值 |
|---|---|
| 資料表 | `template_field_mappings` |
| 記錄 | `cmrin1af9000101r6gsv3674m`（CEVA - export to logistics template mapping (Full List)） |
| 規則 | `mappings` 中 id = `ygE34j36XKWZlFKAairrD`（`cfs_charge`）與 `-KB5_t9yRdWmvr6jBP_fR`（`gate_charge`） |
| 變更 | `sourceField`: `cfs` → `destination_cfs_charges`、`gate_charge` → `destination_gate_fee` |
| 不動 | 同公司 Inbound mapping `cmrwu7bqb001101miqgc5e989`（本來就正確） |
| 不動 | `field_definition_sets` 的任何欄位 |
| 不動 | 其餘 7 條規則 |

腳本：`scripts/fix-161-ceva-export-source-field.js`（三段式 `inspect` / `dryrun` / `write`，具備前置快照、單一交易、數量閘、樂觀鎖、冪等）

### 驗證結果

| 檢查 | 結果 |
|---|---|
| 重建 instance 後欄位值 | `cfs_charge = 200`、`gate_charge = 80`，皆由新 sourceField 取得 |
| [D] 來源不存在 | 155 次 / 5 種 → **93 次 / 3 種** |
| [B] 金額遺失 | 6 項 → **4 項**（兩個 key 不再是孤兒） |
| `check-orphan-charge-keys` | CEVA 漏接 6,390.55 → **6,110.55**（減少 280 = 200 + 80） |
| `snapshot-template-values` diff | **變空 0、值改變 0、變有值 2**，exit 0 —— 沒有打破既有欄位落點 |

同時解掉 [FIX-160](FIX-160-template-mapping-unreferenced-extracted-charges.md) 清單中的兩項（`destination_cfs_charges` 200、`destination_gate_fee` 80）—— [D] 與 [B] 在這裡是同一枚硬幣的兩面。

---

## 待處理的 3 項（欄位定義缺失，未動）

| # | 規則 | 現況 |
|---|---|---|
| 2 | CEVA `delivery` ← `pick_up_at_origin` | CEVA 定義集沒有此欄位。行項描述中確實出現過 `PICK UP AT ORIGIN - MINIMUM HKD 480.00` |
| 3 | CEVA `x_ray_fee` ← `x_ray` | 同上，行項描述有 `X-RAY - 123.5KG @ HKD 0.78/KG` |
| 8 | Nippon (HK) `telex_release` ← `surrender_bl` | 該公司 export 樣本僅 3 份，無法分辨是定義缺失還是母體未覆蓋 |

這三項要修必須**新增欄位定義**（`field_definition_sets`），而 aliases 會進 Stage 3 prompt，直接影響模型的提取行為 —— 風險高於改 `sourceField`，需另行評估。

🔴 第 8 項尤其不可貿然處理：3 份樣本不足以判定。依 §樣本 ≠ 母體 紀律，需要更多 Nippon (HK) 的 export 發票才能確認該公司是否真的會收 Surrender B/L 費用。

---

## Azure DEV 同步狀態（2026-08-06 更新）

原記「尚未同步」。2026-08-06 已完成移植與驗收 —— **修復正確，但在 Azure 現有資料上不產生可見效果**。

| 步驟 | 本機 | Azure DEV |
|---|---|---|
| mapping `sourceField` 變更 | ✅ 2026-08-04 | ✅ 2026-08-06 |
| 重新匹配模板實例 | ✅ | ✅ 2026-08-06（建新實例，見下） |
| 目標欄位取到值 | ✅ `cfs_charge=200`、`gate_charge=80` | ❌ **48/48 列皆取不到** |
| 對帳驗收 | ✅ 降 280 | ➖ 不會下降（原因見下） |

移植方式：`prisma/fix-161-ceva-export-20260806.js`（三段式 gated，由 `RUN_FIX161_CEVA_20260806` 觸發，見 [runbook §21](../../../docs/07-deployment/02-azure-deployment/dev-deployment-runbook.md)）。腳本 write 前會**逐項驗證 Azure 自己的欄位定義集**，不符即中止 —— 不照抄本機。

| 項目 | 值 |
|---|---|
| 映像 | `dev-fix161-20260806`（ACR run `ck1y`，Succeeded） |
| 記錄 | `cmrin1af9000101r6gsv3674m`（與本機同 id，因 Azure 資料源自本機匯入） |
| 樂觀鎖 | `updated_at = 2026-07-25T10:32:56.093Z`（通過） |
| 更新筆數 | 1（數量閘通過），單一交易 COMMIT |
| 事後對帳 | 九條規則重新讀取，僅該 2 條變動，殘餘待修 0 |
| 前置快照 | `fix161-before.json`（存於本機，🔴 Azure `/home` 不持久，log 會過期） |

### 重新匹配為什麼要建新實例（而非重跑舊的）

受影響的是 5 個實例、48 列（`dataTemplateId=cmrbhjbl4033101o3n77yg0sh`）。**它們一列都改不了**：

```
DELETE 列 → 409  「實例狀態為 COMPLETED，不可刪除行」
POST execute → 400  INVALID_INSTANCE_STATUS
```

`template-instance.ts:358-364` 的白名單只放行 `DRAFT`（可刪）與 `DRAFT`/`ERROR`（可寫），而
`STATUS_TRANSITIONS`（同檔 :346-352）中 `COMPLETED → ['EXPORTED']` —— **沒有回頭路**，
`changeStatus` 嚴格檢查（`template-instance.service.ts:1063-1069`），所以「退回 DRAFT 再改」也走不通。

這不是缺陷：實例是**一次性快照 / 交付物**（終點 `EXPORTED` 會輸出 Excel），設計上要重跑就建新的。
對帳腳本的 `DISTINCT ON (doc.id, ti.data_template_id) ORDER BY tir.created_at DESC` 正是配合這個模式——
**新快照自動取代舊快照參與計算，不會重複計**。前提是新實例必須用**同一個** `dataTemplate`。

實際做法：建新實例 `cmshcs6ce000v01o4trvbsu3m`（DRAFT，同模板）→ execute 48 份文件
（`options.companyId=0d02b680-165b-4cfd-8c1b-7ebfa6da8424`）→ 48 列全 VALID、零錯誤。舊 5 個實例未動。

> ✅ 該驗證實例已於驗收後刪除（DRAFT 可刪，回 200；覆查回 404）。留著會讓它的 48 列因
> `created_at` 較新而**永久取代**舊列參與對帳，故不保留。
> 刪除後覆查舊 5 個實例：狀態皆 `COMPLETED`、列數 20+2+7+9+10 = **48**，與 before 快照一致。
> Azure DEV 除 mapping 修復外回到原狀。

### 🔴 驗收結果：規則修對了，但這批資料沒有這兩項費用

新列的 `transformDiagnostics`（系統自留診斷，記錄取不到值的 sourceField）：

| 次數 | 診斷 | 意義 |
|---:|---|---|
| **48/48** | `cfs_charge ← destination_cfs_charges` | 提取結果沒有這個 key 的值 |
| **48/48** | `gate_charge ← destination_gate_fee` | 同上 |

即：**這 48 份 CEVA export 發票本來就沒有 CFS 與 Gate 這兩項費用**，屬本文件 §對照 所述的
「母體未覆蓋」，不是映射缺陷。本機之所以能驗出 200 / 80，是因為那批樣本中**有一份**收了這兩項費用。

因此 CEVA 漏接金額（189,073.28）**不會**因本次修復下降。修復本身仍然正確——
對未來確實收取這兩項費用的 CEVA export 發票會生效。

🔴 **推論**：CEVA 那 189,073.28 的漏接**另有原因**。48 列中實際取到值的只有 5 個欄位
（`shipment_number` 48、`document_fee` 42、`thc` 26、`seal_fee` 23、`vgm` 13），而模板有 36 個
number 欄位。缺口在別處，需另案追查。

### 順帶驗證的兩項原有判斷

| 診斷 | 佐證了什麼 |
|---|---|
| `document_fee ← awb_fee` 48/48 取不到，但 42/48 列 `document_fee` **有值** | §逐條追查 第 1 項判為**誤報**是對的——FORMULA 只要另有 key 有值即可 |
| `delivery ← pick_up_at_origin`、`x_ray_fee ← x_ray` 各 48/48 取不到 | §待處理的 3 項 中的第 2、3 項，Azure 同樣未修，符合預期 |

### 兩家 CEVA 必須分辨（已於 Azure 實測驗證）

Azure 上有**兩筆** CEVA 公司記錄，同一個 Outbound(Full List) 模板下**各有一條 mapping**，
只動第一筆：

| 公司 | 定義集 | `cfs` / `gate_charge` | mapping | 處置 |
|---|---|---|---|---|
| `0d02b680-…`（…LTD） | `f13aaf3b-…`（21 key） | ❌ 無 / ❌ 無 | `cmrin1af9…` | ✅ 本次變更對象 |
| `7448b7c5-…`（…Limited） | `90e7e76e-…`（26 key） | ✅ 有 / ✅ 有 | `cmrcxw6ul…` | 🔴 **不動** |

兩條 mapping 的九條規則**只差 `cfs_charge` 與 `gate_charge` 兩行**。第二家寫 `← cfs` 是**有效的**
（它的定義集有這個 key），第一家寫 `← cfs` 必然落空——這正是 FIX-161 的根因。
判準是各公司**自己的**定義集，不是規則長相。

---

## 對照：另有 21 種「來源不存在」不是缺陷

除上述 9 項外，還有 21 個 key 也被報「來源不存在」，但它們**在該公司自己的定義集裡**，代表這批發票剛好沒有這筆費用 —— 屬母體未覆蓋。多集中在 Toll Global Forwarder / export（`airway_bill_fee_origin`、`vgm_fee_origin`、`telex_fees_origin` 等，各 1/14 列）。

🔴 依 §樣本 ≠ 母體 紀律，**不可**因為這批樣本沒出現就提議刪除這些定義。

---

## 這次學到的判準

| 判準 | 說明 |
|---|---|
| **看 targetField 有沒有值，不是看 sourceField 落不落空** | FORMULA 有多個 key，落空一個不代表欄位失效。9 項中 4 項因此是誤報 |
| **先找同公司的另一個模板當對照** | CEVA Inbound 的寫法直接給出正解，不必憑名稱猜。若無對照組才需推論 |
| **改 sourceField 前先確認目標 key 無人引用** | 若已被別的規則引用，改指過去會造成重複計費（[FIX-162](FIX-162-row-total-exceeds-invoice-amount.md) 的形態） |

---

## 驗證方式（供後續 3 項沿用）

1. 重建 instance，確認目標 `targetField` 實際取到值（**不是只看 [D] 徵狀消失**）
2. `check-orphan-charge-keys.js --baseline=...` 確認漏接金額下降且降幅等於預期
3. `snapshot-template-values.js diff` 確認「變空 0」—— 這是「修 A 打破 B」的偵測訊號

---

**建立者**: AI 助手
**最後更新**: 2026-08-04
