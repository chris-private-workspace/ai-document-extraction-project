# FIX-157: FORMULA 轉換在來源全為空時寫入 0 而非留空 —— 「沒有這筆費用」被顯示成「這筆費用是 0」

> **建立日期**: 2026-08-03
> **發現方式**: 使用者核對 template instance 結果時指出「有些欄位會變了做 0，正常應該都是顯示 -」
> **影響頁面/功能**: `template_instance_rows.fieldValues` → 模板實例畫面顯示、Excel 匯出、後續統計
> **優先級**: 中（**不影響金額正確性** —— 0 不改變合計，對帳仍然通過。影響的是語意與可讀性：使用者無法分辨「這張發票沒有這筆費用」與「這筆費用金額為零」）
> **狀態**: ✅ 已完成（2026-08-03，採「完全不寫入該 key」與 DIRECT 一致；本地 `type-check` / `lint` / `test` **467 通過**零失敗；**已於本機 production build 實機驗證通過**，見 §實機驗證）
> **相關**: [FIX-128](FIX-128-mapping-source-field-validation.md)（transform 診斷機制）、[CHANGE-101](../feature-changes/CHANGE-101-batch-template-field-mappings-from-excel.md)（FORMULA 型 mapping 的大量建立）

---

## 問題描述

模板實例的列中，有些費用欄位顯示 **0**，但該張發票根本沒有那筆費用。

以 `RIL_RCIM250313_22084`（空運發票）為例：

```json
{"cfs":0, "thc":0, "delivery":0, "gate_charge":0, "wh_container_facility_fee":0,
 "freight":1472.31, "docs_fee":148.46, "handling":538.88, ...}
```

`thc`（碼頭作業費）在**空運**發票上不可能存在，卻顯示 0，讀起來像「THC 收費零元」。`cfs`、`gate_charge` 同理。

### 受影響範圍（2026-08-03 抽樣四個 instance）

| instance | 值為 0 的欄位 |
|---|---|
| `NEX_RCIM250001_202` | `wh_container_facility_fee` |
| `NEX_RCEX240705` | `freight`、`others_local_charge`、`wh_container_facility_charge` |
| `RIL_RCIM250313` | `cfs`、`thc`、`delivery`、`gate_charge`、`wh_container_facility_fee` |
| `CEVA_RCIM250325` | `handling`、`docs_fee_at_origin`、`handling_at_origin` |

---

## 根本原因

`src/services/transform/formula.transform.ts` 的 `replaceVariables()`（第 347-364 行）：

```typescript
private replaceVariables(formula: string, row: Record<string, unknown>): string {
  return formula.replace(VARIABLE_PATTERN, (match, fieldName) => {
    const value = row[fieldName];

    if (value === undefined || value === null) {
      // 缺失值視為 0
      return '0';
    }
    ...
  });
}
```

每個 null 來源都被替換成字串 `'0'`。當公式引用的**所有**變數都是 null，表達式變成 `0 + 0 + 0`，`safeEval` 算出 `0`，於是寫入 0。

實例：`RIL` 的 `thc` 規則是

```
thc ← {sea_thc_hongkong_asia} + {thc} + {sea_thc}
```

三個來源在該空運發票上全部為 null → `0 + 0 + 0` → 寫入 `thc: 0`。

### 🔴 只有 FORMULA 有此問題，DIRECT 是正確的

同一批資料中，DIRECT 型規則在來源為 null 時**不會寫入該欄位**。`NEX_RCIM250020_8925` 的列即為證：

```json
{"docs_fee":680, "vgm_at_origin":936, "shipment_number":"RCIM250020",
 "handling_at_origin":540, "terminal_fees_at_origin":8700}
```

該公司的 mapping 另有 `freight ← nvo_freight`、`cfs ← cfs_charge`、`lss ← low_sulphur_surchg`、`psc ← port_security_charge`、`delivery ← o_local_truckage`、`car_park_fee ← o_gate_io_or_parking_chg`、`docs_fee_at_origin ← nehk_do_fee` 七條 DIRECT 規則，來源全部為 null —— **這些欄位完全沒有出現在列裡**，行為正確。

