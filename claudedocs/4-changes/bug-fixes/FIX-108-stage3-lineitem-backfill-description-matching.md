# FIX-108: Stage 3 費用回填以失真的 classifiedAs 比對 + GPT 錯值無法被覆蓋 → 費用欄位金額錯誤

> **建立日期**: 2026-07-13
> **發現方式**: 用戶回報（Azure DEV 測試 —— Nippon Express (HK) 的 template instance 中 `docs_fee_at_origin` 空白）→ 逐層追查至 Stage 3
> **影響頁面/功能**: 文件處理管線（Stage 3 欄位提取）→ 所有依賴 `fields` 費用欄位的下游（Template Instance / 匯出 / 報表）
> **優先級**: 高（費用金額直接錯誤，且錯得不一致 —— 同一份文件每次處理結果不同）
> **狀態**: ✅ 已實作並已部署 Azure DEV（2026-07-14，映像 `dev-fix108-20260714135401`）；🔴 **§6.2 驗收仍待執行**（驗收目標文件 `NEX_RCIM250020_8925.pdf` 在 Azure DEV 最後一次處理為 2026-07-13，屬部署前的舊映像結果）
> **最後更新**: 2026-07-14
> **關聯**: CHANGE-094（確定性回填，本 FIX 修正其兩個設計缺陷）、FIX-095（Stage 3 prompt 格式衝突）、CHANGE-045（`fieldType: lineItem`）
> **Rollback**: 設環境變數 `STAGE3_DETERMINISTIC_BACKFILL=false` 即回到 CHANGE-094 行為（Azure：改 App Service 設定 + 重啟，**無需重建容器映像**）

---

## 1. 問題描述

Azure DEV 上，Nippon Express (HK) 的發票 `NEX_RCIM250020_8925.pdf` 經 Template Instance 映射後，`docs_fee_at_origin` 欄位空白。追查後發現這只是表徵，底下有兩個更嚴重的問題：

| # | 問題 | 嚴重度 | 影響 |
|---|------|--------|------|
| BUG-1 | GPT 把 line item 金額歸戶進 `fields` 時**加總算錯**，且確定性回填因「GPT 已填值優先」不介入修正 | 高 | 費用金額直接錯誤（實測 THC 應為 8700，三次處理分別填 3700 / 2200 / 2400） |
| BUG-2 | 確定性回填以 GPT **改寫過的 `classifiedAs`** 比對欄位定義，而非發票原始 `description` | 高 | 費用被歸到錯的欄位（`CONTAINER SEAL FEE` 被改寫成 `Seal Charge` → 誤填 `seal_charge`），造成下游重複計算 |

**關鍵事實**：AI 抽取 line items 這一層是**完全正確且穩定**的 —— 三次處理的 description / 數量 / 單價 / 金額一字不差。壞掉的是「把 line items 再歸戶進 `fields`」這第二步。

---

## 2. 證據（Azure DEV 真實資料）

### 2.1 line items —— 三次處理完全一致且正確

文件 `NEX_RCIM250020_8925.pdf`（Nippon Express (HK)，companyId `7b6a2886-945e-4ea2-8463-0ec6fc2c71c7`），三份處理記錄（`3174b348…` / `a5d9bb29…` / `37b06826…`）的 `stage3Result.lineItems` 完全相同：

| description | qty | unitPrice | amount | GPT 改寫的 classifiedAs |
|---|---|---|---|---|
| `T.H.C.` | 1 | 1500 | 1500 | `Terminal Handling Charge` |
| `T.H.C.` | 3 | 2400 | 7200 | `Terminal Handling Charge` |
| `CONTAINER SEAL FEE - FCL` | 1 | 110 | 110 | **`Seal Charge`** ⚠️ |
| `CONTAINER SEAL FEE - FCL` | 3 | 110 | 330 | **`Seal Charge`** ⚠️ |
| `NEHK B/L FEE - FCL` | 1 | 680 | 680 | `B/l Fee`（前兩次）/ `Nehk B/l Fee`（第三次） |
| `HANDLING CHARGE` | 1 | 100 | 100 | `Handling Charge` |
| `VGM ADMIN. CHARGE - FCL` | 1 | 234 | 234 | `Vgm Admin Charge` |
| `VGM ADMIN. CHARGE - FCL` | 3 | 234 | 702 | `Vgm Admin Charge` |

