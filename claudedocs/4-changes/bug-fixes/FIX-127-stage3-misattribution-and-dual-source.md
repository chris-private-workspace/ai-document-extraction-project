# FIX-127: GPT 誤填欄位未被清除，同一筆費用同時存在兩個 key 導致 template 重複計算

> **建立日期**: 2026-07-22
> **發現方式**: 使用者 Azure DEV 測試回報（THC / Docs fee 重複計算）+ 真實資料查證
> **影響頁面/功能**: V3.1 Stage 3 費用回填 → Template Instance 金額正確性
> **優先級**: 🔴 最高（產生**錯誤的金額**，比欄位空白更危險）
> **狀態**: 📋 規劃中

---

## 問題描述

同一筆費用會**同時**寫進兩個不同的 field key：

1. **GPT** 在 Stage 3 自行判斷填入某個欄位（可能是錯的欄位）
2. **確定性回填**（`backfillLineItemCharges`）依名稱比對填入另一個欄位（通常是對的）

回填的「清除誤填」機制條件過嚴，證明不了 GPT 那筆是誤填，於是**兩個欄位都保留**。到了 template field mapping 層，使用者為了容錯而寫的加總公式把兩者相加 —— **同一筆錢被算了兩次**。

使用者回報的「THC recorded twice」「double entry in Docs fee」「THC double counted」全部是這個機制。

---

## 重現步驟

1. 某公司的 field definition 同時有兩個語意相近的欄位（如 `thc` 與 `sea_thc`，或 `document_fee_destination` 與 `delivery_order_fee_destination`）。
2. 上傳一份發票，其中一筆費用的名稱只能被其中一個欄位確定性命中。
3. GPT 把該筆金額填進 A 欄；回填把同一筆金額填進 B 欄。
4. template mapping 的公式同時引用 A 與 B（例如 `{thc}+{sea_thc}`）。
5. 觀察 template instance：該欄位金額為實際值的 **2 倍**。

---

## 根本原因

### 清除機制的三道門檻（`stage-3-extraction.service.ts:1559-1577`）

```ts
for (const def of chargeDefs) {
  if (claimed.has(def.key)) continue;              // ① 有 lineItem 認領 → 不動
  if (!this.hasFieldValue(fields[def.key])) continue; // ② 本來就空 → 不動

  const hits = classifiedHits.get(def.key);
  if (!hits?.length) continue;                     // ③ 無 classifiedAs 命中 → 保留
  if (!hits.every((index) => claimedItems.has(index))) continue; // ④ 命中行未全被認領 → 保留

  fields[def.key] = { value: null, confidence: 0, source: 'lineItem-backfill-cleared' };
}
```

門檻 ③ 的註解寫著「值可能來自 lineItems 以外（如 summary 區）→ 保留」。這個保守設計在**GPT 填的是合理值**時是對的，但當 **GPT 把 A 費用的金額填進 B 欄位**時，B 欄位往往沒有任何 lineItem 的 `classifiedAs` 命中它（因為根本沒有 B 這種費用），於是**直接被門檻 ③ 放行保留**。

換言之：**GPT 錯得越離譜（填了一個文件上根本不存在的費用欄位），越不會被清除。**

### 實測證據（Azure DEV，2026-07-21）

**（a）`RIL_RCIM250015_14409.pdf` —— THC 翻倍**

| 層級 | 內容 |
|---|---|
| 文件明細 | `(SEA) THC (DEST)` **一筆**，325.42 |
| `stage_3_result.fields` | `thc = 325.42`（無 backfill 標記 = GPT 填）**且** `sea_thc = 325.42`（`source=lineItem-backfill`） |
| mapping 公式 | `thc ← {sea_thc_hongkong_asia}+{thc}+{sea_thc}` |
| template instance | **650.84** |

instance 歷史完整記錄了問題的產生：

```
RIL - import to inbound 1.0 (7/20)  → thc = 325.42   ✓
RIL - import to inbound 1.1 (7/20)  → thc = 650.84   ← 公式加入第二個來源後翻倍
RIL - import to inbound 1.2 (7/20)  → thc = 650.84
```

**（b）`TOLL_RCIM240349_58326.PDF` —— Docs fee 憑空翻倍**

文件明細**沒有**任何 document fee，只有 `Delivery Order Fee - Destination` = 50.82。但：

```
document_fee_destination     = 50.82            ← GPT 誤填（無 backfill 標記）
delivery_order_fee_destination = 50.82 (backfill) ← 正確
```

TOLL Inbound 公式：`docs_fee ← {document_fee_destination} + {delivery_order_fee_destination}` → **101.64**。

