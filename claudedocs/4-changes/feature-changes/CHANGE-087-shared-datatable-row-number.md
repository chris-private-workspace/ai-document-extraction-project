# CHANGE-087: 全站列表建立共用 DataTable 封裝並加入 No. 序號欄

> **日期**: 2026-06-20
> **狀態**: ⏳ 待實作
> **優先級**: Medium
> **類型**: Refactor（架構）
> **影響範圍**: 全站 35+ 列表組件

---

## 變更背景

全站所有列表頁（documents、companies、rules、review、escalations、admin/users、reference-numbers、exchange-rates、prompt-configs、pipeline-settings 等共 35+ 個列表組件）目前都**沒有顯示記錄序號（No.）**，用戶在審視列表時無法直接得知「這是第幾筆」「本頁共幾筆」，需要自行數行，影響審核與比對效率。

用戶需求（2026-06-20 確認）：**全站所有列表加上「No.」序號欄**，讓用戶易於得知記錄筆數與當前位置。

**現狀調查結論**：

- 本項目**沒有共用的 DataTable 封裝**。grep `DataTable` 僅在 `docs/` 規劃檔出現，`src/` 內無任何實作。
- 唯一的共用表格基礎是 shadcn/ui 的 `src/components/ui/table.tsx`（thin HTML primitive：`Table` / `TableHeader` / `TableHead` / `TableRow` / `TableCell`），屬**不可改的 shadcn 組件**，本身無序號、分頁、欄位定義等邏輯。
- **35+ 個列表組件各自手寫** `<TableHeader>` / `<TableHead>` 表頭與 `<TableBody>` 列渲染：
  - `*Table.tsx` 約 19 個（`DocumentListTable`、`UserTable`、`RuleTable`、`ReviewQueueTable`、`ForwarderTable`、`EscalationListTable` 等）
  - `*List.tsx` 約 16 個（`ReferenceNumberList`、`ExchangeRateList`、`PipelineConfigList`、`OutlookConfigList` 等）
- **目前無任何主列表頁有真正的通用 No. 序號欄**：
  - `MappingRuleList.tsx:139` 的 `index + 1` 是 priority 排序值（非通用列表序號）
  - 兩個 `LineItemsTable` 的行號是發票明細的固有欄位（非通用列表序號）

> **D6 決策**：用戶於 2026-06-20 確認**採共用 DataTable 封裝**方式統一加入序號欄（**而非**逐頁手改 35+ 組件各自塞序號邏輯），並批准引入此新抽象層（見 §設計決策 D6 / Hard Constraint H3）。

---

## 變更內容

### 變更項目 1：新建共用 DataTable 封裝組件

新增一個共用 wrapper 組件，統一封裝列表表格的通用能力，供全站列表組件套用：

- **序號欄（No.）**：在表格最左側加入序號欄，序號採**跨頁連續**計算 `(page - 1) * pageSize + index + 1`（無分頁時退化為 `index + 1`），確保翻頁時序號連續而非每頁從 1 重新計。
- **欄位定義（columns）**：以欄位定義陣列描述表頭與儲存格渲染，取代各組件手寫 `<TableHead>` / `<TableCell>`。
- **可選排序 / 空狀態**：可選地支援欄位排序與空資料時的 empty state 顯示（沿用各頁既有行為，不擴增未要求的能力）。

> 路徑於 §設計決策 D1 確認（候選 `src/components/features/common/DataTable.tsx` 或 `src/components/ui/data-table.tsx`）。

### 變更項目 2：逐頁遷移 35+ 列表組件套用此封裝

將現有 35+ 個手寫表格的列表組件（`*Table.tsx` 約 19 + `*List.tsx` 約 16）**逐頁遷移**為使用共用 DataTable 封裝，使其自動獲得 No. 序號欄並統一表頭/列渲染寫法。

### 變更項目 3：清理遷移後遺留的手寫表頭/序號邏輯

各組件遷移後，原本手寫的 `<TableHeader>` / `<TableHead>` 表頭與任何臨時序號邏輯成為冗餘（屬本次遷移造成的 orphan），於對應 Phase 一併清理。

---

## 技術設計

### 修改範圍

| 文件 | 變更內容 |
|------|----------|
| `src/components/features/common/DataTable.tsx`（路徑待 D1 確認） | 🆕 新建共用 DataTable 封裝（序號欄 + 欄位定義 + 可選排序/空狀態） |
| `src/components/ui/table.tsx` | 不修改（shadcn primitive，DataTable 內部組合它） |
| 35+ 列表組件（`*Table.tsx` ~19 + `*List.tsx` ~16） | 🔧 逐頁遷移為套用 DataTable，移除手寫表頭/序號 |
| `messages/{en,zh-TW,zh-CN}/common.json` | 🔧 新增 `table.columns.no` 序號表頭文字（3 語言同步） |

> 35+ 組件完整清單於 Phase 2 遷移時逐模組列出並核對；代表性列表頁見 §變更背景。

### i18n 影響

