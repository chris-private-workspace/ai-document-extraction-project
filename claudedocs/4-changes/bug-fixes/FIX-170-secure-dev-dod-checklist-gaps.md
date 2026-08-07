# FIX-170: 依公司 Secure Development DoD Checklist 對標 —— 13 項安全缺口

> **建立日期**: 2026-08-07
> **發現方式**: 依公司安全團隊提供的 `docs/09-reference/security-check/`（SCM/ITPM 掃描報告衍生的 28 項 DoD Checklist）對本專案做代碼靜態檢查 + Azure DEV 線上黑箱驗證
> **影響頁面/功能**: 全站 HTTP 回應標頭、登入流程（`/[locale]/auth/login`）、Cookie、對外 API 攻擊面、生產相依套件、CI 安全 gate
> **優先級**: 高（含 3 個 critical 相依漏洞與 1 個 open redirect；其餘為掃描必然標記的 Level 2–3 項目）
> **狀態**: 🚧 待修復
> **相關**: [FIX-050](FIX-050-auth-config-pii-leakage-console-logs.md)、[FIX-051](FIX-051-db-context-sql-injection-city-codes.md)、[FIX-052](FIX-052-rate-limit-single-instance-redis-migration.md)（同屬安全稽核系列）、`docs/08-security-and-governance/`（Epic 22 治理評估，AppSec-08 已標記 L0 但未實作）

---

## 問題描述

公司安全團隊於 2026-07-30 對 **RAPO-ITPM** / **RAPO-SCM** 兩個應用完成 Qualys WAS 與 Rapid7 InsightVM 掃描，產出 45 個網頁弱點與 10 個基礎設施弱點，並據此整理成 28 項 Definition of Done 檢查清單。

**本專案與該次掃描的關係不是「同類參考」，而是同一批基礎設施**：掃描標的之一 `13.75.34.162` 正是本專案 Azure DEV 的公開 IP（見 `docs/07-deployment/02-azure-deployment/dev-deployment-runbook.md` §1）。因此報告中的基礎設施發現與本專案高度相關。

本次逐項對標 28 個檢查點，結果如下：

| 結果 | 數量 | 項次 |
|------|-----:|------|
| ✅ 通過 | 14 | 1, 3, 4, 8, 9, 10, 11, 12, 13, 17, 22, 23, 25, 26 |
| ⚠️ 部分符合 | 4 | 5, 7, 15, 19 |
| ❌ 失敗 | 9 | 2, 14, 16, 18, 20, 21, 24, 27, 28 |
| ❓ 無法驗證 | 1 | 6 |

### 待處理子問題

| # | DoD 項次 | 問題 | 嚴重度 | 對應 QID | 驗證方式 |
|---|---|------|--------|----------|----------|
| BUG-1 | 27 | 生產相依套件 38 個已知漏洞（3 critical / 21 high / 13 moderate / 1 low） | 高 | http-iis-0035 同類 | `npm audit --omit=dev` 實測 |
| BUG-2 | 24 | `callbackUrl` 未做白名單驗證 → open redirect | 高 | 150084 | 代碼靜態 |
| BUG-3 | 21 | `X-Content-Type-Options` / `Referrer-Policy` / `Permissions-Policy` / `X-Frame-Options` 全部缺失 | 中 | 150202 / 150208 / 150248 / 150245 | 線上實測 |
| BUG-4 | 20 | 無 `Content-Security-Policy`（含 `frame-ancestors`） | 中 | 150206 / 531006 / 150082 | 線上實測 |
| BUG-5 | 2 | 無 `Strict-Transport-Security` | 中 | 150135 | 線上實測 |
| BUG-6 | 18 | 回應帶 `X-Powered-By: Next.js` | 中 | 150210 | 線上實測 |
| BUG-7 | 14 | 登入路徑無防暴力破解（無帳號鎖定、無速率限制） | 高 | 150837 | 代碼靜態 |
| BUG-8 | 16 | 無伺服器端 PII 遮罩機制 | 中 | 150602 / 150375 | 代碼靜態 |
| BUG-9 | 28 | 4 個安全掃描 workflow 全為 advisory，不阻擋合併 | 中 | 全部 | 代碼靜態 |
| BUG-10 | 7 | `NEXT_LOCALE` cookie 無 `Secure`、無 `HttpOnly` | 中 | 150122 / 150123 | 線上實測 |
| BUG-11 | 15 | 3 個設定表單的密碼欄位無 `autoComplete` 屬性 | 低 | 150112 | 代碼靜態 |
| BUG-12 | 19 | `/api/openapi` 未認證可讀完整 API 規格（23 KB） | 低 | 150004 / 150228 | 線上實測 |
| BUG-13 | 5 | 平台預設網址 `*.azurewebsites.net` 仍對外可達，其憑證 CN 與自訂網域不符 | 低 | certificate-common-name-mismatch | 線上實測 |

