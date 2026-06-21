# CHANGE-084: documents 文件列表欄位增強（檔名完整／絕對時間／處理時間／信心度／上傳者）

> **日期**: 2026-06-20
> **狀態**: ✅ 已完成（2026-06-21）
> **優先級**: High
> **類型**: UI Enhancement
> **影響範圍**: documents 列表頁顯示

---

## 變更背景

目前 `/documents` 文件列表頁的表格（`DocumentListTable.tsx`）只有 6 欄：選擇、文件名稱、狀態、處理路徑、上傳時間、操作。實際使用上有以下不足：

1. **檔名顯示不完整**：檔名被 `truncate max-w-[200px]` 截斷，需要 hover 才能看到完整名稱，不利於快速辨識文件。
2. **上傳時間是相對時間**：目前顯示「2 天前」這類相對時間，無法看到精確的上傳時間點，不利於對帳與排查。
3. **缺少處理時間資訊**：使用者無法在列表中得知文件處理開始／結束時間與耗時，須進入詳情頁才看得到。
4. **缺少信心度欄位**：信心度是核心路由依據，但列表沒有直接呈現，使用者難以快速判斷文件品質。
5. **缺少上傳者欄位**：列表無法直接看出文件是誰上傳的，協作場景下不便追蹤。

**核心結論**：本次 5 個子項**全部不需要變更 Prisma schema**（不觸發 H1）。所需資料層皆已存在，差異主要在於 `getDocuments` 服務的 `select`/`include` 沒有撈出對應欄位，以及前端表格未渲染。

---

## 變更內容

### 子項 1 — 檔名顯示完整

目前 `DocumentListTable.tsx`（第 202-207 行）使用 `truncate max-w-[200px]` 加 `title={doc.fileName}` 來截斷檔名。`doc.fileName` 本身已是完整檔名。

**修法**：放寬或移除 `max-w-[200px]` 限制，或改為 `whitespace-normal break-all` 讓檔名可換行完整顯示。屬純前端調整。

### 子項 2 — 上傳時間改為絕對時間

目前（`DocumentListTable.tsx` 第 53-54 行 import、第 238-241 行渲染）使用 date-fns 的 `formatDistanceToNow` 加 locale 顯示「2 days ago」相對時間。

**修法**：改用專案既有工具 `src/lib/i18n-date.ts` 的 `formatDateTime(date, locale)` 顯示絕對時間（如「2026年6月20日 14:30」）。同時移除不再使用的 date-fns import（`formatDistanceToNow`、`zhTW`、`enUS`）——此為本次改動造成的 orphan，依 Karpathy §1.3 必須清理。符合 `.claude/rules/i18n.md`「日期統一用格式化工具」。

### 子項 3 — 顯示處理時間（開始＋結束＋耗時全顯示）

`documents` 表已有 `processingStartedAt`、`processingEndedAt`、`processingDuration`（Int，毫秒）欄位，但 `getDocuments` 的 `select`（`document.service.ts` 第 209-226 行）未撈出。

**修法**（純加法，不改 schema）：
- `getDocuments` 的 `select` 加入 `processingStartedAt`、`processingEndedAt`、`processingDuration` 3 欄
- `DocumentListItem` type（`use-documents.ts` 第 56-71 行）加入對應欄位
- 表格新增「處理時間」欄，呈現開始／結束絕對時間（用 `formatDateTime`）＋ 耗時格式化（毫秒轉可讀格式）
- 新增 i18n column key（`processingTime` 或開始／結束／耗時分項 key）

### 子項 4 — 顯示信心度

`Document` 模型本身**沒有** confidence 欄位；信心度的權威來源是 `extraction_results.average_confidence`（**0–100 範圍，實機驗證樣本為 97.6**），與 `Document` 為 1:1 關聯。`getDocuments` 目前未 include `extractionResult`。