所以兩種轉換型別對「來源無值」的處理**不一致**：DIRECT 留空、FORMULA 填 0。

---

## 修復方案

### 建議做法

在 FORMULA 求值前先判定：若公式引用的變數**全部**為 null/undefined，直接回傳 null，不進入求值。只要**任一**變數有值，維持現行行為（其餘 null 當 0 參與計算）。

理由：
- 「沒有任何來源有值」與「合計為零」是不同語意，前者應為空
- 部分有值時把 null 當 0 是正確的（`{a}+{b}`，a=100、b=null，答案就是 100）
- 與 DIRECT 的行為對齊，兩種型別一致

### 影響評估

| 面向 | 影響 |
|---|---|
| 金額正確性 | **無** —— 0 與空值對合計的貢獻相同，對帳結果不變 |
| 既有資料 | **不回溯** —— 既有 `template_instance_rows` 不會自動更新，需重新匹配才反映 |
| 範圍 | 所有公司、所有模板的 FORMULA 型規則 |
| Excel 匯出 | 空白儲存格取代 0，符合使用者期待 |

### 已實作（2026-08-03）

**使用者拍板：完全不寫入該 key，與 DIRECT 一致。**

實作關鍵在於呼叫端既有的判斷 —— `template-matching-engine.service.ts:707-710`：

```typescript
// 只有當轉換結果不是 undefined 時才設定
if (transformedValue !== undefined) {
  result[mapping.targetField] = transformedValue;
}
```

判準是 **`undefined`**。DIRECT 之所以留空，是因為來源 key 不存在時 `sourceFields[...]` 為 `undefined`，原樣回傳後不寫入。因此本修復只需讓 FORMULA 在全缺值時同樣回傳 `undefined`，即可走同一條路徑 —— **不必改動呼叫端**。

`src/services/transform/formula.transform.ts` 的變更：

1. `execute()` 在替換變數前先呼叫新增的 `hasAnyReferencedValue()`，回傳 false 就直接回傳 `undefined`
2. 新增私有方法 `hasAnyReferencedValue(formula, row)`：逐一檢查公式引用的變數，任一具備可用數值即回傳 true；公式不含變數（純常數式）時回傳 true 以保留原行為

判定為「缺值」的情況：`undefined`、`null`、**空字串**、非數值字串。

> 空字串是實作過程中由測試抓出來的：`Number('') === 0`，若只用 `Number.isNaN` 判斷會把空字串當成有效的 0，導致全空的列仍寫入 0。

### 仍未確認

| # | 事項 |
|---|---|
| 1 | `LOOKUP` 型是否有同樣問題（本次未查） |
| 2 | 是否有任何下游邏輯依賴「FORMULA 一定回傳數字」的假設（既有測試全數通過，但非窮舉） |

---

## 驗收標準與結果

| # | 判準 | 結果 |
|---|---|---|
| 1 | 公式 `{a}+{b}+{c}` 在三者全缺值時不寫入 | ✅ 新增 `tests/unit/services/formula-transform-null-handling.test.ts`，9 項全過 |
| 2 | `{a}+{b}`，a=100、b=null → 100（原行為不變） | ✅ 已鎖定 |
| 3 | 變數合法為 0 時仍須計算（0 ≠ 缺值） | ✅ 已鎖定 |
| 4 | 與 DIRECT 行為一致 | ✅ 專門一項比對測試，兩者皆回傳 `undefined` |
| 5 | `npm run test` 零回歸 | ✅ **467 通過 / 2 skipped / 0 失敗** |
| 6 | 重新匹配 `RIL_RCIM250313_22084`，`thc`/`cfs`/`gate_charge`/`delivery`/`wh_container_facility_fee` 為空而非 0 | ✅ 五個欄位全部為空（見 §實機驗證） |
| 7 | 同列 `freight`/`docs_fee`/`handling`/`handling_at_origin` 數值不變、合計仍 5,090.17 | ✅ 三個數值皆未變、合計 5,090.17 = `total_amount` |

