# FIX-175: 頁面層保護只涵蓋 14 個受保護路徑中的 3 個

> **建立日期**: 2026-08-08
> **發現方式**: FIX-171 第三批盤點 `next-auth` fail-open advisory 曝險時的副產物（見 FIX-171 §第三批評估 三），當時決定另開編號處理
> **影響頁面/功能**: `(dashboard)` 路由組全部 13 個頂層路徑的未登入存取行為
> **優先級**: 中（縱深防禦缺口，非當前可利用漏洞）
> **狀態**: ✅ 已完成（2026-08-08 —— `isProtectedRoute()` 由 3 個前綴補齊為 14 個；22 個案例實測全數符合期待，並以 negative control 證明係依清單攔截而非無差別攔截）
> **相關**: [FIX-171](FIX-171-secure-dev-dod-checklist-gaps.md)（本 FIX 的來源，§第三批評估 三 與 §步驟 4）、[FIX-170](FIX-170-epic19-template-apis-missing-auth.md)（同屬「Edge 層與 handler 層雙防線」主題，方向相反：FIX-170 補 handler 層，本 FIX 補 Edge 層）

---

## 問題描述

`src/middleware.ts` 的 `isProtectedRoute()` 決定「未登入者存取此頁面時是否導向登入頁」。它目前只認得 3 個路徑前綴：

```typescript
function isProtectedRoute(pathname: string): boolean {
  const { restPath } = extractLocaleFromPath(pathname)
  return (
    restPath.startsWith('/dashboard') ||
    restPath.startsWith('/documents') ||
    restPath.startsWith('/docs')
  )
}
```

而實際需要登入才能使用的頁面有 **14 個頂層路徑** —— `(dashboard)` 路由組的 13 個，加上 FIX-171 收攏的 `/docs`。

| 有 middleware 保護（雙重防線） | 只有 layout 保護（單點） |
|---|---|
| `/dashboard`、`/documents`、`/docs` | `/admin`、`/audit`、`/companies`、`/escalations`、`/global`、`/profile`、`/reports`、`/review`、`/rollback-history`、`/rules`、`/template-instances` |

右欄 **11 個路徑**（其中 `/admin` 底下還有 24 個管理模組）唯一的頁面層防線，是 `src/app/[locale]/(dashboard)/layout.tsx` 裡的一次 session 檢查。

### 這目前不是漏洞

必須先講清楚，以免高估嚴重度：**該單點防線目前是有效的**。

FIX-171 步驟 3 已把 `layout.tsx` 的判斷從裸物件檢查 `if (!session)` 改為 `if (!session?.user)`，正是 GHSA-8fpg-xm3f-6cx3 advisory 明文建議的安全模式；`next-auth` 也已升到 beta.32，該版本本身就讓配置錯誤時的 session 解析 fail closed。所以未登入者現在訪問 `/admin` 會被 layout 導向登入頁，行為正確。

問題在於**它只有一道防線**，而這道防線的正確性同時依賴：

1. `layout.tsx` 那一行判斷式維持正確寫法（一次誤改即全數失效）
2. Auth.js 在配置異常時回傳的物件不含 `.user`（依賴套件行為）
3. 每個新增的 `(dashboard)` 子路徑都確實被該 layout 包住（依賴目錄結構不被繞過）

FIX-171 §第三批實作記錄已記載，fail-open 在本機**被實際重現過**（`AUTH_URL` 誤用 v4 變數名 `NEXTAUTH_URL` 觸發 `UntrustedHost`），不是理論風險。

### 為何 API 層不受影響

middleware 的 API 認證閘（`handleApiAuthGate`）用的是 `session?.user`（安全模式），且 Azure DEV 為 `enforce`。所以即使頁面殼被渲染，資料仍取不到 —— 這也是本 FIX 優先級定為中而非高的原因。

---

## 根本原因

`isProtectedRoute()` 自 Epic 17（i18n 基礎建設）建立時只列了當時存在的 `/dashboard` 與 `/documents`，此後 `(dashboard)` 路由組陸續增加 11 個頂層路徑，但沒有任何機制要求同步更新這個清單。

FIX-171 / BUG-12 加入 `/docs` 時是為了配合 API 文件收攏，屬個案處理，也未順帶盤點其餘路徑。

換言之這是**清單與目錄結構之間缺乏強制同步**的典型漂移，不是某次改動寫錯。

---

## 解決方案

把 3 個 `||` 條件改為一份具名清單，涵蓋全部 14 個路徑：