「No.」序號欄表頭為使用者可見文字，必須 i18n（H5）。建議集中於 `common.json` 的 `table.columns.no`，由 DataTable 封裝統一讀取，避免每頁各自定義。

| 語言 | 文件 | 需要更新的 Key |
|------|------|---------------|
| en | `messages/en/common.json` | `table.columns.no`（建議值：`No.`） |
| zh-TW | `messages/zh-TW/common.json` | `table.columns.no`（建議值：`編號` 或 `No.`，由實作時確認） |
| zh-CN | `messages/zh-CN/common.json` | `table.columns.no`（同上對應簡體） |

> 完成前必跑 `npm run i18n:check` 確認 3 語言同步。

### 資料庫影響

無。本變更為前端組件層重構，不涉及 Prisma Schema、不改三層映射 / 信心度路由（**不觸發 H1**）。

---

## 設計決策

1. **D1 — DataTable 封裝路徑** — 候選兩處：(a) `src/components/features/common/DataTable.tsx`（features 領域共用，目前該目錄不存在，需新建）；(b) `src/components/ui/data-table.tsx`（緊鄰 shadcn `table.tsx`，符合 shadcn data-table 慣例）。**實作前於本節確認**，預設傾向 (b)（與 shadcn 慣例一致、就近組合 `table.tsx`），最終以實作時的目錄一致性為準。
2. **D2 — 序號採跨頁連續** — 序號計算 `(page - 1) * pageSize + index + 1`，翻頁時連續遞增而非每頁重置為 1，符合「易知記錄筆數」的需求；列表無分頁時退化為 `index + 1`。各列表的 `page` / `pageSize` 來源沿用該頁既有分頁狀態傳入。
3. **D3 — 序號欄置於最左** — No. 欄固定為表格第一欄，符合一般列表閱讀慣例。
4. **D4 — 序號表頭集中於 `common.json`** — 由 DataTable 統一讀 `table.columns.no`，避免 35+ 組件各自硬編碼或各自定義 key（同時滿足 H5）。
5. **D5 — 不擴增未要求能力** — DataTable 僅封裝「序號欄 + 欄位定義 + 沿用各頁既有的排序/空狀態」，**不**新增用戶未要求的篩選器、欄位顯隱、虛擬捲動等 flexibility（Karpathy §1.2 Simplicity First；避免 H3 範圍蔓延）。
6. **D6 — 引入新抽象層（共用 DataTable）已獲批准** — 引入全站共用 DataTable 屬新增抽象層，觸發 H3（task scope / 新抽象層）。**用戶已於 2026-06-20 explicit 批准**採封裝方式（而非逐頁手改）。記錄於此作為 H3 approval 依據。

---

## 影響範圍評估

### 文件影響清單

| 文件路徑 | 類型 | 說明 |
|----------|------|------|
| `src/components/features/common/DataTable.tsx`（或 `ui/data-table.tsx`，待 D1） | 🆕 新增 | 共用封裝 |
| `*Table.tsx`（~19 個列表組件） | 🔧 修改 | 遷移套用 DataTable + 移除手寫表頭/序號 |
| `*List.tsx`（~16 個列表組件） | 🔧 修改 | 同上 |
| `messages/{en,zh-TW,zh-CN}/common.json` | 🔧 修改 | 新增 `table.columns.no` ×3 語言 |

### 向後兼容性

- DataTable 為**新增**組件，建立階段不影響任何既有頁面。
- 遷移為**逐頁替換**：每頁遷移後該列表多出 No. 欄、其餘欄位與行為（排序、空狀態、點擊、分頁）須與遷移前一致，屬**視覺增量 + 寫法統一**，不改資料、不改 API、不改路由。
- 未遷移的列表頁在遷移完成前**維持原樣**正常運作（新舊寫法可共存），故可分批漸進 ship，不需一次全量切換。
- 風險集中於「遷移時是否完整保留各頁原有欄位定義與行為」與「分頁序號計算是否正確」（見 §風險評估）。

---

## 實施計劃（分階段）

| 階段 | 範圍 | 驗證 | 狀態 |
|------|------|------|------|
| Phase 1 | 建 DataTable 封裝 + 試點 1–2 個列表（建議 documents 列表，與 CHANGE-084 協作）；同步新增 `common.json` `table.columns.no` ×3 語言 | type-check / lint 通過；試點頁 No. 欄正確、跨頁序號連續、原欄位與行為無回歸；`i18n:check` 通過 | ⏳ 待實作 |
| Phase 2 | 分批遷移其餘 ~33 個列表組件（按模組分批：documents → companies/rules → review/escalations → admin → reference/exchange/pipeline/prompt 等），每批獨立驗證 | 每批 type-check / lint / 視覺核對該批列表 No. 欄與原行為一致 | ⏳ 待實作 |
| Phase 3 | 清理各組件遷移後遺留的手寫表頭 / 臨時序號邏輯（orphan 清理） | grep 確認已遷移組件無殘留手寫 `<TableHead>` 重複邏輯；type-check / lint 通過 | ⏳ 待實作 |

