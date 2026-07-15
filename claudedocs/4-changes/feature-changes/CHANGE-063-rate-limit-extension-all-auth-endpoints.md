# CHANGE-063: Rate Limit 推廣至全認證/敏感端點（AppSec-09 L1 → L3）

> **狀態**: 📋 規劃中（規劃日期 2026-04-28）

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-063 |
| **變更日期** | 2026-04-28 |
| **相關模組** | API Routes / Rate Limiting / Authentication |
| **影響範圍** | `src/services/rate-limit.service.ts`（既有，擴增配置）、新增 `src/lib/api/with-rate-limit.ts`、`src/middleware.ts`（全域 rate limit）、`src/app/api/auth/**`、`src/app/api/documents/upload/`、所有認證端點 |
| **優先級** | HIGH |
| **狀態** | 📋 規劃中（規劃日期 2026-04-28） |
| **類型** | Security Hardening |
| **依賴** | FIX-052（基礎 Redis rate limit 已實作，本 CHANGE 推廣使用）；CHANGE-061（withAuth HOF）— 整合 withRateLimit |

---

## 問題描述

### 現況

依據 `docs/08-security-and-governance/phase2-appsec-obs-assessment.md` AppSec-09 章節（評分 L1，HIGH 風險）：

| 指標 | 數值 | 來源 |
|------|------|------|
| **基礎設施** | ✅ FIX-052 已實作 Redis 優先 + in-memory fallback | `src/services/rate-limit.service.ts` 372 行 |
| **採用 routes** | **僅 7 個 `/v1/invoices/*` 端點 + 1 個 service 自身** | grep `rateLimitService` / `checkLimit` |
| **覆蓋率** | **2.1%（7/331）** | 7 / 331 |
| **目標覆蓋率** | 認證端點 100% + 上傳端點 100% + 一般 API 廣泛 | 企業基準 L3 |
| **認證端點 rate limit** | ❌ 完全無（`/auth/register`、`/forgot-password`、`/reset-password`） | grep |
| **上傳端點 rate limit** | ❌ 完全無（`/documents/upload`、`/admin/historical-data/upload`）| grep |

### 關鍵風險

依 `phase2-appsec-obs-assessment.md` AppSec-09「缺口」段落：

1. **324 個路由完全無 rate limit**
2. **認證 brute-force 攻擊面開放**
3. **用戶批量上傳 100 張發票（Wave 3 必測項目 #1）尚未設計獨立配額**
4. **n8n / SharePoint / Outlook 自動化呼叫尚未列入「服務帳號免限制白名單」**
5. **無管理員臨時提升配額機制**

### Wave 3 必測項目對應

依矩陣 §3.3：

> 矩陣 §3.3 必測項目 #1「批量上傳（100+ 檔案）兼容性」— 與業務「批量 100」需求衝突（目前 MAX_FILES_PER_BATCH=20）

→ 本 CHANGE 必須處理批量場景配額。

---

## 變更內容

### 子變更 1：定義 Rate Limit 配置策略

**新檔案**：`src/lib/rate-limit/rate-limit-config.ts`