```typescript
const PROTECTED_PAGE_PREFIXES = [
  '/admin', '/audit', '/companies', '/dashboard', '/docs',
  '/documents', '/escalations', '/global', '/profile',
  '/reports', '/review', '/rollback-history', '/rules', '/template-instances',
]

function isProtectedRoute(pathname: string): boolean {
  const { restPath } = extractLocaleFromPath(pathname)
  return PROTECTED_PAGE_PREFIXES.some((prefix) => restPath.startsWith(prefix))
}
```

### 前綴誤判的事前檢查

沿用 `startsWith` 比對（與既有寫法一致），因此必須確認新增前綴不會誤中公開路徑。唯一公開的頁面路徑是 `/auth/*`（登入、註冊、忘記密碼、email 驗證），與新增的 `/audit` 形態相近：

| 比對 | 結果 |
|---|---|
| `'/auth'.startsWith('/audit')` | `false`（第 4 字元 `h` ≠ `d`） |
| `'/audit'.startsWith('/auth')` | `false`（同上） |

其餘 10 個新增前綴與 `/auth` 無共同開頭。14 個前綴彼此之間亦無包含關係 —— 最接近的是既有的 `/docs` 與 `/documents`（第 5 字元 `s` ≠ `u`，FIX-171 已驗證過）。

此檢查必須以實測收尾，不能只靠推理：`/auth` 路徑一旦被誤判為受保護，未登入者將無法登入，形成與 FIX-171 記載的 fail-open 相同的「登入頁不可用」故障形態。

### 不納入本 FIX 的部分

| 項目 | 理由 |
|---|---|
| 改為精確比對（`restPath === p \|\| restPath.startsWith(p + '/')`） | 現行 `startsWith` 在本專案實際路由下無誤判（已逐一檢查）。改比對語義屬既有寫法的行為變更，非本 FIX 要解決的覆蓋缺口 |
| 建立清單與目錄結構的自動同步檢查 | 屬新增 CI 檢查，是另一個問題（防止再次漂移），與本次補齊覆蓋範圍分開 |
| 移除 `layout.tsx` 的檢查 | 🔴 **絕不可做**。本 FIX 的目的是把單點變雙重，不是把防線從 layout 搬到 middleware |

---

## 修改的檔案

| 檔案 | 修改內容 | 狀態 |
|------|----------|------|
| `src/middleware.ts` | `isProtectedRoute()` 改用 `PROTECTED_PAGE_PREFIXES` 清單，補入 11 個缺漏路徑；同步更新檔頭 JSDoc 的路由分類與 `@lastModified` | ✅ 已完成 |

---

## 實作記錄（2026-08-08）

### 驗證上的關鍵難題：如何證明改動真的生效

這個改動有一個容易產出**假綠燈**的陷阱：`(dashboard)/layout.tsx` 本來就會把未登入者導向登入頁，因此「訪問 `/en/admin` 被導向登入頁」在改動前後**都成立**。若只看這個現象，測試沒有辨別力。

分辨依據在導向 URL 的形態，兩者不可能混淆：

| 來源 | 導向目標 | 出處 |
|---|---|---|
| **middleware** | `/en/auth/login?callbackUrl=%2Fen%2Fadmin` | `loginUrl.searchParams.set('callbackUrl', pathname)`，帶 locale 與 callbackUrl |
| **layout** | `/auth/login` | `redirect('/auth/login')` 為硬編碼字串，**無 locale、無 query** |

layout 在結構上不可能產生 `callbackUrl` 參數，所以「導向目標帶 callbackUrl」即為 middleware 攔截的充分證據。

### 實測結果（本機 dev server，port 3200，未登入）

**22 個案例全數符合期待**：13 個新增受保護路徑（含 `/en/admin/users`、`/en/reports/cost` 兩個子路徑）、3 個既有路徑回歸、3 個公開路徑回歸、3 個跨 locale 案例（`zh-TW` / `zh-CN`）。全部受保護路徑的導向皆為 middleware 形態並保留完整返回路徑。

### Negative control：證明係依清單攔截

僅有正向案例無法排除「誤攔所有路徑」，故另跑一組清單外路徑：

| 路徑 | 結果 | 意義 |
|---|---|---|
| `/en/nonexistent-xyz` | **404**，未導向 | 清單外不攔 —— 測試具辨別力 |
| `/en/aud` | **404**，未導向 | `/audit` 不會誤攔其前綴片段 |
| `/en/auth` | **404**，未導向 | 🔴 公開路徑未被 `/audit` 誤判 |
| `/en` | 307 → `/en/auth/login`（**無 callbackUrl**） | 天然對照：非 middleware 的導向確實不帶 callbackUrl |
| `/en/adminx` | 307 → 登入頁（帶 callbackUrl） | `startsWith` 的固有行為，見下方 |