**修法**（純加法，不改 schema）：
- `getDocuments` 的 `select` 加入 `extractionResult: { select: { averageConfidence: true } }`
- `DocumentListItem` type 加入 `confidence: number | null`
- 表格新增「信心度」欄，使用既有 `ConfidenceBadge` 組件（`src/components/features/confidence/`）
- i18n key `table.columns.confidence` **已存在**（`documents.json` 第 38 行），無需新增
- 數值呈現用 `formatPercent`（`src/lib/i18n-number.ts`）。因 `averageConfidence` 已是 0–100 範圍，**不需再 ×100**

### 子項 5 — 顯示上傳者

`getDocuments` 已 `select` `uploader { id, name, email }`（`document.service.ts` 第 219-225 行），`DocumentListItem` 也已含 `uploader`（`use-documents.ts` 第 66-70 行）。目前僅在處理失敗訊息條件中用到 `doc.uploader`（`DocumentListTable.tsx` 第 214 行），沒有獨立欄位。

**修法**：資料已現成，只需新增一欄渲染上傳者。**H4（PII）**：顯示優先用 `uploader.name`、`email` 作為 fallback，且**不可** log email。新增 i18n column key（如 `uploader`）。

---

## 技術設計

### 修改範圍

| 文件 | 變更內容 |
|------|----------|
| `src/services/document.service.ts` | `getDocuments` 的 `select`（第 209-226 行）加 `processingStartedAt`、`processingEndedAt`、`processingDuration`、`extractionResult: { select: { averageConfidence: true } }` |
| `src/hooks/use-documents.ts` | `DocumentListItem` type（第 56-71 行）加 `processingStartedAt`、`processingEndedAt`、`processingDuration`、`confidence` 欄位 |
| `src/components/features/document/DocumentListTable.tsx` | 放寬檔名截斷；上傳時間改 `formatDateTime` 並移除 date-fns import；新增「處理時間」「信心度」「上傳者」3 欄渲染（用 `ConfidenceBadge`、`formatPercent`、`formatDateTime`） |
| `messages/en/documents.json` | `table.columns` 新增處理時間／上傳者相關 key（confidence 已存在） |
| `messages/zh-TW/documents.json` | 同上 |
| `messages/zh-CN/documents.json` | 同上 |

> 頁面 `src/app/[locale]/(dashboard)/documents/page.tsx` 與 API `src/app/api/documents/route.ts` 僅作為資料傳遞層，預期無需修改（除非 API 對回傳欄位做了白名單過濾，實作時需確認）。

### i18n 影響

> 信心度 key（`table.columns.confidence`）已存在於三語言檔，不需新增。以下為**需新增**的 column header key（建議命名，實作時可微調）。

| 語言 | 文件 | 需要更新的 Key |
|------|------|---------------|
| en | `messages/en/documents.json` | `table.columns.processingTime`（或 `processingStartedAt` / `processingEndedAt` / `processingDuration` 分項）、`table.columns.uploader` |
| zh-TW | `messages/zh-TW/documents.json` | 同上 |
| zh-CN | `messages/zh-CN/documents.json` | 同上 |

> **H5 要求**：新增 column header 必須三語言同步，完成後執行 `npm run i18n:check`。

### 資料庫影響

**無**。本次 5 個子項全部不變更 `prisma/schema.prisma`：
- 處理時間 3 欄（`processingStartedAt`、`processingEndedAt`、`processingDuration`）— `documents` 表已存在
- 信心度 — 來自既有關聯 `extraction_results.average_confidence`
- 上傳者 — 來自既有關聯 `uploader`

因不改 schema，**不觸發 H1（Architectural Change Constraint）**。

---

## 設計決策

1. **檔名完整顯示用換行而非加寬固定值** — 避免在不同檔名長度下出現過寬或仍被截斷的問題；`whitespace-normal break-all` 能自適應。
2. **上傳時間統一改 `formatDateTime`** — 符合 `.claude/rules/i18n.md`「日期統一用格式化工具」，並移除 date-fns 相對時間依賴的 orphan import。
3. **處理時間採 D4 方案（開始＋結束＋耗時全顯示）** — 提供完整處理脈絡，方便排查；耗時以毫秒轉可讀格式呈現。
4. **信心度權威來源用 `extraction_results.average_confidence`** — `Document` 模型無 confidence 欄位，避免引入冗餘欄位（不改 schema）；數值已是 0–100，用 `formatPercent` 不需再 ×100。
5. **上傳者顯示 `name` 優先、`email` fallback** — 符合 H4（PII），避免在列表直接暴露所有人 email，且絕不 log email。
6. **序號（No.）欄不在本 CHANGE 範圍** — 見下方「依賴」。

