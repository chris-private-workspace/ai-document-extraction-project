# CHANGE-060: HTTP Security Headers + CSP（DP-02 + AppSec-03 + AppSec-08 合併）

> **狀態**: 📋 規劃中（規劃日期 2026-04-28）

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-060 |
| **變更日期** | 2026-04-28 |
| **相關模組** | Next.js Configuration / HTTP Response Headers |
| **影響範圍** | `next.config.ts`、`src/middleware.ts`（CSP nonce 注入）、新增 `src/lib/security/csp-policy.ts` |
| **優先級** | HIGH（Quick Win，1 小時實作完成基礎 headers） |
| **狀態** | 📋 規劃中（規劃日期 2026-04-28） |
| **類型** | Security Hardening / Quick Win |
| **依賴** | 無前置依賴（零功能影響） |

---

## 問題描述

### 現況

**3 個 HIGH/MED 風險評估項合併處理**：

| 評估項 | 評分 | 風險 | 來源段落 |
|--------|------|------|---------|
| **DP-02**（資料加密 / Security Headers）| L1 | 🔴 HIGH | `phase2-iam-dp-assessment.md` DP-02 |
| **AppSec-03**（XSS / CSP）| L1 | 🔴 HIGH | `phase2-appsec-obs-assessment.md` AppSec-03 |
| **AppSec-08**（Security Headers）| L0 | 🟡 MED | `phase2-appsec-obs-assessment.md` AppSec-08 |

依 `phase2-iam-dp-assessment.md` DP-02 第 1 點：

> **`next.config.ts`** 完整檢視（67 行）：
> - 配置了 `output: 'standalone'`、ESLint、images、experimental serverActions、webpack
> - **完全沒有 `headers()` 配置** ❌
> - **完全沒有 HSTS / CSP / X-Frame-Options / X-Content-Type-Options 設定** ❌

依 `phase2-appsec-obs-assessment.md` AppSec-08 證據：

> `next.config.ts` 完整 67 行已讀 — **無 `async headers()` 函數**、無任何 security headers 配置
> `src\middleware.ts` 完整 183 行已讀 — 僅處理 i18n + auth redirect，**無設定任何 response header**

### 缺失的 Headers 清單

| Header | 用途 | OWASP 對應 |
|--------|------|-----------|
| `Strict-Transport-Security` (HSTS) | 強制 HTTPS | A02 |
| `X-Frame-Options` | 防點擊劫持（已被 CSP frame-ancestors 取代但仍建議）| A05 |
| `X-Content-Type-Options` | 防 MIME sniffing | A05 |
| `Referrer-Policy` | 控制 referer 洩漏 | A01 |
| `Permissions-Policy` | 限制瀏覽器功能（camera、microphone 等）| A05 |
| `Content-Security-Policy` (CSP) | 防 XSS / 資料洩漏 | A03 |
| `Cross-Origin-Opener-Policy` | 隔離 cross-origin 文件 | A05 |
| `Cross-Origin-Resource-Policy` | 控制資源跨域使用 | A05 |

### 風險場景

1. **點擊劫持**：攻擊者在惡意網站 iframe 嵌入本應用的管理頁面，誘導 admin 點擊
2. **MIME sniffing**：攻擊者上傳圖片實為 HTML，瀏覽器執行為 script
3. **HTTPS 降級**：man-in-the-middle 將 HTTPS 請求降級為 HTTP（HSTS 防護）
4. **Referer 洩漏**：頁面 URL 含 sensitive query param 被洩漏給第三方
5. **XSS 後果擴大**：若有 XSS 漏洞，無 CSP 時攻擊者可任意 inline script / 連外部 domain

---

## 變更內容

### 子變更 1：基礎 Security Headers（Quick Win，1 小時實作）

> ✅ **用戶決策（B9, 2026-04-28）**：HSTS 採選項 A — **啟用 HSTS 但不提交到 preload list**。理由：
> - 對對內企業系統而言，基本 HSTS（`max-age=31536000; includeSubDomains`）已足夠 90% 防護效果
> - 避免 preload 不可逆性風險：一旦提交 hstspreload.org，移除需 6-12 個月（瀏覽器 cache 過期）
> - 移除 `preload` 指令，避免誤被外部抓取後自動提交至 preload list
> - 後續若有「對外公網服務」需求，可再單獨評估 preload 申請

**檔案**：`next.config.ts`（在第 67 行後新增 `headers()` 函數）