最後一列的 `/en` 是意外收穫 —— 它讓「帶 callbackUrl」與「不帶 callbackUrl」兩種形態在同一次實測中並存，直接印證了上表的分辨依據，不必依賴代碼推理。

### ⚠️ 一項行為變更：前綴相近的不存在路徑

`/en/adminx` 之類「以受保護前綴開頭、但實際不存在」的路徑，改動前回 404，改動後導向登入頁。

這是 `startsWith` 比對的固有結果（`'/adminx'.startsWith('/admin')` 為 `true`），非本次新引入的語義。判定為**可接受**：方向偏保守（不存在的路徑要求登入，不洩漏任何資訊），且既有的 `/dashboard`、`/documents` 本來就是這個行為。若日後要收斂，屬 §不納入本 FIX 的部分 第一列所述的比對語義變更。

### 品質閘結果

| 檢查 | 結果 |
|---|---|
| `npm run lint` | ✅ exit 0 |
| `npm run test` | ✅ 42 檔案通過 / 1 跳過；489 測試通過 / 2 跳過、0 失敗 |
| `npm run type-check` | ⚠️ 1 個錯誤，**與本 FIX 無關** —— 見下 |

### 🔴 type-check 的既有錯誤：FIX-170 gitignore 問題的第二個症狀

```
src/app/api/v1/field-definition-sets/[id]/coverage/route.ts(13,35):
error TS2307: Cannot find module '@/lib/auth/api-session'
```

成因是 FIX-170 已登記但尚未處理的 `.gitignore` 缺陷，在分支切換時顯現：

| 檔案 | git 狀態 | 切換到不含 FIX-170 的分支時 |
|---|---|---|
| `src/lib/auth/api-session.ts` | 已追蹤（FIX-170 新增） | **被刪除** |
| `.../coverage/route.ts` | 被 `.gitignore:45` 的 `coverage/` 排除 | **不還原**，保留 FIX-170 寫入的 import |

於是磁碟上出現「引用了不存在模組」的組合。**CI 不受影響** —— CI 自 git checkout，根本沒有這個未追蹤檔案，這也是 FIX-170 的 PR 能通過 CI 的原因。

此症狀擴大了原本登記的影響範圍：先前只知道「線上沒有這個端點」，現在確認它還會**污染任何不含 FIX-170 之分支的本機 type-check**。處理方式仍待決定（納入版控並將規則改為 `/coverage/`，或確認廢棄後刪除），登記於 FIX-170。

除該檔案外無其他類型錯誤，`src/middleware.ts` 零錯誤。

---

## 測試驗證

### 受保護路徑（未登入應導向登入頁並保留 callbackUrl）

- [x] `/en/admin`
- [x] `/en/audit`
- [x] `/en/companies`
- [x] `/en/escalations`
- [x] `/en/global`
- [x] `/en/profile`
- [x] `/en/reports`
- [x] `/en/review`
- [x] `/en/rollback-history`
- [x] `/en/rules`
- [x] `/en/template-instances`
- [x] `/en/admin/users`、`/en/reports/cost`（子路徑一併涵蓋）
- [x] `/zh-TW/admin`、`/zh-CN/reports`（locale 剝離正確，導向對應語言的登入頁）

### 回歸（既有行為不得改變）

- [x] `/en/dashboard`、`/en/documents`、`/en/docs` 仍導向登入頁
- [x] 🔴 `/en/auth/login` 仍回 200 —— **未被 `/audit` 誤判**，這是本次最關鍵的回歸項
- [x] `/en/auth/register`、`/en/auth/forgot-password` 仍回 200
- [x] `/zh-TW/auth/login` 仍回 200（跨 locale 的公開頁）
- [x] Negative control：`/en/nonexistent-xyz`、`/en/aud`、`/en/auth` 皆回 404 未被攔截

### 品質閘

- [x] `npm run lint`（exit 0，無新增 warning）
- [x] `npm run test`（489 passed / 2 skipped / 0 failed，無回歸）
- [x] `npm run docs:check`
- [ ] `npm run type-check` —— ⚠️ 1 個既有錯誤源自 FIX-170 的 gitignore 缺陷，與本 FIX 無關且 CI 不受影響（詳見 §實作記錄）。`src/middleware.ts` 本身零錯誤

### 未涵蓋

| 項目 | 原因 |
|---|---|
| 登入**後**的導覽行為 | 本機 dev bypass 實際為關閉狀態（需 `NODE_ENV=dev` 且 Azure AD 未配置，而本機已配置 Azure AD），無法自助登入。本次改動只在「未登入」分支生效，登入後 `isProtectedRoute()` 的結果不影響流程，故此缺口對本 FIX 的風險低 |

---

*文件建立日期: 2026-08-08*
*最後更新: 2026-08-08*
