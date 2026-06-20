# CHANGE-086: reference numbers 新增「文件子類型」（進口/出口/兩者/未知）維度

> **日期**: 2026-06-20
> **狀態**: ⏳ 待實作
> **優先級**: Medium
> **類型**: Feature
> **影響範圍**: reference number schema＋型別＋服務＋API＋前端＋i18n

---

## 變更背景

目前 `ReferenceNumber` 主檔僅有 `type` 欄位（`ReferenceNumberType`，9 值：SHIPMENT / DELIVERY / BOOKING / CONTAINER / HAWB / MAWB / BL / CUSTOMS / OTHER），用來區分**號碼種類**，但無法區分該參考編號對應的**文件方向**（進口 / 出口）。

用戶要求在參考編號上**新增一個獨立維度**來標示文件方向。此維度與現有 `type` **正交**（互不相關、不可混用）：`type` 回答「這是哪一種號碼」，新維度回答「這份文件是進口還是出口」。

### 關鍵設計約束（用戶已確認）

| 決策編號 | 內容 | 說明 |
|----------|------|------|
| **D1** | 命名與值域 | 欄位顯示名稱為「**文件子類型**」（非「方向 / direction」）；值域 4 個全加：`IMPORT` / `EXPORT` / `BOTH` / `UNKNOWN` |
| **D2** | schema 設計 | 欄位設為 **nullable**，**不**納入現有唯一約束 |
| **D3** | ref match 行為 | 比對流程**不**依文件子類型過濾，比對 pipeline 完全不動 |

---

## 變更內容

### 新增「文件子類型」維度

在 `ReferenceNumber` 主檔新增一個獨立的可空欄位，標示該參考編號對應文件的方向：

| 值 | 顯示（繁中暫定） | 說明 |
|----|------------------|------|
| `IMPORT` | 進口 | 進口文件 |
| `EXPORT` | 出口 | 出口文件 |
| `BOTH` | 兩者 | 進出口皆適用 |
| `UNKNOWN` | 未知 | 尚未判定 / 不適用 |

此維度貫穿資料層 → 型別 → 驗證 → 服務 → API → 前端表單／列表／篩選／導入導出 → i18n，全鏈新增，但**不影響**既有 `type` 欄位、唯一約束與比對 pipeline。

### 與現有 `type` 欄位的關係（務必區分）

- 現有 `type`（`ReferenceNumberType`）：保持不變，繼續區分號碼種類。
- 新維度 `documentSubType`（`ReferenceNumberSubType`）：獨立欄位，**不**與 `type` 共用 enum、**不**取代 `type`。
- 兩者在 UI 上分別呈現為兩個獨立欄位 / 兩個獨立篩選器 / 兩個獨立 Excel 欄位。

---

## 技術設計

### 命名（Open Question — 待用戶最終確認）

| 項目 | 暫定值 | 狀態 |
|------|--------|------|
| TypeScript 欄位名 | `documentSubType` | ⚠️ Open Question（見下方） |
| Prisma enum 名 | `ReferenceNumberSubType` | ⚠️ Open Question |
| TS 型別名 | `ReferenceNumberSubType` | ⚠️ Open Question |
| 顯示名稱（i18n） | 「文件子類型」 | ✅ 已確認 |
| enum 值域 | `IMPORT` / `EXPORT` / `BOTH` / `UNKNOWN` | ✅ 已確認 |

> **OQ-CHANGE086-1**：英文識別符 `documentSubType` 與 enum 名 `ReferenceNumberSubType` 為暫定。實作前必須向用戶確認最終命名（是否改用 `direction`、`flowType`、`tradeDirection` 等）。在獲確認前，commit message 標註 `Note: depends on OQ-CHANGE086-1`。

### 資料庫影響

新增 Prisma enum 與一個 nullable 欄位（含建議索引）：

