# FIX-061: Session 過期後頁面不導回登入，背景查詢 401 灌爆 console

> **建立日期**: 2026-06-03
> **發現方式**: 用戶回報（開啟頁面閒置一段時間後，DevTools console 出現大量 401）
> **影響頁面/功能**: 所有 `(dashboard)` 路由組頁面（共 69 頁，含主儀表板 `/dashboard`）——頁面開啟且閒置時
> **優先級**: 中-高（影響全體已登入用戶體驗；無資料外洩風險，但 UX 與 console 雜訊嚴重）
> **狀態**: ✅ 已修復（含回歸修復 v2；已用 Playwright 端到端實測通過）

---

## 問題描述

當用戶開啟任一 dashboard 頁面後**閒置一段時間**，JWT session 過期（或開發伺服器重啟、cookie 失效）。此時：

- 頁面**仍停留在原地**，不會自動導回登入頁。
- 頁面上由 React Query 驅動的自動刷新查詢（視窗聚焦刷新 / `refetchInterval` 輪詢）持續打 API，**一律收到 401**。
- DevTools console 被大量 401 灌爆，例如：

```
useDashboardStatistics.ts:92  GET http://localhost:3200/api/dashboard/statistics?startDate=...&endDate=... 401 (Unauthorized)
```

| # | 問題 | 嚴重度 | 影響位置 |
|---|------|--------|----------|
| BUG-1 | session 過期後客戶端無守衛偵測 `unauthenticated`，頁面不導回登入 | 中-高 | 全部 `(dashboard)` 頁面 |
| BUG-2 | 過期後背景自動刷新查詢持續 401，無全局攔截、無止損 | 中 | 全部使用 React Query 自動刷新的 hook |

---

## 重現步驟

1. 登入系統，停留在 `/[locale]/dashboard`（或任一 dashboard 頁面）。
2. 讓頁面閒置直到 session 過期（`maxAge` = 8 小時；開發時可改短 `maxAge`、清除 session cookie，或重啟 dev server 使 JWT 失效以加速重現）。
3. 觸發背景刷新（切回視窗、或等待 `refetchInterval` 觸發）。
4. 觀察現象：
   - 頁面不動，未導回登入頁。
   - console 持續輸出 `401 (Unauthorized)`，數量隨刷新累積。

---

## 根本原因

三層 session 防護**都只在「導航 / SSR 渲染時」生效，缺少「頁面執行期」的客戶端防護**。

| 層級 | 檔案 | 何時檢查 session | 缺口 |
|------|------|------------------|------|
| Middleware | `src/middleware.ts:148` | 僅頁面**導航**時（`auth()` 檢查 → 未登入 redirect） | 頁面已開啟後不會再觸發 |
| Dashboard Layout | `src/app/[locale]/(dashboard)/layout.tsx:47` | 僅 **SSR 渲染**時（`if (!session) redirect`） | 同上，開著不會重檢 |
| React Query Hooks | `src/hooks/useDashboardStatistics.ts:92` 等 100+ hook | 持續輪詢 / 聚焦刷新 | 收到 401 卻無人處理 |

### 子原因 1 — Session 為 JWT 策略，過期後 API 一律回 401

- `src/lib/auth.config.ts:69` 設 `SESSION_MAX_AGE = 8 * 60 * 60`（8 小時），`session.strategy = 'jwt'`（第 257-260 行）。
- JWT 過期後，API 路由的 `getAuthSession()` 取不到有效 session，回傳 401。

### 子原因 2 — React Query hook 收到 401 後僅 throw 通用 Error，無全局攔截

- 以 `fetchDashboardStatistics` 為例（`src/hooks/useDashboardStatistics.ts:92-97`）：401 回應使 `result.success` 為 false → `throw new Error('獲取統計數據失敗')`。錯誤**不含 HTTP status**，React Query `retry: 2` 後停在 error 狀態。
- 全部 100+ 個 hook 各自 `fetch()`，沒有共用的 fetch 封裝，401 被各自吞掉。

### 子原因 3 — QueryProvider 無全局錯誤處理器

- `src/providers/QueryProvider.tsx:49` 的 `QueryClient` 未設定 `QueryCache.onError` / `MutationCache.onError`，因此沒有任何全局邏輯能攔截 401。

