# CHANGE-058: Session 管理強化（IAM-04 L1 → L3）

> **狀態**: 📋 規劃中（規劃日期 2026-04-28）

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-058 |
| **變更日期** | 2026-04-28 |
| **相關模組** | Authentication / Session / NextAuth |
| **影響範圍** | `src/lib/auth.config.ts`、`src/lib/auth.ts`、`src/middleware.ts`、`.env.example`、新增 `src/lib/auth/token-revocation.service.ts` |
| **優先級** | HIGH |
| **狀態** | 📋 規劃中（規劃日期 2026-04-28） |
| **類型** | Security Hardening |
| **依賴** | FIX-052（Redis 基礎設施已就緒，可重用）；無前置 CHANGE |

---

## 問題描述

### 現況

依據 `docs/08-security-and-governance/phase2-iam-dp-assessment.md` IAM-04 章節（評分 L1，HIGH 風險）：

| 項目 | 現況 | 企業基準 L3 | 狀態 |
|------|------|-----------|------|
| Session 有效期 | 8 小時（`SESSION_MAX_AGE = 8 * 60 * 60`）| ≤ 24h | ✅ 達標 |
| JWT strategy | `strategy: 'jwt'`（無狀態）| — | ⚠️ 限制 |
| Refresh token | ❌ 無應用層機制 | ✅ 必須 | 🔴 缺失 |
| Logout token revocation | ❌ NextAuth `signOut()` 僅清 cookie，JWT 仍有效 8h | ✅ 即時失效 | 🔴 缺失 |
| Session secret 配置 | 3 個 secret 並存（AUTH_SECRET / JWT_SECRET / SESSION_SECRET）| 統一 | 🟡 混亂 |
| Token 過期一致性 | `JWT_EXPIRES_IN="7d"` vs `SESSION_MAX_AGE=8h` 不一致 | 一致 | 🟡 |
| 帳號停用後 token 即時失效 | ❌ middleware 不查 DB，停用帳號的 JWT 仍可用 | ✅ 必須 | 🔴 重大缺陷 |

### 關鍵風險

依 `phase2-iam-dp-assessment.md` IAM-04 第 4 點與「為何不評 L2」段落：

1. **JWT 在 8 小時內無法主動 invalidate**（即使 admin 在系統內按「停用此用戶」）
2. **Logout 後 JWT 仍可用於 API 呼叫**（cookie 清除無效，因為攻擊者已抓取 token）
3. **多個 secret 配置不一致**（`.env.example` L27-37）
4. **JWT_EXPIRES_IN="7d" 與 SESSION_MAX_AGE=8h 衝突**（`.env.example` L34 vs auth.config.ts L257）

### Session 表設計問題

依 `phase2-iam-dp-assessment.md` IAM-04 第 2 點：

> `prisma/schema.prisma` L113-126：`Session` model 含 `sessionToken`, `userAgent`, `ipAddress` 欄位，但因採用 JWT strategy，這些欄位實際不會被填充。

→ Schema 與實際使用脫節。

---

## 變更內容

### 子變更 1：JWT 有效期統一為 24h（含 sliding session）

**檔案**：`src/lib/auth.config.ts`

```typescript
// Before
const SESSION_MAX_AGE = 8 * 60 * 60; // 8 hours

// After
const SESSION_MAX_AGE = 24 * 60 * 60; // 24 hours（符合 L3 上限）
const SESSION_UPDATE_AGE = 60 * 60;    // 1 hour（每小時 sliding 更新 token）

session: {
  strategy: 'jwt',
  maxAge: SESSION_MAX_AGE,
  updateAge: SESSION_UPDATE_AGE,  // NextAuth 自動 sliding
}

jwt: {
  maxAge: SESSION_MAX_AGE,        // 與 session 一致
}
```

### 子變更 2：實作 Token Revocation（基於 Redis 黑名單）

**新檔案**：`src/lib/auth/token-revocation.service.ts`

複用 FIX-052 的 Upstash Redis 基礎設施（in-memory fallback）：

