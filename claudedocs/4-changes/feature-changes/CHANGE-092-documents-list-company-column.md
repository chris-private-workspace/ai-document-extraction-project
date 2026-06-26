# CHANGE-092: 文件列表表格加回公司名稱欄位

> **日期**: 2026-06-24
> **狀態**: ✅ 已完成（2026-06-26 實作）
> **優先級**: Medium（使用者測試後反饋的顯示缺漏）
> **類型**: UI Enhancement
> **影響範圍**: 文件列表（`/[locale]/documents`）資料鏈 + 表格欄位 + i18n
> **Epic 範圍**: Epic 2（手動發票上傳與 AI 處理）

---

## 變更背景

使用者反映 `http://localhost:3200/en/documents` 的文件列表表格**沒有顯示公司名稱**，要求加回。

調查確認：
- 公司名稱在**處理過程中已擷取並儲存**（V3 Stage 1 公司識別 → `Document.companyId`），文件詳情頁已透過 `company` 關聯顯示，但**列表頁沒有**。
- 目前列表表格欄位（`DocumentListTable.tsx`）：文件名稱 / 狀態 / 處理路徑 / 上傳時間 / 處理時間 / 信心度 / 上傳者 / 操作 — **無公司欄**。
- 資料鏈缺口：`DocumentListItem`（`use-documents.ts:56-79`）型別無 `company`；列表 API（`/api/documents` GET → `document.service.ts` 的 `getDocuments`）未 select 公司。

---

## 變更內容

在文件列表表格新增「公司」欄位，顯示該文件識別出的公司名稱（`company.name`）；無公司（未識別/處理中）時顯示 `--`。

---

## 技術設計

### 修改範圍

| 文件 | 類型 | 變更內容 |
|------|------|----------|
| `src/services/document.service.ts` | 🔧 修改 | `getDocuments` 查詢加 `company: { select: { id, name } }`，回傳結構帶 company |
| `src/hooks/use-documents.ts` | 🔧 修改 | `DocumentListItem` 介面新增 `company: { id: string; name: string } \| null` |
| `src/components/features/document/DocumentListTable.tsx` | 🔧 修改 | 新增「公司」欄（建議置於「文件名稱」之後），無值顯示 `--` |
| `messages/en/documents.json` | 🔧 修改 | `table.columns.company` |
| `messages/zh-TW/documents.json` | 🔧 修改 | 同上 |
| `messages/zh-CN/documents.json` | 🔧 修改 | 同上 |

### i18n 影響

| 語言 | Key | 值 |
|------|-----|-----|
| en | `table.columns.company` | Company |
| zh-TW | `table.columns.company` | 公司 |
| zh-CN | `table.columns.company` | 公司 |

> 完成後執行 `npm run i18n:check`。

### 資料庫影響

無 schema 變更（`Document.companyId` + `company` 關聯皆已存在，僅需在列表查詢 select）。

---

## 設計決策

1. **資料來源用 `company.name`**：與詳情頁一致（詳情頁顯示 `company?.name`）。
2. **欄位位置**：置於「文件名稱」之後，符合「文件 → 屬於哪家公司」的閱讀順序（實作時可依版面微調，不影響資料）。
3. **效能**：`getDocuments` 已是分頁查詢，多 join 一個 `company`（1:1）成本可忽略。

---

## 影響範圍評估

### 向後兼容性
- 純新增欄位與查詢欄位，不改既有欄位/行為。`company` 為 nullable，未識別公司的舊文件顯示 `--`。

### 文件影響清單

| 文件路徑 | 類型 | 說明 |
|----------|------|------|
| `src/services/document.service.ts` | 🔧 修改 | 列表查詢加 company |
| `src/hooks/use-documents.ts` | 🔧 修改 | 型別加 company |
| `src/components/features/document/DocumentListTable.tsx` | 🔧 修改 | 加公司欄 |
| `messages/{en,zh-TW,zh-CN}/documents.json` | 🔧 修改 | 加欄位標題 |

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | 公司欄顯示 | 列表表格出現「公司」欄，已識別公司的文件顯示公司名稱 | High |
| 2 | 空值處理 | 未識別公司的文件顯示 `--`，不報錯 | High |
| 3 | i18n | en/zh-TW/zh-CN 欄位標題正確，`npm run i18n:check` 通過 | High |
| 4 | 品質 gate | `type-check` / `lint` 通過 | High |

---

## 實作結果（2026-06-26）

### 實際修改檔案

| 文件 | 類型 | 說明 |
|------|------|------|
| `src/services/document.service.ts` | 🔧 修改 | `getDocuments` 查詢 select 加 `company: { id, name }`；`DocumentSummary` 介面加 `company` 欄位 |
| `src/hooks/use-documents.ts` | 🔧 修改 | `DocumentListItem` 介面加 `company: { id; name } \| null` |
| `src/components/features/document/DocumentListTable.tsx` | 🔧 修改 | 「文件名稱」欄後新增「公司」欄，無值顯示 `--` |

### 規劃偏差（i18n 無需改動）

- 規劃假設需新增 `table.columns.company`，但實際調查發現 **en / zh-TW / zh-CN 三語言皆已存在**該 key（`Company` / `公司` / `公司`），僅前端表格未使用。故本次**未改任何 i18n 檔**，直接複用既有 key。
- API route（`src/app/api/documents/route.ts`）以 `...result` 展開 service 回傳，未經 map 過濾，故 service select `company` 後即自動傳遞到前端，無需改 API。

### 驗證

| 項目 | 結果 |
|------|------|
| `npm run type-check` | ✅ 通過 |
| `npm run lint`（改動範圍） | ✅ 無新增 error/warning（`document.service.ts:627` 為既有 console warning，非本次引入，屬已知差異 #3） |
| `npm run i18n:check` | ✅ 通過（key 本就存在且三語言一致） |