```prisma
/**
 * 參考號碼文件子類型（文件方向）
 * @since CHANGE-086
 */
enum ReferenceNumberSubType {
  IMPORT          // 進口
  EXPORT          // 出口
  BOTH            // 兩者
  UNKNOWN         // 未知
}

model ReferenceNumber {
  // ... 既有欄位不動 ...

  // CHANGE-086: 文件子類型（獨立維度，nullable）
  documentSubType ReferenceNumberSubType? @map("document_sub_type")

  // ... 既有約束不動 ...
  @@index([documentSubType])   // CHANGE-086 新增（建議）
}
```

**約束說明**：
- 欄位 nullable → 既有資料無需 backfill，遷移向後相容。
- **不**修改 `@@unique([number, type, year, regionId], name: "unique_reference_number")`（`prisma/schema.prisma:3224`），`documentSubType` 不納入唯一鍵。
- 新增 migration（純加欄位 + enum + index），nullable 故不需資料回填腳本。

### 修改範圍

| 文件 | 變更內容 |
|------|----------|
| `prisma/schema.prisma` | 新增 enum `ReferenceNumberSubType`（值域 4）+ `ReferenceNumber.documentSubType` nullable 欄位 + 建議 `@@index([documentSubType])`（model 位於 3178-3232，enum 區位於 3243 附近） |
| `prisma/migrations/` | 新增 migration（加欄位 + enum + index，nullable 不需 backfill） |
| `prisma/seed.ts` / `prisma/seed-data/` | 若種子含 reference number 樣本，可選擇補上 `documentSubType` 範例值（非必須） |
| `src/types/reference-number.ts` | 新增 `ReferenceNumberSubType` 型別 + `REFERENCE_NUMBER_SUB_TYPE_LABELS` / `REFERENCE_NUMBER_SUB_TYPE_OPTIONS` 常量；於 `ReferenceNumber`、`ReferenceNumberListItem`、`CreateReferenceNumberInput`、`ReferenceNumberImportItem` 等 interface 加上 `documentSubType` 欄位（型別 20-29 為現有 `type` 區段參考） |
| `src/lib/validations/reference-number.schema.ts` | 新增 `referenceNumberSubTypeSchema = z.enum([...])`；串入 create / update / query / import（`importItemSchema`）/ export 各 schema（檔案結構見 70-462） |
| `src/services/reference-number.service.ts` | `createReferenceNumber`(299) / `updateReferenceNumber`(396) / `getReferenceNumbers`(148) / `getReferenceNumberById`(249) / `importReferenceNumbers`(579) / `exportReferenceNumbers`(729) 及各 mapper 加上 `documentSubType` 欄位透傳；**`findMatchesInText` 等比對函數不動**（D3） |
| `src/app/api/v1/reference-numbers/route.ts` | GET / POST 透傳 `documentSubType`（查詢篩選 + 建立） |
| `src/app/api/v1/reference-numbers/[id]/route.ts` | GET / PATCH / DELETE 透傳 `documentSubType` |
| `src/app/api/v1/reference-numbers/import/route.ts` | 導入透傳 `documentSubType` |
| `src/app/api/v1/reference-numbers/export/route.ts` | 導出含 `documentSubType` Excel 欄 |
| `src/app/api/v1/reference-numbers/validate/route.ts` | 透傳（如回傳記錄含 `documentSubType` 則一併帶出） |
| `src/components/features/reference-number/ReferenceNumberForm.tsx` | 新增「文件子類型」`<Select>`（IMPORT/EXPORT/BOTH/UNKNOWN，可清空對應 null） |
| `src/components/features/reference-number/ReferenceNumberSubTypeBadge.tsx` | 🆕 新建，仿 `ReferenceNumberTypeBadge.tsx` 結構 |
| `src/components/features/reference-number/ReferenceNumberList.tsx` | 新增「文件子類型」欄（用新 Badge 呈現） |
| `src/components/features/reference-number/ReferenceNumberFilters.tsx` | 新增「文件子類型」篩選器 |
| `src/components/features/reference-number/ReferenceNumberImportDialog.tsx` | 預覽表格 + 範本新增 `documentSubType` 欄 |
| `src/components/features/reference-number/ReferenceNumberExportButton.tsx` | 導出 Excel 新增 `documentSubType` 欄 |
| `src/hooks/use-reference-numbers.ts` | query params 串入 `documentSubType` 篩選 |

