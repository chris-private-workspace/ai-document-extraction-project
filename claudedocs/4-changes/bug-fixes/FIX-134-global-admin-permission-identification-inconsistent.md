# FIX-134: 全域管理員識別方式三套並存且互不相通，導致 API 與前端權限誤判

> **建立日期**: 2026-07-27
> **發現方式**: FIX-094 驗證期間實測 —— 以 global admin 帳號呼叫 `/api/jobs/stuck-processing-sweeper` 竟回 403，追查後發現是系統性問題
> **影響頁面/功能**: 多個 API 端點的授權判斷、前端 `useAuth().hasPermission()` 的所有呼叫點
> **優先級**: 高（全域管理員在部分功能上完全無法操作，且錯誤訊息會誤導成「權限不足」）
> **狀態**: ✅ 已修復（2026-07-27 本地四閘全過 —— `npm run build` / `type-check` / `lint` / 27 檔 282 項測試含新增 26 項；**BUG-3 實際規模為 7 檔 8 處**，遠大於規劃時記載的「至少 `/api/audit/reports`」，見下方「實作時的範圍修正」。待部署 Azure DEV 復測兩個 403 端點）

---

## 問題描述

系統中判斷「這個人是不是全域管理員」有**三套彼此不相通**的方式：

| # | 方式 | 使用者 |
|---|------|--------|
| 1 | `session.user.isGlobalAdmin` 布林欄位 | auth 核心（`auth.config.ts`）、`grant-global-admin.js` |
| 2 | `role.permissions` 陣列含 wildcard `*` | 25 個檔案（大多數 `/api/rules/*`、`/api/escalations/*`、`/api/admin/*`）|
| 3 | role **名稱**等於 `GLOBAL_ADMIN` | `/api/audit/reports` 等 |

實際帳號的資料形狀（2026-07-27 於 Azure DEV 實測 `admin@rci-t.com`）：

```
isGlobalAdmin : true
roles         : [{ name: "System Admin", permissions: ["*"] }]
```

三種方式各自看到的結論完全不同：方式 1 說是、方式 2 說是（若該檔有處理 `*`）、方式 3 說**不是**（因為角色名叫 `System Admin` 而非 `GLOBAL_ADMIN`）。

| # | 問題 | 嚴重度 | 影響 |
|---|------|--------|------|
| BUG-1 | 4 個 API route 的權限檢查不認 wildcard `*`，也不看 `isGlobalAdmin` | 高 | 全域管理員被 403 擋下 |
| BUG-2 | 前端 `use-auth.ts` 的 `hasPermission` / `hasAnyPermission` / `hasAllPermissions` 全都不認 `*` | 高 | 所有依賴這些方法的 UI 元素對全域管理員判定為無權限 |
| BUG-3 | 部分 route 以 role **名稱**判斷，與實際角色名不符 | 中 | 全域管理員被 403（與 CHANGE-052 同源） |

---

## 重現步驟

1. 以全域管理員帳號登入（`isGlobalAdmin = true`、角色 `System Admin`、`permissions = ["*"]`）
2. 於瀏覽器 console 執行：

```js
await fetch('/api/jobs/stuck-processing-sweeper', { method: 'POST' })   // → 403
await fetch('/api/audit/reports?page=1&limit=5')                        // → 403
```

3. 觀察現象：

```json
// BUG-1
{ "type": "forbidden", "status": 403, "detail": "INVOICE_REVIEW permission required" }

// BUG-3
{ "status": 403, "detail": "Audit access required. Only AUDITOR and GLOBAL_ADMIN roles can access this resource." }
```

兩者都發生在**確實擁有最高權限**的帳號上。

---

## 根本原因

### BUG-1 / BUG-2：精確比對遇上 wildcard

```typescript
// src/app/api/jobs/stuck-processing-sweeper/route.ts:43-49
function hasPermission(roles, permission: string): boolean {
  if (!roles) return false;
  return roles.some((role) => role.permissions.includes(permission));
}
```

`["*"].includes('INVOICE_REVIEW')` 為 `false` —— wildcard 是一個**字面字串** `"*"`，不是通配邏輯。`Array.prototype.includes` 只做精確比對，永遠不會把 `*` 展開。

同一份檔案也完全沒有讀取 `session.user.isGlobalAdmin`。

前端同樣模式（`src/hooks/use-auth.ts:89-129`）：`permissions` 只是把各 role 的 permissions 展平成 Set，之後三個方法一律用 `includes()` 精確比對，既不認 `*` 也不看 `isGlobalAdmin`。

### 為何有些地方正常

25 個檔案顯式寫了 wildcard 分支，所以能通過：

```typescript
// src/app/api/roles/route.ts:63-68
const hasPermission = session.user.roles?.some(
  (role) =>
    role.permissions.includes('*') ||          // ← 關鍵
    role.permissions.includes(PERMISSIONS.USER_VIEW) || ...
);
```

**問題不在「哪個寫錯」，而在於沒有單一的權限判斷入口** —— 每個 route 各自手寫，寫法漂移是必然結果。

---

## 影響範圍（2026-07-27 實測盤點）

