# CHANGE-085: Prompt Configuration Management 補上刪除入口（含後端擋啟用中配置）

> **日期**: 2026-06-20
> **狀態**: ⏳ 待實作
> **優先級**: Medium
> **類型**: Feature（補完 CRUD）
> **影響範圍**: Prompt Config 管理頁前端 ＋ DELETE API

---

## 變更背景

Prompt Configuration Management（`/admin/prompt-configs`，Epic 14）的刪除能力**九成已實作**，但使用者在 UI 上找不到刪除入口。經調查，後端 DELETE API、React Query hook、頁面確認 dialog 全部已存在且可運作，唯一缺口是「配置卡片下拉選單沒有刪除按鈕」，且 `onDelete` 回調在列表組件層被「漏接」沒有往下傳到卡片。

**本變更不是從零開發，而是接回一條斷掉的線。**

### 既有 CRUD 現狀盤點

| 操作 | 狀態 | 位置 |
|------|------|------|
| Create | ✅ 已有 | `src/app/api/v1/prompt-configs/route.ts:170`（POST）＋ `new/page.tsx` |
| Read（列表） | ✅ 已有 | `src/app/api/v1/prompt-configs/route.ts:32`（GET list） |
| Read（單一） | ✅ 已有 | `src/app/api/v1/prompt-configs/[id]/route.ts:41`（GET one） |
| Update | ✅ 已有 | `src/app/api/v1/prompt-configs/[id]/route.ts:136`（PATCH，含樂觀鎖） |
| **Delete 後端** | ✅ 已有 | `src/app/api/v1/prompt-configs/[id]/route.ts:294-351`（Zod `promptConfigIdParamSchema`、404、`prisma.promptConfig.delete`、RFC 7807） |
| **Delete hook** | ✅ 已有 | `src/hooks/use-prompt-configs.ts:178` `useDeletePromptConfig`（已 `invalidateQueries`） |
| **Delete 頁面 dialog** | ✅ 已有 | `src/app/[locale]/(dashboard)/admin/prompt-configs/page.tsx:104-128, 199-221`（`handleDeleteRequest`/`handleDeleteConfirm`/確認 `AlertDialog` 都已寫好） |
| **Delete 卡片觸發按鈕** | ❌ 缺 | `src/components/features/prompt-config/CollapsiblePromptGroup.tsx:205-211`（下拉選單只有 Edit） |

### 斷點細節（為何 UI 上沒有刪除）

1. `page.tsx:196` 已經傳 `onDelete={handleDeleteRequest}` 給 `<PromptConfigList>`。
2. `PromptConfigList.tsx`：props 介面**有**宣告 `onDelete`（第 55 行），但函數簽名解構時（第 122-127 行）**遺漏 `onDelete`**，且渲染 `<CollapsiblePromptGroup>` 時（第 235-243 行）**沒有把 `onDelete` 往下傳**。
3. `CollapsiblePromptGroup.tsx`：props 介面**完全沒有** `onDelete`，內部 `PromptConfigCard` 的 `DropdownMenuContent`（第 205-211 行）只渲染一個 Edit 項目。

結果：回調鏈從 `page.tsx` 傳到 `PromptConfigList` 後就斷了，卡片永遠拿不到刪除回調，也就沒有刪除按鈕。

---

## 變更內容

### 1. 前端接回 `onDelete` 回調鏈

- `PromptConfigList.tsx`：函數簽名解構補上 `onDelete`，並在渲染 `<CollapsiblePromptGroup>` 時往下傳。
- `CollapsiblePromptGroup.tsx`：props 介面新增 `onDelete`，並透傳給內部 `PromptConfigCard`。
- `PromptConfigCard`（位於 `CollapsiblePromptGroup.tsx` 內）：在 `DropdownMenuContent` 新增「刪除」`DropdownMenuItem`（destructive 紅色樣式），點擊呼叫 `onDelete(config.id, config.name)`。

### 2. 後端 DELETE 擋「啟用中（isActive = true）」配置（用戶要求，範圍擴張）

- `src/app/api/v1/prompt-configs/[id]/route.ts` 的 `DELETE`：在 `prisma.promptConfig.delete` 之前，檢查 `existingConfig.isActive`。若為 `true`，拒絕刪除並回傳 **409 Conflict** ＋ RFC 7807 錯誤（`detail` 明確說明「啟用中的配置不可刪除，請先停用」）。
- 前端對 `config.isActive === true` 的卡片：刪除 `DropdownMenuItem` 設為 `disabled`，並以 tooltip / 說明文字提示「需先停用才能刪除」（防止使用者點擊後才吃到 409）。

