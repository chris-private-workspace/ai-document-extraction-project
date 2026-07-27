# FIX-128: Template mapping 公式引用不存在的 sourceField 時完全靜默，欄位永遠空白

> **建立日期**: 2026-07-22
> **發現方式**: 追查「delivery order charge / pick up charge cannot display」時發現公式 key 拼寫與實際欄位定義不符
> **影響頁面/功能**: Template Field Mapping 設定頁 → Template Instance 產出
> **優先級**: 中高（不會產生錯誤數字，但會讓設定者無從察覺自己打錯字）
> **狀態**: ✅ 已完成（2026-07-22，B + C + A 降級警告；Azure 實機重跑驗證於下次部署批次執行）

---

## 問題描述

Template field mapping 的 FORMULA 規則以 `{key}` 語法引用來源欄位。當引用的 key **在該公司的 field definition 中根本不存在**時，系統既不在儲存時擋下，也不在執行時提示 —— 該項靜默視為空值，整條公式回傳 null，目標欄位永遠空白。

設定者看到的現象是「這個欄位就是出不來」，於是往公式裡**再加更多來源 key** 試圖補救。這正是 [FIX-127](FIX-127-stage3-misattribution-and-dual-source.md) 那些重複來源公式的由來 —— **兩個問題互為因果**。

---

## 重現步驟

1. 進入某公司的 Template Field Mapping 設定。
2. 新增一條 FORMULA 規則，公式寫 `{some_key_that_does_not_exist}`。
3. 儲存 —— **沒有任何警告**。
4. 對該公司的文件執行 template instance。
5. 該目標欄位空白，介面上沒有任何線索指出原因。

---

## 根本原因

公式執行時把未知 key 當空值處理，且沒有回報未解析的 key。設定端（`TemplateFieldMappingForm` / `MappingRuleEditor`）也沒有把公式中的 key 與該公司實際可用的 sourceField 清單做交叉檢查。

### 實測證據（Azure DEV，2026-07-22）

**（a）SBS INTERNATIONAL LOGISTICS — Inbound**

| 公式中引用的 key | 該公司實際的 field definition key | 差異 |
|---|---|---|
| `air_delivery_order_dest_charge` | `air_delivery_order_dest` | 多了 `_charge` |
| `air_delivery_order_charge` | `air_delivery_order_dest` | 完全不同 |
| `air_delivery_charge_dest_charge` | `air_delivery_charge_dest` | 多了 `_charge` |
| `air_pick_up_charge_original_charge` | `air_pick_up_charge_origin` | `original` vs `origin` |
| `air_cfs_charge_dest_charge` | `air_cfs_charge_dest` | 多了 `_charge` |
| `air_gate_charge_dest_charge` | `air_gate_charge_dest` | 多了 `_charge` |
| `air_airline_document_charge_dest_charge` | `air_airline_document_charge_dest` | 多了 `_charge` |
| `sea_document_b_l` | `sea_document_bl` | 多了底線 |

`delivery` 欄位的公式是 `{air_delivery_charge_dest_charge} + {drayage} + {dryage_charge}` —— **第一項拼錯、後兩項該公司也沒有** → 三項全空 → `delivery` 永遠空白。

`pick_up_fee_at_origin` 的公式是 `{air_pick_up_charge_original_charge} + {air_pick_up_charge}` —— 第一項拼錯；第二項 `air_pick_up_charge` 雖然定義中存在，但文件實際填入的是 `air_pick_up_charge_origin` → 同樣空白。

實測 `RIL_RCIM250313_22084.pdf` 的 template instance：14 個目標欄位中只有 7 個有值，`delivery`、`pick_up_fee_at_origin`、`docs_fee` 全部空白 —— 即使用者回報的「delivery order charge, pick up charge cannot display in the template」。

**（b）Toll Global Forwarder — Inbound / Outbound**

```
terminal_fees_at_origin ← terminal_handling_charges_origin   [DIRECT]
```

實際 key 是 `terminal_handling_charge_origin`（**單數**）。這條 DIRECT 規則永遠取不到值。

Outbound 的 `thc` 公式 `{terminal_handling_charge_origin} + {terminal_handling_charges_origin} + {terminal_handling_charge} + {terminal_handling_charge_destination}` 中，第 2 項（複數）與第 3 項在 TOLL 的定義中都不存在 —— 顯然是設定者不確定系統用哪個 key，於是把所有可能寫法都列上。

**這種「全都寫上去」的防禦性寫法正是 FIX-127 重複計算的溫床** —— 一旦其中兩個 key 同時有值就會翻倍。

---

## 解決方案

