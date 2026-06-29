# FIX-096: 文件詳情頁「Delete」按鈕回 405（API 無 DELETE handler）

> **建立日期**: 2026-06-29
> **發現方式**: Playwright E2E（FIX-095 回歸驗證後清理測試文件時發現）
> **影響頁面/功能**: 文件詳情頁刪除功能 — `DELETE /api/documents/[id]`
> **優先級**: 中（功能缺失；有「直接 DB 刪除」workaround，但日常文件管理無法用 UI 刪除）
> **狀態**: ✅ 已修復（2026-06-29，採方案 B 授權；本地 type-check / lint / live E2E 通過）

---

## 問題描述

在文件詳情頁（`/[locale]/documents/[id]`）點擊「Delete」按鈕並於確認對話框按下刪除後，文件**並未被刪除**，UI 顯示刪除失敗（toast error）。

瀏覽器 console 回報：

```
Failed to load resource: the server responded with a status of 405 (Method Not Allowed)
@ http://localhost:3200/api/documents/{id}
```

根因是該 API 路由**根本沒有 DELETE handler** — 前端送出 `DELETE` 請求，Next.js 因該方法未實作而回 405。亦即**UI 刪除文件功能自始無法運作**（非環境問題、非權限問題）。

---

## 重現步驟

1. 登入後進入任一文件詳情頁（`/en/documents/{id}`）。
2. 點右上角「Delete」→ 確認對話框按「Delete」。
3. 觀察現象：
   - 文件未刪除（列表/DB 中仍存在）。
   - Console 出現 `405 (Method Not Allowed)` 於 `DELETE /api/documents/{id}`。
   - UI 顯示刪除失敗 toast（`detail.errors.deleteFailed`）。

---

## 根本原因

### 原因 1：`documents/[id]` 路由只實作 GET，未實作 DELETE

- 前端 `src/components/features/document/detail/DocumentDetailHeader.tsx`（`handleDelete`，第 113–121 行）送出：
  ```ts
  const response = await fetch(`/api/documents/${document.id}`, { method: 'DELETE' })
  ```
- 但 `src/app/api/documents/[id]/route.ts` **只 `export async function GET`**（第 139 行），沒有 `DELETE` export → Next.js App Router 對未實作的方法回 **405 Method Not Allowed**。

### 原因 2：刪除 service 已存在但未接上任何 API 路由

- `src/services/document.service.ts` 已有 `deleteDocument(id)`（第 336 行）：先刪 Azure Blob（`deleteFile`），再 `prisma.document.delete`（依賴 Prisma `onDelete: Cascade` 級聯清子表）。
- 但全專案**無任何 API 路由呼叫 `deleteDocument`**（`grep -rn "deleteDocument" src/app/api/` 為空）→ 功能寫好卻沒接通。

### 待決定（授權設計點）

`src/types/permissions.ts` 目前**無 `INVOICE_DELETE` 權限**，只有 `INVOICE_VIEW / INVOICE_CREATE / INVOICE_REVIEW / INVOICE_APPROVE`。刪除屬破壞性操作，DELETE handler 該用哪個權限需在實作時定案（見方案）。

---

## 解決方案

### 修復：在 `documents/[id]/route.ts` 新增 DELETE handler

在 `src/app/api/documents/[id]/route.ts` 新增 `export async function DELETE`，遵循既有 API 規範：

1. **認證**：`const session = await auth()`，無 session 回 401（RFC 7807）。
2. **授權**：呼叫 `hasPermission(session.user, ...)` + 城市存取檢查（參考 `upload/route.ts` 對 `INVOICE_CREATE` + `hasPermission` 的 pattern）。
   - ✅ **授權方案已定案：方案 B（admin 角色 + 城市檢查）**（用戶 2026-06-29 確認）。其他選項：A（沿用 `INVOICE_CREATE`，語意偏寬）、C（新增 `INVOICE_DELETE`，牽涉權限模型 + i18n，屬 H1）皆未採用。
   - **實作的授權規則**（用 `session.user` 權威欄位，非 progress route 那組錯誤的 `user.role`/`user.cityAccess`）：
     - `isGlobalAdmin === true` → 可刪任何城市的文件。
     - `isRegionalManager === true` 且 `cityCodes` 含文件城市（或 `'*'`）→ 可刪該城市文件。
     - 其餘（city manager / reviewer / viewer）→ 403。
     - ⚠️ **範圍說明**：方案 B 保守起見**只放行 global / regional 兩個明確 admin 旗標**；city manager 暫不放行（系統無乾淨的 city-admin 布林旗標）。若日後需放行 city manager，再調整。