### 子原因 4 — AuthProvider 無守衛組件反應 `unauthenticated`

- `src/providers/AuthProvider.tsx:55` 的 `SessionProvider` 雖設 `refetchOnWindowFocus={true}`（重新聚焦會刷新 session），但**沒有任何組件監聽 `useSession()` 的 `unauthenticated` 狀態**去導向登入。
- 此外未設 `refetchInterval`，純閒置（未重新聚焦視窗）不會主動刷新 session，無法及時察覺過期。

### 現況旁證

- 目前**只有** `src/app/[locale]/(dashboard)/global/page.tsx:83` 一頁手動檢查 `status === 'unauthenticated'`；其餘 68 頁（含主儀表板）皆無客戶端守衛。
- 既往相關 FIX 不涵蓋本議題：FIX-019b 處理的是「下載 fetch 跟隨重導向拿到 HTML」、FIX-030 處理的是「生產 auth session 同步」，皆非客戶端輪詢遇 401 不導回。

---

## 解決方案（選項 A，用戶 2026-06-03 確認）

**全局客戶端 session 守衛 + 閒置定期刷新**。最小且外科手術式改動，沿用既有 NextAuth 機制，不觸碰 100+ hook，直接解決「過期後不導回」的根因並快速止住 401 洪流。

### 1. 新增 `SessionGuard` 客戶端組件

新建 `src/components/layout/SessionGuard.tsx`（`'use client'`）：

- 透過 `useSession()` 監聽認證狀態。
- 當 `status === 'unauthenticated'` 時，使用 **locale-aware** 的 `useRouter` / `usePathname`（來自 `@/i18n/routing`）導向 `/auth/login`，並帶上 `callbackUrl`（當前路徑），登入後可回到原頁。
- 僅在「曾經認證、隨後變為未認證」時導向，避免初次 `loading` 狀態誤判（以 `status` 判斷，`loading` 不動作）。
- 本身不渲染任何可見 UI（回傳 `null`），純行為守衛。

### 2. 將 `SessionGuard` 掛進 dashboard 佈局

在 `(dashboard)` 佈局範圍內掛載，使 69 頁全覆蓋（取代目前僅 `global/page.tsx` 單頁處理）。預計掛在 `src/components/layout/DashboardLayout.tsx`（客戶端組件）內，或於 `(dashboard)/layout.tsx` 中作為 `children` 旁的 sibling。

### 3. 為 SessionProvider 加 `refetchInterval`

在 `src/providers/AuthProvider.tsx` 的 `SessionProvider` 加上 `refetchInterval`（單位：秒，預計 5 分鐘 = `300`），讓**純閒置（未重新聚焦視窗）也能定期刷新 session**，及時偵測過期並觸發 `SessionGuard` 導向。

> 屬「補上既有機制缺口」，沿用 NextAuth + 既有 `global/page.tsx` 模式，不偏離設計、不觸發 H1/H6。i18n 方面僅使用既有 `@/i18n/routing`，無新增使用者可見字串（導向過程不顯示新文案），不觸發 H5；若決定加「session 已過期」提示 toast，再同步補 3 語言翻譯。

---

## 修改的檔案（實際）

| 檔案 | 修改內容 |
|------|----------|
| `src/components/layout/SessionGuard.tsx`（新增） | 客戶端守衛：`useSession` 監聽 `status`；偵測 `unauthenticated` 後**延遲 1.5 秒 + `getSession()` 權威二次確認**，確認真的取不到 session 才以 `@/i18n/routing` 的 `useRouter().replace({ pathname: '/auth/login', query: { callbackUrl } })` 導向（callbackUrl = `window.location.pathname + search`，locale-aware、replace 不留歷史）。`getSession` 失敗（網路/重編譯）不導向。組件回傳 `null` |
| `src/components/layout/DashboardLayout.tsx` | `import { SessionGuard }` + 在根 `<div>` 內掛載 `<SessionGuard />`，使全部 69 個 dashboard 頁面受守衛 |
| `src/providers/AuthProvider.tsx` | `SessionProvider` 新增 `refetchInterval={5 * 60}`（300 秒，閒置定期刷新 session） |

