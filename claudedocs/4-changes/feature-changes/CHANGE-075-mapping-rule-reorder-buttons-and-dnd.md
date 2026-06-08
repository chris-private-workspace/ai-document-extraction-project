# CHANGE-075: Template Field Mapping 規則排序（↑↓ 按鈕 + 拖放）

> **日期**: 2026-06-03
> **狀態**: ✅ 已完成（實作 2026-06-03；建議補手動/E2E 驗證見 §實作記錄）
> **優先級**: Medium
> **類型**: UX Enhancement
> **影響範圍**: Template Field Mapping 規則編輯器（`/admin/template-field-mappings/[id]` 與 `/new`）
> **關聯**: Epic 19 - Story 19.4（模板欄位映射）；參考 CHANGE-005（unified pipeline step reorder）、Epic 13 SortableRuleItem（拖放範式）

---

## 變更背景

Template Field Mapping 的規則編輯器（`MappingRuleEditor` / `MappingRuleItem`）目前**無法調整規則順序**：

- `MappingRuleItem.tsx` 第 173-174 行有一個 `GripVertical` 圖示，包在 `<div className="cursor-move">` 中，**只是把游標變成移動樣式，沒有綁任何拖放事件** → UI 看起來可拖、實際不能動，造成使用者誤解（本 CHANGE 的觸發來源）。
- `MappingRuleEditor.tsx` 只有 `handleAddRule`（append 到最後）、`handleRuleChange`、`handleDeleteRule`（刪除後重新編號）、`handleExpandToggle`，**完全沒有 move / reorder handler**。
- 每條 rule 雖有 `order` 欄位，但只會跟「新增先後」走，使用者無法重排。

### 為何 order 重要（不只是視覺）

規則順序不是純視覺問題。文件匹配投影時，合併路徑 `template-field-mapping.service.ts` 第 447 行會 `.sort((a, b) => a.order - b.order)` 決定**輸出欄位的排列順序**。因此「排序」直接影響匯出/投影結果的欄位次序，是有實際語意的功能缺口。

---

## 變更內容

讓使用者能在規則編輯器中重新排列 Mapping Rules，**同時提供兩種互動方式**（依使用者決策 2026-06-03：兩者都做）：

### 變更項目 1：↑↓ 上下按鈕（精準 / 可及性）

仿照 `DataTemplateFieldEditor.tsx` 的 `handleMoveUp` / `handleMoveDown` 範式，在每條規則列加上下移動按鈕，邊界時 `disabled`（第一列不能上移、最後一列不能下移）。提供鍵盤可操作、單步精準的排序方式。

### 變更項目 2：拖放排序（直覺）

仿照 `src/components/features/mapping-config/SortableRuleItem.tsx` 的 `@dnd-kit/sortable` 範式，把現有那個**裝飾性的 `GripVertical` 接成真正的拖放手柄**。`@dnd-kit` 已是專案既有依賴（`package.json`：`@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/utilities`），不觸發 H2。

### 變更項目 3：排序後同步 `order` 與展開狀態

- 每次移動（按鈕或拖放）後，**重新編號所有 rule 的 `order` 為其新陣列索引**（比照 `handleDeleteRule` 第 114-117 行的既有模式），確保持久化與投影排序正確。
- 正確維護「展開中的規則」：目前 `expandedIndex` 是以陣列索引追蹤，重排後索引會錯位 → 需改以**穩定的 client 端 id 追蹤展開狀態**（拖放亦需穩定 id）。

---

## 技術設計

### 核心結論：純前端變更，無需動後端

| 層級 | 結論 |
|------|------|
| Prisma Schema | ❌ 無需變更（`mappings` 已是 JSON 陣列，內含 `order`） |
| API / Service | ❌ 無需變更。提交時 `TemplateFieldMappingForm` 第 282-290 行已逐欄位重建 payload 並寫 `order: r.order ?? i`；`getById`（service 第 512 行）原樣回傳陣列、按陣列順序顯示 |
| 前端 | ✅ 僅 `MappingRuleEditor` + `MappingRuleItem` + i18n |

> 因規則以 JSON 陣列持久化、且讀取/顯示皆按陣列順序，排序只要改變 React state 陣列順序即可生效；`order` 重新編號是為了讓投影合併路徑（service 第 447 行）排序正確。

### 穩定 client id 設計（拖放與展開狀態的前提）

`@dnd-kit` 要求每個 sortable item 有穩定 `id`，但目前 `MappingRuleEditor` 以 `key={index}` 渲染、規則無 client 端 id。需為每條規則維護一個**暫態 client id**（不持久化）：

- 方案（建議）：在 `mappingRules` state 的每個物件加一個暫態欄位（如 `__clientId`）。**提交時不會外洩** —— 父層 `onSubmit`（第 282-290 行）是逐欄位挑選重建 payload，任何額外欄位都會被丟棄。
- 替代方案：維護一個與 `rules` 長度同步的獨立 `ids` 陣列。

### 修改範圍