```typescript
/**
 * @fileoverview Rate Limit 配置策略
 * @module lib/rate-limit/rate-limit-config
 * @since CHANGE-063
 * @lastModified 2026-04-28
 */

export interface RateLimitConfig {
  windowMs: number;     // 時間窗口（毫秒）
  maxRequests: number;  // 窗口內最大請求數
  keyBy: 'ip' | 'userId' | 'apiKey' | 'composite';  // 配額鍵
  skipOnAuth?: boolean; // 已登入用戶是否跳過（如僅限 IP-based 限制）
  message?: string;     // 自訂 429 錯誤訊息
}

/**
 * 認證端點：嚴格限制（防 brute-force）
 * 5 attempts / 15 min per IP
 */
export const AUTH_RATE_LIMIT: RateLimitConfig = {
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
  keyBy: 'ip',
  message: 'Too many authentication attempts. Please try again in 15 minutes.',
};

/**
 * 認證後 sensitive 端點（password reset 完成、step-up 失敗等）
 * 10 / hour per user
 */
export const AUTH_SENSITIVE_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000,
  maxRequests: 10,
  keyBy: 'composite',  // ip + userId
};

/**
 * 一般已認證 API：寬鬆限制
 * 100 req / minute per user
 */
export const GENERAL_API_LIMIT: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 100,
  keyBy: 'userId',
};

/**
 * 上傳端點：中度限制
 * 30 uploads / hour per user（單檔）；批量場景另計
 */
export const UPLOAD_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000,
  maxRequests: 30,
  keyBy: 'userId',
};

/**
 * 批量上傳場景：100 張發票/批次，每用戶 5 批次/小時
 * = 500 文件/小時 上限
 */
export const BULK_UPLOAD_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000,
  maxRequests: 5,  // 5 批次
  keyBy: 'userId',
  message: 'Bulk upload quota exceeded. Maximum 5 batches per hour.',
};

/**
 * 報表生成（重操作）
 * 10 / hour per user
 */
export const REPORT_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000,
  maxRequests: 10,
  keyBy: 'userId',
};

/**
 * 對外 API（v1）：依 API key 配額
 * 1000 / minute per apiKey
 */
export const EXTERNAL_API_LIMIT: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 1000,
  keyBy: 'apiKey',
};
```

### 子變更 2：服務帳號白名單

**新檔案**：`src/lib/rate-limit/service-account-allowlist.ts`

```typescript
/**
 * @fileoverview 服務帳號白名單（rate limit 豁免）
 * 用於 n8n、SharePoint integration、Outlook 同步等系統間呼叫
 */

export const SERVICE_ACCOUNT_PREFIXES = [
  'svc-n8n-',           // n8n workflow service account
  'svc-sharepoint-',    // SharePoint sync
  'svc-outlook-',       // Outlook integration
  'svc-azure-graph-',   // Microsoft Graph
] as const;

export function isServiceAccount(userId: string): boolean {
  return SERVICE_ACCOUNT_PREFIXES.some((prefix) => userId.startsWith(prefix));
}

/**
 * 服務帳號的特殊配額（仍需限制，避免失控）
 * 10000 / minute per service account
 */
export const SERVICE_ACCOUNT_LIMIT: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 10000,
  keyBy: 'userId',
};
```

### 子變更 3：withRateLimit HOF

**新檔案**：`src/lib/api/with-rate-limit.ts`

```typescript
import { rateLimitService } from '@/services/rate-limit.service';
import { isServiceAccount, SERVICE_ACCOUNT_LIMIT } from '@/lib/rate-limit/service-account-allowlist';
import type { RateLimitConfig } from '@/lib/rate-limit/rate-limit-config';
import { apiError } from '@/lib/api/response';

export function withRateLimit(
  handler: (request: NextRequest, ctx: any) => Promise<NextResponse>,
  config: RateLimitConfig
) {
  return async (request: NextRequest, ctx: any) => {
    const userId = ctx.auth?.userId;

    // 服務帳號用獨立配額
    const effectiveConfig = userId && isServiceAccount(userId)
      ? SERVICE_ACCOUNT_LIMIT
      : config;

    const key = buildRateLimitKey(request, ctx, effectiveConfig.keyBy);
    const result = await rateLimitService.checkLimit({
      key,
      windowMs: effectiveConfig.windowMs,
      maxRequests: effectiveConfig.maxRequests,
    });

    if (!result.allowed) {
      // 寫 SecurityLog（Obs-03 整合）
      await securityLogService.create({
        eventType: 'RATE_LIMIT_EXCEEDED',
        severity: 'MEDIUM',
        userId: userId ?? null,
        metadata: {
          endpoint: request.nextUrl.pathname,
          key,
          retryAfter: result.retryAfter,
        },
      });

      return apiError(request, {
        type: 'https://datatracker.ietf.org/doc/html/rfc6585#section-4',
        title: 'Too Many Requests',
        status: 429,
        detail: effectiveConfig.message ?? 'Rate limit exceeded.',
        instance: request.nextUrl.pathname,
      }).headers.set('Retry-After', String(result.retryAfter));
    }

    return handler(request, ctx);
  };
}

function buildRateLimitKey(request: NextRequest, ctx: any, keyBy: string): string {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip')
    ?? 'unknown';
  const path = request.nextUrl.pathname;

  switch (keyBy) {
    case 'ip': return `rl:${path}:ip:${ip}`;
    case 'userId': return `rl:${path}:user:${ctx.auth?.userId ?? 'anon'}`;
    case 'apiKey': return `rl:${path}:apikey:${ctx.auth?.apiKeyId ?? 'unknown'}`;
    case 'composite': return `rl:${path}:user:${ctx.auth?.userId ?? 'anon'}:ip:${ip}`;
    default: return `rl:${path}:${ip}`;
  }
}
```