### 3. i18n 補上卡片選單與「擋用中」提示文字

- 新增 `list.delete`（`list.edit` 已存在；卡片選單刪除項 label）。
- 新增「啟用中不可刪除」提示文字 key（卡片禁用 item 的提示 + 後端 409 對應的友善訊息）。
- `page.deleteDialog.*` 與 `page.toast.deleteSuccess/deleteFailed` 三語言**皆已存在**，無需新增。

---

## 技術設計

### 修改範圍

| 文件 | 變更內容 |
|------|----------|
| `src/components/features/prompt-config/PromptConfigList.tsx` | 函數簽名解構補 `onDelete`（第 122-127 行）；渲染 `CollapsiblePromptGroup` 時往下傳（第 235-243 行） |
| `src/components/features/prompt-config/CollapsiblePromptGroup.tsx` | props 介面加 `onDelete`；透傳給 `PromptConfigCard`；`DropdownMenuContent`（第 205-211 行）新增 destructive 刪除項；對 `isActive` 配置禁用刪除項並顯示提示 |
| `src/app/api/v1/prompt-configs/[id]/route.ts` | `DELETE`（第 294-351 行）在刪除前加 `isActive` 檢查，啟用中回 409 ＋ RFC 7807（維持既有 Zod `promptConfigIdParamSchema`） |
| `messages/en/promptConfig.json` | 新增 `list.delete` ＋ 啟用中不可刪除提示 key |
| `messages/zh-TW/promptConfig.json` | 同上 |
| `messages/zh-CN/promptConfig.json` | 同上 |

> **僅前端 + 單一 DELETE handler**，不新增 API 路由、不新增組件檔案、不動 hook、不動 page.tsx 既有 dialog 邏輯。

### i18n 影響

> 命名空間：`promptConfig`。`page.deleteDialog.*` 與 `page.toast.delete*` 已存在（已驗證），本次僅補卡片選單 label 與「擋用中」提示。

| 語言 | 文件 | 需要更新的 Key |
|------|------|---------------|
| en | `messages/en/promptConfig.json` | `list.delete`、`list.deleteDisabledHint`（啟用中不可刪除提示） |
| zh-TW | `messages/zh-TW/promptConfig.json` | 同上 |
| zh-CN | `messages/zh-CN/promptConfig.json` | 同上 |

> 實際 key 命名以實作時為準（`deleteDisabledHint` 為暫定名稱）。後端 409 的 `detail` 屬開發者層級英文訊息，依規範可用英文；但前端**呈現給使用者**的提示文字必須走 i18n 三語言同步。
> 完成前必須執行 `npm run i18n:check`。

### 資料庫影響

無。`PromptConfig`（`prisma/schema.prisma:2981`）僅有指出去的 `companyId` / `documentFormatId` 外鍵，無其他 model 反向引用，硬刪除安全、不產生孤兒；model 無 `deletedAt` 欄位。**維持硬刪除**，不動 schema、不建 migration。

---

## 設計決策

1. **接回斷掉的回調鏈，而非重寫** — 後端 / hook / dialog 都已完整且可運作，最小改動是補上 `onDelete` 透傳 ＋ 卡片刪除按鈕（符合 Karpathy §1.2 Simplicity First、§1.3 Surgical Changes）。

2. **維持硬刪除（不觸發 H1）** — `PromptConfig` 無反向引用、無 `deletedAt`，與既有 `field-mapping-configs` / `pipeline-configs` 的刪除行為一致；不引入軟刪除，避免擅自改動資料模型架構。

3. **【D7】擋刪除「啟用中（isActive = true）」配置 — 用戶 2026-06-20 批准的範圍擴張（H3）** — 此項超出「補完刪除 CRUD」的原始 task scope，屬 H3 Task Scope Constraint 觸發，**用戶已於 2026-06-20 明確批准**納入本變更。
   - **後端為真實防線**：必須在 DELETE handler 檢查 `isActive`，啟用中回 409 ＋ RFC 7807，而非只在前端藏按鈕（避免直接打 API 繞過）。
   - **前端為體驗防線**：對 `isActive` 配置禁用刪除項並顯示「需先停用」提示，避免使用者點下去才吃到 409。