3. **存在性檢查**：查無文件回 404（RFC 7807）。
4. **執行刪除**：`await deleteDocument(id)`（重用既有 service，含 blob + DB cascade）。
5. **回應**：成功回 200（或 204 No Content）。
6. **錯誤處理**：try/catch + RFC 7807 top-level 錯誤格式。
7. **審計**：可記錄 `DOCUMENT_DELETED`（`src/lib/audit` 已定義此 action）。

> 🔴 **範圍限制**：本 FIX 僅補 DELETE handler + 授權，**不改** `deleteDocument` service 邏輯、**不改**前端 `DocumentDetailHeader`（其 DELETE 呼叫已正確）。文件列表頁若另有刪除入口，確認其亦走同一端點。

---

## 修改的檔案

> 以下為**實際**修改範圍。

| 檔案 | 實際修改內容 |
|------|------------|
| `src/app/api/documents/[id]/route.ts` | 新增 `export async function DELETE`：`auth()` → 401；查文件取城市 → 404；方案 B 授權（global/regional admin + 城市檢查）→ 403；呼叫 `deleteDocument(id)`（blob + DB 級聯）；`logAudit('DOCUMENT_DELETED')`；成功回 200。錯誤採 RFC 7807 top-level。新增 import `deleteDocument` / `logAudit`，更新檔頭端點清單 + `@lastModified` |

> **未改動**：`src/types/permissions.ts`（採方案 B，不新增權限）、i18n（前端 `detail.deleteSuccess` / `detail.errors.deleteFailed` 既有 key 沿用）、前端 `DocumentDetailHeader`（其 DELETE 呼叫原已正確）、`deleteDocument` service（直接重用）。
> **未順手修**：同檔 `progress/route.ts` 用 `user.role`/`user.cityAccess` 錯誤欄位的潛在 bug（超出本 FIX 範圍，另記）。

---

## 測試驗證

修復完成後需驗證：

- [x] 文件詳情頁點「Delete」→ 確認 → 文件被刪除，列表/DB 不再存在（2026-06-29 live E2E）
- [x] DELETE `/api/documents/[id]` 回 200（非 405）— 刪除後自動導回列表、console 0 errors
- [x] 級聯刪除正確（`extraction_results`=0、`processing_queues`=0 已驗證）
- [x] 審計記錄 `DOCUMENT_DELETED`（`audit_logs` 有 DELETE on document）
- [x] `npm run type-check` 通過
- [x] `npm run lint` 通過（0 error；`detectExtractionVersion` 未使用警告為既有，非本次造成）
- [ ] Azure Blob 一併刪除 — `deleteDocument` 已呼叫 `deleteFile`，但本次未個別核對 Azurite blob 消失
- [ ] 負面路徑（未登入 401 / 無權限 403 / 查無 404）— 本次只驗 global admin happy path，負面路徑未個別觸發

### Live E2E（2026-06-29，本地，方案 B + 全域管理員）

上傳 `CEVA_HEX250447,0448_45585.pdf`（SHA）→ 詳情頁點 Delete → 確認：

| 項目 | 修復前 | 修復後 |
|------|--------|--------|
| DELETE 回應 | 405 Method Not Allowed | **200**（導回 `/en/documents`）|
| 文件刪除 | ❌ 仍存在 | ✅ `documents` count=0 |
| 級聯子表 | — | ✅ `extraction_results`=0、`processing_queues`=0 |
| 審計 | — | ✅ `audit_logs` DELETE on document |

---

*文件建立日期: 2026-06-29*
*最後更新: 2026-06-29*