```typescript
/**
 * @fileoverview JWT Token 撤銷服務（Redis 黑名單 + in-memory fallback）
 * @module lib/auth/token-revocation
 * @since CHANGE-058
 * @lastModified 2026-04-28
 */
import { redis } from '@/lib/redis';

const TOKEN_BLACKLIST_PREFIX = 'token:blacklist:';
const USER_REVOKE_AT_PREFIX = 'user:revoke-at:';

export class TokenRevocationService {
  /**
   * 撤銷單一 token（logout 時呼叫）
   * @param tokenId JWT 的 jti claim
   * @param ttlSeconds 剩餘有效期（避免無限期佔用 Redis）
   */
  async revokeToken(tokenId: string, ttlSeconds: number): Promise<void> {
    if (redis) {
      await redis.setex(`${TOKEN_BLACKLIST_PREFIX}${tokenId}`, ttlSeconds, '1');
    } else {
      // in-memory fallback（非多實例安全，但與 FIX-052 一致）
      memoryBlacklist.set(tokenId, Date.now() + ttlSeconds * 1000);
    }
  }

  /**
   * 撤銷某用戶的所有現有 token（管理員停用帳號 / 強制重新登入）
   * 透過 "issued before X" 邏輯：所有 iat < revokeAt 的 token 視為失效
   */
  async revokeAllUserTokens(userId: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    if (redis) {
      await redis.set(`${USER_REVOKE_AT_PREFIX}${userId}`, now.toString());
    } else {
      memoryUserRevokeAt.set(userId, now);
    }
  }

  /**
   * 檢查 token 是否被撤銷
   */
  async isRevoked(tokenId: string, userId: string, issuedAt: number): Promise<boolean> {
    // Check 1: 個別 token blacklist
    const blacklisted = redis
      ? await redis.get(`${TOKEN_BLACKLIST_PREFIX}${tokenId}`)
      : memoryBlacklist.get(tokenId);
    if (blacklisted) return true;

    // Check 2: 用戶級撤銷時間
    const userRevokeAt = redis
      ? await redis.get(`${USER_REVOKE_AT_PREFIX}${userId}`)
      : memoryUserRevokeAt.get(userId);
    if (userRevokeAt && issuedAt < parseInt(userRevokeAt)) return true;

    return false;
  }
}
```

### 子變更 3：Middleware 整合 Revocation 檢查

**檔案**：`src/middleware.ts` + `src/lib/auth.config.ts`（jwt callback）

在 NextAuth `jwt` callback 加入 revocation check：

```typescript
// auth.config.ts
callbacks: {
  async jwt({ token, user, trigger }) {
    if (user) {
      // 登入時注入 jti 與 iat
      token.jti = crypto.randomUUID();
      token.iat = Math.floor(Date.now() / 1000);
    }

    // 每次 token 使用都檢查 revocation
    if (token.jti && token.sub && token.iat) {
      const revoked = await tokenRevocationService.isRevoked(
        token.jti as string,
        token.sub,
        token.iat as number
      );
      if (revoked) {
        return null;  // NextAuth 會視為未登入
      }
    }

    return token;
  },
  // ...
}
```

**效能考量**：每次 API 請求都查 Redis（O(1) GET）— 預期延遲 < 5ms（FIX-052 實測）。

### 子變更 4：Logout 主動撤銷

**檔案**：`src/app/api/auth/logout/route.ts`（新增或擴增）

```typescript
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ success: true }); // 已登出
  }

  const token = request.headers.get('authorization')?.replace('Bearer ', '');
  // 從 token 解出 jti 與 exp
  const decoded = decodeJwt(token);
  if (decoded?.jti && decoded?.exp) {
    const ttl = decoded.exp - Math.floor(Date.now() / 1000);
    await tokenRevocationService.revokeToken(decoded.jti, Math.max(ttl, 1));
  }

  return Response.json({ success: true });
}
```

### 子變更 5：管理員停用帳號 → 撤銷所有 token

**檔案**：`src/app/api/admin/users/[id]/status/route.ts`（既有，擴增）