---

## 檢查方法與分母

本節記錄量測口徑，供日後重新驗證時對照。

### 靜態檢查

| 檢查 | 分母 | 工具 |
|---|---:|---|
| Luhn 有效信用卡號掃描 | **1,665** 個文字檔（`prisma/`、`tests/`、`src/`、`scripts/`；`.ts/.tsx/.js/.json/.sql/.md/.csv`） | 自訂 Python 腳本（Luhn + 卡別前綴雙重判準） |
| 危險 sink 掃描 | `src/` 全量 | Grep `dangerouslySetInnerHTML\|innerHTML\|document.write\|eval(\|new Function(` |
| 瀏覽器儲存掃描 | `src/` 全量 | Grep `localStorage\|sessionStorage` |
| 安全標頭設定掃描 | repo 全量（排除 `node_modules`） | Grep 7 個標頭名稱 + `poweredByHeader` |
| 相依漏洞 | 生產相依（`--omit=dev`） | `npm audit --json` |

> ⚠️ **分母外的部分**：`docs/Doc Sample/` 的 137 份 PDF 為二進位，不在 1,665 個文字檔內，未做卡號掃描。

### 線上黑箱驗證（Azure DEV，2026-08-07 實測）

標的：`webapp-raposcm-aidocprocessing-dev-f8dua6b5eqerbrbk.eastasia-01.azurewebsites.net` 與自訂網域 `raposcm-aidocprocessing-dev.rci-t.com`

| 驗證 | 方法 |
|---|---|
| HTTP 轉址、回應標頭、Cookie 屬性 | `curl -s -D -` 對 `/api/health`、`/en/auth/login`、`/api/auth/csrf` |
| 認證閘是否生效 | `curl` 對 `/api/documents`、`/api/admin/users` |
| TLS 版本與 cipher | `openssl s_client -tls1 / -tls1_1 / -tls1_2` |
| 憑證主體與 SAN | `openssl x509 -noout -subject -ext subjectAltName` |

### 未能驗證的部分

| 項目 | 原因 |
|---|---|
| DoD #6（管理埠 8172 / SCM 站台） | 本機對 `*.scm.*.azurewebsites.net` DNS 解析失敗（`connect:errno=11001`）。**「連不上」不等於「已關閉」**，此項需由具 Azure 讀取權限者確認 |
| Azure 資源設定（`httpsOnly` / `minTlsVersion` / `ftpsState` / IP 限制） | 當前 `az` 登入身分對 `RG-RAPOSCM-AIDocProcessing-DEV` 無 `Microsoft.Web/sites/read` 權限（`AuthorizationFailed`）。本文件所有 Azure 相關結論均來自黑箱探測，**不是資源設定的讀取結果** |

---

## 根本原因

### 原因 1：安全標頭從未實作（BUG-3 / BUG-4 / BUG-5 / BUG-6）