| 檔案 | 變更內容 |
|------|----------|
| `src/components/features/template-field-mapping/MappingRuleEditor.tsx` | 加 `handleMoveUp/handleMoveDown` 與 `handleDragEnd`（用 `arrayMove`）；包 `DndContext` + `SortableContext`（`verticalListSortingStrategy`）+ sensors（Pointer + Keyboard）；移動後重新編號 `order`；改以穩定 client id 追蹤 `expanded` 狀態 |
| `src/components/features/template-field-mapping/MappingRuleItem.tsx` | 接 `useSortable`（`setNodeRef/attributes/listeners/transform/transition/isDragging`）；把 `GripVertical` 接成拖放手柄（移除純裝飾的 `cursor-move`）；新增 ↑↓ 按鈕（邊界 `disabled`）；接收 `index/total` 或 `isFirst/isLast` 與 `onMoveUp/onMoveDown` |
| `messages/en/templateFieldMapping.json` | 新增 `rule.moveUp` / `rule.moveDown`（按鈕 aria-label / tooltip）、必要時 `rule.dragHandle` |
| `messages/zh-TW/templateFieldMapping.json` | 同上（繁中） |
| `messages/zh-CN/templateFieldMapping.json` | 同上（簡中） |

### i18n 影響

| 語言 | 檔案 | 需新增的 Key |
|------|------|-------------|
| en | `messages/en/templateFieldMapping.json` | `rule.moveUp`、`rule.moveDown`、`rule.dragHandle` |
| zh-TW | `messages/zh-TW/templateFieldMapping.json` | 同上 |
| zh-CN | `messages/zh-CN/templateFieldMapping.json` | 同上 |

> 完成後執行 `npm run i18n:check`。

### 資料庫影響

無。

---

## 設計決策

1. **兩種互動方式並存** — 使用者明確要求（2026-06-03）。↑↓ 按鈕提供可及性與精準單步；拖放提供直覺批次移動。`@dnd-kit` 的 KeyboardSensor 也讓拖放本身具鍵盤可操作性。
2. **純前端、不動後端** — 持久化與讀取皆走陣列順序，無需新增 API 或改 schema，符合 Simplicity First。
3. **移動後強制重新編號 `order`** — 否則投影合併路徑（service 第 447 行 `.sort` by order）會用到陳舊 `order`，導致匯出/投影欄位順序錯誤。此為正確性要求，非美化。
4. **展開狀態改用穩定 client id 追蹤** — 重排會打亂 index-based 的 `expandedIndex`；改用穩定 id 才不會「拖了 A、展開的卻變成 B」。
5. **暫態 client id 不持久化** — 利用父層逐欄位重建 payload 的既有行為，天然過濾掉 `__clientId`，不污染 API 與資料庫。
6. **不改 `DataTemplateFieldEditor`** — 那是另一個編輯器（欄位定義），已有可用 ↑↓，不在本 scope。

---

## 影響範圍評估

### 文件影響清單

| 文件路徑 | 類型 | 說明 |
|----------|------|------|
| `src/components/features/template-field-mapping/MappingRuleEditor.tsx` | 🔧 修改 | 加排序邏輯、DndContext、order 重編號、展開狀態 id 化 |
| `src/components/features/template-field-mapping/MappingRuleItem.tsx` | 🔧 修改 | useSortable、拖放手柄、↑↓ 按鈕 |
| `messages/{en,zh-TW,zh-CN}/templateFieldMapping.json` | 🔧 修改 | 3 語言新增移動/拖放相關 key |

### 向後兼容性

- **既有資料**：現有 mapping 記錄的 `order` 維持不變；不重排即不變動，純加功能。
- **API contract**：不變（payload 形狀與既有 `order` 欄位相同）。
- **既有行為**：新增 rule 仍 append 到最後；刪除仍重新編號 —— 不受影響。

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | ↑↓ 按鈕可用 | 點上/下移按鈕，規則於列表即時換位；第一列「上移」與最後一列「下移」為 disabled | High |
| 2 | 拖放可用 | 拖動 `GripVertical` 手柄可重排規則；拖動中有視覺回饋（半透明/陰影） | High |
| 3 | order 同步 | 任一方式移動後，提交並重新進入編輯頁，順序維持不變 | High |
| 4 | 投影順序正確 | 重排後跑一次模板匹配，輸出欄位順序符合新的規則順序 | High |
| 5 | 展開狀態正確 | 某規則展開時移動它（或移動其他規則），展開的仍是同一條規則、不錯位 | Medium |
| 6 | 暫態 id 不外洩 | 提交後檢查 API payload 與 DB，無 `__clientId` 等暫態欄位 | Medium |
| 7 | i18n 三語同步 | ↑↓ 按鈕 aria-label / tooltip 三語齊全，`npm run i18n:check` 通過 | Medium |
| 8 | 既有行為不退化 | 新增/刪除規則、編輯 source/target/transform 行為與改動前一致 | High |
| 9 | 型別與 lint | `npm run type-check`、`npm run lint` 無錯誤 | High |

