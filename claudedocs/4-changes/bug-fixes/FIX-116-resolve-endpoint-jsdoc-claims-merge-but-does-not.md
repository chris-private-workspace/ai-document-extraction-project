# FIX-116: `getResolvedFields` 與 `/resolve` 端點註解宣稱「三層合併」，實際不合併

> **日期**: 2026-07-20
> **狀態**: ✅ 已修復（註解修正；行為未變動）
> **嚴重度**: Sev4（文件缺陷 — 無執行期影響，但會誤導判讀與除錯）
> **類型**: Bug Fix（JSDoc 與實作不符）
> **影響範圍**: `field-definition-set.service.ts`、`/api/v1/field-definition-sets/resolve`

---

## 問題描述

`getResolvedFields()` 與其對外端點 `/api/v1/field-definition-sets/resolve` 的註解均宣稱執行「三層合併」，但實作是**首個命中即回傳**：依 FORMAT → COMPANY → GLOBAL → FALLBACK 順序查找，命中哪一層就整份回傳該層的 fields，其餘層完全不參與。

誤導性註解共 3 處：

| 位置 | 原文 |
|------|------|
| `field-definition-set.service.ts:14` | `- getResolvedFields: 三層合併邏輯` |
| `field-definition-set.service.ts:362` | `三層合併解析欄位（GLOBAL → COMPANY → FORMAT）` |
| `resolve/route.ts:8` | `GET .../resolve - 依 companyId+formatId 解析合併欄位` |

## 實際造成的誤判（UAT 2026-07-20）

為 CEVA 建立 FORMAT scope 欄位定義集時，只放了 4 個需要覆蓋 aliases 的費用欄位（其餘 11 個沿用 COMPANY 層）。呼叫 `/resolve` 驗證時只回傳 4 個欄位，據此一度誤判為「FORMAT 層會取代整個 COMPANY 層」，差點改成把 15 個欄位全部複製一份到 FORMAT 層。

實際重跑文件後確認 `stage3Result.fields` 有完整 15 個 key —— **提取管線是合併的，只有這個驗證端點不是**。

## 語意對照（修正後已寫入註解）

| 使用者 | 函式 | 語意 |
|--------|------|------|
| Stage 3 提取 | `stage-3-extraction.service.ts` 內的 `loadFieldDefinitionSet`（`:510-537`） | ✅ 合併（GLOBAL 基底 → COMPANY → FORMAT，同 key 取代） |
| 匯率換算（CHANGE-072） | `getMergedResolvedFields`（`:438`） | ✅ 合併 |
| `/resolve` API、SourceFieldCombobox | `getResolvedFields`（`:366`） | ❌ 擇一，回傳最具體那一層 |

> `getResolvedFields` 的行為對其設定介面用途（「這一層設定了什麼」）是**正確的**，問題純粹在註解描述錯誤。因此本 FIX **不改行為**。

## 修正內容

1. `field-definition-set.service.ts:14` — 改為「三層擇一解析（回傳最具體的那一層，**不合併**）」，並補列 `getMergedResolvedFields`
2. `field-definition-set.service.ts:361` — 函式 JSDoc 重寫：明確標示不合併、說明部分欄位 FORMAT 集的回傳結果、指向 `getMergedResolvedFields` 與提取管線實際採用的合併路徑
3. `resolve/route.ts` — 檔案頂部新增 `@remarks` 區塊說明不合併，並在 GET handler 補 `@returns` 說明 `source` 欄位語意

## 驗收

| # | 項目 | 標準 | 狀態 |
|---|------|------|------|
| 1 | 3 處註解修正 | 不再出現「合併」字樣描述 `getResolvedFields` | ✅ |
| 2 | 行為未變動 | 無任何邏輯改動，僅註解 | ✅ |
| 3 | 型別檢查 | `npm run type-check` | ✅ |
| 4 | Lint | `npx eslint`（修改檔） | ✅ |

## 關聯

- 同批 UAT 發現：[FIX-114](FIX-114-document-format-id-uuid-validation-blocks-format-scope.md)、[FIX-115](FIX-115-stage2-prompt-missing-knownformats-variable.md)、[FIX-117](FIX-117-document-status-config-missing-approved-escalated.md)
- 操作指南已記錄此陷阱：[company-multi-format-setup-guide.md](../../reference/company-multi-format-setup-guide.md)
