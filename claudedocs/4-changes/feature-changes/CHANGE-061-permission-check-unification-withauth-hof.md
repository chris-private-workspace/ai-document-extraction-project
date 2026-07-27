# CHANGE-061: Permission 檢查統一 withAuth HOF（IAM-03 L1 → L3）

> **狀態**: 📋 規劃中（規劃日期 2026-04-28）

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-061 |
| **變更日期** | 2026-04-28 |
| **相關模組** | API Routes / Authentication / Authorization |
| **影響範圍** | 新增 `src/lib/api/with-auth.ts`、`src/lib/api/response.ts`；`src/app/api/**/route.ts`（漸進式遷移）；`.eslintrc.cjs`、CI workflow |
| **優先級** | MEDIUM（架構改進，與 CHANGE-057 高度耦合） |
| **狀態** | 📋 規劃中（規劃日期 2026-04-28） |
| **類型** | Architecture / Refactor |
| **依賴** | 無前置；CHANGE-057（API auth 覆蓋率提升）會大量使用此 HOF |

---

## 問題描述

### 現況

依據 `docs/08-security-and-governance/phase2-iam-dp-assessment.md` IAM-03 章節（評分 L1，MED 風險）：

> **沒有統一的 auth middleware**：每個 API route 各自呼叫 `await auth()` + 手動檢查 `session.user`

### 三種並存的認證模式

依 `phase2-iam-dp-assessment.md` IAM-03 第 3 點：

| 模式 | 名稱 | 採用 routes | 實作位置 |
|------|------|-----------|---------|
| **A** | Session-based | ~190 | `await auth()` from `@/lib/auth` |
| **B** | API Key | ~10 | `ApiKeyService.verify()` |
| **C** | External API Key | ~3 | `externalApiAuthMiddleware()` （SHA-256 + IP 白名單）|

### 權限檢查實作不一致

依 `phase2-iam-dp-assessment.md` IAM-03 第 4 點：

| 範例 | 模式 | 問題 |
|------|------|------|
| `/admin/users/route.ts` | 用 `hasViewPermission()` helper | 不一致 |
| 許多 routes | 直接 inline `session.user.roles.find(r => r.permissions.includes(...))` | 重複代碼 |
| 部分 routes | 僅檢查 `session?.user`，無 permission 級別控制 | 安全漏洞 |

### 錯誤回應格式不一致（AppSec-11）

依 `phase2-appsec-obs-assessment.md` AppSec-11：

> 主 CLAUDE.md 已明列：「**RFC 7807 格式不一致**: 部分路由使用 top-level，部分使用 nested」
>
> 抽查 `src\app\api\documents\upload\route.ts` line 162-173 範例：使用 **nested** 格式 `{ success: false, error: { type, title, status, detail } }`（top-level 是 `error`，內含 RFC 7807 欄位 — 偏離標準）

→ 統一 HOF 內統一錯誤格式，根除此問題。

### 為何此項影響 IAM-01 覆蓋率

依 `phase2-iam-dp-assessment.md` IAM-03「為何不評 L2」：

> 缺乏統一強制機制；新 routes 容易忘記 auth check（**這也是 IAM-01 覆蓋率低的根本原因**）

---

## 變更內容

### 子變更 1：設計 withAuth HOF

**新檔案**：`src/lib/api/with-auth.ts`