`next.config.ts`（87 行）沒有 `headers()` 設定，也沒有 `poweredByHeader: false`；`src/middleware.ts` 只處理 i18n 與認證，不加任何標頭。全站因此完全沒有 HSTS、CSP、`X-Frame-Options`、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`，並保留 Next.js 預設的 `X-Powered-By`。

此缺口早在 `docs/08-security-and-governance/phase2-appsec-obs-assessment.md` 就以 **AppSec-08 = L0** 記載，`claudedocs/5-status/security-audit-2026-06-10/SECURITY-ASSESSMENT.md` 第 9 項亦列出，但一直未實作。

### 原因 2：`callbackUrl` 全程無驗證（BUG-2）

三個位置串成一條未驗證的轉址鏈：

| 位置 | 行為 |
|---|---|
| `src/app/[locale]/(auth)/auth/login/page.tsx:72` | `redirect(callbackUrl ?? '/dashboard')` —— 直接使用查詢參數 |
| `src/components/features/auth/LoginForm.tsx:136` | `router.push(callbackUrl)` —— 登入成功後直接導向 |
| `src/middleware.ts:248` | `loginUrl.searchParams.set('callbackUrl', pathname)` —— 此處來源是內部 pathname，安全；但攻擊者可自行構造 URL |

`signIn('microsoft-entra-id', { redirectTo })` 走 NextAuth 內建的同源檢查，相對安全；問題在前兩者。

補充：相依套件中的 `next-intl` 本身另有一個 open redirect 漏洞（見 BUG-1），與本項疊加。

### 原因 3：防暴力破解從未納入登入路徑（BUG-7）

`src/services/rate-limit.service.ts` 只服務對外 ApiKey API（7 個 `/api/v1/invoices/*` 呼叫端）。`src/app/api/auth/resend-verification/route.ts:46` 有一份自建的 in-memory 速率限制，但只用於重寄驗證信。

`prisma/schema.prisma` 中沒有 `failedLoginAttempts` / `lockedUntil` 之類欄位——搜尋 `rateLimit` 命中的兩處都是 `ExternalApiKey` 與 n8n API key 的配額欄位，與登入無關。`auth.config.ts` 的 `authorize()` 密碼比對失敗只回 `null`，不累計、不鎖定。

### 原因 4：相依套件掃描不阻擋合併（BUG-9 → BUG-1）

`.github/workflows/security-deps.yml:25` 等所有步驟都帶 `continue-on-error: true`，檔頭註明「advisory 階段；Week 3 移除以強制 block」，但至今未移除。這正是 38 個漏洞得以累積的機制性原因。

其中三個 critical 值得單獨列出：

| 套件 | 問題 |
|---|---|
| `@auth/core` / `next-auth` | 設定錯誤時，以物件存在與否判斷的認證檢查會 **fail open**（auth 物件被填入 error 仍為 truthy） |
| `fast-xml-parser` | DOCTYPE 實體名稱的正則注入導致實體編碼繞過 |
| `next-intl` | open redirect（與 BUG-2 疊加） |

> ⚠️ `@auth/core` 的 fail-open 模式需要特別留意：`src/middleware.ts:148` 的 `if (session?.user)` 與各 handler 的同型判斷正屬此類寫法。是否實際受影響，需在升級前依該 advisory 的觸發條件逐一確認。

### 原因 5：`NEXT_LOCALE` 由 next-intl 預設行為設定（BUG-10）

`src/middleware.ts` 只讀 `request.cookies.get('NEXT_LOCALE')`，寫入是 next-intl 中間件的預設行為，未指定 `secure` / `httpOnly`。線上實測回應為 `Set-Cookie: NEXT_LOCALE=en; Path=/; SameSite=lax`。

> 對照：NextAuth 自己設的 cookie **完全正確** —— `__Host-authjs.csrf-token` 與 `__Secure-authjs.callback-url` 皆帶 `HttpOnly; Secure; SameSite=Lax`。所以 QID 150120 / 150121（Level 3，認證相關 cookie）在本專案不成立，成立的是 Level 2 的 150122 / 150123。

### 原因 6：無業務資料遮罩層（BUG-8）

全庫 `mask` / `redact` 僅出現在 8 個檔案，用途都是遮蔽 API key、連線字串、設定值（`system-config.service.ts`、`encryption.ts` 等），**沒有任何一處遮罩業務資料**。發票提取結果（聯絡人、地址、參考編號等）在 API 與頁面回應中原樣輸出。

> 目前 `prisma/schema.prisma` 中沒有 `bankAccount` / `taxId` / `iban` / `swiftCode` 等明確的高敏感欄位，且卡號掃描 0 命中，所以此項的**當下實際曝險低於 SCM 應用的 24 個實例**。但缺口在於「沒有機制」，而非「目前沒有資料」。

---

## 解決方案

### 第一批：純標頭修復（BUG-3 / BUG-4 / BUG-5 / BUG-6 / BUG-10）

在 `next.config.ts` 加入 `poweredByHeader: false` 與 `headers()`：

```typescript
const nextConfig: NextConfig = {
  poweredByHeader: false,                    // BUG-6

  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },  // BUG-5
        { key: 'X-Content-Type-Options', value: 'nosniff' },                                 // BUG-3
        { key: 'X-Frame-Options', value: 'DENY' },                                           // BUG-3
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },                // BUG-3
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },    // BUG-3
      ],
    }]
  },
}
```

**CSP（BUG-4）分兩步**，不可一次到位：

1. 先發 `Content-Security-Policy-Report-Only`，觀察 1–2 週。Next.js App Router 會注入 inline script（hydration 資料、`next/script`），直接 enforce `script-src 'self'` 會白畫面。
2. 觀察期無違規後改為 enforce，並以 middleware 產生 per-request nonce。

`frame-ancestors 'self'` 可在第一步就 enforce（不影響 script 載入），一併關掉 531006 與 150082。

**BUG-10** 於 `src/middleware.ts` 回應階段覆寫 `NEXT_LOCALE`，補 `secure`（生產環境）與 `httpOnly`。需確認 `src/hooks/use-locale-preference.ts` 是否有前端讀取此 cookie 的路徑——若有，`httpOnly` 會使其失效，需改由 server 傳遞。

> ⚠️ **HSTS 的不可逆性**：`max-age=31536000` 一旦被瀏覽器接受，該網域在一年內強制 HTTPS。先不加 `preload`，且確認所有子網域皆已支援 HTTPS 後再考慮 `includeSubDomains`。

### 第二批：邏輯修復（BUG-2 / BUG-11 / BUG-12 / BUG-9）

**BUG-2**：新增 `src/lib/safe-redirect.ts`，只接受站內相對路徑：

```typescript
/** 只允許以單一 / 開頭的站內路徑；擋掉 //evil.com、https://evil.com、\\evil.com */
export function toSafeRedirect(url: string | undefined, fallback = '/dashboard'): string {
  if (!url) return fallback
  if (!url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) return fallback
  return url
}
```

套用於 `login/page.tsx:72`、`LoginForm.tsx:136`、`RegisterForm.tsx`、`DevLoginForm.tsx:50`。

**BUG-11**：`ConfigEditDialog.tsx:227`、`OutlookConfigForm.tsx:272`、`SharePointConfigForm.tsx:271` 三個密碼欄位補 `autoComplete="new-password"`。

> 說明：`LoginForm.tsx:207` 現用 `autoComplete="current-password"`、註冊表單用 `new-password`，這是現代瀏覽器的正確做法（`off` 已不被遵循，DoD #15 本身也承認這點）。Qualys 150112 仍可能標記，屆時以「應用端已強制密碼複雜度規則」回應即可，**不建議為了過掃描而改回 `off`** —— 那會讓密碼管理器失效，反而降低實際安全性。

**BUG-12**：把 `/api/openapi` 與 `/api/docs` 自 `src/middleware.ts:99` 的 `PUBLIC_API_PREFIXES` 移除，改為要求登入。需先確認是否有對外整合方（n8n / 外部 API 使用者）依賴未認證存取。

**BUG-9**：移除 `.github/workflows/security-deps.yml` 等 4 個 workflow 的 `continue-on-error: true`。**必須在 BUG-1 修完之後才做**，否則所有 PR 立即被擋。移除後需同步更新 GitHub 的 required checks 清單（workflow 定義 ≠ 分支保護設定）。

### 第三批：需先評估（BUG-1 / BUG-7 / BUG-8）

**BUG-1**：38 個漏洞需分類處理。`next-auth` 與 `@auth/core` 可能跨 major 版本，屬 H2 觸發條件，需先出升級影響評估。`sharp`、`axios`、`nodemailer`、`form-data` 等應可在 minor 範圍內升級。

**BUG-7**：需新增 `User.failedLoginAttempts` / `User.lockedUntil` 欄位（Prisma migration）+ `authorize()` 累計邏輯 + 解鎖路徑。屬 H1（動到認證流程），需先確認鎖定閾值（DoD 建議 3–5 次）與解鎖方式（時間解鎖 / 自助 / 管理員）。

**BUG-8**：需先盤點「哪些欄位算 PII」，再決定遮罩層放在 service 還是 API 序列化層。此項在無高敏感欄位的現況下優先級最低。

### 需他人協助（BUG-13 / DoD #6）

| 項目 | 需要什麼 |
|---|---|
| BUG-13 | 對 `*.azurewebsites.net` 預設網址加存取限制，只留自訂網域。需 Azure 資源寫入權限 |
| DoD #6 | 確認 SCM / 8172 埠是否對外開放並加 IP 限制。需 Azure 讀取權限 |

---

## 修改的檔案（預估，修復後須更新為實際清單）

| 檔案 | 修改內容 | 批次 |
|------|----------|------|
| `next.config.ts` | 加 `poweredByHeader: false` + `headers()` 五個標頭 + CSP Report-Only | 一 |
| `src/middleware.ts` | 覆寫 `NEXT_LOCALE` cookie 屬性；（第二批）調整 `PUBLIC_API_PREFIXES` | 一 / 二 |
| `src/lib/safe-redirect.ts` | **新增** —— 站內路徑白名單驗證 | 二 |
| `src/app/[locale]/(auth)/auth/login/page.tsx` | 第 72 行套用 `toSafeRedirect()` | 二 |
| `src/components/features/auth/LoginForm.tsx` | 第 136 行套用 `toSafeRedirect()` | 二 |
| `src/components/features/auth/RegisterForm.tsx` | 同上 | 二 |
| `src/components/features/auth/DevLoginForm.tsx` | 第 50 行同上 | 二 |
| `src/components/features/admin/config/ConfigEditDialog.tsx` | 第 227 行補 `autoComplete` | 二 |
| `src/components/features/outlook/OutlookConfigForm.tsx` | 第 272 行補 `autoComplete` | 二 |
| `src/components/features/sharepoint/SharePointConfigForm.tsx` | 第 271 行補 `autoComplete` | 二 |
| `.github/workflows/security-deps.yml` | 移除 `continue-on-error`（BUG-1 修完後） | 二 |
| `.github/workflows/security-sast.yml` `security-secrets.yml` `security-container.yml` | 同上 | 二 |
| `package.json` / `package-lock.json` | 相依套件升級 | 三 |
| `prisma/schema.prisma` + migration | `User.failedLoginAttempts` / `User.lockedUntil` | 三 |
| `src/lib/auth.config.ts` | `authorize()` 加失敗累計與鎖定判斷 | 三 |

> ⚠️ `package-lock.json` 的更新必須留意跨平台問題：Windows 產生的 lock 缺 Linux 專屬相依，會使 CI 的 `npm ci` 失敗（已復發兩次）。辨識訊號為 type-check / lint / i18n 三個 job 在 8–10 秒內同時失敗、而 docs-check 獨自通過。

---

## 測試驗證

### 第一批

- [ ] `curl -s -D - https://<host>/en/auth/login` 回應含 HSTS、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`
- [ ] 同一回應**不含** `X-Powered-By`
- [ ] `Set-Cookie: NEXT_LOCALE=...` 帶 `Secure` 與 `HttpOnly`
- [ ] 語言切換功能仍正常（`NEXT_LOCALE` 改為 `httpOnly` 後）
- [ ] CSP Report-Only 觀察期內收集到的違規已逐項確認來源
- [ ] 頁面在三種語言下皆無白畫面、無 console CSP 錯誤