---

## 實機驗證（2026-08-03）

修的是 `src/services/transform/formula.transform.ts`，屬 server bundle —— **production 不熱重載**，必須重新 build 才會生效。流程：停 `AiDocProdServer` 排程任務 → 終止佔用 3200 的 node 程序 → `npm run build` → 重啟。

### 先確認 build 真的含新碼

不直接相信 `npm run build` 的 exit code。`.next/server/chunks/21551.js` 中 minified 後的樣子：

```javascript
async execute(a,b,c){if(!b?.formula)throw Error("FORMULA 轉換需要提供 formula 參數");
if(!this.hasAnyReferencedValue(b.formula,c.row))return;
let d=this.replaceVariables(b.formula,c.row);return this.safeEval(d)}
```

guard 完整保留、`return` 無值即 `undefined`，未被 webpack 改寫。

### 驗證結果

透過 `/api/v1/template-matching/execute` 重新匹配（新建 DRAFT instance，不動既有資料），逐欄追溯：

| 欄位 | 公式 | 重建前 | 重建後 |
|---|---|---:|---|
| `cfs` | `{air_cfs_charge_dest} + {sea_cfs}` | `0` | **（無）** |
| `thc` | `{sea_thc_hongkong_asia} + {thc} + {sea_thc}` | `0` | **（無）** |
| `delivery` | `{air_delivery_charge_dest} + {drayage} + {dryage_charge}` | `0` | **（無）** |
| `gate_charge` | `{air_gate_charge_dest} + {gate_charge}` | `0` | **（無）** |
| `wh_container_facility_fee` | `{sea_equipment_management_charge} + {status_charge}` | `0` | **（無）** |
| `freight` / `docs_fee` / `handling` | — | 1472.31 / 148.46 / 538.88 | **不變** |
| 列合計 | — | 5,090.17 | **5,090.17** = `total_amount` |

### 🔴 沒有誤傷 —— 部分有值的公式照常計算

比通過驗收更值得記錄的是這個對照：同一批匹配中的 `RIL_RCIM250015_14409`（海運發票）：

```
wh_container_facility_fee = 178.98
  ← [FORMULA] sea_equipment_management_charge=null + status_charge=178.98
```

同一條公式、其中一個來源為 null，**仍算出 178.98**。證明 guard 判的是「**全部**來源皆空」而非「有任一來源為空」，§驗收標準 第 2 項在真實資料上成立。該列合計 4,530.20 = `total_amount`。

> 驗證用的 instance：`cmscxbw060000ksxg5keksbfl`、`cmscxbw7l0003ksxg4ls4itfl`（DRAFT，可刪）。核對工具對三列的判定皆為「未發現徵狀」。

### ⚠️ 一個既有測試的斷言被更新

`tests/unit/services/template-matching-engine-diagnostics.test.ts` 原本明確鎖住舊行為：

```typescript
expect(values.delivery).toBe(0) // 三項全空 → 0（既有行為不變）
```

該測試屬 FIX-128，**保護的重點是 `unresolvedSourceKeys` 診斷記錄**（該斷言未動、仍通過），`values.delivery` 只是附帶描述當時的行為。本次依 FIX-157 的決定改為 `toBeUndefined()`，並加註說明。

值得一提的是，**同一個測試檔的下一項測試原本就斷言 DIRECT 為 `toBeUndefined()`** —— 兩者現在一致，正是本 FIX 的目的。

---

## 備註

- 本問題**不影響任何金額**，純粹是空值語意。優先級中而非高，是因為它會誤導人工核對 —— 看到 `thc: 0` 會以為系統抓到了一筆零元的 THC，實際上那張發票根本沒有 THC
- 發現途徑值得記錄：這是**使用者從畫面觀察**發現的，我的核對工具原本把「值為 0」當成正常而過濾掉了。工具看的是金額正確性，看不出語意問題