### i18n 影響

> **🔴 H5 觸發**：新增顯示字串與選項常量必須 en / zh-TW / zh-CN 三語同步，完成後執行 `npm run i18n:check`。

| 語言 | 文件 | 需要更新的 Key |
|------|------|---------------|
| en | `messages/en/referenceNumber.json` | `subTypes.IMPORT` / `subTypes.EXPORT` / `subTypes.BOTH` / `subTypes.UNKNOWN`；`columns.documentSubType`；`filters.documentSubType`；`form.documentSubType`（+ placeholder）；`import.columns.documentSubType` |
| zh-TW | `messages/zh-TW/referenceNumber.json` | 同上（繁中：進口 / 出口 / 兩者 / 未知；「文件子類型」） |
| zh-CN | `messages/zh-CN/referenceNumber.json` | 同上（簡中：进口 / 出口 / 两者 / 未知；「文件子类型」） |

> `referenceNumber` 命名空間已存在並註冊於 `src/i18n/request.ts`，**無需**新增命名空間，僅在現有檔案內補 key。

---

## 設計決策

1. **採獨立新維度而非擴充 `type`** — 用戶明確要求文件方向與號碼種類正交；若塞進 `ReferenceNumberType` 會污染既有 9 值語意並破壞既有比對 / 篩選邏輯。

2. **欄位 nullable（D2）** — 既有資料無方向資訊，nullable 可零風險遷移、不需 backfill，符合 §H1 例外「純加 nullable 欄位（向後相容）」，**故不觸發 H1**。

3. **不納入唯一約束（D2）** — `documentSubType` 不參與 `unique_reference_number`，避免同號碼因方向不同被視為不同筆而破壞既有去重語意。

4. **比對 pipeline 不動（D3）** — ref match 不依文件子類型過濾，`findMatchesInText` 維持原行為；此維度目前僅為**資料標註 / 顯示 / 篩選**用途。

5. **命名留作 Open Question（OQ-CHANGE086-1）** — `documentSubType` / `ReferenceNumberSubType` 為暫定，實作前須經用戶確認。

6. **⚠️ H1 邊界提醒（重要）** — 本變更因 nullable + 不動唯一約束而**不觸發 H1**。但若**日後**需求改為：
   - 將 `documentSubType` 改為 **non-nullable**（含 default + 既有資料 backfill），或
   - 將 `documentSubType` **納入** `@@unique`（改變去重語意），或
   - 讓比對 pipeline **依文件子類型過濾**（改變信心度 / 比對核心邏輯），

   則上述任一皆**觸發 H1**，必須 STOP 並重新取得用戶 approve 後才可實作，並記錄於本文件。

---

## 影響範圍評估

### 文件影響清單

