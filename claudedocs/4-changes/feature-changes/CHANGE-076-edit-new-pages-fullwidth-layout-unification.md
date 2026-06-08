# CHANGE-076: 全平台編輯/新建頁版面統一（全寬化）

> **日期**: 2026-06-05
> **狀態**: ✅ 已完成（2026-06-05）
> **優先級**: Medium
> **類型**: UI Enhancement
> **影響範圍**: 15 個編輯/新建頁面（admin + rules + documents/upload）+ 1 個共用元件 bug 修復

---

## 變更背景

目前平台多數**編輯頁（`[id]/page.tsx`）與新建頁（`new/page.tsx`）**使用 `container mx-auto py-6 max-w-2xl|3xl|4xl` 將表單**收窄並置中**。在寬螢幕上，表單卡片左側（靠近側邊導航欄）與右側都留下大片空白，與**列表頁全寬貼齊側欄**（`container mx-auto py-6 space-y-6`，無 `max-w-*`）的視覺不一致，整體版面不平衡。

用戶決定：**全平台所有編輯/新建頁統一移除 `max-w-*` 限制，改為全寬**（比照列表頁），讓內容貼齊側邊欄、撐滿可用寬度（仍受外層 `DashboardLayout` 的 `max-w-[1600px]` 上限約束，超寬螢幕不會無限拉寬）。

> **觸發來源**：用戶在 field-definition-sets 編輯頁發現版面置中留白問題，確認全寬效果後決定推廣至全平台統一。

---

## 變更內容

### 變更項目 1：移除編輯/新建頁的 `max-w-*` 寬度限制

將所有目標頁面根容器的 `container mx-auto py-6 max-w-{2xl|3xl|4xl} [space-y-6]` 統一改為 `container mx-auto py-6 [space-y-6]`（移除 `max-w-*`，保留其餘 class），與列表頁一致。

每個編輯頁通常有 **3 處**需改（主畫面 + 載入中狀態 + 錯誤狀態），新建頁通常 **1 處**。

### 變更項目 2（已完成）：修復 FieldCandidatePicker 候選清單高度洩漏 bug

於 field-definition-sets 編輯頁全寬化後發現的**既有版面 bug**（與寬度變更無關，原因是表單原本窄、少捲到底未被注意）：