> **執行方式**：Phase 2 各組件彼此獨立、無檔案衝突，可並行多 Agent 分批處理（依 `.claude/rules/agent-orchestration.md`）。`common.json` 的 i18n 修改須**集中由單一 Agent 或主 Session 處理**，避免多 Agent 同改一 JSON 造成衝突。
>
> **與 CHANGE-084 協調**：見 §依賴。建議 Phase 1 的 documents 試點與 CHANGE-084 協調或先行，避免重工。

---

## 風險評估

| 風險 | 等級 | 緩解 |
|------|------|------|
| 大量組件（35+）遷移的回歸風險（漏欄位、排序/點擊/空狀態行為改變） | 中 | 分批遷移（Phase 2 按模組）、每批獨立 type-check / lint / 視覺核對；單頁可獨立回滾 |
| 跨頁序號計算錯誤（翻頁不連續、無分頁頁誤用 page 公式） | 中 | DataTable 內統一處理序號公式並於 Phase 1 試點頁驗證跨頁連續性；無分頁時退化為 `index + 1` |
| 不同列表的分頁狀態來源不一致（部分頁 client 端分頁、部分 server 端） | 中 | 遷移每頁時確認 `page` / `pageSize` 正確傳入；無分頁頁不傳分頁參數 |
| `common.json` 多 Agent 並行修改衝突 | 低 | i18n 修改集中單一處理（見實施計劃備註） |
| 引入新抽象層後與既有 shadcn `table.tsx` 用法分歧 | 低 | DataTable 內部組合 shadcn primitive，不取代、不修改 `table.tsx` |

## 回滾計劃

- **封裝為新增、遷移為逐頁替換** → 可**分批 ship、單頁回滾**。
- 若某頁遷移後出現回歸：`git revert` 該頁遷移 commit，還原該頁原本手寫表頭即可，不影響其他已遷移頁與 DataTable 封裝本身。
- 若需整體放棄：DataTable 為新增檔，移除引用後刪除即可；`common.json` 的 `table.columns.no` 為新增 key，移除不影響既有翻譯。
- 無資料庫 / API / 路由變更，回滾無資料或狀態副作用。

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | 共用 DataTable 建立 | DataTable 封裝存在且支援序號欄 + 欄位定義 + 可選排序/空狀態 | High |
| 2 | 序號欄顯示 | 已遷移列表最左側顯示 No. 欄 | High |
| 3 | 跨頁序號連續 | 有分頁列表翻頁時序號連續（`(page-1)*pageSize+index+1`） | High |
| 4 | i18n 同步 | `table.columns.no` 於 en/zh-TW/zh-CN 三語言齊全；`npm run i18n:check` 通過 | High |
| 5 | 行為無回歸 | 已遷移列表的欄位、排序、點擊、空狀態、分頁與遷移前一致 | High |
| 6 | 全站列表覆蓋 | 35+ 列表組件全部遷移完成並具 No. 欄 | Medium |
| 7 | 型別 / Lint 通過 | `npm run type-check`、`npm run lint` 無新增錯誤 | High |
| 8 | orphan 清理 | 已遷移組件無殘留重複的手寫表頭/序號邏輯 | Medium |

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | 試點列表序號 | 開 documents 列表 | 最左 No. 欄由 1 起遞增 |
| 2 | 跨頁序號連續 | documents 列表第 1 頁→第 2 頁（pageSize 20） | 第 2 頁首列序號為 21 而非 1 |
| 3 | 無分頁列表 | 開無分頁的小型列表 | No. 欄由 1 起，序號 = index+1 |
| 4 | 行為無回歸 | 已遷移列表執行排序 / 點擊列 / 觸發空狀態 | 與遷移前行為一致 |
| 5 | i18n 表頭 | 切換 en / zh-TW / zh-CN | No. 欄表頭顯示對應語言文字 |
| 6 | 分批回滾 | revert 單一已遷移頁 commit | 該頁還原手寫表頭，其餘已遷移頁與 DataTable 不受影響 |

---

## 依賴

- **CHANGE-084（documents 列表欄位增強）** 會套用本 CHANGE 建立的共用 DataTable。
  - 建議本 CHANGE 的 **Phase 1（封裝 + documents 試點）先行或與 CHANGE-084 協調實作**，避免兩者各自改 documents 列表造成重工 / 衝突。
  - 若 CHANGE-084 先動 documents 列表，本 CHANGE 的 documents 試點需在其基礎上套用 DataTable；反之 CHANGE-084 應在本 CHANGE 的 DataTable 上擴增欄位。實作時於兩文件互相標註協調結果。

---

## Hard Constraint 檢核

| 約束 | 是否觸發 | 處理 |
|------|----------|------|
| H1（架構 / 三層映射 / 信心度 / Prisma） | 否 | 純前端組件層重構，不涉及 |
| H3（task scope / 新抽象層） | **是** | 引入全站共用 DataTable 抽象層 — **用戶已於 2026-06-20 批准**（見 §設計決策 D6） |
| H5（i18n / 硬編碼） | **是** | 「No.」表頭 3 語言同步於 `common.json` `table.columns.no`，完成前跑 `npm run i18n:check` |