### 子變更 4：認證端點套用嚴格限制（最高優先級）

**檔案**：以下端點立即套用 `withRateLimit(handler, AUTH_RATE_LIMIT)`：

| Endpoint | Config |
|----------|--------|
| `POST /api/auth/login` | AUTH_RATE_LIMIT（5/15min per IP）|
| `POST /api/auth/register` | AUTH_RATE_LIMIT |
| `POST /api/auth/forgot-password` | AUTH_RATE_LIMIT |
| `POST /api/auth/reset-password` | AUTH_RATE_LIMIT |
| `POST /api/auth/verify-email` | AUTH_RATE_LIMIT |
| `POST /api/auth/resend-verification` | AUTH_SENSITIVE_LIMIT（10/hour）|
| `POST /api/auth/step-up` | AUTH_SENSITIVE_LIMIT（與 CHANGE-059 整合）|

### 子變更 5：上傳端點套用配額

| Endpoint | Config |
|----------|--------|
| `POST /api/documents/upload`（單筆） | UPLOAD_LIMIT（30/hour per user）|
| `POST /api/documents/upload`（批量 ≥ 10） | BULK_UPLOAD_LIMIT（5 批次/hour）|
| `POST /api/admin/historical-data/upload` | BULK_UPLOAD_LIMIT |

**邏輯**：在 handler 內依 file count 動態選擇 config。

### 子變更 6：全域 API rate limit（middleware 層）

**檔案**：`src/middleware.ts`（在 i18n 邏輯後注入）

```typescript
// 全域兜底限制（防止單一惡意 IP 打爆）
const GLOBAL_IP_LIMIT = {
  windowMs: 60 * 1000,
  maxRequests: 1000,  // 1000 req/min per IP（極寬鬆，僅防 DoS）
};

if (request.nextUrl.pathname.startsWith('/api/')) {
  const ip = getClientIp(request);
  const result = await rateLimitService.checkLimit({
    key: `rl:global:ip:${ip}`,
    ...GLOBAL_IP_LIMIT,
  });
  if (!result.allowed) {
    return new Response('Too Many Requests', { status: 429 });
  }
}
```

### 子變更 7：管理員臨時提升配額機制

**新檔案**：`src/services/admin/rate-limit-override.service.ts`

```typescript
/**
 * 管理員可暫時提升某用戶的 rate limit（如用戶批次匯入大量資料）
 * 寫入 Redis with TTL，下個 request 自動套用
 */
export class RateLimitOverrideService {
  async grantOverride(
    userId: string,
    multiplier: number,  // 倍數（如 5x = 5 倍正常配額）
    durationMs: number,
    grantedBy: string,
    reason: string
  ): Promise<void> {
    await redis.setex(
      `rl:override:${userId}`,
      Math.ceil(durationMs / 1000),
      JSON.stringify({ multiplier, grantedBy, reason, expiresAt: Date.now() + durationMs })
    );
    await auditLogService.log({
      action: 'RATE_LIMIT_OVERRIDE_GRANTED',
      userId,
      actorId: grantedBy,
      metadata: { multiplier, durationMs, reason },
    });
  }

  async getOverride(userId: string): Promise<{ multiplier: number } | null> {
    const data = await redis.get(`rl:override:${userId}`);
    return data ? JSON.parse(data) : null;
  }
}
```

