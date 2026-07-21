# FIX-126: Stage 3 費用名稱比對過於脆弱，實務變體大量落空

> **建立日期**: 2026-07-22
> **發現方式**: 使用者 Azure DEV 測試回報（Quentin Liu，2026-07-14 ~ 07-21）+ 真實資料查證
> **影響頁面/功能**: V3.1 Stage 3 費用回填（`backfillLineItemCharges`）→ 下游 template field mapping
> **優先級**: 高
> **狀態**: 📋 規劃中

---

## 問題描述

`backfillLineItemCharges` 用 `matchLabel` 把 lineItem 的 `description` / `classifiedAs` 對照 field definition 的 `label` / `aliases`。該函數只認兩種命中：**正規化後完全相等（exact）**，或**短的一方以完整詞被長的一方包含（substring，且短方需 ≥8 字元且 ≥2 詞）**。

實務上發票的費用名稱與欄位定義之間存在大量小差異（單複數、插入詞、計價後綴），這些差異全部落在兩種命中之外，導致 description 認領失敗，只能退回 `classifiedAs` —— 而後者是 GPT 改寫過的分類名，**同一份文件重跑兩次可能不同**。

結果：欄位時填時空、或落到相鄰的錯誤欄位。

---

## 重現步驟

1. 某公司的 field definition 設有 `Terminal Handling Charge - Origin`（單數）。
2. 上傳一份該公司的發票，明細行文字為 `Terminal Handling Charges - Origin - 1 40HC Container(s) @ THB 4300.00/Container`（複數 + 計價後綴）。
3. 觀察 `stage_3_result.fields`：`terminal_handling_charge_origin` **不存在**，或存在但沒有 `source: 'lineItem-backfill'` 標記（表示是 GPT 自行填的，非確定性回填）。

---

## 根本原因

`matchLabel`（`src/services/extraction-v3/utils/classify-normalizer.ts:95-111`）：

```ts
export function matchLabel(candidate: string, target: string): LabelMatchKind {
  const a = canonicalizeLabel(candidate);
  const b = canonicalizeLabel(target);
  if (a === b) return 'exact';

  const shorter = a.length <= b.length ? a : b;
  const longer  = a.length <= b.length ? b : a;
  const isWordBounded = longer === shorter
    || longer.includes(` ${shorter} `)
    || longer.startsWith(`${shorter} `)
    || longer.endsWith(` ${shorter}`);
  if (isWordBounded && shorter.length >= 8 && shorter.split(' ').length >= 2) {
    return 'substring';
  }
  return null;
}
```

`canonicalizeLabel` 只做「轉小寫 + 非英數字元轉空格 + 壓縮空白」，**不處理詞形**。因此比對本質上是「連續子字串 + 詞邊界」，任何插入詞或詞尾變化都會讓它失敗。

### 五種失敗模式（皆已實測）

| # | 模式 | 實例（文件名稱 → 定義名稱） | 結果 |
|---|---|---|---|
| 1 | **單複數** | `Terminal Handling Charges - Origin` → `Terminal Handling Charge - Origin` | 不命中 |
| 2 | **插入詞** | `(AIR) DELIVERY ORDER CHARGE DEST CHARGE` → `(Air) Delivery Order (Dest Charge)` | 不命中（`CHARGE` 卡在中間，連續子字串斷裂） |
| 3 | **長度門檻** | `NEHK B/L FEE - FCL` → `B/L fee` | 不命中（`b l fee` 僅 **7** 字元，門檻要求 ≥8） |
| 4 | **共同後綴歧義** | `DEST CHARGE` → SBS 的 8 個 `(Dest Charge)` 結尾欄位 | 歧義 → 放棄填值 |
| 5 | **結尾誤配** | `HANDLING CHARGE` → `Terminal handling charge` | **誤命中**（`handling charge` 正好是它的結尾） |

### 實測證據

**（a）本地實測**：以真實 `matchLabel` 函數 + 本地 DB 的真實 field definition 清單跑比對，使用者回報的 **8 個真實費用名稱全數未成功認領**（6 個未命中、1 個歧義放棄、模式 5 為誤配）。

**（b）Azure DEV 真實資料**：

`TOLL_RHIM260048_79294.PDF` —— 文件明細 `Terminal Handling Charges - Origin - 4 40HC Container(s) @ THB 4300.00/Container`，`classifiedAs` 為 `Terminal Handling Charge`（無方向後綴）：

```
stage_3_result.fields 中完全沒有 terminal_handling_charge_origin
```

原因是 `Terminal Handling Charge` 同時 substring 命中 `..._origin` 與 `..._destination` 兩個定義 → 判為歧義 → 依設計放棄填值。下游 template 公式取不到任何值，THC 欄位空白 —— 即使用者回報的「THC cannot display to the template」。

`TOLL_RHIM260062_51857.PDF` 與 `TOLL_RHIM260103_55060.PDF` —— **同一種費用**（`Documentation Fee - Destination - Base Rate HKD 650.00`）因 `classifiedAs` 不同而落到不同欄位：