以 `permissions.includes(` 搜尋得 **34 個檔案**，其中 **25 個**有處理 wildcard `*`。差集 9 個：

| 檔案 | 類型 | 實質影響 |
|------|------|----------|
| `src/hooks/use-auth.ts` | 前端 hook | 🔴 **最廣** —— 所有 `hasPermission()` 呼叫點 |
| `src/app/api/jobs/stuck-processing-sweeper/route.ts` | API | 🔴 已實測 403 |
| `src/app/api/jobs/pattern-analysis/route.ts` | API | 🔴 同樣寫法 |
| `src/app/api/corrections/patterns/route.ts` | API | 🔴 同樣寫法 |
| `src/app/api/corrections/patterns/[id]/route.ts` | API | 🔴 同樣寫法 |
| `src/app/[locale]/(dashboard)/rules/review/[id]/page.tsx` | 頁面 | 🔴 頁面級守衛 |
| `src/types/permission-categories.ts` | 類型定義 | 待確認（可能非檢查邏輯） |
| `src/services/role.service.ts` | 服務層 | 待確認（可能為角色管理而非授權） |
| `src/components/reports/ExportDialog.tsx` | JSDoc 範例 | 無（僅註解） |

BUG-3（role 名稱判斷）另需獨立盤點，已知至少 `/api/audit/reports`。

---

## 解決方案

### 建立單一權限判斷入口

新增 `src/lib/auth/has-permission.ts`，供 API 與前端共用同一份語意：

```typescript
/** 判斷 session 是否擁有指定權限（統一入口） */
export function sessionHasPermission(
  user: { isGlobalAdmin?: boolean; roles?: Array<{ permissions: string[] }> } | undefined,
  permission: string
): boolean {
  if (!user) return false;
  if (user.isGlobalAdmin) return true;                                    // 方式 1
  return (user.roles ?? []).some(
    (r) => r.permissions.includes('*') || r.permissions.includes(permission)  // 方式 2
  );
}
```

判斷順序刻意為 `isGlobalAdmin` → wildcard → 精確比對，三種方式一次涵蓋。

### 套用範圍

1. 上表 6 個有實質影響的檔案改用此函式
2. `use-auth.ts` 三個方法改為委派此函式（前端 session 形狀相同）
3. BUG-3 的 role 名稱判斷改為權限判斷（不再比對名稱字串）
4. 既有 25 個已處理 wildcard 的檔案**逐步**收斂到此函式（非本 FIX 必要範圍，避免一次改動過大）

### 與既有規劃的關係

| 項目 | 關係 |
|------|------|
| **CHANGE-052**（global admin role name unification，📋 未開始） | 只涵蓋 BUG-3 的角色名稱面向。本 FIX 補上 wildcard 與 `isGlobalAdmin` 兩面 —— 三者是同一根本問題，建議合併處理或明確分工 |
| **FIX-047**（audit log role name mismatch，已修復） | 同類「以角色名稱做判斷」的前例，可參考其修法 |
| **CHANGE-061**（permission check unification withauth HOF，📋 未開始） | 目標一致（統一權限檢查）。本 FIX 可作為其第一步，或直接併入 |

> ⚠️ 若採「併入 CHANGE-061」，需注意 CHANGE-061 規模較大（withAuth HOF 改造全部 route），而本 FIX 屬**當下阻塞問題**，建議先以最小修正解除阻塞。

---

## 實作時的範圍修正（2026-07-27）

### BUG-3 實際規模是 7 檔 8 處，不是「至少 1 個」

規劃時只確認了 `/api/audit/reports`。實作時以 `['AUDITOR', 'GLOBAL_ADMIN']` 全庫搜尋，命中 **7 個檔案 8 處**，全是同一份複製的寫法：

| 檔案 | 形式 |
|------|------|
| `src/app/api/audit/reports/route.ts` | `hasAuditAccess()`（2 處呼叫）|
| `src/app/api/audit/reports/[jobId]/route.ts` | `hasAuditAccess()` |
| `src/app/api/audit/reports/[jobId]/download/route.ts` | `hasAuditAccess()` |
| `src/app/api/audit/reports/[jobId]/verify/route.ts` | `hasAuditAccess()` |
| `src/app/api/audit/query/route.ts` | 行內判斷 |
| `src/app/api/audit/query/count/route.ts` | 行內判斷 |
| `src/app/api/documents/[id]/trace/report/route.ts` | `ALLOWED_ROLES` 常量 |

### 兩個角色名稱**都**是錯的（比規劃描述更嚴重）

規劃寫「角色名叫 `System Admin` 而非 `GLOBAL_ADMIN`」，只指出了一半。查 `src/types/role-permissions.ts` 後確認：

| route 比對的字串 | 實際角色名 | 結果 |
|---|---|---|
| `'GLOBAL_ADMIN'` | `'System Admin'` | ❌ 不符 |
| `'AUDITOR'` | **`'Auditor'`**（`ROLE_NAMES.AUDITOR`）| ❌ 不符（大小寫）|

意即這 8 處的判斷**對任何帳號都是 false** —— 連專門為此設計的 `Auditor` 角色也一樣被 403 擋下，不只全域管理員。