對應 admin UI：`/admin/rate-limit-overrides/route.ts`（POST/GET/DELETE）。

### 子變更 8：監控與告警

**整合 Obs-03 / Obs-05-lite**（與其他 Wave 1 連動）：
- Rate limit 觸發 → 寫 `SecurityLog`
- Spike 偵測：5 分鐘內 > 100 次 429 → 觸發告警

### 子變更 9：客戶端 retry-after 處理

**檔案**：`src/lib/api/api-client.ts`（既有 fetch wrapper）

- 接收 429 + `Retry-After` header → 自動排程 retry
- 多次 429 → 顯示 toast「請求過於頻繁，請稍後再試」（i18n）

---

## 影響評估

### 正面影響

| 面向 | 改善 |
|------|------|
| **AppSec-09 評分** | L1 → L3 |
| **覆蓋率** | 2.1%（7/331）→ ≥ 80% 認證/敏感端點 |
| **Brute-force 防護** | 認證端點完整防護 |
| **DoS 防護** | 全域兜底 + 端點級雙層 |
| **批量場景支援** | 業務流暢（100 張發票批次 OK）+ 安全（5 批次/hour 上限）|
| **服務整合不中斷** | 白名單 + 高配額 |

### 風險與緩解

| 風險 | 影響 | 緩解 |
|------|------|------|
| **既有用戶突破限制 → 體驗變差** | 業務中斷 | Phase 1 Report-Only 模式 1 週收集數據；保留 admin override |
| **n8n / SharePoint 自動化被誤限** | integration 失敗 | 服務帳號白名單；高配額 |
| **Redis 故障 → rate limit 失效** | 安全降級 | FIX-052 in-memory fallback；單實例 OK |
| **共用 NAT IP 用戶誤限** | 同公司多用戶誤觸發 | composite key（ip + userId）優先於純 IP |
| **批量上傳 100 張發票需求** | UX 差 | 設計 5 批次 × 100 張 = 500 文件/hour 上限 |
| **管理員 override 被濫用** | 規避限制 | 完整 audit log + override 上限（如最多 5x、最多 24h）|

### 不變範圍

- 不變動既有 7 個 v1 端點的 rate limit 配置
- 不變動 rate-limit.service.ts 的核心演算法（FIX-052）
- 不變動 NextAuth 內部 flow

---

## 測試計劃

### 單元測試

- [ ] `withRateLimit` 配額用盡返回 429 + Retry-After
- [ ] 服務帳號自動套用 SERVICE_ACCOUNT_LIMIT
- [ ] composite key 正確組合 IP + userId
- [ ] Override 機制：正常用戶 vs 已 grant override 用戶
- [ ] Redis 故障時 fallback 到 in-memory（與 FIX-052 對齊）

### 整合測試

- [ ] 連續呼叫 `/api/auth/login` 6 次 → 第 6 次 429
- [ ] 不同 IP 各自有獨立配額（A IP 用盡，B IP 仍可）
- [ ] 上傳 31 個單檔 → 第 31 個 429
- [ ] 批量上傳 6 批 → 第 6 批 429
- [ ] 服務帳號連續 1000 req → 全部成功
- [ ] Admin grant override → 該用戶配額提升

### E2E 測試

- [ ] 攻擊模擬：嘗試 brute-force `/auth/login` → 5 次後被阻擋 15 分鐘
- [ ] 業務流程：合法用戶批量上傳 100 張發票 → 成功
- [ ] n8n workflow 高頻呼叫 → 不誤限
- [ ] 多實例部署：實例 A 限制觸發，實例 B 也識別（驗證 Redis 共享）

### 效能測試

- [ ] 每次 API 請求 Redis 查詢延遲 < 5ms（p95）
- [ ] 1000 並發請求下，rate limit 計數準確

---

## Rollout 策略

### 階段化部署