合計 = 8700 + 440 + 680 + 100 + 936 = **10856**，與發票 `subtotal` 完全吻合。

### 2.2 fields —— 同一份文件三次處理三種結果

| 欄位 | 正確值（由 line items 導出） | 08:18 | 08:59 | 09:42 |
|---|---|---|---|---|
| `thc` | **8700**（1500 + 7200） | 3700 ❌ | 2200 ❌ | 2400 ❌ |
| `container_seal_fee` | **440**（110 + 330） | 440 ✅ | 440 ✅ | 220 ❌ |
| `seal_charge` | **null**（發票無此描述） | 440 ❌ | 440 ❌ | 440 ❌ |
| `nehk_bl_fee` | **680** | 缺席 ❌ | 缺席 ❌ | 680 ✅ |
| `bl_fee` | **null**（發票無此描述） | 680 ❌ | 680 ❌ | null ✅ |
| `vgm_admin_charge` | **936** | 936 ✅ | 936 ✅ | 936 ✅ |
| `handling_charge` | **100** | 100 ✅ | 100 ✅ | 100 ✅ |

> `nehk_bl_fee` / `bl_fee` 在第三次已正確 —— 該次處理前已於 Azure DEV 為這兩個定義補上 `aliases` + `extractionHints`（欄位集 `4c17a087…` v9）。這證實**設定層去歧義有效**，但那只治單一公司，不治通用機制。

### 2.3 下游污染（Template Instance）

Inbound Full List 的映射規則 `handling_at_origin = {seal_charge} + {handling_charge} + {container_seal_fee}`：

- 實際產出 = 440 + 100 + 440 = **980**（`seal_charge` 被誤填，同一筆 seal 費算了兩次）
- 正確應為 = 0 + 100 + 440 = **540**

---

## 3. 根本原因

### 3.1 BUG-1：確定性回填「GPT 已填值優先」，錯值無法被修正

`src/services/extraction-v3/stages/stage-3-extraction.service.ts:1496`（CHANGE-094）：

```ts
// GPT 已填值優先：僅補空缺
if (this.hasFieldValue(fields[targetKey])) continue;
```

回填只在 GPT **沒填**該 key 時才補值。GPT 填了一個**錯的**數字（`thc = 2400`）時，回填完全不介入 —— 明明 line items 裡有可確定加總的正確答案（1500 + 7200 = 8700），系統卻採用 GPT 的心算結果。

Stage 3 prompt 雖有明文要求（`:984`「If multiple line items map to the same charge key, SUM their amounts... MUST be consistent across runs」），但 GPT 並未穩定遵守 —— 這正是 CHANGE-094 當初要用程式回填取代 GPT 心算的初衷，只是「僅補空缺」讓這個機制在最需要它的情況下失效。

### 3.2 BUG-2：回填的比對來源是失真的 `classifiedAs`

`stage-3-extraction.service.ts:1465`：

```ts
const candidate = li.classifiedAs;   // ← 用的是 GPT 改寫過的分類名
```

`classifiedAs` 是 GPT 對 description 做「清理 / 正規化」後的產物，會失真：

| 發票原始 description | GPT 產出的 classifiedAs | 後果 |
|---|---|---|
| `CONTAINER SEAL FEE - FCL` | `Seal Charge` | 與 `seal_charge` 的 label 精確相等 → 回填/GPT 都把錢歸到 `seal_charge`（錯的 key） |
| `NEHK B/L FEE - FCL` | `B/l Fee` | 與 `bl_fee` 的 label 相符 → 歸到 `bl_fee`（錯的 key） |

而 `description` 三次處理完全一致、且就是發票原文 —— 它才是可靠的比對錨點。

補充：`matchLabel`（`src/services/extraction-v3/utils/classify-normalizer.ts:95-111`）的比對邏輯本身沒問題（正規化後 exact > substring，多重命中視為歧義而跳過），問題純粹出在**餵給它的 candidate 來源選錯**。

---

## 4. 解決方案

核心原則：**`fieldType: 'lineItem'` 的費用欄位，其值應由 line items 確定性導出，而不是讓 GPT 心算第二遍。**

### 4.1 修正 1 —— 比對來源改為 `description` 優先