改以權限判斷後兩者都能通行：`Auditor` 憑 `AUDIT_VIEW`／`AUDIT_EXPORT`（`ROLE_PERMISSIONS` 已定義），全域管理員憑 `isGlobalAdmin` 或 wildcard。

### 兩個「待確認」檔案的判定

| 檔案 | 判定 | 理由 |
|------|------|------|
| `src/services/role.service.ts` | ✅ **納入** | `hasPermission` / `hasAnyPermission` / `hasAllPermissions` 確實是授權判斷，且 `getUserPermissions()` 原樣回傳含 `'*'` 的陣列 → 同樣的 wildcard 漏洞。改用 `permissionListHas`（無 session 故無法檢查 `isGlobalAdmin`，已於 JSDoc 標明）|
| `src/types/permission-categories.ts` | ❌ **不納入** | `hasAllCategoryPermissions` / `hasSomeCategoryPermissions` 是角色**編輯 UI** 用來顯示「此角色勾選了哪些分類」，非授權判斷。若讓它認 `*`，UI 會誤顯示所有 checkbox 已勾選 |

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `src/lib/auth/has-permission.ts` | 🆕 統一入口：`sessionHasPermission` / `sessionHasAnyPermission` / `sessionHasAllPermissions` / `sessionHasAuditAccess` / `permissionListHas` |
| `tests/unit/lib/has-permission.test.ts` | 🆕 26 項測試 |
| `src/hooks/use-auth.ts` | 🔧 BUG-2：三個方法委派統一函式（`permissions` 公開回傳值保留）|
| `src/app/api/jobs/stuck-processing-sweeper/route.ts` | 🔧 BUG-1：移除 local `hasPermission` |
| `src/app/api/jobs/pattern-analysis/route.ts` | 🔧 同上 |
| `src/app/api/corrections/patterns/route.ts` | 🔧 同上 |
| `src/app/api/corrections/patterns/[id]/route.ts` | 🔧 同上 |
| `src/app/[locale]/(dashboard)/rules/review/[id]/page.tsx` | 🔧 同上（頁面級守衛）|
| `src/services/role.service.ts` | 🔧 三個函式改用 `permissionListHas` |
| `src/app/api/audit/reports/route.ts` | 🔧 BUG-3 |
| `src/app/api/audit/reports/[jobId]/route.ts` | 🔧 BUG-3 |
| `src/app/api/audit/reports/[jobId]/download/route.ts` | 🔧 BUG-3 |
| `src/app/api/audit/reports/[jobId]/verify/route.ts` | 🔧 BUG-3 |
| `src/app/api/audit/query/route.ts` | 🔧 BUG-3 |
| `src/app/api/audit/query/count/route.ts` | 🔧 BUG-3 |
| `src/app/api/documents/[id]/trace/report/route.ts` | 🔧 BUG-3（`ALLOWED_ROLES` 常量移除）|

既有 25 個已自行處理 wildcard 的檔案**未動**（規劃 §套用範圍 第 4 點：逐步收斂，非本 FIX 範圍）。

---

## 測試驗證

修復完成後需驗證：

- [x] 單元測試 `sessionHasPermission`：(a) `isGlobalAdmin=true` 任何權限皆 true；(b) `permissions=["*"]` 任何權限皆 true；(c) 精確權限命中；(d) 無權限回 false；(e) `user` / `roles` 為 undefined 不拋錯 —— **26 項全過**，另涵蓋多角色聚合、`sessionHasAuditAccess`、空要求陣列邊界
- [x] **無權限帳號仍被正確擋下**（回歸：不可因加入 wildcard 而放寬成任何人都通過）—— 測試明確涵蓋 `VIEWER` / `REVIEWER` 被拒的案例
- [x] `npm run type-check` / `npm run lint` 通過（另加跑 `npm run build` 與完整測試套件：27 檔 282 項）
- [ ] 全域管理員（`isGlobalAdmin=true`、`permissions=["*"]`）可成功呼叫 `POST /api/jobs/stuck-processing-sweeper`（規劃時實測為 403）—— **待部署 Azure DEV 復測**
- [ ] 全域管理員可成功呼叫 `GET /api/audit/reports`（規劃時實測為 403）—— 待部署復測
- [ ] `Auditor` 角色帳號可存取審計端點（BUG-3 修正後應由 403 變為通行）—— 待部署復測，需有該角色帳號
- [ ] 前端：全域管理員登入後，依賴 `hasPermission()` 的 UI 元素正常顯示 —— 待部署復測
- [ ] 部署 Azure DEV 後以 `admin@rci-t.com` 復測上述端點

---

## 備註

- 本 FIX 由 FIX-094 的驗證過程意外發現。當時 sweeper 在 Azure 上「三重不可達」，其中一重正是 BUG-1；已透過補設 `CRON_SECRET` 繞過，但根因未解 —— 全域管理員仍無法從 UI 或 API 直接觸發該功能。
- 修復前的替代途徑：`x-cron-secret` header（僅適用於有 cron 支援的端點）。

---

*文件建立日期: 2026-07-27*
*最後更新: 2026-07-27*
