# CHANGE-059: 特權帳號 Step-Up Authentication（IAM-08 L1 → L3）

> **狀態**: 📋 規劃中（規劃日期 2026-04-28）

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-059 |
| **變更日期** | 2026-04-28 |
| **相關模組** | Authentication / Admin Operations / RBAC |
| **影響範圍** | `src/app/api/admin/**/route.ts`（高風險端點）、新增 `src/lib/auth/step-up.service.ts`、新增 `src/components/features/auth/StepUpDialog.tsx`、`prisma/schema.prisma`（StepUpVerification model） |
| **優先級** | HIGH |
| **狀態** | 📋 規劃中（規劃日期 2026-04-28） |
| **類型** | Security Hardening / New Feature |
| **依賴** | CHANGE-058（Token revocation 機制可重用 Redis 基礎設施） |

---

## 問題描述

### 現況

依據 `docs/08-security-and-governance/phase2-iam-dp-assessment.md` IAM-08 章節（評分 L1，HIGH 風險）：

| 項目 | 現況 | 企業基準 L3 | 狀態 |
|------|------|-----------|------|
| 特權角色識別 | `User.isGlobalAdmin` flag + 6 個角色（System Admin / Super User / Regional Manager / City Manager / Data Processor / Auditor）| 至少分類存在 | ✅ |
| **Step-up authentication** | ❌ Admin 操作僅需現有 session | ✅ 必須 | 🔴 缺失 |
| **定期審查 admin 權限** | ❌ 無「Last reviewed at」欄位、無 cron、無 UI | ✅ 必須 | 🔴 缺失 |
| **最小權限稽核** | ❌ System Admin 永遠 22 permissions 全有 | ✅ 必須 | 🔴 缺失 |
| 敏感操作 audit log | ⚠️ 部分有（service 層手動寫），不一致 | 100% 覆蓋 | 🟡 |

### 關鍵風險

依 `phase2-iam-dp-assessment.md` IAM-08「為何不評 L2」段落：

1. **Admin 操作（建立用戶、變更權限）僅需現有 session，無重新驗證機制**
2. **無「Last reviewed at」欄位、無 cron job 提醒、無 UI 列出已 90 天未使用的 admin 帳號**
3. **System Admin 永遠擁有所有 22 permissions，無法限縮**
4. **`/admin/users/route.ts` 權限檢查存在但寬鬆**（USER_VIEW 即可看用戶列表，無「敏感操作必須 INVOKE_MFA」之類設計）

### 攻擊情境

1. Admin 帳號被 phishing → 攻擊者取得 8h session
2. 攻擊者直接呼叫 `/admin/users/[id]` PATCH 變更某用戶 role 為 System Admin
3. 攻擊者建立 backdoor admin 帳號
4. **目前無任何額外驗證攔截**

---

## 變更內容

### 子變更 1：定義「高風險操作」清單

**新檔案**：`src/lib/auth/sensitive-operations.ts`

```typescript
/**
 * @fileoverview 高風險操作清單（需 step-up auth）
 * @module lib/auth/sensitive-operations
 * @since CHANGE-059
 * @lastModified 2026-04-28
 */

export const SENSITIVE_OPERATIONS = {
  // 用戶管理
  USER_CREATE: 'user.create',
  USER_DELETE: 'user.delete',
  USER_ROLE_CHANGE: 'user.role-change',
  USER_PERMISSION_CHANGE: 'user.permission-change',
  USER_STATUS_CHANGE: 'user.status-change',  // SUSPEND / ACTIVATE
  USER_PASSWORD_RESET: 'user.password-reset',  // admin 重置別人密碼

  // 角色 / 權限
  ROLE_CREATE: 'role.create',
  ROLE_DELETE: 'role.delete',
  ROLE_PERMISSION_CHANGE: 'role.permission-change',

  // 系統配置
  SYSTEM_CONFIG_CHANGE: 'system.config-change',
  API_KEY_CREATE: 'apikey.create',
  API_KEY_REVOKE: 'apikey.revoke',
  WEBHOOK_CONFIG: 'webhook.config',

  // 批量操作
  BULK_DELETE_DOCUMENTS: 'documents.bulk-delete',
  BULK_DELETE_USERS: 'users.bulk-delete',
  IMPORT_HISTORICAL_DATA: 'historical.import',
  RESTORE_BACKUP: 'backup.restore',

  // 整合配置
  AZURE_INTEGRATION_CONFIG: 'integration.azure',
  N8N_WEBHOOK_CONFIG: 'integration.n8n',
} as const;

export type SensitiveOperation = typeof SENSITIVE_OPERATIONS[keyof typeof SENSITIVE_OPERATIONS];
```