| 文件路徑 | 類型 | 說明 |
|----------|------|------|
| `prisma/schema.prisma` | 🔧 修改 | 加 enum + nullable 欄位 + index |
| `prisma/migrations/{新}` | 🆕 新增 | 純加欄位 migration |
| `prisma/seed.ts` / `prisma/seed-data/` | 🔧 修改（可選） | 種子樣本補欄位 |
| `src/types/reference-number.ts` | 🔧 修改 | 型別 + LABELS / OPTIONS 常量 + interface 欄位 |
| `src/lib/validations/reference-number.schema.ts` | 🔧 修改 | 新 enum schema 串入各 schema |
| `src/services/reference-number.service.ts` | 🔧 修改 | CRUD / list / import / export / mapper 透傳（比對不動） |
| `src/app/api/v1/reference-numbers/route.ts` | 🔧 修改 | GET / POST 透傳 |
| `src/app/api/v1/reference-numbers/[id]/route.ts` | 🔧 修改 | GET / PATCH 透傳 |
| `src/app/api/v1/reference-numbers/import/route.ts` | 🔧 修改 | 導入透傳 |
| `src/app/api/v1/reference-numbers/export/route.ts` | 🔧 修改 | 導出欄 |
| `src/app/api/v1/reference-numbers/validate/route.ts` | 🔧 修改 | 透傳 |
| `src/components/features/reference-number/ReferenceNumberForm.tsx` | 🔧 修改 | 新增 Select |
| `src/components/features/reference-number/ReferenceNumberSubTypeBadge.tsx` | 🆕 新增 | 仿 TypeBadge |
| `src/components/features/reference-number/ReferenceNumberList.tsx` | 🔧 修改 | 新欄 |
| `src/components/features/reference-number/ReferenceNumberFilters.tsx` | 🔧 修改 | 新篩選 |
| `src/components/features/reference-number/ReferenceNumberImportDialog.tsx` | 🔧 修改 | 預覽 + 範本欄 |
| `src/components/features/reference-number/ReferenceNumberExportButton.tsx` | 🔧 修改 | 導出欄 |
| `src/hooks/use-reference-numbers.ts` | 🔧 修改 | query params |
| `messages/en/referenceNumber.json` | 🔧 修改 | subTypes + 各區段 key |
| `messages/zh-TW/referenceNumber.json` | 🔧 修改 | 同上 |
| `messages/zh-CN/referenceNumber.json` | 🔧 修改 | 同上 |

### 向後兼容性

- **資料庫**：nullable 欄位，既有 `reference_numbers` 資料無需變更，舊記錄 `documentSubType` 為 `NULL`，向後相容。
- **API**：新欄位於請求 / 回應皆為可選，舊客戶端不傳亦正常運作。
- **比對 pipeline**：完全不動（D3），既有比對行為零變化。
- **唯一約束**：不變，既有去重語意維持。
- **i18n**：僅在現有 `referenceNumber` 命名空間內新增 key，不刪改既有 key。

---

## 實施計劃（分階段）

| 階段 | 內容 | 驗證 |
|------|------|------|
| **P0 命名確認** | 向用戶確認 OQ-CHANGE086-1（最終欄位 / enum 命名） | 用戶 approve 命名 |
| **P1 資料層** | 加 enum + nullable 欄位 + index → 寫 migration → `npx prisma generate` → dry-run 驗證 | migration 套用成功、Prisma Client 生成 |
| **P2 型別 + 驗證** | `reference-number.ts` 型別 / 常量 / interface；`reference-number.schema.ts` 串入各 schema | `npm run type-check` 通過 |
| **P3 服務 + API** | service mapper / CRUD / import / export 透傳；5 個 route 透傳（比對不動） | `npm run type-check` + `npm run lint` 通過 |
| **P4 前端** | Form Select + 新 SubTypeBadge + List 欄 + Filters + Import / Export 欄 + hook query | UI 顯示正確、篩選可運作 |
| **P5 i18n** | 三語 `referenceNumber.json` 補 key | `npm run i18n:check` 通過、瀏覽器無 IntlError |

> P1 須序列化先行（Prisma migration 不可並行）；P2-P5 部分可並行，但 i18n（P5）必須在前端 key 確定後統一處理。

## 風險評估

| 風險 | 等級 | 緩解 |
|------|------|------|
| 命名未確認即實作導致大範圍改名 | 中 | P0 先鎖定 OQ-CHANGE086-1，未確認不進 P1 |
| Excel 導入 / 導出欄位順序與既有範本衝突 | 低 | 新欄附加於既有欄之後，舊範本無此欄時視為 `NULL` |
| 前端遺漏某處 mapper 導致欄位顯示空白 | 低 | P3/P4 以 `type-check` + 手動 UI 驗證雙重把關 |
| i18n 三語不同步 | 中 | P5 強制跑 `npm run i18n:check`（H5） |

## 回滾計劃