```typescript
// 當 status 改為 SUSPENDED / INACTIVE 時
if (newStatus === 'SUSPENDED' || newStatus === 'INACTIVE') {
  await tokenRevocationService.revokeAllUserTokens(userId);
  await auditLogService.log({
    action: 'USER_TOKENS_REVOKED',
    userId,
    actorId: session.user.id,
    reason: `Status changed to ${newStatus}`,
  });
}
```

### 子變更 6：統一 Session Secret 配置

**檔案**：`.env.example` + `src/lib/auth.config.ts`

合併三個 secret，僅保留 `AUTH_SECRET`（NextAuth v5 標準）：

```env
# Before
AUTH_SECRET="..."
JWT_SECRET="..."
SESSION_SECRET="..."
JWT_EXPIRES_IN="7d"   # 與 SESSION_MAX_AGE 衝突

# After
AUTH_SECRET="..."  # 唯一 secret，NextAuth 自動使用
# JWT_SECRET 與 SESSION_SECRET 保留 1-2 release 的相容性註解，標記 deprecated
```

`.env.example` 加註解：
```env
# AUTH_SECRET 為唯一 secret（CHANGE-058 統一）
# JWT_SECRET / SESSION_SECRET deprecated（將於下個 major version 移除）
```

### 子變更 7：（可選）Refresh Token 機制評估

依 `phase2-iam-dp-assessment.md` IAM-04 建議第 4 點：

> 「文檔化是否需要 refresh token（B2B 對內系統可考慮直接縮短 maxAge 到 1h + 自動 re-login）」

**設計決策**：建議**不實作 refresh token**，理由：
1. B2B 對內系統，sliding session（updateAge=1h）已可解決長時間使用問題
2. Refresh token 引入額外複雜度（rotation、revocation list）
3. 24h JWT + sliding update 是業界主流配置

→ 在 `docs/08-security-and-governance/iam-04-design-decisions.md` 記錄此決策（新增）。

---

## 影響評估

### 正面影響

| 面向 | 改善 |
|------|------|
| **帳號停用即時生效** | 從「8 小時延遲」→ 「即時」(< 5ms Redis 延遲) |
| **Logout 真正失效** | JWT 加入黑名單，無法被攻擊者重用 |
| **Session 有效期符合 L3** | ≤ 24h 統一配置 |
| **Secret 管理一致性** | 3 個 → 1 個（AUTH_SECRET）|
| **配置一致性** | maxAge 統一為 24h，不再有 8h vs 7d 衝突 |

### 風險與緩解

| 風險 | 影響 | 緩解 |
|------|------|------|
| **Redis 故障 → revocation check 失效** | 已撤銷 token 仍可用 | FIX-052 已有 in-memory fallback；單實例環境仍可用 |
| **每次請求查 Redis 增加延遲** | API 響應變慢 | 實測 < 5ms；可加應用層 LRU cache（5 秒）降低 Redis 呼叫 |
| **既有用戶 logout 體驗改變** | 從「立即」→ 「立即且 token 失效」（無感） | — |
| **AUTH_SECRET 統一後既有環境需更新 .env** | 重新部署需協調 | 部署前提供 migration script + .env 更新指南 |
| **現有 8h session 用戶需重新登入** | 部署當下所有用戶被踢出 | 部署時間選擇低峰時段；發送公告 |

### 不變範圍

- 不變動 NextAuth provider（Azure AD / Credentials）邏輯
- 不變動 Session model schema（仍保留為未來 db-strategy 預留）
- 不變動 password hashing / login flow

---

## 測試計劃

### 單元測試

- [ ] `TokenRevocationService.revokeToken()` 寫入 Redis 與 in-memory 都正確
- [ ] `TokenRevocationService.isRevoked()` 正確識別黑名單 token
- [ ] `revokeAllUserTokens()` 後該用戶舊 token 失效，新登入 token 仍可用
- [ ] Redis 不可用時 fallback 到 in-memory（與 FIX-052 對齊）

### 整合測試

- [ ] 登入 → 使用 token → API 通過
- [ ] 登入 → logout → 同 token 重試 API → 401
- [ ] 登入 → admin 將該用戶 status 改為 SUSPENDED → 該用戶 token 立即失效
- [ ] 24h 後 token 自動過期
- [ ] sliding update：1 小時內活躍使用，token iat 自動更新