### 子變更 2：Step-Up Verification Service

**新檔案**：`src/lib/auth/step-up.service.ts`

實作 5 分鐘有效的 step-up token（複用 CHANGE-058 的 Redis 基礎設施）：

```typescript
/**
 * @fileoverview Step-Up Authentication Service
 * @module lib/auth/step-up
 * @since CHANGE-059
 * @lastModified 2026-04-28
 */
import { redis } from '@/lib/redis';
import { verifyPassword } from '@/lib/password';

const STEP_UP_PREFIX = 'stepup:';
const STEP_UP_TTL = 5 * 60;  // 5 分鐘

export class StepUpService {
  /**
   * 用戶提供密碼（或 SSO re-auth）→ 取得 step-up token
   */
  async createStepUpToken(
    userId: string,
    method: 'password' | 'sso',
    proof: string  // password 或 SSO id_token
  ): Promise<string> {
    // 驗證 proof
    if (method === 'password') {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      const valid = await verifyPassword(proof, user.password);
      if (!valid) {
        await this.recordFailedAttempt(userId);
        throw new Error('Invalid credentials');
      }
    } else if (method === 'sso') {
      // 驗證 Azure AD id_token signature + iat < 5 分鐘
      await verifyAzureAdToken(proof);
    }

    const token = crypto.randomUUID();
    if (redis) {
      await redis.setex(`${STEP_UP_PREFIX}${token}`, STEP_UP_TTL, userId);
    } else {
      memoryStepUp.set(token, { userId, expiresAt: Date.now() + STEP_UP_TTL * 1000 });
    }

    await auditLogService.log({
      action: 'STEP_UP_AUTH_SUCCESS',
      userId,
      metadata: { method },
    });

    return token;
  }

  /**
   * 驗證 step-up token（在敏感 API 中呼叫）
   */
  async verifyStepUpToken(token: string, expectedUserId: string): Promise<boolean> {
    const userId = redis
      ? await redis.get(`${STEP_UP_PREFIX}${token}`)
      : memoryStepUp.get(token)?.userId;

    if (!userId || userId !== expectedUserId) return false;

    // One-time use：驗證後即刪除（避免 replay）
    if (redis) {
      await redis.del(`${STEP_UP_PREFIX}${token}`);
    } else {
      memoryStepUp.delete(token);
    }

    return true;
  }

  /**
   * 失敗計數（防暴力破解 step-up 密碼）
   */
  private async recordFailedAttempt(userId: string): Promise<void> {
    // 5 次失敗 → 鎖定 step-up 30 分鐘
    // 此處與 IAM-07 帳號鎖定區隔（step-up 失敗不鎖整個帳號）
  }
}
```

### 子變更 3：Step-Up API Endpoint

**新檔案**：`src/app/api/auth/step-up/route.ts`

```typescript
/**
 * POST /api/auth/step-up
 * Body: { method: 'password' | 'sso', proof: string }
 * Returns: { token: string }
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return unauthorized();

  const { method, proof } = await request.json();
  const token = await stepUpService.createStepUpToken(
    session.user.id,
    method,
    proof
  );

  return Response.json({ success: true, data: { token, expiresIn: 300 } });
}
```

### 子變更 4：withStepUp HOF

**新檔案**：`src/lib/api/with-step-up.ts`

包裝高風險 API endpoint：

```typescript
import type { SensitiveOperation } from '@/lib/auth/sensitive-operations';

export function withStepUp<T>(
  handler: (req: Request, ctx: { session: Session; userId: string }) => Promise<T>,
  operation: SensitiveOperation
) {
  return async (req: Request, ctx: any) => {
    const session = await auth();
    if (!session?.user) return unauthorized();

    const stepUpToken = req.headers.get('X-Step-Up-Token');
    if (!stepUpToken) {
      return Response.json({
        type: 'about:blank',
        title: 'Step-Up Authentication Required',
        status: 403,
        detail: `Operation ${operation} requires step-up authentication.`,
        instance: req.url,
      }, { status: 403 });
    }

    const valid = await stepUpService.verifyStepUpToken(stepUpToken, session.user.id);
    if (!valid) {
      return Response.json({
        type: 'about:blank',
        title: 'Invalid Step-Up Token',
        status: 403,
        detail: 'Step-up token expired or invalid.',
        instance: req.url,
      }, { status: 403 });
    }

    // 記錄高風險操作
    await auditLogService.log({
      action: 'SENSITIVE_OPERATION',
      userId: session.user.id,
      metadata: { operation, endpoint: req.url },
    });

    return handler(req, { session, userId: session.user.id });
  };
}
```