### 第二批

- [ ] `/{locale}/auth/login?callbackUrl=https://example.com` 登入後導向 `/dashboard`，**不**導向外部網域
- [ ] `callbackUrl=//example.com` 與 `callbackUrl=/\evil` 同樣被擋
- [ ] 正常站內路徑（如 `/zh-TW/documents`）登入後仍正確返回
- [ ] 三個設定表單的密碼欄位不再被瀏覽器自動填入既有密碼
- [ ] `/api/openapi` 未登入時回 401（若決定收攏）
- [ ] CI 四個安全 workflow 在有 high 漏洞時確實使 PR 失敗

### 第三批

- [ ] `npm audit --omit=dev --audit-level=high` 回報 0 筆
- [ ] 連續 5 次密碼錯誤後帳號被鎖定，且錯誤訊息不洩漏帳號是否存在
- [ ] 解鎖路徑可用
- [ ] 既有登入流程（Azure AD SSO + 本地帳號）不受影響

### 全批次完成後

- [ ] 重跑本文件 §檢查方法 的全部靜態與線上檢查，28 項對照結果更新
- [ ] `npm run type-check` / `npm run lint` / `npm run test` 通過
- [ ] `npm run docs:status` 重新生成 `claudedocs/STATUS.md` 並一併提交

---