- **程式碼**：各階段獨立 commit，可依 P5→P1 逆序 revert。
- **資料庫**：因欄位 nullable 且不在唯一約束，必要時可新增 migration `DROP COLUMN document_sub_type` + `DROP TYPE "ReferenceNumberSubType"`，不影響既有資料。
- **比對 pipeline**：未動，無需回滾。

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | 資料層 | enum + nullable 欄位 + index 已建，migration 套用成功，既有資料 `documentSubType` 為 `NULL` | High |
| 2 | 唯一約束不變 | `unique_reference_number` 仍為 `(number, type, year, regionId)`，未含 `documentSubType` | High |
| 3 | 建立 / 編輯 | Form 可選 4 值或清空（null），儲存後正確持久化 | High |
| 4 | 列表 / 篩選 | List 顯示文件子類型欄（Badge），Filters 可依文件子類型篩選 | High |
| 5 | 導入 / 導出 | Excel 範本含 `documentSubType` 欄，導入 / 導出正確帶值 | Medium |
| 6 | 比對不變 | ref match 行為與變更前完全一致（不依文件子類型過濾） | High |
| 7 | i18n | 三語顯示「文件子類型 / 進口 / 出口 / 兩者 / 未知」，`npm run i18n:check` 通過，無 IntlError | High |
| 8 | 型別 / lint | `npm run type-check` + `npm run lint` 通過無 warning | High |

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | 建立帶文件子類型的參考編號 | 新增頁面選「進口」並儲存 | 列表顯示該筆 `documentSubType=IMPORT`，Badge 顯示「進口」 |
| 2 | 建立不選文件子類型 | 新增頁面留空文件子類型並儲存 | 成功建立，`documentSubType` 為 `NULL`，列表該欄顯示空 / 預設 |
| 3 | 編輯既有（NULL）記錄 | 開啟舊記錄，設為「出口」並更新 | 更新成功，值變為 `EXPORT` |
| 4 | 文件子類型篩選 | Filters 選「出口」 | 列表僅顯示 `documentSubType=EXPORT` 的記錄 |
| 5 | 同號碼不同文件子類型 | 以相同 `(number, type, year, regionId)` 但不同 `documentSubType` 建立第二筆 | 因唯一約束不含 `documentSubType` → 仍被視為重複而擋下（驗證去重語意未變） |
| 6 | Excel 導入含文件子類型欄 | 用含 `documentSubType` 欄的範本導入 | 導入記錄帶正確值；欄位留空者為 `NULL` |
| 7 | Excel 導出 | 導出現有記錄 | 匯出檔含 `documentSubType` 欄，值正確 |
| 8 | 比對行為回歸 | 對含 / 不含文件子類型的記錄跑文件比對 | 比對命中結果與變更前一致，不受文件子類型影響 |
| 9 | i18n 三語 | 切換 en / zh-TW / zh-CN 檢視欄位與選項 | 三語皆正確顯示，無 IntlError |

---

## Hard Constraint 自檢

| 約束 | 是否觸發 | 說明 |
|------|----------|------|
| **H1** 架構 | ❌ 不觸發 | nullable 欄位、不動唯一約束、不改比對邏輯，符合 §H1 例外「純加 nullable 欄位」。⚠️ 若日後改 non-nullable / 納入唯一約束 / 比對依此過濾 → 觸發 H1，須重新 approve |
| **H2** 依賴 | ❌ 不觸發 | 無新套件、不換 vendor |
| **H3** 範圍 | ✅ 範圍內 | 全部改動圍繞「新增文件子類型維度」，未夾帶無關功能 |
| **H4** 安全 | ❌ 不涉及 | 無 PII / secret / 客戶端直連 DB |
| **H5** i18n | 🔴 觸發 | 新增顯示字串 + 選項常量，必須三語同步並跑 `npm run i18n:check` |
| **H6** 設計偏離 | ❌ 不涉及 | 依用戶確認的 D1-D3 實作 |

---

## Open Questions

| 編號 | 問題 | 狀態 | 處理 |
|------|------|------|------|
| OQ-CHANGE086-1 | 英文識別符 `documentSubType` 與 enum 名 `ReferenceNumberSubType` 為暫定，是否採此命名（或改 `direction` / `flowType` / `tradeDirection`） | Open | 實作前向用戶確認；未確認前 commit 標註 `Note: depends on OQ-CHANGE086-1` |