### 子變更 5：高風險 API 套用 withStepUp

**檔案**：以下 endpoint 包裝 `withStepUp`：

| Endpoint | Operation |
|----------|-----------|
| `POST /api/admin/users` | USER_CREATE |
| `DELETE /api/admin/users/[id]` | USER_DELETE |
| `PATCH /api/admin/users/[id]/roles` | USER_ROLE_CHANGE |
| `PATCH /api/admin/users/[id]/permissions` | USER_PERMISSION_CHANGE |
| `PATCH /api/admin/users/[id]/status` | USER_STATUS_CHANGE |
| `POST /api/admin/users/[id]/reset-password` | USER_PASSWORD_RESET |
| `POST/DELETE/PATCH /api/admin/roles/*` | ROLE_* |
| `PATCH /api/admin/config/*` | SYSTEM_CONFIG_CHANGE |
| `POST /api/admin/api-keys` | API_KEY_CREATE |
| `POST /api/admin/restore` | RESTORE_BACKUP |
| `POST /api/admin/historical-data/upload` | IMPORT_HISTORICAL_DATA |
| `DELETE /api/admin/documents/bulk-delete` | BULK_DELETE_DOCUMENTS |

### 子變更 6：前端 StepUpDialog 元件

**新檔案**：`src/components/features/auth/StepUpDialog.tsx`

- 攔截 403 with `title: 'Step-Up Authentication Required'` 的響應
- 彈出對話框要求重新輸入密碼（或點擊 SSO re-auth）
- 取得 token 後自動 retry 原始 API 並注入 `X-Step-Up-Token` header
- i18n 整合：`messages/{en,zh-TW,zh-CN}/auth.json` 新增 `stepUp.*` 區塊

### 子變更 7：定期審查機制

**新檔案**：
- `prisma/schema.prisma`：`User` model 加 `lastPrivilegeReviewAt: DateTime?` 欄位
- `src/services/admin/privilege-review.service.ts`：每月生成「未審查的 admin 帳號」報表
- `src/app/api/admin/privilege-review/route.ts`：管理員 UI 端點

### 子變更 8：審計日誌完整覆蓋

確保所有 step-up 相關事件均寫入 AuditLog：
- `STEP_UP_AUTH_REQUEST`
- `STEP_UP_AUTH_SUCCESS`
- `STEP_UP_AUTH_FAILURE`
- `SENSITIVE_OPERATION`
- `STEP_UP_TOKEN_EXPIRED`

---

## 影響評估

### 正面影響

| 面向 | 改善 |
|------|------|
| **特權帳號被入侵後攻擊面** | 大幅縮小（攻擊者需另外取得密碼/SSO 才能執行敏感操作）|
| **敏感操作審計** | 100% 覆蓋（withStepUp 強制寫 AuditLog）|
| **合規要求** | 達 IAM-08 L3 基準 |
| **內部威脅防護** | 即使 admin 帳號被同事借用，5 分鐘後 step-up token 失效 |

### 風險與緩解

| 風險 | 影響 | 緩解 |
|------|------|------|
| **Admin 體驗變差**（每次敏感操作要重新輸密碼）| 操作效率降低 | 5 分鐘內可重複使用 step-up token；批量操作前先 step-up 一次 |
| **SSO-only 用戶無密碼可輸** | 無法 step-up | 提供 Azure AD re-auth flow（OAuth prompt=login） |
| **Redis 故障 → step-up token 無法驗證** | 敏感操作中斷 | in-memory fallback；單實例可用 |
| **Step-up token 被攔截重用** | 攻擊者取得短期權限 | one-time use（驗證即刪除）|
| **既有 admin 流程需大量改動** | 開發成本高 | 分批導入：先 USER_* + ROLE_* 系列 → SYSTEM_CONFIG → 其他 |

### 不變範圍

- 不變動既有 RBAC 結構（仍 6 角色 / 22 permissions）
- 不變動 NextAuth provider 設定
- 一般操作（INVOICE_VIEW、REPORT_VIEW）不受影響

---

## 測試計劃

### 單元測試

- [ ] `StepUpService.createStepUpToken()` 密碼正確時生成 token
- [ ] 密碼錯誤時 throw error 並寫 audit log
- [ ] `verifyStepUpToken()` 一次性使用（驗證後刪除）
- [ ] `withStepUp` HOF 缺 token 時返回 403 + RFC 7807 格式
- [ ] Token 過期（> 5 分鐘）後驗證失敗