`backfillLineItemCharges` 的 candidate 改為：先用 `li.description` 比對欄位定義的 `label` / `aliases`；若 description 無任何命中，才退回 `li.classifiedAs`（向後相容 —— 舊資料 / 未設 aliases 的公司行為不變）。

### 4.2 修正 2 —— 唯一命中時，以程式加總覆蓋 GPT 的值

移除「GPT 已填值優先」的 early return。當某個 charge key 被 line items **唯一命中**（exact 優先、歧義仍跳過）時，其值一律改為該 key 所有命中行的 `amount` 加總，覆蓋 GPT 填的值。

### 4.3 修正 3 —— 清除「`classifiedAs` 失真造成的誤填」（精準版）

修正 1 + 2 只會讓 `container_seal_fee` 得到正確的 440，**不會**動到 `seal_charge = 440` 這個 GPT 誤填值 —— 它仍會污染下游（`handling_at_origin` 繼續重複計算）。因此需要一條清除規則。

#### 為何不採用「嚴格模式 gate + 清空所有未認領欄位」

初版設計為「若該文件每筆 line item 都唯一命中某 def → 清空所有沒被認領的 charge key」。**已否決**，因為存在靜默資料遺失路徑：

> 某筆費用不在 line item 表格裡（印在發票 summary / header 區），但在欄位集中被定義為 `fieldType: 'lineItem'`。GPT 從發票別處正確抽到並填入 `fields`。若該文件的 line items 剛好全部命中其他定義 → gate 通過 → **這個正確的值被靜默清空。**

gate 只檢查「line items 有沒有全部找到家」，無法檢查「某欄位的值是否來自 line items 以外的地方」，因此擋不住此情境。不可接受。

#### 採用：只清除有證據的誤填

```
對每個 fieldType='lineItem' 的 charge key K：
  若 (1) 沒有任何 line item 以 description 認領 K
     且 (2) 有 line item L 的 classifiedAs 命中 K
     且 (3) L 已被另一個 key K' 以 description 認領
  → K 的值判定為 classifiedAs 失真造成的誤填 → 清空為 null
  其餘情況一律保留（保守不動）
```

驗證（NEHK 實例）：

| key | 是否清空 | 理由 |
|---|---|---|
| `seal_charge` | ✅ 清空 | 無 description 認領；但 `CONTAINER SEAL FEE - FCL` 的 classifiedAs（`Seal Charge`）命中它，而該兩行已被 `container_seal_fee` 以 description 認領 |
| `bl_fee` | ✅ 清空 | 無 description 認領；`NEHK B/L FEE - FCL` 的 classifiedAs（`B/l Fee`）命中它，而該行已被 `nehk_bl_fee` 以 description 認領 |
| 假想的 header 來源費用 | ❌ 保留 | 無任何 line item 的 classifiedAs 命中它 → 不符條件 (2) → 不誤傷 |

此規則只打擊「有證據的誤填」，無 gate、無全面清空，不存在靜默刪資料的路徑。

> ⚠️ **修正 2 與修正 3 改變既定提取行為（H1/H6）**，已於 2026-07-13 取得用戶 approve。

### 4.4 不在本 FIX 範圍

- `template-matching-engine.service.ts:709-711` 的 `li_{classifiedAs}_total` 展平仍使用 `classifiedAs`。目前 NEHK 的映射規則未使用 `li_*` 來源欄位，暫不處理；若日後有公司改用 `li_*`，需另開 FIX 一併改為 description。
- Stage 3 prompt 中「Match by MEANING」的指示（`:981`）不動 —— 回填成為權威來源後，GPT 的 fields 只是備援。

---

## 5. 修改的檔案（實際）

| 檔案 | 修改內容 |
|------|----------|
| `src/services/extraction-v3/stages/stage-3-extraction.service.ts` | `backfillLineItemCharges` 重寫（修正 1 / 2 / 3 + rollback 分支）；新增 `resolveUniqueChargeKey`（唯一性裁決邏輯自原方法抽出，兩條路徑共用）；新增 `backfillLineItemChargesLegacy`（CHANGE-094 原行為，rollback 路徑）；新增 `BACKFILL_CONFIDENCE` 常數 |
| `tests/unit/services/stage-3-lineitem-backfill.test.ts`（新增） | 6 項單元測試，fixture 取自 Azure DEV 實測的 8 筆 line items |
| `.env.example` | 新增 `STAGE3_DETERMINISTIC_BACKFILL` 開關說明 |