| 階段 | 動作 | 驗證點 |
|------|------|--------|
| **Phase 1** | `withRateLimit` HOF + config 完成（Report-Only 模式）| 單元測試通過 |
| **Phase 2** | 認證端點套用 AUTH_RATE_LIMIT（最高優先級）| 監控 1 週無誤觸發 |
| **Phase 3** | 上傳端點套用 UPLOAD_LIMIT + BULK_UPLOAD_LIMIT | E2E：批量上傳 100 張 |
| **Phase 4** | 全域 middleware 兜底（GLOBAL_IP_LIMIT）| 監控 DoS 攔截效果 |
| **Phase 5** | 服務帳號白名單啟用 | n8n / SharePoint 整合不中斷 |
| **Phase 6** | Admin override UI + service | 管理員可手動授予 |
| **Phase 7** | 一般 API 端點套用 GENERAL_API_LIMIT（廣泛）| 漸進式 batch by domain |

### Feature Flag

```env
FEATURE_RATE_LIMIT_AUTH=true        # Phase 2
FEATURE_RATE_LIMIT_UPLOAD=true      # Phase 3
FEATURE_RATE_LIMIT_GLOBAL=true      # Phase 4
FEATURE_RATE_LIMIT_GENERAL=false    # Phase 7（最後啟用）
```

### Report-Only 模式

每個 Phase 啟用前 1 週，配置 `mode: 'report-only'` 寫 SecurityLog 但不阻擋 → 收集數據後切 `enforce`。

### 回滾策略

- 各 Phase 用 feature flag 控制
- Rate limit 計數 Redis key 可手動清除恢復服務

---

## 完成標準

- [ ] `withRateLimit` HOF + 配置策略完成
- [ ] 7 個認證端點套用 AUTH_RATE_LIMIT
- [ ] 上傳端點（含批量）套用 UPLOAD_LIMIT / BULK_UPLOAD_LIMIT
- [ ] 全域 middleware 兜底限制啟用
- [ ] 服務帳號白名單機制完成
- [ ] Admin override UI + service 完成
- [ ] 監控告警整合（429 spike 偵測）
- [ ] 客戶端 Retry-After 自動 retry 邏輯
- [ ] `phase2-appsec-obs-assessment.md` AppSec-09 評分 L1 → L3
- [ ] 整合測試 + E2E 全部通過
- [ ] 業務驗證：100 張發票批量上傳成功

---

## 相關文件

- **Phase 2 評估**：`docs/08-security-and-governance/phase2-appsec-obs-assessment.md` AppSec-09 章節
- **Governance Matrix**：`docs/08-security-and-governance/enterprise-security-governance-matrix.md` v1.2 AppSec-09
- **依賴 FIX**：FIX-052（Rate Limit Redis 基礎設施）
- **依賴 CHANGE**：CHANGE-061（withAuth）— withRateLimit 在 withAuth 之後組合
- **配套 CHANGE**：CHANGE-058（Token revocation 共用 Redis）、CHANGE-059（Step-up auth 共用 sensitive limit）
- **業務需求**：批量上傳 100 張發票（年處理 450,000-500,000 張，APAC 地區）
- **既有實作**：`src/services/rate-limit.service.ts`（372 行，FIX-052）

---

## 風險提示

- **共用 NAT IP 場景**：企業客戶內多個用戶可能共用對外 IP，純 IP-based 限制誤觸發 — composite key 設計優先 user，IP 兜底
- **批量上傳業務需求 vs 安全平衡**：100 張/批次 × 5 批次/hour = 500 張/hour，需業務確認此上限可接受
- **服務帳號白名單管理**：白名單前綴必須與 seed/部署流程一致，避免 service account 命名漂移
- **Override 機制濫用**：Admin override 必須完整 audit；考慮加入 multi-approver 流程（CHANGE-059 step-up auth）
- **設計取捨：是否啟用全域 IP 限制？** 1000 req/min 是極寬鬆預設，需用戶確認是否合理（公司網路 NAT 場景可能不夠）

---

*文件建立日期: 2026-04-28*
*規劃者: Claude AI（Phase 3 Security Hardening）*
*下一步: 確認業務批量上傳 SLA 後排定 Phase 1*