### 整合測試

- [ ] 未持有 step-up token 呼叫 `POST /api/admin/users` → 403
- [ ] 持有有效 step-up token 呼叫 → 成功
- [ ] Token 重用（同一 token 第二次使用）→ 403
- [ ] SSO 用戶透過 Azure AD re-auth 取得 token → 成功

### E2E 測試

- [ ] Admin 點擊「建立用戶」→ 彈 StepUpDialog → 輸密碼 → 自動 retry → 成功
- [ ] Admin 5 分鐘內連續做 3 個敏感操作 → 第一次彈窗，後續無感
- [ ] Admin 6 分鐘後做敏感操作 → 重新彈窗
- [ ] 模擬攻擊：取得 admin session 但無密碼 → 任何敏感操作均被攔截

### 安全測試

- [ ] Step-up token 無法跨用戶使用（A 的 token 不能被 B 用）
- [ ] Step-up token 在 Redis 中以 hashed 形式儲存（非 plaintext）
- [ ] 失敗 5 次後 step-up 暫時鎖定（30 分鐘）

---

## Rollout 策略

### 階段化部署

| 階段 | 動作 | 驗證點 |
|------|------|--------|
| **Phase 1** | StepUpService + endpoint + StepUpDialog | 單元測試通過 |
| **Phase 2** | USER_CREATE / USER_DELETE / USER_ROLE_CHANGE 套用 | E2E：用戶管理 |
| **Phase 3** | ROLE_* 系列套用 | E2E：角色管理 |
| **Phase 4** | SYSTEM_CONFIG_CHANGE / API_KEY_* 套用 | E2E：系統配置 |
| **Phase 5** | BULK_DELETE / RESTORE_BACKUP / IMPORT_HISTORICAL_DATA | E2E：批量操作 |
| **Phase 6** | 整合配置（AZURE / N8N） | E2E：整合 |
| **Phase 7** | 定期審查機制（cron + UI） | 抽樣檢視報表 |

### Feature Flag

```env
FEATURE_STEP_UP_AUTH=true            # 全域開關
FEATURE_STEP_UP_USER_OPS=true        # Phase 2
FEATURE_STEP_UP_ROLE_OPS=true        # Phase 3
FEATURE_STEP_UP_SYSTEM_OPS=true      # Phase 4
# ...
```

### 回滾策略

- 每個 Phase 用 feature flag 控制
- StepUpDialog 元件 graceful fallback（flag off 時不彈窗）

---

## 完成標準

- [ ] `StepUpService` 完成並有 ≥ 90% 單元測試覆蓋
- [ ] `withStepUp` HOF 完成
- [ ] 所有列出的 12+ 高風險 endpoint 套用 withStepUp
- [ ] StepUpDialog 元件 + i18n 完整
- [ ] 定期審查機制（lastPrivilegeReviewAt + cron + UI）完成
- [ ] 審計日誌覆蓋所有 step-up 事件
- [ ] `phase2-iam-dp-assessment.md` IAM-08 評分從 L1 升 L3
- [ ] 所有 E2E 測試通過

---

## 相關文件

- **Phase 2 評估**：`docs/08-security-and-governance/phase2-iam-dp-assessment.md` IAM-08 章節
- **Governance Matrix**：`docs/08-security-and-governance/enterprise-security-governance-matrix.md` v1.2 IAM-08
- **依賴 CHANGE**：CHANGE-058（Redis 基礎設施）
- **配套 CHANGE**：CHANGE-061（withAuth HOF）— withStepUp 可組合在 withAuth 之後
- **既有 RBAC**：`src/types/role-permissions.ts`、`src/types/permissions.ts`

---

## 風險提示

- **使用者體驗 trade-off**：每次敏感操作彈窗會降低 admin 效率，但這是企業級必要安全代價
- **SSO re-auth 實作複雜度**：Azure AD `prompt=login` 需要前端 redirect flow，建議先做密碼版本
- **與 IAM-07（帳號鎖定）區隔**：step-up 失敗不應觸發帳號鎖定，避免 admin 自我鎖死
- **設計取捨**：是否要求**所有** admin 操作都 step-up？本 CHANGE 採用「高風險清單」策略，平衡安全與體驗 — 需用戶確認是否同意此清單

---

*文件建立日期: 2026-04-28*
*規劃者: Claude AI（Phase 3 Security Hardening）*
*下一步: 與 Stakeholder review 高風險操作清單 + SSO re-auth 是否 Phase 1 必做*