> **註**：新增的一行診斷輸出沿用 `console.log` —— `extraction-v3/` 目錄零 logger 使用、全為 `console.log`（Karpathy §1.3 match existing style）。統一改 logger 屬 CLAUDE.md §當前 Open 差異 #3 的漸進清理範圍，不在本 FIX scope（H3）。

### 5.1 Rollback 機制

| 項目 | 說明 |
|------|------|
| 開關 | 環境變數 `STAGE3_DETERMINISTIC_BACKFILL` |
| 啟用 FIX-108（預設） | 未設定，或設為任何非 `"false"` 的值 |
| 回到 CHANGE-094 行為 | 設為 `"false"` → 走 `backfillLineItemChargesLegacy`（classifiedAs 對照 + 僅補空缺 + 不覆蓋不清除） |
| Azure 操作 | App Service → 設定 → 應用程式設定 新增此鍵 → 重啟。**無需重建容器映像、無需重新部署** |
| 影響範圍 | 僅影響切換後**新處理**的文件；已處理文件需重新處理才會改變 |

---

## 6. 測試驗證

### 6.1 本地（已通過）

- [x] 單元測試：NEHK 8 筆 line items → `thc=8700`、`container_seal_fee=440`、`seal_charge=null`、`nehk_bl_fee=680`、`bl_fee=null`、`vgm_admin_charge=936`、`handling_charge=100`
- [x] 單元測試：多筆同 key line item → 金額加總（110 + 330 = 440），且覆蓋 GPT 填的錯值（修正 2）
- [x] 單元測試：description 無命中但 classifiedAs 命中 → fallback 生效（修正 1 向後相容）
- [x] 單元測試（修正 3 誤傷防護）：某 charge key 的值來自 line items 以外（無任何 line item 的 classifiedAs 命中它）→ **保留**，不得清空
- [x] 單元測試（歧義保護）：line item 同時命中多個 def → 跳過不填、不覆蓋、不清空
- [x] 單元測試：`standard` 類型欄位不受影響
- [x] 單元測試（rollback）：`STAGE3_DETERMINISTIC_BACKFILL=false` → GPT 值不被覆蓋、不被清除
- [x] `npm run type-check` 通過
- [x] `npm run lint` 通過（0 error）
- [x] `npm run test` 全套：58 passed / 4 failed —— 4 個失敗全在 `gpt-caller-gateway-routing.test.ts`，經 stash 驗證為 **pre-existing**（抽掉本 FIX 改動後仍全數失敗），與本 FIX 無關

### 6.2 Azure DEV 驗收（待執行）

**前置條件（2026-07-14 已確認）**：

| 項目 | 狀態 |
|------|------|
| 程式碼上線 | ✅ 映像 `dev-fix108-20260714135401` 已為線上映像 |
| `STAGE3_DETERMINISTIC_BACKFILL` | App Service **未設定** → 走程式碼預設，即 FIX-108 新行為**已啟用**（僅在明確設為 `'false'` 時才回退 legacy） |
| 驗收目標文件現況 | `NEX_RCIM250020_8925.pdf` 在 Azure DEV 的最後處理時間為 **2026-07-13**（部署前），故其現存結果仍是舊行為（`thc` 三次分別為 2400／2200／3700、`seal_charge=440` 未清除）—— 正是本 FIX 要消除的非確定性 |

**驗收項目**：

- [ ] 重新處理 `NEX_RCIM250020_8925.pdf` → `thc=8700`、`container_seal_fee=440`、`seal_charge` 空、`nehk_bl_fee=680`、`bl_fee` 空、`vgm_admin_charge=936`、`handling_charge=100`
- [ ] 重跑 Template Instance → `terminal_fees_at_origin=8700`、`handling_at_origin=540`、`docs_fee_at_origin=680`、`vgm_at_origin=936`
- [ ] 連續處理同一文件 3 次 → 費用欄位結果完全一致（消除非確定性）
- [ ] 抽驗其他公司（aliases 未設定者）的文件 → 行為與修復前一致（無回歸）

---

*文件建立日期: 2026-07-13*
*最後更新: 2026-07-14（已部署 Azure DEV 並確認開關預設啟用；§6.2 驗收仍待執行）*