```typescript
/**
 * @fileoverview 統一 API 認證 / 授權 HOF
 * @module lib/api/with-auth
 * @since CHANGE-061
 * @lastModified 2026-04-28
 */
import { NextRequest, NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { auth } from '@/lib/auth';
import { apiKeyService } from '@/lib/auth/api-key.service';
import { externalApiAuthMiddleware } from '@/middlewares/external-api-auth';
import { tokenRevocationService } from '@/lib/auth/token-revocation.service';  // CHANGE-058
import { unauthorizedError, forbiddenError } from '@/lib/api/response';
import type { Permission } from '@/types/permissions';

export interface WithAuthOptions {
  /** 必須持有的 permissions（AND 邏輯，全部都需要） */
  permissions?: Permission[];
  /** 必須持有「以下任一」permission（OR 邏輯） */
  anyPermission?: Permission[];
  /** 是否啟用城市範圍 scope 檢查（自動將 cityCode filter 注入 ctx）*/
  cityScope?: boolean;
  /** 認證模式：session（預設）/ apiKey / externalApiKey / mixed */
  authMode?: 'session' | 'apiKey' | 'externalApiKey' | 'mixed';
  /** 自訂額外 guard（拒絕時 throw forbiddenError）*/
  guard?: (session: Session) => Promise<void>;
}

export interface AuthContext {
  session: Session;
  userId: string;
  permissions: Permission[];
  cityCodes?: string[];  // 若 cityScope = true 自動填入
}

type Handler<TParams = any> = (
  request: NextRequest,
  context: { params: TParams } & { auth: AuthContext }
) => Promise<NextResponse>;

export function withAuth<TParams = any>(
  handler: Handler<TParams>,
  options: WithAuthOptions = {}
): (request: NextRequest, context: { params: TParams }) => Promise<NextResponse> {
  return async (request, context) => {
    try {
      const authMode = options.authMode ?? 'session';

      // 1. 取得 session
      let session: Session | null = null;
      if (authMode === 'session' || authMode === 'mixed') {
        session = await auth();
      }
      if ((authMode === 'apiKey' || authMode === 'mixed') && !session) {
        const apiKeySession = await apiKeyService.verifyFromRequest(request);
        if (apiKeySession) session = apiKeySession;
      }
      if (authMode === 'externalApiKey') {
        return externalApiAuthMiddleware(request, handler);
      }

      if (!session?.user) return unauthorizedError(request);

      // 2. CHANGE-058 token revocation 檢查
      if (session.token?.jti && session.user.id) {
        const revoked = await tokenRevocationService.isRevoked(
          session.token.jti,
          session.user.id,
          session.token.iat ?? 0
        );
        if (revoked) return unauthorizedError(request, 'Token revoked');
      }

      // 3. Permission 檢查
      const userPermissions = collectUserPermissions(session.user);
      if (options.permissions?.length) {
        const allMatch = options.permissions.every((p) => userPermissions.includes(p));
        if (!allMatch) return forbiddenError(request, 'Missing required permissions');
      }
      if (options.anyPermission?.length) {
        const anyMatch = options.anyPermission.some((p) => userPermissions.includes(p));
        if (!anyMatch) return forbiddenError(request, 'Missing required permissions');
      }

      // 4. 城市 scope（複用 city-permission.ts）
      let cityCodes: string[] | undefined;
      if (options.cityScope) {
        cityCodes = await getCityFilter(session.user);
      }

      // 5. 自訂 guard
      if (options.guard) {
        await options.guard(session);
      }

      // 6. 注入 auth context 給 handler
      return handler(request, {
        ...context,
        auth: {
          session,
          userId: session.user.id,
          permissions: userPermissions,
          cityCodes,
        },
      });
    } catch (error) {
      // 統一錯誤格式（top-level RFC 7807）
      return handleApiError(error, request);
    }
  };
}

function collectUserPermissions(user: any): Permission[] {
  const permissions = new Set<Permission>();
  for (const role of user.roles ?? []) {
    for (const p of role.permissions ?? []) {
      permissions.add(p as Permission);
    }
  }
  if (user.isGlobalAdmin) {
    // System Admin 擁有所有 permission
    return Object.values(PERMISSIONS) as Permission[];
  }
  return Array.from(permissions);
}
```

### 子變更 2：統一錯誤回應 helper

**新檔案**：`src/lib/api/response.ts`

```typescript
/**
 * @fileoverview RFC 7807 統一錯誤回應 helper
 * @module lib/api/response
 * @since CHANGE-061（與 CHANGE-067 共用設計）
 * @lastModified 2026-04-28
 */
import { NextRequest, NextResponse } from 'next/server';

interface RFC7807Error {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: Record<string, string[]>;
}

export function apiError(request: NextRequest, error: RFC7807Error): NextResponse {
  return NextResponse.json(error, { status: error.status });
}

export function unauthorizedError(request: NextRequest, detail = 'Authentication required'): NextResponse {
  return apiError(request, {
    type: 'https://datatracker.ietf.org/doc/html/rfc7235#section-3.1',
    title: 'Unauthorized',
    status: 401,
    detail,
    instance: request.nextUrl.pathname,
  });
}

export function forbiddenError(request: NextRequest, detail = 'Insufficient permissions'): NextResponse {
  return apiError(request, {
    type: 'https://datatracker.ietf.org/doc/html/rfc7231#section-6.5.3',
    title: 'Forbidden',
    status: 403,
    detail,
    instance: request.nextUrl.pathname,
  });
}

export function validationError(request: NextRequest, errors: Record<string, string[]>): NextResponse {
  return apiError(request, {
    type: 'https://example.com/errors/validation',
    title: 'Validation Failed',
    status: 422,
    detail: 'One or more fields failed validation.',
    instance: request.nextUrl.pathname,
    errors,
  });
}

export function apiSuccess<T>(data: T, meta?: any): NextResponse {
  return NextResponse.json({ success: true, data, meta });
}
```