---

## 依賴

| 項目 | 說明 |
|------|------|
| 序號欄（No.） | **不在本 CHANGE 範圍**。序號由 **CHANGE-087**（全站共用 DataTable 封裝）統一提供；documents 列表後續將套用該封裝。建議 CHANGE-087 Phase 1 封裝先行，本 CHANGE 聚焦欄位內容增強，兩者解耦。 |

---

## 影響範圍評估

### 文件影響清單

| 文件路徑 | 類型 | 說明 |
|----------|------|------|
| `src/services/document.service.ts` | 🔧 修改 | `getDocuments` select 加處理時間 3 欄 + extractionResult.averageConfidence |
| `src/hooks/use-documents.ts` | 🔧 修改 | `DocumentListItem` type 加處理時間欄位 + confidence |
| `src/components/features/document/DocumentListTable.tsx` | 🔧 修改 | 放寬檔名、上傳時間改絕對時間、新增 3 欄、清理 date-fns orphan import |
| `messages/en/documents.json` | 🔧 修改 | 新增處理時間／上傳者 column key |
| `messages/zh-TW/documents.json` | 🔧 修改 | 同上 |
| `messages/zh-CN/documents.json` | 🔧 修改 | 同上 |

### 向後兼容性

- **資料層**：全部為 `select`/type 的純加法，不刪除既有欄位，不改 API 既有回傳結構（僅增欄）。既有呼叫端不受影響。
- **Schema**：不變更，無 migration，無資料相容性風險。
- **UI**：表格欄位由 6 欄增為 9 欄，屬增量呈現；既有功能（選擇、狀態、處理路徑、操作）不變。
- **i18n**：信心度 key 已存在；其餘為新增 key，不改既有 key 名，不影響其他頁面。
- **date-fns**：移除的是 `DocumentListTable.tsx` 內因改動而 unused 的 import，date-fns 套件本身保留（其他檔案可能仍使用），不涉及 H2。

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | 檔名完整顯示 | 列表中長檔名不再被截斷，完整可見（換行或加寬） | High |
| 2 | 上傳時間絕對化 | 上傳時間顯示為絕對日期時間（如 2026年6月20日 14:30），隨 locale 格式化 | High |
| 3 | 處理時間欄 | 新增欄位顯示處理開始時間、結束時間與耗時；無資料時顯示佔位符（如 --） | High |
| 4 | 信心度欄 | 新增欄位以 `ConfidenceBadge` 顯示 `average_confidence`（0–100），無 extraction 結果時顯示佔位符 | High |
| 5 | 上傳者欄 | 新增欄位顯示上傳者 name（無 name 時顯示 email），不洩漏／不 log email | High |
| 6 | i18n 同步 | 新增 column header 三語言皆有翻譯，`npm run i18n:check` 通過 | High |
| 7 | 類型檢查 | `npm run type-check` 通過 | High |
| 8 | Lint | `npm run lint` 無 warning（含移除 date-fns orphan import） | Med |
| 9 | 不改 schema | `prisma/schema.prisma` 無變更，無新增 migration | High |