---

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | 按鈕上移 | 編輯一個有 ≥3 條規則的 mapping，點第 3 條的「上移」 | 第 3 條移到第 2 位，order 對調，畫面即時更新 |
| 2 | 按鈕邊界 | 觀察第 1 條的「上移」與最後一條的「下移」 | 兩者皆 disabled 不可點 |
| 3 | 拖放重排 | 把第 1 條拖到第 4 條之後 | 規則落到新位置，其餘自然位移，拖動中有視覺回饋 |
| 4 | 持久化 | 任一方式重排後按儲存 → 重新進入編輯頁 | 順序與儲存前一致 |
| 5 | 投影順序 | 重排後對一份文件跑模板匹配 | 匯出/投影欄位順序 = 新規則順序 |
| 6 | 展開中移動 | 展開第 2 條後，將其拖到最後 | 仍是該條保持展開，內容正確 |
| 7 | 新建頁 | 在 `/new` 加 4 條規則後重排再建立 | 建立成功，順序如所排 |
| 8 | payload 乾淨 | DevTools 觀察提交的 request body | 僅含 `sourceField/targetField/transformType/transformParams/isRequired/order/description`，無暫態欄位 |

---

## 實作備註（給實作者）

- ↑↓ 範式直接參考 `DataTemplateFieldEditor.tsx` 第 145-175 行（`handleMoveUp/handleMoveDown` + `order: i + 1` 重編號）。
- 拖放範式直接參考 `mapping-config/SortableRuleItem.tsx`（`useSortable` + `CSS.Transform.toString` + `{...attributes} {...listeners}` 綁在手柄 button）；`DndContext`/`SortableContext`/sensors 可參考同目錄使用該組件的父層編輯器。
- ⚠️ `MappingRuleItem` 同時有「展開切換」與「刪除」按鈕，拖放 listeners **只綁在 `GripVertical` 手柄**，避免與點擊操作衝突。
- order 重編號統一在 `MappingRuleEditor` 的移動 handler 內做（單一真實來源），不要分散到子組件。

---

## 實作記錄（2026-06-03）

### 實際修改檔案

| 檔案 | 變更 |
|------|------|
| `src/components/features/template-field-mapping/MappingRuleItem.tsx` | 接 `useSortable`（`@dnd-kit/sortable`）；根 div 套 `setNodeRef`/`style`/拖曳陰影；把裝飾性 `GripVertical` 換成真正的拖放手柄 `<button>`（綁 `attributes`/`listeners`、`aria-label`）；actions 區新增 ↑↓ 按鈕（`ArrowUp`/`ArrowDown`，邊界 `disabled`）；新增 props `total`/`sortableId`/`onMoveUp`/`onMoveDown` |
| `src/components/features/template-field-mapping/MappingRuleEditor.tsx` | 引入 `DndContext`/`SortableContext`/sensors（Pointer 距離 8 + Keyboard）+ `restrictToVerticalAxis`；新增暫態 client id state（`ids` + `makeId` 計數器）；展開狀態改用 `expandedId`（取代 index-based `expandedIndex`）；新增 `handleMove`/`handleMoveUp`/`handleMoveDown`/`handleDragEnd`，移動後以 `order: i` 重新編號；`handleAddRule`/`handleDeleteRule` 同步維護 `ids` 與展開狀態 |
| `messages/{en,zh-TW,zh-CN}/templateFieldMapping.json` | `rule.moveUp` / `rule.moveDown` / `rule.dragHandle` 三語同步 |

### 設計落實要點

- **純前端**：未動 API / service / Prisma schema，符合規劃。
- **order 重編號**：`handleMove` 對 `arrayMove` 後的陣列以 `order: i` 重新編號（與 `handleDeleteRule` 既有 0-based 慣例一致），確保投影合併路徑排序正確。
- **穩定 client id**：`ids` 與 `rules` 在所有 handler 內 lockstep 維護，長度恆等；不持久化（父層 `onSubmit` 逐欄位重建 payload 天然過濾）。
- **展開狀態以 id 追蹤**：重排後不錯位。

### 靜態驗證結果

| 檢查 | 結果 |
|------|------|
| `npm run type-check` | ✅ 本變更兩檔零錯誤（既有錯誤僅在 `tests/` 缺測試型別、`CityDetailPanel.tsx` recharts 型別，與本變更無關） |
| `npm run lint`（兩檔） | ✅ 0 error；5 個 warning 全為**既有** unused import（`Collapsible*`、`TargetFieldDisplay`、`TemplateFieldMappingRule`），本變更未新增 warning |
| `npm run i18n:check` | ✅ 通過 |

### 待辦（建議）

- **手動/E2E 驗證**：依 §測試場景跑一輪（↑↓、拖放、儲存後順序持久化、投影欄位順序、展開中移動、payload 乾淨）。靜態檢查已過，但拖放與持久化的實際行為尚未在瀏覽器中跑過。
- 既有 5 個 unused import warning 屬技術債，可另開 FIX 清理（非本 scope，依 surgical-changes 原則未順手刪）。