### 實作備註

- `callbackUrl` 採**完整路徑（含 locale 前綴）**：因 `LoginForm` 使用 `next/navigation` 的 `router.push(callbackUrl)`（非 locale-aware），需完整路徑才能登入後正確返回。
- 守衛僅在 `status === 'unauthenticated'` 時動作；初次 `loading` 與 `authenticated` 皆不觸發，不影響正常使用流程（與既有 `global/page.tsx` 模式一致）。
- 守衛只掛在 `(dashboard)` 佈局；登入頁屬 `(auth)` 路由組，不受守衛包裹，無導向迴圈風險。
- 與既有 SSR 防護互補：`(dashboard)/layout.tsx` 處理「導航時已登出」，`SessionGuard` 處理「頁面開啟後執行期過期」。

---

## 回歸修復 v2（2026-06-04）：誤判導向

### 回歸症狀

初版 `SessionGuard` 上線後，用戶回報「登入後約 1 分鐘就被導回登入頁」。

### 回歸根因（Playwright 端到端調查）

1. **伺服器 session 全程有效**：登入後連續觀測 `/api/auth/session`（每 3 秒一次、共 120 秒；另觸發 12 次視窗聚焦刷新）——**每次都回傳有效 session（`hasUser:true`）**，`expires` 持續往後滑動。dev 模式登入的 user id 為 `dev-user-1`，jwt callback 走簡單分支，伺服器 session 不可能在 1 分鐘內失效。
2. **導向來自初版 `SessionGuard` 的誤判**：導向 URL 帶 locale 前綴的 `callbackUrl`、發生在 middleware 不保護的 `/admin` 路由、且 dashboard layout 的 SSR redirect 不帶 callbackUrl → 只可能來自 `SessionGuard`。
3. **瞬間 `unauthenticated`**：next-auth v5 (beta) 的 `useSession` 會在輪詢 / 視窗聚焦重新驗證 / **開發模式 HMR 重編譯**時，因單次 session 請求短暫失敗（實測捕捉到 `Failed to fetch`）而瞬間回報 `unauthenticated`。初版守衛立即 `router.replace` 導走，沒給狀態恢復的機會（~1 分鐘的節奏正好對應接連存檔觸發的 HMR 重編譯）。

### 修法

`SessionGuard` 改為「延遲 + 權威二次確認」：偵測到 `unauthenticated` 後延遲 `REVERIFY_DELAY_MS`（1500ms），再以 `getSession()` 權威確認；**僅在確實取不到 session 時才導向**，`getSession` 失敗（網路 / 重編譯）則不導向。狀態若在延遲內恢復，effect cleanup 會取消計時器。

---

## 測試驗證

### 靜態檢查（已完成）

- [x] `npm run type-check`：改動檔案無型別錯誤（僅既有、無關的 `CityDetailPanel.tsx` recharts 型別與 `tests/` 缺測試 runner 型別，皆非本次引入）
- [x] `npx eslint`（改動檔案）：exit code 0，無 warning

### 瀏覽器執行期驗證（Playwright 實測，2026-06-04）

- [x] **誤判已消除**：session 有效時，連續 12 次視窗聚焦刷新（皆 `200 / hasUser:true`）→ **零導向**，頁面停留原處
- [x] **真正失效仍正確導向**：清除 session 後觸發刷新 → 守衛延遲 + `getSession()` 確認 null → 導向 `/en/auth/login?callbackUrl=%2Fen%2Fdocuments`（約 2.4 秒）
- [x] `callbackUrl` 為原頁完整路徑、保留正確 locale 前綴（`/en/...`）
- [x] 正常已登入 + 初次 `loading` 不會誤判導向
- [ ] 三語言（`zh-TW` / `zh-CN`）導向各驗一次（僅實測 `en`；邏輯與 locale 無關，低風險）
- [ ] 真實瀏覽器中由用戶確認原始「1 分鐘被踢出」不再發生（建議用戶覆驗）

---

*文件建立日期: 2026-06-03*
*最後更新: 2026-06-04（回歸修復 v2：誤判導向，Playwright 實測通過）*