```typescript
async headers() {
  return [
    {
      source: '/:path*',
      headers: [
        // HTTPS 強制（生產環境）— 不含 preload（B9 用戶決策）
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=31536000; includeSubDomains',
        },
        // 防 MIME sniffing
        {
          key: 'X-Content-Type-Options',
          value: 'nosniff',
        },
        // 防點擊劫持（同源 only；CSP frame-ancestors 進階控制）
        {
          key: 'X-Frame-Options',
          value: 'DENY',
        },
        // 限制 referer 資訊洩漏
        {
          key: 'Referrer-Policy',
          value: 'strict-origin-when-cross-origin',
        },
        // 禁用不需要的瀏覽器功能
        {
          key: 'Permissions-Policy',
          value: 'camera=(), microphone=(), geolocation=(), payment=()',
        },
        // Cross-origin 隔離
        {
          key: 'Cross-Origin-Opener-Policy',
          value: 'same-origin',
        },
        {
          key: 'Cross-Origin-Resource-Policy',
          value: 'same-site',
        },
      ],
    },
  ];
}
```

**驗證方式**：
- 部署後 `curl -I https://<host>` 檢查 headers
- [securityheaders.com](https://securityheaders.com) 評分目標 A+

### 子變更 2：CSP Report-Only 階段（觀察 1-2 週）

**新檔案**：`src/lib/security/csp-policy.ts`

```typescript
/**
 * @fileoverview Content Security Policy 配置
 * @module lib/security/csp-policy
 * @since CHANGE-060
 * @lastModified 2026-04-28
 */

export function buildCspPolicy(nonce: string, isDev: boolean): string {
  const directives = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      // Next.js 開發環境需要 unsafe-eval（HMR）
      ...(isDev ? ["'unsafe-eval'"] : []),
      // 'strict-dynamic' 配合 nonce 後，可移除其他 script-src 來源
      "'strict-dynamic'",
    ],
    'style-src': [
      "'self'",
      "'unsafe-inline'",  // Tailwind / shadcn-ui 需要（短期接受）
    ],
    'img-src': [
      "'self'",
      'data:',
      'blob:',
      'https://*.blob.core.windows.net',  // Azure Blob
      'https://graph.microsoft.com',       // Microsoft Graph 頭像
    ],
    'font-src': ["'self'", 'data:'],
    'connect-src': [
      "'self'",
      'https://*.openai.azure.com',          // Azure OpenAI
      'https://*.cognitiveservices.azure.com', // Azure DI
      'https://graph.microsoft.com',
      'https://login.microsoftonline.com',
      'https://*.blob.core.windows.net',
      ...(isDev ? ['ws://localhost:*', 'http://localhost:*'] : []),
    ],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'object-src': ["'none'"],
    'upgrade-insecure-requests': [],
    'report-uri': ['/api/security/csp-report'],
  };

  return Object.entries(directives)
    .map(([key, values]) => values.length === 0 ? key : `${key} ${values.join(' ')}`)
    .join('; ');
}
```

**Middleware 注入 nonce**：`src/middleware.ts`

```typescript
import { buildCspPolicy } from '@/lib/security/csp-policy';

export function middleware(request: NextRequest) {
  // ... 既有 i18n 邏輯

  const nonce = crypto.randomBytes(16).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';
  const csp = buildCspPolicy(nonce, isDev);

  const response = NextResponse.next({
    request: {
      headers: new Headers({
        ...Object.fromEntries(request.headers),
        'x-nonce': nonce,
      }),
    },
  });

  // Phase 1: Report-Only（觀察）
  response.headers.set('Content-Security-Policy-Report-Only', csp);

  // Phase 2 切換為 enforce（觀察 1-2 週後）
  // response.headers.set('Content-Security-Policy', csp);

  return response;
}
```

### 子變更 3：CSP Violation Report Endpoint

**新檔案**：`src/app/api/security/csp-report/route.ts`

```typescript
/**
 * 接收瀏覽器送來的 CSP violation 報告
 * 用於 Phase 1 觀察期分析需要放寬的 directive
 */
export async function POST(request: Request) {
  const report = await request.json();

  // 寫入 SecurityLog（Obs-03 整合）
  await securityLogService.create({
    eventType: 'CSP_VIOLATION',
    severity: 'LOW',
    metadata: {
      blockedUri: report['csp-report']?.['blocked-uri'],
      violatedDirective: report['csp-report']?.['violated-directive'],
      sourceFile: report['csp-report']?.['source-file'],
      lineNumber: report['csp-report']?.['line-number'],
    },
  });

  return new Response(null, { status: 204 });
}
```

### 子變更 4：CSP Enforce 切換（Phase 2，觀察期後）

觀察 1-2 週後，分析 CSP violation report：

1. 確認所有合法 inline script / external resource 都在 policy 內
2. 將 `Content-Security-Policy-Report-Only` 改為 `Content-Security-Policy`
3. 保留 `report-uri` 以持續監控

### 子變更 5：API Routes 額外 Cache-Control

**檔案**：`next.config.ts`（headers 函數內加 API 專屬規則）

```typescript
{
  source: '/api/:path*',
  headers: [
    { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' },
    { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  ],
}
```

### 子變更 6：文檔化部署驗證腳本

**新檔案**：`scripts/verify-security-headers.sh`

```bash
#!/bin/bash
URL=${1:-https://localhost:3000}
echo "Checking security headers on $URL..."

curl -sI "$URL" | grep -iE "strict-transport-security|x-content-type-options|x-frame-options|referrer-policy|permissions-policy|content-security-policy|cross-origin"

# 預期看到全部 7 個 headers
```

加入 `package.json`：
```json
"verify-security-headers": "bash scripts/verify-security-headers.sh"
```

---

## 影響評估

### 正面影響

| 面向 | 改善 |
|------|------|
| **DP-02 評分** | L1 → L3（達企業基準）|
| **AppSec-03 評分** | L1 → L2（CSP 啟用後 → L3）|
| **AppSec-08 評分** | L0 → L3 |
| **OWASP Top 10 對齊** | A02、A03、A05 覆蓋顯著提升 |
| **securityheaders.com 評分** | 預期 F → A+ |
| **點擊劫持防護** | 完整 |
| **MIME sniffing 防護** | 完整 |
| **HTTPS 強制** | 啟用 HSTS（`max-age=1y; includeSubDomains`，不含 preload — B9 用戶決策） |

### 風險與緩解

| 風險 | 影響 | 緩解 |
|------|------|------|
| **CSP 過於嚴格阻擋合法資源** | 頁面破版 | Phase 1 Report-Only 1-2 週觀察；保留 unsafe-inline for style |
| **Tailwind/shadcn 需 unsafe-inline style** | CSP score 不完美 | 短期接受；長期評估 nonce-based style |
| **HSTS 啟用後 1 年內無法降級** | 開發環境誤連 HTTP 失敗 | dev 環境用 NODE_ENV 條件式排除 HSTS；不提交 preload list（B9 用戶決策），即使啟用後仍可在 1 年 max-age 過期後恢復 |
| **第三方資源（Azure OpenAI 等）需明列** | 新增 integration 需更新 CSP | 集中於 csp-policy.ts，變更可追蹤 |
| **Microsoft Entra ID redirect 流程**| login redirect 可能被 form-action 阻擋 | `form-action` 加 `https://login.microsoftonline.com` |

### 不變範圍

- 不變動既有 React 元件（不需 inline script 改寫）
- 不變動 NextAuth 流程（Microsoft Entra ID redirect 透過 connect-src 允許）
- 不變動 Azure Blob 上傳流程

---

## 測試計劃

### 部署前驗證

- [ ] `npm run dev` 後檢查所有 page 載入正常（特別是 dashboard / admin / login）
- [ ] CSP Report-Only 模式不阻擋任何合法資源
- [ ] `curl -I http://localhost:3000` 含全部 7 個 headers

### 整合測試

- [ ] Login flow：點擊 Microsoft Entra ID → 成功 redirect
- [ ] Document upload：選檔 → 上傳到 Azure Blob → 成功
- [ ] Dashboard：圖表（Recharts）正常渲染（inline style 允許）
- [ ] Admin pages：所有頁面無 CSP console error

### E2E 測試

- [ ] 完整 user journey（login → upload → review → export）無破版
- [ ] iframe 嵌入測試（外部網站 iframe 本應用）→ 應被 X-Frame-Options 阻擋
- [ ] HTTPS 強制：HTTP 請求自動 redirect 到 HTTPS（基本 HSTS 已啟用，未提交 preload — B9 用戶決策）

### CSP 觀察期（Phase 1）

- [ ] CSP violation report endpoint 收到事件並寫入 SecurityLog
- [ ] 1-2 週內統計 violation 數量與類型
- [ ] 修正所有 false positive 後切換 enforce

### 部署後驗證

- [ ] [securityheaders.com](https://securityheaders.com) 評分 A+
- [ ] [Mozilla Observatory](https://observatory.mozilla.org) 評分 A+
- ~~HSTS Preload List 提交（hstspreload.org）~~ — ❌ 已取消（B9 用戶決策 2026-04-28）

---

## Rollout 策略

### 階段化部署

| 階段 | 動作 | 驗證點 |
|------|------|--------|
| **Phase 1**（30 分鐘） | 部署基礎 7 個 headers（不含 CSP） | curl 驗證 + 全頁瀏覽 |
| **Phase 2**（1 小時） | 部署 CSP Report-Only + violation endpoint | SecurityLog 正常收到報告 |
| **Phase 3**（1-2 週觀察） | 收集 CSP violation，調整 policy | violation 數降至 < 10/天 |
| **Phase 4**（5 分鐘） | 切換 CSP 為 enforce | 全頁瀏覽無 console error |
| ~~Phase 5（提交 HSTS preload）~~ | ❌ **已取消（B9 用戶決策 2026-04-28）**：不提交 preload，避免不可逆性風險 | — |

### Feature Flag

```env
FEATURE_CSP_ENFORCE=false  # Phase 4 才設 true
```

### 回滾策略

- Phase 1-3：僅新增 headers 不影響功能，回滾 = revert PR
- Phase 4 CSP enforce：若大量破版，立即切回 Report-Only
- HSTS：採基本啟用（`max-age=1y; includeSubDomains`）— 1 年內已存取的瀏覽器仍會強制 HTTPS，但**未提交 preload**（B9 用戶決策），可在 1 年後依需求調整 max-age 至較短值再過期

---

## 完成標準

- [ ] `next.config.ts` 加入完整 7 個 security headers
- [ ] `src/lib/security/csp-policy.ts` 完成
- [ ] `src/middleware.ts` 注入 CSP nonce
- [ ] `src/app/api/security/csp-report/route.ts` 完成
- [ ] CSP Report-Only 觀察期 ≥ 1 週，violation < 10/天
- [ ] CSP 切換為 enforce 模式
- [ ] securityheaders.com 評分 ≥ A
- [x] HSTS 提交至 preload list — ❌ **已取消（B9 用戶決策 2026-04-28）**：保留基本 HSTS 即可
- [ ] `phase2-iam-dp-assessment.md` DP-02 評分 L1 → L3
- [ ] `phase2-appsec-obs-assessment.md` AppSec-03 評分 L1 → L2
- [ ] `phase2-appsec-obs-assessment.md` AppSec-08 評分 L0 → L3

---

## 相關文件

- **Phase 2 評估**：
  - `docs/08-security-and-governance/phase2-iam-dp-assessment.md` DP-02 章節
  - `docs/08-security-and-governance/phase2-appsec-obs-assessment.md` AppSec-03、AppSec-08 章節
- **Governance Matrix**：`docs/08-security-and-governance/enterprise-security-governance-matrix.md` v1.2
- **OWASP 參考**：[OWASP Secure Headers Project](https://owasp.org/www-project-secure-headers/)
- **CSP 參考**：[content-security-policy.com](https://content-security-policy.com)

---

## 風險提示

- **HSTS 部分不可逆性**：基本 HSTS（不含 preload）在 1 年 max-age 過期前，已存取過的瀏覽器仍會強制 HTTPS。**B9 用戶決策不提交 preload list**，避免 6-12 個月不可逆窗口；若未來需要更強保護可再評估
- **CSP 對既有第三方資源的衝擊**：Azure / Microsoft Graph / 等 integrations 必須完整列在 connect-src，遺漏會造成功能中斷
- **inline style 暫保留 unsafe-inline**：Tailwind/shadcn 短期相容，長期應評估 hash-based 或 nonce-based style
- **dev 環境 HMR 需 unsafe-eval**：production 應移除（已條件式處理）
- **設計取捨**：是否啟用 CSP `strict-dynamic`？啟用後相容性更高但配置複雜 — 本 CHANGE 採用 strict-dynamic + nonce 方案（建議）

---

*文件建立日期: 2026-04-28*
*規劃者: Claude AI（Phase 3 Security Hardening - Quick Win）*
*下一步: 立即實作 Phase 1（基礎 headers），1 小時內完成*
