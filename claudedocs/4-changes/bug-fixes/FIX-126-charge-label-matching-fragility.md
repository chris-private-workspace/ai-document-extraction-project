# FIX-126: Stage 3 費用名稱比對過於脆弱，實務變體大量落空

> **建立日期**: 2026-07-22
> **發現方式**: 使用者 Azure DEV 測試回報（Quentin Liu，2026-07-14 ~ 07-21）+ 真實資料查證
> **影響頁面/功能**: V3.1 Stage 3 費用回填（`backfillLineItemCharges`）→ 下游 template field mapping
> **優先級**: 高
> **狀態**: ✅ 已完成（2026-07-22，採方案 A + C + 非對稱子字串；Azure 實機重跑驗證於下次部署批次執行）

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

- [x] 以本次 17 份真實文件的 `lineItems` 原文為測試集，建立單元測試，涵蓋上述 5 種模式（`classify-normalizer.test.ts` 13 項 + `stage-3-lineitem-backfill.test.ts` FIX-126 區塊 6 項）
- [x] 模式 1（單複數）：`Terminal Handling Charges - Origin` 能命中 `terminal_handling_charge_origin`
- [x] 模式 4（歧義）：明確定義為**一律不填**——無方向的候選不參與有方向的欄位（方案 C），與「寧可不填、不可填錯」一致
- [x] 模式 5（誤配）：`HANDLING CHARGE` **不再**命中 `Terminal handling charge`（非對稱子字串）
- [x] 迴歸：Nippon Express (HK) 現有正確行為不變（`T.H.C.` → `thc = 8700`，單元測試 + 本地回放皆驗證）
- [x] `npm run type-check` / `npm run lint` 通過（lint 無新增警告）
- [x] 本地批次回放既有 79 份文件，比對修改前後認領差異，逐筆確認無新增誤配（見下方實作記錄；以確定性回放代替 GPT 全量重跑）

---

## 實作記錄（2026-07-22）

### 定案方案

經用戶確認：**方案 A + 方案 C + 非對稱子字串**（模式 5 的補充機制，A+C 覆蓋不到它），不採 B；D（aliases 補齊）作為補充由 [FIX-130](FIX-130-existing-config-correction-checklist.md) 執行。

| 機制 | 實作位置 | 內容 |
|---|---|---|
| A 單複數歸一 | `canonicalizeLabel` | 白名單查表（charges/fees/costs/surcharges/expenses/containers/documents/services/orders/rates/taxes/duties → 單數），不做通用 stemming |
| 非對稱子字串 | `matchLabel` | 子字串命中僅允許「候選（文件文字）⊇ 目標（定義名稱）」；反向（定義名稱 ⊇ 較短的文件文字）一律不命中——模式 5 的根治，模式 4 隨之明確化為不填 |
| C 方向必要條件 | `resolveUniqueChargeKey` | 新增 `extractChargeDirections`（origin/orig；destination/dest/dst）；定義 label 帶方向時，候選必須帶相同方向才可參與比對（閘在 aliases 之前，防 FIX-130 補的無方向 alias 成為跨方向漏洞） |

### 修改檔案

| 檔案 | 變更 |
|---|---|
| `src/services/extraction-v3/utils/classify-normalizer.ts` | `PLURAL_TO_SINGULAR` 白名單、`canonicalizeLabel` 逐詞歸一、`matchLabel` 非對稱化、新增 `extractChargeDirections` / `ChargeDirection` |
| `src/services/extraction-v3/stages/stage-3-extraction.service.ts` | `resolveUniqueChargeKey` 加方向閘 |
| `tests/unit/services/classify-normalizer.test.ts` | 新建，13 項（5 種模式真實字串） |
| `tests/unit/services/stage-3-lineitem-backfill.test.ts` | 新增 FIX-126 區塊 6 項（TOLL 實測、方向防護、aliases 協同、Nippon 迴歸） |
| `scripts/local-verify-fix126-replay.ts` | 新建，本地回放比對工具（唯讀） |

### 本地回放比對結果（79 份）

以既有 `stage_3_result.lineItems` + 各公司 field definitions 確定性回放新舊認領流程（不重打 GPT——全量重跑的 GPT 非確定性會混淆前後比較）：

- **72/79 完全一致**；0 筆金額改變
- **7 筆 LOST 全部是舊邏輯的跨方向誤配被修掉**：CEVA `origin_thc_terminal_handling_charge` 帶過泛 alias `"Terminal Handling Charge"`，舊邏輯把 `Terminal Handling Charge at Destination THB ...` 行（實為 Destination）誤認領進 origin 欄位（2 份文件、393.30 / 225.34）；方向閘修正
- **1 筆 GAINED 為正確認領**：同一行在 classifiedAs 帶方向的版本改認領 `destination_thc_terminal_handling_charge` ✅
- 過泛 alias 本身已回寫 [FIX-130](FIX-130-existing-config-correction-checklist.md) 存量修正清單

### ⚠️ Rollback 注意

`STAGE3_DETERMINISTIC_BACKFILL=false` 只回退 FIX-108 的回填行為，**回退不了本次比對變更**（legacy 路徑共用 `resolveUniqueChargeKey`）。FIX-126 的回退 = 重新部署前一版映像。

### 已知能力邊界（交由 FIX-130 aliases）

- 模式 2（插入詞，如 `(AIR) DELIVERY ORDER CHARGE DEST CHARGE`）與模式 3（目標 < 8 字元，如 `B/L fee`）維持不命中——需 aliases
- CEVA `43397` 類（description 與 classifiedAs 皆無法安全歸戶）落入「寧可不填」——需 destination 欄位補 `Terminal Handling Charge at Destination` alias

---

## 相關文件

- [FIX-127](FIX-127-stage3-misattribution-and-dual-source.md) —— 比對失敗的下游後果（GPT 誤填未被清除）
- [FIX-130](FIX-130-existing-config-correction-checklist.md) —— aliases 存量補齊
- [CHANGE-094] —— 確定性回填的原始設計
- [FIX-108] —— 回填改為 description 優先 + 覆蓋 GPT 值