4. **狀態碼選 409 Conflict** — 「資源當前狀態（啟用中）與請求（刪除）衝突」語意上對應 409；錯誤主體採 RFC 7807 top-level 格式，與該檔案既有 DELETE 錯誤回應一致。

5. **刪除項採 destructive 紅色樣式** — 與專案其他刪除入口（如 reference-number、field-mapping）視覺慣例一致，符合 H6 既定 UX pattern。

---

## 影響範圍評估

### 文件影響清單

| 文件路徑 | 類型 | 說明 |
|----------|------|------|
| `src/components/features/prompt-config/PromptConfigList.tsx` | 🔧 修改 | 解構補 `onDelete` ＋ 往下傳 |
| `src/components/features/prompt-config/CollapsiblePromptGroup.tsx` | 🔧 修改 | props 加 `onDelete` ＋ 卡片刪除項 ＋ isActive 禁用 |
| `src/app/api/v1/prompt-configs/[id]/route.ts` | 🔧 修改 | DELETE 加 isActive 檢查（409） |
| `messages/en/promptConfig.json` | 🔧 修改 | 新增 `list.delete` ＋ 提示 key |
| `messages/zh-TW/promptConfig.json` | 🔧 修改 | 同上 |
| `messages/zh-CN/promptConfig.json` | 🔧 修改 | 同上 |

### 向後兼容性

- **前端**：純新增刪除入口，不改既有 Edit 行為、不改列表 / 分組 / 展開邏輯，向後兼容。
- **後端 DELETE 行為變更**：新增 isActive 檢查屬**收緊**行為——原本啟用中配置可被刪除，現在會被拒絕（409）。對既有「刪除已停用配置」的流程無影響；僅改變「刪除啟用中配置」的結果，此為用戶要求的預期行為。
- **API 契約**：`onDelete` 在 `PromptConfigList` 已是 optional prop，補上透傳不破壞既有呼叫端。
- **資料庫**：無 schema 變更，無 migration，無相容性風險。

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | 卡片刪除入口 | 每張配置卡片的下拉選單出現「刪除」項（destructive 樣式） | High |
| 2 | 回調鏈接通 | 點擊刪除項觸發 page.tsx 既有的確認 `AlertDialog`，顯示正確配置名稱 | High |
| 3 | 刪除成功流程 | 確認後成功刪除、列表自動刷新（invalidateQueries）、顯示成功 toast | High |
| 4 | 後端擋啟用中 | 對 `isActive = true` 配置呼叫 DELETE，回 409 ＋ RFC 7807 錯誤，配置未被刪除 | High |
| 5 | 前端禁用提示 | `isActive = true` 卡片的刪除項為 disabled，並顯示「需先停用」提示 | High |
| 6 | i18n 三語言 | `list.delete` 與提示文字在 en/zh-TW/zh-CN 皆正確顯示，無 IntlError | High |
| 7 | i18n 檢查 | `npm run i18n:check` 通過 | High |
| 8 | 型別與 Lint | `npm run type-check` ＋ `npm run lint` 無錯誤、無 warning | Medium |

---

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | 刪除已停用配置 | 在 `/admin/prompt-configs` 找一個 `isActive = false` 的配置 → 開卡片下拉選單 → 點「刪除」→ 確認 dialog 點「確認刪除」 | 配置被刪除，列表刷新，顯示刪除成功 toast |
| 2 | 取消刪除 | 點「刪除」開啟確認 dialog → 點「取消」 | dialog 關閉，配置保留 |
| 3 | 嘗試刪除啟用中配置（前端） | 找一個 `isActive = true` 的配置 → 開卡片下拉選單 | 刪除項為 disabled，hover 顯示「需先停用」提示，無法點擊 |
| 4 | 直接呼叫 API 刪除啟用中配置（後端防線） | 對 `isActive = true` 配置直接送 `DELETE /api/v1/prompt-configs/:id` | 回 409 ＋ RFC 7807 錯誤（detail 說明需先停用），配置未被刪除 |
| 5 | 刪除不存在配置 | `DELETE` 一個不存在的 id | 回 404 ＋ RFC 7807（既有行為，不受本變更影響） |
| 6 | 多語言顯示 | 切換 en / zh-TW / zh-CN | 刪除 label 與提示文字皆正確翻譯，console 無 IntlError |
| 7 | 停用後可刪除 | 將一個啟用中配置改為停用 → 再刪除 | 停用後刪除項變可用，可成功刪除 |