### 子變更 3：使用範例與遷移指南

**範例**：

```typescript
// Before（散布的 ad-hoc 模式）
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json(
      { success: false, error: { type: '...', title: 'Unauthorized', ... } },
      { status: 401 }
    );
  }
  if (!session.user.roles.find((r) => r.permissions.includes('USER_VIEW'))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const users = await userService.list();
  return NextResponse.json({ success: true, data: users });
}

// After（withAuth + apiSuccess）
import { withAuth } from '@/lib/api/with-auth';
import { apiSuccess } from '@/lib/api/response';
import { PERMISSIONS } from '@/types/permissions';

export const GET = withAuth(
  async (request, { auth }) => {
    const users = await userService.list({ cityCodes: auth.cityCodes });
    return apiSuccess(users);
  },
  {
    permissions: [PERMISSIONS.USER_VIEW],
    cityScope: true,
  }
);
```

### 子變更 4：漸進式遷移計劃

**策略：先強制新 API + 既有逐步遷移**

| 階段 | 目標 | 預估工時 |
|------|------|---------|
| **Phase 1** | HOF 完成 + 文檔 + 範例 | 3 天 |
| **Phase 2** | 強制新 API 必須使用 withAuth（lint rule） | 1 天 |
| **Phase 3** | CHANGE-057 130 個未保護 routes 用 withAuth 補完 | 與 CHANGE-057 同步 |
| **Phase 4** | 既有 ~190 個 session-based routes 批次遷移 | 4-6 週 |
| **Phase 5** | API Key routes 整合（authMode: 'apiKey' / 'mixed'） | 1 週 |

### 子變更 5：ESLint Rule 強制

**檔案**：`.eslintrc.cjs`（新增 custom rule）+ `eslint-plugin-app-auth/`（自定義 plugin）

```javascript
// 規則：src/app/api/**/route.ts 必須符合
// (1) 在公開白名單中（CHANGE-057 PUBLIC_API_ROUTES）
// 或 (2) 含有 withAuth 包裝
// 或 (3) 使用 externalApiAuthMiddleware
```

### 子變更 6：CI 整合

**檔案**：`.github/workflows/ci.yml`

加入 `npm run check:api-auth-coverage` step（與 CHANGE-057 子變更 3 共用）。

### 子變更 7：文檔

**檔案**：
- `docs/08-security-and-governance/api-auth-pattern.md`（新增）— withAuth 使用指南
- `.claude/rules/api-design.md`（更新）— 強制要求所有新 API 必須用 withAuth
- `claudedocs/CLAUDE.md`（更新）— 引用新模式

---

## 影響評估

### 正面影響

| 面向 | 改善 |
|------|------|
| **架構一致性** | 3 套模式收斂為 1 個 HOF（authMode 參數選擇）|
| **重複代碼消除** | 預估減少 ~3,000 行（auth check + permission check + error response）|
| **新 routes 防呆** | lint rule 阻擋無 withAuth 的新 route |
| **錯誤格式統一** | 解決 AppSec-11 RFC 7807 不一致 |
| **CHANGE-057 加速** | 130 routes 補 auth 模式統一，工時降低 |
| **CHANGE-058 整合** | Token revocation check 集中於 HOF |
| **CHANGE-059 整合** | withStepUp 可組合在 withAuth 之後 |

### 風險與緩解

| 風險 | 影響 | 緩解 |
|------|------|------|
| **既有 ~190 routes 遷移工作量大** | 4-6 週 | 不阻擋 CHANGE-057；既有 routes 採「碰到就改」策略 |
| **HOF 包裝可能破壞既有測試** | 整合測試 fail | 保留既有 `await auth()` 模式為向後相容；逐步遷移 |
| **HOF 設計過於嚴格 / 寬鬆** | 產品 PR 多次返工 | Phase 1 先做 5 個範例 route 驗證設計 |
| **lint rule 過於嚴格阻擋 PR** | 開發體驗差 | 提供 `// eslint-disable-next-line app-auth/required` 緊急逃生口 |
| **API Key routes 遷移風險** | 外部客戶整合中斷 | Phase 5 獨立處理，先在 staging 完整驗證 |

### 不變範圍

- 不變動既有 RBAC 模型（仍 6 角色 / 22 permissions）
- 不變動 NextAuth 配置
- 不變動既有 routes 的業務邏輯（只變 auth/error 包裝）

---

## 測試計劃

### 單元測試

