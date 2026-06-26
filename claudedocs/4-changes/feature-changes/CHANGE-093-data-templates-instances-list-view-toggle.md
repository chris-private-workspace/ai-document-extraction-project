# CHANGE-093: 資料模板 / 模板實例頁面新增「卡片 ↔ 列表」檢視切換

> **日期**: 2026-06-24
> **狀態**: ✅ 已完成（2026-06-26 實作）
> **優先級**: Medium（使用者測試後反饋的可用性需求）
> **類型**: UI Enhancement
> **影響範圍**: `/[locale]/admin/data-templates` 與 `/[locale]/template-instances` 兩頁的清單呈現 + i18n
> **Epic 範圍**: Epic 19（資料模板匹配與匯出）

---

## 變更背景

使用者反映以下兩頁「需要有列表顯示的選項」：
- `http://localhost:3200/en/admin/data-templates`
- `http://localhost:3200/en/template-instances`

調查確認：
- 兩頁目前**只有卡片網格**（`DataTemplateList.tsx:90`、`TemplateInstanceList.tsx:250`，皆 `grid md:grid-cols-2 lg:grid-cols-3`），**無列表檢視、無切換**。
- 資料量大時，卡片網格不利快速掃描/比較，使用者要列表（表格）選項。
- 專案已有共用 `DataTable` 組件（`src/components/features/common/DataTable.tsx`，documents/rules/companies/escalations 在用），可作為列表版基礎；但**目前沒有任何「卡片/列表切換」的既有 pattern**（屬本 CHANGE 首次引入）。

---

## 變更內容

為兩頁各新增「卡片 / 列表」檢視切換：
1. 工具列加切換按鈕（卡片網格圖示 / 列表圖示）。
2. 列表檢視用共用 `DataTable` 呈現（複用既有序號欄/樣式）。
3. 卡片檢視維持現狀。
4. 檢視偏好記憶（見設計決策）。

### 列表檢視建議欄位

| 頁面 | 欄位 |
|------|------|
| data-templates | 名稱、描述、欄位數、是否啟用、更新時間、操作（編輯/刪除）|
| template-instances | 名稱、所屬模板、狀態（徽章）、行數（總/有效/錯誤）、更新時間、操作 |

---

## 技術設計

### 修改範圍

| 文件 | 類型 | 變更內容 |
|------|------|----------|
| `src/components/features/common/ViewToggle.tsx`（或就近放置） | 🆕 新增 | 共用「卡片/列表」切換按鈕組（grid / list 圖示），受控 `value` + `onChange` |
| `src/app/[locale]/(dashboard)/admin/data-templates/page.tsx` | 🔧 修改 | 管理 `viewMode` 狀態 + 工具列放 ViewToggle + 條件渲染卡片/列表 |
| `src/app/[locale]/(dashboard)/template-instances/page.tsx` | 🔧 修改 | 同上 |
| `src/components/features/data-template/DataTemplateTable.tsx` | 🆕 新增 | data-template 列表（DataTable 欄位定義） |
| `src/components/features/template-instance/TemplateInstanceTable.tsx` | 🆕 新增 | template-instance 列表（DataTable 欄位定義，含狀態徽章） |
| `messages/{en,zh-TW,zh-CN}/dataTemplates.json` | 🔧 修改 | 檢視切換 aria-label / 列表欄位標題 |
| `messages/{en,zh-TW,zh-CN}/templateInstance.json` | 🔧 修改 | 同上 |

> 列表版欄位標題優先複用既有 i18n（卡片已用的名稱/狀態/行數等 key），僅補缺漏者。

### i18n 影響

| 語言 | 需新增/確認的 Key（範例） |
|------|---------------------------|
| en / zh-TW / zh-CN | `viewToggle.card`、`viewToggle.list`（aria-label）；列表欄位標題（複用既有為主，缺者補：如 `table.columns.*`）|

> 完成後執行 `npm run i18n:check`。

### 資料庫影響

無（純前端呈現方式切換，資料來源不變）。

---

## 設計決策

1. **OQ-B（已決議 2026-06-26）— 檢視偏好持久化**：採用 `localStorage`（每頁獨立 key：`dataTemplates.viewMode` / `templateInstances.viewMode`），重新整理後記住上次選擇。預設 = 卡片（維持現狀，降低意外）。封裝為共用 `useViewMode` hook（SSR-safe：首次 render 用 default，掛載後才讀 localStorage，避免 hydration mismatch；localStorage 不可用時優雅退化）。
2. **列表版複用 `DataTable`**：與 documents/rules 等頁一致，沿用序號欄與樣式，不自造表格（符合 §1.3 Surgical / 既有 pattern）。
3. **ViewToggle 設為共用組件**：本 CHANGE 首次引入，放共用位置，供日後其他卡片頁複用（但本 CHANGE 僅接這兩頁，不擴散範圍，符合 H3）。
4. **template-instances 既有分頁**：列表檢視沿用既有分頁（12 筆/頁）；data-templates 目前無分頁（展示全部），列表檢視維持一致。

---

## 影響範圍評估

### 向後兼容性
- 純新增檢視選項，預設仍為卡片，不改既有卡片行為與資料流。

### 文件影響清單

| 文件路徑 | 類型 | 說明 |
|----------|------|------|
| `ViewToggle.tsx` | 🆕 新增 | 共用切換組件 |
| `DataTemplateTable.tsx` / `TemplateInstanceTable.tsx` | 🆕 新增 | 兩頁列表版 |
| 兩頁 `page.tsx` | 🔧 修改 | 接檢視切換 |
| `messages/{en,zh-TW,zh-CN}/{dataTemplates,templateInstance}.json` | 🔧 修改 | i18n |

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | 切換按鈕 | 兩頁工具列出現「卡片/列表」切換 | High |
| 2 | 列表呈現 | 列表檢視正確顯示各欄位（含狀態徽章、行數）+ 操作可用 | High |
| 3 | 偏好記憶 | 切換後重新整理仍維持上次檢視（OQ-B 確認後）| Medium |
| 4 | 卡片不變 | 卡片檢視維持原樣 | High |
| 5 | i18n | 三語言同步，`npm run i18n:check` 通過 | High |
| 6 | 品質 gate | `type-check` / `lint` 通過 | High |

## 測試場景

| # | 場景 | 步驟 | 預期 |
|---|------|------|------|
| 1 | 切到列表 | data-templates 頁點「列表」 | 以表格顯示模板清單，欄位正確 |
| 2 | 切到列表 | template-instances 頁點「列表」 | 表格顯示實例，狀態徽章/行數正確 |
| 3 | 偏好記憶 | 切列表後重新整理 | 仍為列表檢視 |
| 4 | 操作 | 列表中編輯/刪除/查看 | 與卡片操作行為一致 |