| 文件 | `classifiedAs` | 落到的欄位 |
|---|---|---|
| 51857 | `Document Fee` | `document_fee` |
| 55060 | `Document Fee Destination` | `document_fee_destination` |

兩份的 description 完全相同，都因帶 `- Base Rate HKD 650.00` 後綴而無法 exact 命中，退回 `classifiedAs` 後就聽天由命。

### 為什麼 `aliases` 能救、但目前救不到

Nippon Express (HK) 的定義有設 aliases：

```
nehk_bl_fee | "NEHK B/L fee"  aliases=["NEHK B/L FEE","NEHK B/L FEE - FCL","NEHK BL FEE"]
thc         | "THC"           aliases=["T.H.C","THC","TERMINAL HANDLING CHARGE"]
```

因此 `NEHK B/L FEE - FCL` 與 `T.H.C.` 都能 exact 命中，回填穩定正確（實測 `thc = 8700`，兩行 1500 + 7200 正確加總）。

但 **TOLL（37 個欄位）、SBS INTERNATIONAL（47 個）、SBS（34 個）的 aliases 全部為空**，只能靠 label 硬碰。存量補齊屬 [FIX-130](FIX-130-existing-config-correction-checklist.md) 範圍。

---

## 解決方案

**取捨核心**：放寬比對能提高命中率，但模式 5 證明**現行寬度已經會誤配**，再放寬有加劇風險。以下四案**需用戶決定**。

| 選項 | 方案 | 優點 | 代價 |
|------|------|------|------|
| **A** | **詞形正規化**：`canonicalizeLabel` 增加英文單複數歸一（`charges`→`charge`、`fees`→`fee`） | 直接解掉模式 1（TOLL 全部 THC 中招）；改動集中在一個純函數，易測試 | 只解一種模式；不當的 stemming 可能造成新的誤命中（如 `class`→`clas`），需限縮為白名單式的簡單規則 |
| **B** | **詞集合比對取代連續子字串**：改為「定義名稱的所有詞都出現在文件名稱中」即算命中，並以覆蓋率排序取最高者 | 一次解掉模式 1、2、3；貼近人的判讀方式 | 大幅放寬 → 誤配風險顯著上升（模式 5 會惡化）；需搭配更嚴的歧義裁決 |
| **C** | **方向後綴（Origin/Destination）視為必要條件**：比對時先抽出方向標記，方向不符一律不命中；方向缺失時不參與有方向的欄位 | 直接解掉模式 4 的歧義來源與 THC 錯欄；語意正確 | 需定義方向詞彙表（origin/dest/destination/orig…）；對沒有方向概念的欄位要能豁免 |
| **D** | **不改代碼**，全靠 aliases 補齊（[FIX-130](FIX-130-existing-config-correction-checklist.md)） | 零回歸風險；Nippon 已證明可行 | 每家公司、每個新費用名稱都要人工維護；新版面出現時必然再次落空 |

### 建議

**A + C 併行，不採 B**。理由：
- A 解掉影響最廣的單複數問題，風險可控（規則簡單、可窮舉測試）。
- C 解掉方向歧義，同時**降低**誤配風險（比 B 更嚴而非更寬）。
- B 的放寬幅度會讓模式 5 這類結尾誤配大量增加，與 FIX-127 的重複計算問題疊加後更難排查。
- D 作為 A + C 的補充而非替代 —— 語意別名（如 `NEHK B/L FEE - FCL` → `Docs fee at origin`）本來就只能靠 aliases。

---

## 驗收標準

- [ ] 以本次 17 份真實文件的 `lineItems` 原文為測試集，建立單元測試，涵蓋上述 5 種模式
- [ ] 模式 1（單複數）：`Terminal Handling Charges - Origin` 能命中 `terminal_handling_charge_origin`
- [ ] 模式 4（歧義）：`Terminal Handling Charge`（無方向）在有 origin/destination 兩個定義時的行為**明確定義**（命中其一或維持放棄，二選一但需一致）
- [ ] 模式 5（誤配）：`HANDLING CHARGE` **不再**命中 `Terminal handling charge`
- [ ] 迴歸：Nippon Express (HK) 現有正確行為不變（`T.H.C.` → `thc = 8700`）
- [ ] `npm run type-check` / `npm run lint` 通過
- [ ] 本地批次重跑既有文件，比對修改前後的 `fields` 差異，逐筆確認無新增誤配

---

## 相關文件

- [FIX-127](FIX-127-stage3-misattribution-and-dual-source.md) —— 比對失敗的下游後果（GPT 誤填未被清除）
- [FIX-130](FIX-130-existing-config-correction-checklist.md) —— aliases 存量補齊
- [CHANGE-094] —— 確定性回填的原始設計
- [FIX-108] —— 回填改為 description 優先 + 覆蓋 GPT 值