同樣模式在 `TOLL_RCIM240356_58536`、`TOLL_RCIM240369_58323`、`TOLL_RCIM250334_77227` **四份文件全部重現**。

**（c）`TOLL_RCIM250334_77227.PDF` —— THC 金額跨欄位重複**

文件明細 `Terminal Handling Charges - Destination` = 138.62（無 Handling Fee - Destination 這筆）：

```
terminal_handling_charge_destination = 138.62   ← 對的欄位
handling_fee_destination             = 138.62   ← GPT 把同一筆錢也填進來
```

兩個欄位分別被 `thc` 與 `handling` 兩條 mapping 取用 → THC 與 Handling 各算一次。

### 與 FIX-126 的關係

FIX-126（名稱比對失敗）是**上游成因**：比對失敗 → 回填不認領 → GPT 的值沒有被覆蓋（`:1550-1557` 的覆蓋只作用於「被認領」的 key）→ 落入清除機制 → 被門檻 ③ 放行。

但**即使 FIX-126 完全修好，本問題仍會存在** —— 因為 GPT 可能填的是一個「文件上沒有、也永遠不會被任何 lineItem 認領」的欄位。兩者需分別處理。

---

## 解決方案

| 選項 | 方案 | 優點 | 代價 |
|------|------|------|------|
| **A** | **金額指紋去重**：回填完成後，掃描所有 `fieldType === 'lineItem'` 欄位，若某欄位的值等於某個「已被別的 key 認領的 lineItem 金額」且該欄位自身無 lineItem 認領 → 清除 | 直擊病灶（同一筆錢兩個 key）；不需依賴名稱比對 | 金額巧合相同的不同費用會被誤清（如兩筆都是 100.00）；需加「同一份文件內」與「無自身認領」雙重限制降低誤傷 |
| **B** | **放寬清除門檻 ③**：改為「只要該 key 沒有任何 lineItem 認領，且該值可在 lineItems 中找到對應金額 → 清除」 | 改動最小，就在現有迴圈內 | 與 A 實質相同但更寬；對「值真的來自 summary 區」的情境會誤清 |
| **C** | **禁止 GPT 填 lineItem 類欄位**：Stage 3 prompt 明確要求費用只放 `lineItems`，`fields` 中的費用欄位一律由回填決定 | 根本解決雙來源；來源單一化後公式不可能重複 | 回填命中率不足時（FIX-126 未修好前）會造成大量空白；需與 FIX-126 綁定發布 |
| **D** | **標記來源並在 template 層去重**：`extractMappedFields` 對同一 lineItem 來源的多個 key 只取一個 | 不動 Stage 3，風險隔離在 template 層 | 需要 Stage 3 傳遞來源對應關係（目前沒有）；`li_*` 展平也要一併處理 |

### 建議

**A 為主、C 為輔**：
- A 可獨立上線，立即止血（使用者現在看到的是**錯誤金額**，優先級高於空白）。
- C 是治本，但必須等 FIX-126 提高回填命中率後才安全，否則會把「金額錯」換成「大量空白」。
- 不建議 B（與 A 重疊但更寬）。不建議 D（需要新的資料結構，且 `li_*` 展平那條路徑也得改，blast radius 大於 A）。

### ⚠️ 與存量公式的關係

即使代碼修好，**現有 mapping 公式裡的重複來源項仍會留著**。若日後 GPT 又填了那個 key，翻倍會再次發生。公式去重屬 [FIX-130](FIX-130-existing-config-correction-checklist.md) 範圍，兩者需**一併完成**才算真正解決。

---

## 驗收標準

- [ ] `RIL_RCIM250015_14409` 重跑後：`thc` 與 `sea_thc` 只有一個有值
- [ ] `TOLL_RCIM240349_58326` 重跑後：`document_fee_destination` 被清除（文件上無此費用）
- [ ] `TOLL_RCIM250334_77227` 重跑後：`handling_fee_destination` 被清除
- [ ] 迴歸：`TOLL_RHIM260037_78679` 的 `terminal_handling_charge_origin = 228.74`（兩行 90.21 + 138.53 正確加總）不受影響
- [ ] 迴歸：真正來自 summary 區的欄位（無對應 lineItem 金額）**不被**清除
- [ ] 上述文件重跑 template instance 後金額不再翻倍
- [ ] `npm run type-check` / `npm run lint` 通過

---

## 相關文件

- [FIX-126](FIX-126-charge-label-matching-fragility.md) —— 上游成因（名稱比對失敗）
- [FIX-130](FIX-130-existing-config-correction-checklist.md) —— 存量公式去重（必須併同完成）
- [FIX-108] —— 現行清除機制的引入
- [CHANGE-094] —— 確定性回填原始設計