| 選項 | 方案 | 優點 | 代價 |
|------|------|------|------|
| **A** | **儲存時驗證**：mapping 建立/更新 API 解析公式中的所有 `{key}`，與該 scope 可用的 sourceField 清單比對，未知 key 回 RFC 7807 錯誤並列出 | 從源頭杜絕；錯誤最早被發現 | 可用 key 清單是動態的（field definition 可能後改），過嚴會擋住合法的「先寫公式後建欄位」流程 → 建議降為警告而非硬擋 |
| **B** | **執行時警示**：`template-matching-engine` 在解析公式時記錄未解析的 key，寫入 template instance 的診斷欄位並顯示於介面 | 反映真實執行結果，不受設定順序影響；能抓到「欄位後來被刪掉」的情況 | 要等執行後才知道；需要新增診斷資料的儲存與顯示 |
| **C** | **UI 即時提示**：公式編輯器加入 key 自動完成與紅字標示未知 key | 體驗最好，打字當下就知道 | 前端工作量最大；需要一支查詢可用 sourceField 的 API（`/api/v1/template-field-mappings/resolve` 或 `SourceFieldSelector` 現有機制或可複用） |
| **D** | 全部做 | 完整 | 工作量最大，且 A 與 C 有重疊 |

### 建議

**B + C，A 降為警告**：
- **B 優先**（執行時警示）—— 唯一能反映真實情況的方案，而且能同時服務既有的 30 組 mapping（不用重新編輯就能知道哪些 key 是死的）。
- **C 次之**（UI 提示）—— 防止未來再打錯。
- **A 不建議硬擋**：`SourceFieldSelector` 目前已能列出可用欄位，但公式是自由文字輸入；硬擋會讓「欄位定義尚未建立」的正常流程無法儲存。改為儲存時回傳警告訊息即可。

---

## 驗收標準

- [x] 對現有 mapping 執行一次全面掃描（實際 33 組，啟用 26），產出「公式引用了不存在 key」的清單（見下方實作記錄；此清單即 [FIX-130](FIX-130-existing-config-correction-checklist.md) 的修正依據）
- [ ] `RIL_RCIM250313_22084` 重跑 template instance 後，介面可看出 `delivery` / `pick_up_fee_at_origin` 空白是因為引用了未知 key（代碼已具備：診斷存入 row + RowDetailDrawer 顯示；**實機重跑待下次 Azure 部署批次**）
- [x] 公式編輯器對未知 key 有可見提示（FormulaEditor 琥珀色 badge + 警告文字）
- [x] 迴歸：合法公式（所有 key 都存在）不產生任何警示（單元測試覆蓋）
- [x] 涉及 UI 字串 → `messages/{en,zh-TW,zh-CN}` 三語言同步 + `npm run i18n:check` 通過
- [x] `npm run type-check` / `npm run lint` 通過（lint 無新增警告）

---

## 實作記錄（2026-07-22）

### 實作範圍（照規劃建議：B 優先 + C 次之 + A 降為警告）

| 方案 | 實作 |
|---|---|
| **B 執行時警示** | `template-matching-engine` 的 `transformFields` 在轉換時收集「引用了 row 中不存在的來源 key」（FORMULA 取公式變數、非 AGGREGATE 取 sourceField；AGGREGATE 讀 lineItems 故豁免），存入 `TemplateInstanceRow.transformDiagnostics`（新增 nullable Json 欄位），`RowDetailDrawer` 以琥珀色警告區塊顯示「哪個欄位引用了哪些未知 key」——欄位空白的原因首次可見。診斷反映最近一次處理（規則修好後重跑即清空）。`previewMatch` / `matchDocuments` 結果同步帶出 `unresolvedSourceKeys` |
| **C UI 即時提示** | `MappingRuleItem` 以既有 `useResolvedFields`（與 SourceFieldCombobox 共用 React Query 快取，無額外請求）+ 標準欄位組出已知清單，經 `TransformConfigEditor` 既有的 `availableFields` prop（原本無人傳入）餵給 `FormulaEditor`；未知變數 badge 轉琥珀色 + 警告文字，打字當下即可見 |
| **A 儲存時警告（不擋）** | `templateFieldMappingService.computeUnknownSourceKeyWarnings`（GLOBAL scope 不判定、解析失敗回空，best-effort 不影響儲存）；POST / PATCH 回應附 `warnings`，表單以 toast 顯示 |

**共用判定核心**：`src/lib/template-mapping-source-keys.ts`（三個使用端共用同一套規則）。`li_*` / `_ref_*` 動態合成欄位一律豁免（依文件內容產生，缺席不代表拼錯）。

### 修改檔案