### E2E 測試

- [ ] 模擬攻擊：取得 token → logout → 重用 token → 應失敗
- [ ] 模擬帳號被入侵：admin 強制 revoke → 攻擊者持有的 token 立即失效
- [ ] 多實例部署：實例 A logout，實例 B 也識別為已撤銷（驗證 Redis 共享）

### 效能測試

- [ ] 每次 API 請求 Redis 延遲 < 5ms（p95）
- [ ] Token 黑名單成長 1 萬筆後查詢仍 < 5ms

---

## Rollout 策略

### 階段化部署

| 階段 | 動作 | 驗證點 |
|------|------|--------|
| **Phase 1** | 部署 TokenRevocationService（不啟用檢查）| Service 單元測試通過 |
| **Phase 2** | 啟用 jwt callback 中的 revocation check | 監控 Redis 延遲 |
| **Phase 3** | 啟用 logout 主動撤銷 | 抽樣驗證 logout 後 token 失效 |
| **Phase 4** | 啟用 admin 停用帳號 → revoke all tokens | 整合測試 |
| **Phase 5** | 統一 AUTH_SECRET（移除 JWT/SESSION_SECRET 使用）| `.env.example` 更新 |
| **Phase 6** | 切換 SESSION_MAX_AGE 8h → 24h + sliding | 用戶體驗驗證 |

### Feature Flag

```env
# 漸進啟用 revocation check
FEATURE_TOKEN_REVOCATION_CHECK=true     # Phase 2
FEATURE_LOGOUT_REVOKES_TOKEN=true       # Phase 3
FEATURE_ADMIN_REVOKE_ALL_TOKENS=true    # Phase 4
```

### 回滾策略

- 每個 Phase 用 feature flag 控制，可獨立關閉
- AUTH_SECRET 統一階段需 1-2 個 release 過渡（保留向後相容）

---

## 完成標準

- [ ] `TokenRevocationService` 實作完成並有 ≥ 90% 單元測試覆蓋
- [ ] NextAuth jwt callback 整合 revocation check
- [ ] Logout endpoint 主動撤銷 token
- [ ] Admin 停用帳號自動 revoke all tokens
- [ ] `SESSION_MAX_AGE` 統一為 24h，sliding update 1h
- [ ] `JWT_EXPIRES_IN` 與 `SESSION_MAX_AGE` 一致（移除 7d 衝突）
- [ ] `.env.example` 統一為 AUTH_SECRET（其餘 deprecated 註解）
- [ ] `docs/08-security-and-governance/iam-04-design-decisions.md` 完成（記錄不做 refresh token 的理由）
- [ ] `phase2-iam-dp-assessment.md` IAM-04 評分從 L1 升 L3
- [ ] 所有 E2E 測試通過

---

## 相關文件

- **Phase 2 評估**：`docs/08-security-and-governance/phase2-iam-dp-assessment.md` IAM-04 章節
- **Governance Matrix**：`docs/08-security-and-governance/enterprise-security-governance-matrix.md` v1.2 IAM-04
- **依賴 FIX**：FIX-052（Redis 基礎設施）
- **配套 CHANGE**：CHANGE-059（Step-up auth）— 進階場景重用 revocation；CHANGE-061（withAuth）整合
- **NextAuth 配置**：`src/lib/auth.config.ts`（L69, L257-260）

---

## 風險提示

- **JWT 無狀態 vs Revocation 有狀態的本質衝突**：本 CHANGE 接受此 trade-off（每請求 Redis check），是業界標準作法
- **Redis 為強依賴**：若 Redis 持續故障，安全性降級為「8h max delay」（與目前一致）
- **AUTH_SECRET 統一需協調部署**：所有環境 `.env` 必須同步更新
- **24h session 比 8h 安全性微降**：但符合企業基準上限，且配合 revocation 即時失效後的整體強度更高

---

*文件建立日期: 2026-04-28*
*規劃者: Claude AI（Phase 3 Security Hardening）*
*下一步: 確認是否實作 refresh token；若不實作則直接進入 Phase 1*
