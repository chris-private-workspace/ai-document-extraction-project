# FIX-128: Template mapping 公式引用不存在的 sourceField 時完全靜默，欄位永遠空白

> **建立日期**: 2026-07-22
> **發現方式**: 追查「delivery order charge / pick up charge cannot display」時發現公式 key 拼寫與實際欄位定義不符
> **影響頁面/功能**: Template Field Mapping 設定頁 → Template Instance 產出
> **優先級**: 中高（不會產生錯誤數字，但會讓設定者無從察覺自己打錯字）
> **狀態**: 📋 規劃中

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

- [ ] 對現有 30 組 mapping 執行一次全面掃描，產出「公式引用了不存在 key」的清單（此清單即 [FIX-130](FIX-130-existing-config-correction-checklist.md) 的修正依據）
- [ ] `RIL_RCIM250313_22084` 重跑 template instance 後，介面可看出 `delivery` / `pick_up_fee_at_origin` 空白是因為引用了未知 key
- [ ] 公式編輯器對未知 key 有可見提示
- [ ] 迴歸：合法公式（所有 key 都存在）不產生任何警示
- [ ] 涉及 UI 字串 → `messages/{en,zh-TW,zh-CN}` 三語言同步 + `npm run i18n:check` 通過
- [ ] `npm run type-check` / `npm run lint` 通過

---

## 相關文件

- [FIX-127](FIX-127-stage3-misattribution-and-dual-source.md) —— 本問題誘發的防禦性公式寫法正是重複計算的來源
- [FIX-130](FIX-130-existing-config-correction-checklist.md) —— 存量公式 key 修正
- [CHANGE-038] —— template field mapping 動態 source field
- [CHANGE-074] —— source field 動態載入與 scope UX