| 檔案 | 變更 |
|---|---|
| `src/lib/template-mapping-source-keys.ts` | 新建：`extractFormulaKeys` / `collectRuleSourceKeys` / `findUnknownRuleSourceKeys` / `isSyntheticSourceKey` |
| `prisma/schema.prisma` + migration `20260722020000` | `TemplateInstanceRow.transformDiagnostics Json?`（純加 nullable） |
| `prisma/apply-schema-drift.js` | 加 FIX-128 冪等條目（Azure 部署需帶 `RUN_SCHEMA_DRIFT_FIX=true`） |
| `src/services/template-matching-engine.service.ts` | `transformFields` 收集診斷；`upsertRow` 存 `transformDiagnostics` |
| `src/services/template-instance.service.ts` | `mapRowToDto` 帶出診斷 |
| `src/services/template-field-mapping.service.ts` | 新增 `computeUnknownSourceKeyWarnings` |
| `src/app/api/v1/template-field-mappings/route.ts` + `[id]/route.ts` | 回應附 `warnings` |
| `src/types/{template-matching-engine,template-instance,template-field-mapping}.ts` | 型別擴充 |
| `src/hooks/use-template-field-mappings.ts` | create/update 回傳 `{ mapping, warnings }` |
| `src/components/.../MappingRuleItem.tsx` / `FormulaEditor.tsx` / `TemplateFieldMappingForm.tsx` / `RowDetailDrawer.tsx` | UI 提示三處 |
| `messages/{en,zh-TW,zh-CN}/{templateFieldMapping,templateInstance}.json` | i18n 三語言 |
| `tests/unit/lib/template-mapping-source-keys.test.ts` + `tests/unit/services/template-matching-engine-diagnostics.test.ts` | 新建 14 項測試 |
| `scripts/local-verify-fix128-dead-keys.ts` | 死 key 掃描分析工具（讀 Kudu 唯讀查詢輸出，不連 DB） |

### 全面掃描結果（Azure DEV，2026-07-22 唯讀查詢）

**33 組 mapping（啟用 26）中 10 組含死 key、29 條規則受影響**——遠超規劃時已知的 SBS/Toll。GLOBAL scope 2 組不判定。

| Mapping（皆 active） | 死 key 規則 | 死 key |
|---|---:|---|
| CEVA - inport to logistics (Full List) | 1/7 | `freight` ← `freight_charges` |
| DSV Air & Sea - Outbound (Full List) | 1/6 | `document_fee` ← `b_l_bill_of_lading` |
| Nippon Express Logistics - Inbound (Full List) | 1/13 | `car_park_fee` ← `o_gate_i_o_or_parking_chg` |
| Nippon Express (HK) - Inbound (Full List) | 1/6 | `terminal_fees_at_origin` ← `terminal_handling_charge` |
| Redlines - Outbound (Full List) | 1/5 | `document_fee` ← `b_l_charges` |
| SBS INTERNATIONAL - Inbound (Full List) | 7/17 | `air_alfa_charge_dest_charge`、`air_import_service_fee_dest_charge`、`ocean_freight_non_nvocc`、`air_cfs_charge_dest_charge`、`air_airline_document_charge_dest_charge`、`sea_document_b_l`、`air_delivery_order_dest_charge`、`d_o_fee`、`air_delivery_order_charge`、`air_pick_up_charge_original_charge`、`air_delivery_charge_dest_charge`、`air_gate_charge_dest_charge` |
| SBS INTERNATIONAL - Outbound (Full List) | 1/11 | `air_alfa_charge_dest_charge`、`air_import_service_fee_dest_charge` |
| SBS - Inbound (Full List) | 11/19 | 上列 SBS 死 key + `air_terminal_charge_dest_charge`、`air_pick_up_charge_origin_charge`、`air_local_charge_in_usa_origin_charge`、`drayage`、`pick_up_d_o_charge` |
| Toll - Inbound (Full List) | 2/15 | `terminal_handling_charges_origin`（複數）、`terminal_handling_charges_destination`（複數） |
| Toll - Outbound (Full List) | 3/14 | `handling_fee_incl_p_u`、`terminal_handling_charges_origin`、`terminal_handling_charge`、`handling_fee_origin_incl_p_u`、`origin_chage_incl_pick_up`（注意 `chage` 拼字） |

> 重跑方式：Kudu 唯讀 `node /home/q6.js`（腳本保留於容器 /home）取資料 → `npx tsx scripts/local-verify-fix128-dead-keys.ts <輸出檔>`。

### 部署注意

1. **Schema 變更**：Azure 部署需帶 `RUN_SCHEMA_DRIFT_FIX=true` 套用 `transform_diagnostics` 欄位（entrypoint 不跑 migrate deploy）。
2. 舊 row 的診斷為 null（無警告顯示），重跑 instance 後填入 —— 無需 backfill。

---

## 相關文件

- [FIX-127](FIX-127-stage3-misattribution-and-dual-source.md) —— 本問題誘發的防禦性公式寫法正是重複計算的來源
- [FIX-130](FIX-130-existing-config-correction-checklist.md) —— 存量公式 key 修正
- [CHANGE-038] —— template field mapping 動態 source field
- [CHANGE-074] —— source field 動態載入與 scope UX