- **問題**：[FieldCandidatePicker.tsx:252](../../../src/components/features/field-definition-set/FieldCandidatePicker.tsx#L252) 的候選欄位清單容器 `max-h-[400px] overflow-y-auto` 為 `position: static`，**不是 containing block**，導致其內部絕對定位子元素（Radix Checkbox 指示器等）逃出 scroll 區、把整頁 `scrollHeight` 撐高約 1600px，產生底部一大段空白可捲動區。
- **修復**：容器加上 `relative`（使其成為 containing block），洩漏即被關回 scroll 區內。
- **驗證**：透過瀏覽器 console live A/B 測試確認 `document.scrollHeight` 由 5060 回到正常 3468（測試 `position: relative` / `contain: content` / `contain: paint` 三者皆可修復，採用副作用最小、最符合慣例的 `relative`）。

---

## 技術設計

### 修改範圍

| 文件 | 變更內容 | 處數 |
|------|----------|------|
| `src/app/[locale]/(dashboard)/admin/field-definition-sets/[id]/page.tsx` | ✅ 已移除 `max-w-3xl` | 3 |
| `src/components/features/field-definition-set/FieldCandidatePicker.tsx` | ✅ 已加 `relative` 修復洩漏 | 1 |
| `src/app/[locale]/(dashboard)/admin/field-definition-sets/new/page.tsx` | 移除 `max-w-3xl` | 1 |
| `src/app/[locale]/(dashboard)/admin/data-templates/[id]/page.tsx` | 移除 `max-w-4xl` | 3 |
| `src/app/[locale]/(dashboard)/admin/data-templates/new/page.tsx` | 移除 `max-w-4xl` | 1 |
| `src/app/[locale]/(dashboard)/admin/exchange-rates/[id]/page.tsx` | 移除 `max-w-2xl` | 3 |
| `src/app/[locale]/(dashboard)/admin/exchange-rates/new/page.tsx` | 移除 `max-w-2xl` | 1 |
| `src/app/[locale]/(dashboard)/admin/reference-numbers/[id]/page.tsx` | 移除 `max-w-3xl` | 3 |
| `src/app/[locale]/(dashboard)/admin/reference-numbers/new/page.tsx` | 移除 `max-w-3xl` | 1 |
| `src/app/[locale]/(dashboard)/admin/template-field-mappings/[id]/page.tsx` | 移除 `max-w-4xl` | 1 |
| `src/app/[locale]/(dashboard)/admin/template-field-mappings/new/page.tsx` | 移除 `max-w-4xl` | 1 |
| `src/app/[locale]/(dashboard)/admin/pipeline-settings/[id]/page.tsx` | 移除 `max-w-2xl` | 3 |
| `src/app/[locale]/(dashboard)/admin/pipeline-settings/new/page.tsx` | 移除 `max-w-2xl` | 1 |
| `src/app/[locale]/(dashboard)/rules/[id]/edit/page.tsx` | 移除 `max-w-4xl` | 1 |
| `src/app/[locale]/(dashboard)/rules/new/page.tsx` | 移除 `max-w-4xl` | 1 |

### documents/upload（已確認納入）

| 文件 | 說明 | 決策 |
|------|------|------|
| `src/app/[locale]/(dashboard)/documents/upload/page.tsx` | `max-w-3xl` 上傳表單頁 | ✅ 用戶確認納入全寬化（Phase 1） |

### 已符合（無需變更）

`admin/prompt-configs/[id]`、`admin/prompt-configs/new`、`admin/field-mapping-configs/[id]`、`admin/field-mapping-configs/new` 等頁已使用全寬 `container mx-auto py-6 space-y-6`（無 `max-w-*`），本次不動。

### i18n 影響

無。純 className 版面調整，不涉及任何使用者可見文字。

### 資料庫影響

無。

---

## 設計決策

1. **採全寬（移除 `max-w-*`）而非加寬置中** — 用戶確認要貼齊側邊欄、與列表頁一致的版面，故移除寬度限制而非僅放寬。仍由外層 `DashboardLayout` 的 `max-w-[1600px]` 提供超寬螢幕上限保護。
2. **FieldCandidatePicker 修復採 `relative` 而非 `contain`** — 三種修法皆驗證可行，`relative` 副作用最小（不建立新 stacking context、不影響 sticky 標題與內部捲動 UX）、最符合 Tailwind 慣例。
3. **保留各元件內部的 `max-w-*`（如有）** — 本次只移除「頁面根容器」的寬度限制；元件內部若有刻意的欄位寬度約束（如 `SelectTrigger w-[200px]`）維持不變，避免破壞個別元件設計。

---

## 影響範圍評估

### 文件影響清單

| 文件路徑 | 類型 | 說明 |
|----------|------|------|
| 上述 14 個 page.tsx | 🔧 修改 | 移除根容器 `max-w-*` |
| FieldCandidatePicker.tsx | 🔧 修改 | ✅ 已加 `relative` |

### 向後兼容性

- 純視覺版面調整，**不影響任何功能、資料、API、路由**。
- 表單欄位、驗證、提交流程完全不變。
- 風險僅在於部分**簡單表單（2-3 欄，如 exchange-rates / pipeline-settings）全寬後輸入框被拉寬**，視覺偏空 — 屬可接受的一致性取捨（用戶已選擇全部統一）。

---

## 實施計劃（分階段）

| 階段 | 範圍 | 狀態 |
|------|------|------|
| Phase 0 | field-definition-sets/[id] 全寬 + FieldCandidatePicker 修復 | ✅ 已完成 |
| Phase 1 | 其餘 admin + rules 編輯/新建頁移除 `max-w-*` | ✅ 已完成（並行 4 Agent，22 處） |
| Phase 2 | 統一驗證（grep + type-check + lint） | ✅ grep 通過；type-check/lint 失敗皆為既有問題、與本次無關 |
| Phase 3 | documents/upload 納入全寬化 | ✅ 已完成 |

> **執行方式**：Phase 1 可並行多 Agent 處理（各頁獨立、無檔案衝突），或單 Session 批次順序處理。

---

## 風險評估

| 風險 | 等級 | 緩解 |
|------|------|------|
| 簡單表單全寬後視覺偏空 | 低 | 用戶已認可統一；如不滿意可個別回退為 `max-w-*` |
| 某頁有未預期的版面副作用（如全寬後其他元件溢出） | 低 | Phase 2 視覺抽查；如同 FieldCandidatePicker 般另查另修 |
| 漏改某狀態（載入/錯誤）造成同頁寬度不一致 | 中 | 每頁需改全部 3 處（主/載入/錯誤），逐頁核對處數 |

## 回滾計劃

純 className 變更，回滾即還原各頁 `max-w-*`。可透過 git revert 對應 commit 一次性回滾，無資料或狀態副作用。

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | 所有目標頁移除 `max-w-*` | grep 確認 14 頁根容器無 `max-w-*` | High |
| 2 | 每頁各狀態一致 | 主畫面/載入/錯誤狀態寬度一致全寬 | High |
| 3 | 型別檢查通過 | `npm run type-check` 無錯誤 | High |
| 4 | Lint 通過 | `npm run lint` 無 warning | High |
| 5 | 候選清單空白 bug 不重現 | field-definition-sets 編輯頁捲到底無異常空白 | High |
| 6 | 功能無回歸 | 各頁表單提交/驗證正常 | Medium |

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | 編輯頁全寬 | 開任一編輯頁 | 表單貼齊側欄、撐滿至 ~1600px |
| 2 | 底部無空白 | field-definition-sets 編輯頁捲到底 | 無多餘空白可捲動區 |
| 3 | 簡單表單 | 開 exchange-rates 編輯頁 | 全寬呈現、功能正常 |
| 4 | 載入/錯誤狀態 | 觸發載入中與錯誤狀態 | 寬度與主畫面一致 |

---

## Implementation Notes

### 實際改動（2026-06-05）

共 **16 個檔案**：15 個 page.tsx（根 container 移除 `max-w-*`）+ 1 個 FieldCandidatePicker.tsx（加 `relative` 修復高度洩漏）。

| 群組 | 執行者 | 檔案 | 處數 |
|------|--------|------|------|
| Phase 0 | 主 Session | field-definition-sets/[id]（3）+ FieldCandidatePicker（1） | 4 |
| A | code-implementer Agent | field-definition-sets/new、data-templates [id]+new | 5 |
| B | code-implementer Agent | exchange-rates [id]+new、reference-numbers [id]+new | 8 |
| C | code-implementer Agent | template-field-mappings [id]+new、pipeline-settings [id]+new | 6 |
| D | code-implementer Agent | rules [id]/edit+new、documents/upload | 3 |

**合計：26 處**（含 Phase 0 的 4 處）。所有 Agent 回報處數與預期一致。

### 驗證結果

| 檢查 | 結果 |
|------|------|
| Grep 根 container `max-w-*` | ✅ `(dashboard)` 下所有 page.tsx 無殘留 |
| `npm run type-check` | ⚠️ 失敗，但錯誤全在未碰檔案（CityDetailPanel.tsx recharts 型別、2 個 test 檔缺 runner 型別）→ **既有問題、與本次無關** |
| `npm run lint` | ⚠️ 失敗（3 Error + 大量 warning），全在未碰檔案（i18n/request.ts、confidence-v3*.service.ts）→ **既有問題、與本次無關** |

本次 16 檔均為純 className 視覺調整，無 import / 邏輯 / 型別 / i18n 異動，**零回歸**。

### 注意事項

- 工作目錄另有與本次無關的既有 WIP（`docker-compose.yml`、`MappingRuleEditor.tsx`、`MappingRuleItem.tsx`、`templateFieldMapping.json` ×3、若干 doc 移動，疑似 CHANGE-075 mapping-rule reorder）。**提交時須選擇性 add 僅本 CHANGE-076 的 16 檔 + 本規劃文件**，勿一併提交無關 WIP。
- type-check / lint 的既有失敗屬技術債，超出本 task scope（H3），未處理。