## 附錄：28 項完整對照

| # | 類別 | 檢查點 | 結果 | 依據 |
|---|------|--------|------|------|
| 1 | 傳輸與憑證 | 僅 HTTPS，非 HTTPS 以 301/302 轉址 | ✅ | 線上實測兩個網域皆回 301 |
| 2 | 傳輸與憑證 | 送出 HSTS | ❌ | 線上實測缺失 |
| 3 | 傳輸與憑證 | 僅 TLS 1.2 以上 | ✅ | `openssl -tls1` / `-tls1_1` 握手被拒 |
| 4 | 傳輸與憑證 | Cipher 限 ECDHE + AEAD | ✅ | 協商結果 `ECDHE-RSA-AES256-GCM-SHA384` |
| 5 | 傳輸與憑證 | 憑證 CN/SAN 相符、綁自訂網域 | ⚠️ | 自訂網域用 Sectigo `*.rci-t.com`；預設網址仍可達且為 `CN=*.azurewebsites.net` |
| 6 | 傳輸與憑證 | 管理埠對外關閉或限 IP | ❓ | DNS 解析失敗，無法判定 |
| 7 | Session 與 Cookie | 全部 cookie 設 Secure / HttpOnly / SameSite | ⚠️ | NextAuth cookie 正確；`NEXT_LOCALE` 缺 Secure 與 HttpOnly |
| 8 | Session 與 Cookie | 認證後重新產生 Session ID | ✅ | JWT 策略，登入即發新 token |
| 9 | Session 與 Cookie | CSPRNG ≥ 128 bits | ✅ | NextAuth JWT 以 `AUTH_SECRET` 簽章 |
| 10 | Session 與 Cookie | 瀏覽器儲存無憑證 / token / 個資 | ✅ | 僅存城市篩選、檢視模式、語言偏好 |
| 11 | 認證與密碼 | 密碼不在其他請求回應出現 | ✅ | `forgot-password` 的 `password` 選取僅用於判斷本地帳號，不回傳 |
| 12 | 認證與密碼 | 加 salt 強雜湊 | ✅ | `bcryptjs` cost 12（`src/lib/password.ts:21`） |
| 13 | 認證與密碼 | 密碼表單僅走 HTTPS | ✅ | HTTP 已 301 轉址 |
| 14 | 認證與密碼 | 防暴力破解 | ❌ | 無鎖定、無速率限制 |
| 15 | 認證與密碼 | 敏感欄位 autocomplete + 密碼規則 | ⚠️ | 3 個設定表單缺屬性；密碼規則已有 |
| 16 | 資料保護 | 伺服器端遮罩 PII | ❌ | 無業務資料遮罩機制 |
| 17 | 資料保護 | 測試資料無有效卡號 | ✅ | 1,665 檔案 Luhn 掃描 0 命中 |
| 18 | 資料保護 | 移除指紋標頭 | ❌ | `X-Powered-By: Next.js` 線上實測存在 |
| 19 | 資料保護 | 無強制瀏覽可得資源 | ⚠️ | `public/` 僅 `.gitkeep`；但 `/api/openapi` 公開 |
| 20 | 安全標頭 | CSP 含 `frame-ancestors 'self'` | ❌ | 線上實測缺失 |
| 21 | 安全標頭 | 四個標頭齊備 | ❌ | 線上實測全缺 |
| 22 | 安全標頭 | 敏感回應 `no-store, private` | ✅ | 登入頁 `private, no-cache, no-store`；公開快取僅 `/api/docs`（3600 < 86400） |
| 23 | 注入與輸出編碼 | 反射輸出依上下文編碼 | ✅ | React 自動轉義，無 `dangerouslySetInnerHTML` |
| 24 | 注入與輸出編碼 | 轉址參數白名單 | ❌ | `callbackUrl` 無驗證 |
| 25 | 注入與輸出編碼 | 避免危險 sink | ✅ | 無 `innerHTML` / `eval` / `document.write` |
| 26 | 相依與平台 | 外部網域最小化 + SRI | ✅ | 無外部 script / CDN，全部經 npm 打包 |
| 27 | 相依與平台 | 元件維持已修補版本 | ❌ | 38 個生產漏洞 |
| 28 | 相依與平台 | 掃描 gate 阻擋 Level 3 以上 | ❌ | 4 個 workflow 全為 advisory |

---

*文件建立日期: 2026-08-07*
*最後更新: 2026-08-07*