---

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | 長檔名顯示 | 上傳/瀏覽含長檔名的文件，查看列表 | 檔名完整顯示，不被截斷 |
| 2 | 上傳時間格式 | 切換 en / zh-TW / zh-CN，查看上傳時間欄 | 各語言皆顯示對應格式的絕對日期時間 |
| 3 | 處理完成文件 | 瀏覽已完成處理的文件 | 處理時間欄顯示開始、結束時間與耗時；信心度欄顯示 Badge |
| 4 | 未處理／處理中文件 | 瀏覽尚未產生 extraction 結果或處理中的文件 | 處理時間／信心度欄顯示佔位符（如 --），不報錯 |
| 5 | 信心度數值正確 | 對照詳情頁信心度與列表 Badge 數值 | 兩者一致，且為 0–100 範圍（未誤乘 100） |
| 6 | 上傳者顯示 | 瀏覽不同上傳者的文件；含有 name 與僅有 email 兩種 | 有 name 顯示 name，無 name 顯示 email；email 不出現在 log |
| 7 | i18n 完整性 | 執行 `npm run i18n:check` | 通過，無缺漏 key |
| 8 | 回歸：既有欄位 | 查看選擇、狀態、處理路徑、操作欄 | 功能與顯示維持原樣 |

---

## 自我檢查（H 約束）

- **H1（架構變更）**：不觸發。5 個子項全部不改 Prisma schema、不改三層映射、不改信心度路由邏輯、不改 vendor。
- **H4（Security/PII）**：上傳者欄顯示 name 優先、email fallback，且不得 log email。
- **H5（i18n）**：新增 column header 需 en/zh-TW/zh-CN 三語言同步，完成後跑 `npm run i18n:check`。
- **H3（Task Scope）**：序號欄明確劃出範圍（歸 CHANGE-087）；移除的 date-fns import 屬本次改動造成的 orphan，依規清理。

---

## 實作記錄（2026-06-21）

於分支 `feature/change-084-087-phase1` 實作完成。

### 實際修改檔案

| 檔案 | 修改內容 |
|------|----------|
| `src/services/document.service.ts` | `getDocuments` select 加 `processingStartedAt/EndedAt/Duration` + `extractionResult: { select: { averageConfidence: true } }`；`DocumentSummary` 型別同步加欄位 |
| `src/hooks/use-documents.ts` | `DocumentListItem` 加處理時間 3 欄 + `extractionResult` |
| `src/components/features/document/DocumentListTable.tsx` | 移除 date-fns（`formatDistanceToNow`/`zhTW`/`enUS`）改用 `formatDateTime`；放寬檔名（`truncate max-w-[200px]` → `break-all`）；上傳時間改絕對時間；新增「處理時間 / 信心度 / 上傳者」3 欄（`ConfidenceBadge`、`formatDateTime`）；`useLocale() as Locale` |
| `messages/{en,zh-TW,zh-CN}/documents.json` | `table.columns` 加 `processingTime`/`uploader`；`table.processing` 新增 `started`/`ended`/`duration`/`durationValue`（confidence 表頭原已存在） |

### 與規劃的合理差異（非偏離設計意圖）

- **信心度採巢狀 `extractionResult.averageConfidence` 而非扁平 `confidence`**：因 API route（`/api/documents/route.ts`）以 `...result` 原樣 spread、無白名單，service select 的巢狀形狀直達前端，hook 無 transform。採巢狀型別最少改動、資料原樣傳遞（Karpathy §1.2/§1.3），組件讀 `doc.extractionResult?.averageConfidence`。語意目標（顯示信心度）完全達成，未改 API 層。
- **耗時格式化**：專案無現成 duration 工具，採 i18n `table.processing.durationValue`（`{seconds}` 插值，以秒呈現一位小數），單位走三語言（en `s` / 中文「秒」），不硬編碼。

### 驗證結果

- `npm run type-check`：通過（exit 0；`useLocale()` 補 `as Locale` 後解決 3 處型別錯）
- `npm run lint`：通過（改動檔案無新 warning；`document.service.ts:627` console 為既有 warning，非本次引入）
- `npm run i18n:check`：通過；三語言 `documents.json` JSON 解析有效
- **未改 schema**：`prisma/schema.prisma` 無變更，無 migration

### 後續

- 本檔的 `DocumentListTable.tsx` 將由 **CHANGE-087 Phase 1**（documents 試點）在此 9 欄基礎上遷移為共用 DataTable 並加 No. 序號欄。