- [ ] `withAuth` 正確注入 session 與 permissions
- [ ] `permissions` 選項：所有都需有（AND）→ 缺一即 403
- [ ] `anyPermission` 選項：任一即可（OR）
- [ ] `cityScope: true` 自動注入 cityCodes
- [ ] `authMode: 'apiKey'` 正確 fallback 到 API key 驗證
- [ ] `authMode: 'mixed'` 同時支援 session + API key
- [ ] `unauthorizedError` / `forbiddenError` / `validationError` 格式符合 RFC 7807

### 整合測試

- [ ] 5 個範例 route 透過 withAuth 包裝後行為與原本一致
- [ ] 未登入呼叫 → 401 + RFC 7807 格式
- [ ] 登入但無 permission → 403 + RFC 7807 格式
- [ ] 登入且有 permission → 200/201
- [ ] City scope routes 正確 filter 用戶可見資料

### Linter 測試

- [ ] 新建 route.ts 缺 withAuth → lint 報錯
- [ ] 公開白名單路由 → lint 通過
- [ ] 含 `// eslint-disable-next-line app-auth/required` → lint 通過

---

## Rollout 策略

### 階段化部署

| 階段 | 動作 | 驗證點 |
|------|------|--------|
| **Phase 1** | HOF + response helper + 文檔 | 單元測試通過 |
| **Phase 2** | 5 個範例 route 遷移（如 `/admin/users` 系列） | E2E 測試通過 |
| **Phase 3** | lint rule + CI 強制（warning 模式） | CI 不阻擋 |
| **Phase 4** | CHANGE-057 130 routes 用 withAuth 補完 | 與 CHANGE-057 同步 |
| **Phase 5** | 既有 190 routes 批次遷移（每週 ~30 個） | 持續整合測試 |
| **Phase 6** | lint rule 切換為 error 模式（強制阻擋） | 所有新 PR 必須通過 |

### Feature Flag

不需要（HOF 為 opt-in 設計，不影響未遷移 routes）。

### 回滾策略

- 每個 route 遷移為獨立 commit，可單獨 revert
- HOF 本身穩定後不會回滾（基礎設施）

---

## 完成標準

- [ ] `withAuth` HOF 完成並有 ≥ 90% 單元測試覆蓋
- [ ] `apiSuccess` / `apiError` / `unauthorizedError` / `forbiddenError` / `validationError` 完成
- [ ] 5 個範例 route 完成遷移驗證
- [ ] CHANGE-057 130 routes 全部使用 withAuth
- [ ] 既有 190 routes ≥ 80% 遷移完成（剩餘 20% 可緩遷）
- [ ] ESLint plugin `eslint-plugin-app-auth` 完成
- [ ] CI 整合並切換為 error 模式
- [ ] `docs/08-security-and-governance/api-auth-pattern.md` 完成
- [ ] `.claude/rules/api-design.md` 更新
- [ ] `phase2-iam-dp-assessment.md` IAM-03 評分 L1 → L3
- [ ] `phase2-appsec-obs-assessment.md` AppSec-11 評分 L1 → L3

---

## 相關文件

- **Phase 2 評估**：
  - `docs/08-security-and-governance/phase2-iam-dp-assessment.md` IAM-03 章節
  - `docs/08-security-and-governance/phase2-appsec-obs-assessment.md` AppSec-11 章節
- **Governance Matrix**：`docs/08-security-and-governance/enterprise-security-governance-matrix.md` v1.2
- **強耦合 CHANGE**：CHANGE-057（API auth 覆蓋率）— 130 routes 補 auth 用此 HOF
- **整合 CHANGE**：CHANGE-058（Token revocation）、CHANGE-059（Step-up auth）
- **既有檔案**：
  - `src/lib/auth.ts`、`src/lib/auth.config.ts`
  - `src/lib/auth/api-key.service.ts`
  - `src/middlewares/external-api-auth.ts`
  - `src/lib/auth/city-permission.ts`

---

## 風險提示

- **設計取捨：HOF vs Decorator vs Middleware**：選擇 HOF 因為 Next.js App Router 不支援 class decorator；middleware 無法注入 typed context — 需用戶確認 HOF 設計可接受
- **既有 routes 遷移時間長**：190 routes 預估 4-6 週，期間混合模式存在
- **API Key 整合複雜度**：3 套 API key 系統（ApiKey / ExternalApiKey / N8nApiKey）合併不在本 CHANGE 範疇（可未來 CHANGE-XXX 處理）
- **與 CHANGE-057 高度耦合**：建議併行開發、同時 review，避免重複設計

---

*文件建立日期: 2026-04-28*
*規劃者: Claude AI（Phase 3 Security Hardening）*
*下一步: 與 CHANGE-057 規劃合併 Sprint，先做 Phase 1（HOF）3 天*
