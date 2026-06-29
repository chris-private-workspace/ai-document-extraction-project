# FIX-099: 模版欄位映射列表「共 N 個配置」恆顯示 0

> **建立日期**: 2026-06-29
> **發現方式**: FIX-098 修復過程中 Playwright 觀察到（列表有 4 筆但標題顯示「共 0 個配置」）
> **影響頁面/功能**: 模版欄位映射頁（`/[locale]/admin/template-field-mappings`）列表計數與分頁控制項
> **優先級**: 低（顯示瑕疵，不影響資料與刪除 / 編輯功能）
> **狀態**: ✅ 已修復（2026-06-29，本地 type-check / lint / Playwright live E2E 通過）

---

## 問題描述

模版欄位映射頁列表實際有多筆記錄，但標題的「共 N 個配置」恆顯示 **0**；同時分頁控制項（上一頁 / 下一頁）即使資料超過一頁也不出現。

---

## 重現步驟

1. 進入 `/zh-TW/admin/template-field-mappings`（資料庫中已有多筆映射配置）。
2. 觀察列表標題：顯示「共 0 個配置」，但下方表格實際列出多筆。

---

## 根本原因

**API 回應的分頁資訊位置與 hook 讀取路徑不一致。**

- API GET handler（`src/app/api/v1/template-field-mappings/route.ts:87-98`）把分頁資訊**巢狀在 `data.pagination`**：
  ```ts
  data: { mappings, pagination: { page, limit, total, totalPages } }
  ```
- 但 hook（`src/hooks/use-template-field-mappings.ts:299-303`）讀的是**平鋪的 `data.total`**：
  ```ts
  total: query.data?.data.total ?? 0,        // data.total 不存在
  totalPages: query.data?.data.totalPages ?? 0,
  ```
- `mappings` 在 `data.mappings`（路徑正確 → 表格能顯示資料），但 `total` / `page` / `limit` / `totalPages` 實際在 `data.pagination.*`，hook 讀平鋪路徑全部落空：
  - `total` → `?? 0` → 標題顯示「共 0 個配置」
  - `totalPages` → `?? 0` → `totalPages > 1` 永遠為 false → 分頁控制項不顯示

> 註：`ListResponse` 介面型別（`use-template-field-mappings.ts:70-79`）也把分頁定義為平鋪，與 API 實際回傳不符，故 TypeScript 未在編譯期擋下此不一致。

---

## 解決方案

讓 hook 對齊 API 實際回傳的 `data.pagination.*`（最小改動，僅前端 hook，一個消費者 `TemplateFieldMappingList.tsx`，hook 回傳介面不變，組件無需改）。

### Hook（`use-template-field-mappings.ts`）

1. `ListResponse` 介面把分頁欄位移入 `pagination` 巢狀，對齊 API。
2. `useTemplateFieldMappings` 回傳改讀 `data.pagination.*`。

```ts
interface ListResponse {
  success: boolean;
  data: {
    mappings: TemplateFieldMappingSummary[];
    pagination: { total: number; page: number; limit: number; totalPages: number };
  };
}

// return
total: query.data?.data.pagination.total ?? 0,
page: query.data?.data.pagination.page ?? page,
limit: query.data?.data.pagination.limit ?? limit,
totalPages: query.data?.data.pagination.totalPages ?? 0,
```

> 範圍限制：**不改** API 回應結構（避免動契約）。專案標準分頁位置為 `meta.pagination`，本 API 用的是 `data.pagination`，屬既有不一致；統一格式不在本 FIX 範圍。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `src/hooks/use-template-field-mappings.ts` | `ListResponse` 介面分頁欄位移入 `pagination` 巢狀；`useTemplateFieldMappings` 回傳改讀 `data.pagination.{total,page,limit,totalPages}` |

---

## 測試驗證

- [x] 列表標題正確顯示「共 4 個配置」（修復前為「共 0 個配置」；本地 4 筆資料，Playwright 確認）
- [~] 資料超過一頁時分頁控制項出現 — 邏輯已修正（`totalPages` 改讀 `data.pagination.totalPages`），但本地僅 4 筆（< 1 頁）無法直接觸發；待 > 20 筆時驗證
- [x] `npm run type-check` 通過
- [x] `npx eslint`（修改檔案）通過，0 error 0 warning

---

*文件建立日期: 2026-06-29*
*最後更新: 2026-06-29*
