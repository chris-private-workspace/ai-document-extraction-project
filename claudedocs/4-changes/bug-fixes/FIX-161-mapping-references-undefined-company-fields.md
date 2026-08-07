# FIX-161: mapping 引用了該公司欄位定義集沒有的 key —— 9 條規則永遠取不到值

> **建立日期**: 2026-08-04
> **發現方式**: 375 份樣本全覆蓋驗證，12 個 template instance 逐列追溯（[TEST-REPORT-006](../../5-status/testing/reports/TEST-REPORT-006-full-sample-coverage-verification.md)）
> **影響範圍**: `template_field_mappings` 的 `sourceField` → 模板實例列值
> **優先級**: 高（CEVA export 有 4 條規則在 **31/31 列**全部落空）
> **狀態**: 🚧 部分完成（2026-08-04，**2 項已修並驗證通過**，見 §已修正；原列的 9 項經逐條追查後為 **4 項誤報 + 5 項真缺陷**，其餘 3 項屬欄位定義缺失，待決策）
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

原記「尚未同步」。2026-08-06 已移植 mapping 變更，但**尚未完成驗收** —— 兩者不可混為一談。

| 步驟 | 本機 | Azure DEV |
|---|---|---|
| mapping `sourceField` 變更 | ✅ 2026-08-04 | ✅ 2026-08-06 |
| 重新匹配模板實例 | ✅ | ❌ **未做** |
| 對帳驗收（漏接金額下降） | ✅ 降 280 | ❌ 未做 |

移植方式：`prisma/fix-161-ceva-export-20260806.js`（三段式 gated，由 `RUN_FIX161_CEVA_20260806` 觸發，見 [runbook §21](../../../docs/07-deployment/02-azure-deployment/dev-deployment-runbook.md)）。腳本 write 前會**逐項驗證 Azure 自己的欄位定義集**，不符即中止 —— 不照抄本機。

| 項目 | 值 |
|---|---|
| 映像 | `dev-fix161-20260806`（ACR run `ck1y`，Succeeded） |
| 記錄 | `cmrin1af9000101r6gsv3674m`（與本機同 id，因 Azure 資料源自本機匯入） |
| 樂觀鎖 | `updated_at = 2026-07-25T10:32:56.093Z`（通過） |
| 更新筆數 | 1（數量閘通過），單一交易 COMMIT |
| 事後對帳 | 九條規則重新讀取，僅該 2 條變動，殘餘待修 0 |
| 前置快照 | `fix161-before.json`（存於本機，🔴 Azure `/home` 不持久，log 會過期） |

### 🔴 剩餘兩步（未做，驗收不算完成）

1. **重新匹配 CEVA 的模板實例** —— 改設定不回溯，Azure 那批 `cfs_charge` / `gate_charge` 目前仍為空
2. **前後對帳** —— `RUN_ORPHAN_CHECK=inspect` + `RECONCILE_BASELINE`（Azure baseline：全庫 607 份、漏 586,302.84、多算 8,014.58，其中 CEVA 漏 189,073.28）

判準是 CEVA 漏接金額**下降**。降幅**不會是 280** —— 那是本機 31 列的數字，Azure 份數不同。若金額**上升**，代表 `destination_cfs_charges` / `destination_gate_fee` 在 Azure 原本已被別的規則引用、被這次改動搶走去處（§樣本 ≠ 母體 的同型風險），須依 `fix161-before.json` 回滾。

### 兩家 CEVA 必須分辨

Azure 上有**兩筆** CEVA 公司記錄，只動第一筆：

| 公司 | 處置 |
|---|---|
| `CEVA LOGISTICS (HONG KONG) LTD`（21 key，無 `cfs`/`gate_charge`） | ✅ 本次變更對象 |
| `CEVA LOGISTICS (HONG KONG) LIMITED（CEVA Logistics）`（含 `cfs`/`gate_charge`） | 🔴 **不動** —— 其 `sourceField` 本來就有效 |

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
