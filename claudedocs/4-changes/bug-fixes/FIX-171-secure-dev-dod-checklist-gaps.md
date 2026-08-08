# FIX-171: 依公司 Secure Development DoD Checklist 對標 —— 13 項安全缺口

> **建立日期**: 2026-08-07
> **發現方式**: 依公司安全團隊提供的 `docs/09-reference/security-check/`（SCM/ITPM 掃描報告衍生的 28 項 DoD Checklist）對本專案做代碼靜態檢查 + Azure DEV 線上黑箱驗證
> **影響頁面/功能**: 全站 HTTP 回應標頭、登入流程（`/[locale]/auth/login`）、Cookie、對外 API 攻擊面、生產相依套件、CI 安全 gate
> **優先級**: 高（含 3 個 critical 相依漏洞與 1 個 open redirect；其餘為掃描必然標記的 Level 2–3 項目）
> **狀態**: 🚧 部分完成（2026-08-08 複驗更新 —— 第一批全數完成；第二批 BUG-2 / BUG-11 / BUG-12 完成；第三批步驟 1–3 完成（`next` 15.5.23、`next-auth` beta.32、裸檢查清零，**fail-open 已於本機重現並驗證修復**）；步驟 5 部分完成（**critical 已歸零**）；步驟 6 / BUG-9 採選項 B 完成；**`npm-audit` 已進入 main 的 required status checks，該閘現已真正生效**；步驟 4 已另開 [FIX-175](FIX-175-protected-route-coverage-gap.md) 完成。**待辦**：BUG-7（防暴力破解，參數已於 2026-08-08 拍板，見 §第三批 BUG-7）、BUG-8（PII 遮罩，維持登記）、剩餘 **21** 個 high）
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

> 🔴 **本段原有的判斷已於 2026-08-07 證實為誤，見 §第三批評估 一**。原文寫「`src/middleware.ts:148` 的 `if (session?.user)` 屬於 fail-open 的脆弱寫法」—— 實際上 advisory 明文建議的**安全**做法正是取用 `.user`，該處寫法本來就正確；真正脆弱的是裸物件檢查（`!!auth`），全庫只有 3 處。該 advisory 亦掛在 `next-auth` 而非 `@auth/core`。

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

> ✅ **參數已於 2026-08-08 由使用者拍板**（實作仍待排程）：
>
> | 項目 | 決定 |
> |---|---|
> | 鎖定閾值 | **連續 5 次**密碼錯誤 |
> | 鎖定時長 | **15 分鐘**，到期自動解鎖 |
> | 額外解鎖途徑 | 管理員可手動解鎖（處理緊急情況） |
> | 計數歸零 | 成功登入即歸零 |
>
> 取 DoD 建議區間（3–5 次）的上限，是為降低正常使用者的誤鎖率；採自動解鎖而非永久鎖定，
> 是因為本專案 Azure 環境無 SMTP（見 memory `project_azure_email_verification`），
> 永久鎖定會讓每一次誤鎖都變成管理員工單。
>
> ⚠️ 實作時仍須注意：錯誤訊息**不得洩漏帳號是否存在**，亦不得因鎖定而回傳與一般密碼錯誤不同的訊息，
> 否則會把防暴力破解變成帳號列舉管道。

**BUG-8**：需先盤點「哪些欄位算 PII」，再決定遮罩層放在 service 還是 API 序列化層。此項在無高敏感欄位的現況下優先級最低。

> 📌 **2026-08-08 使用者決定：暫不處理，維持登記。** 依 §原因 6 的查證，`prisma/schema.prisma` 無 `bankAccount` / `taxId` / `iban` / `swiftCode` 等高敏感欄位，1,665 個檔案的 Luhn 卡號掃描 0 命中，當下實際曝險低。缺的是機制而非資料，故排在 BUG-7 之後。

### 需他人協助（BUG-13 / DoD #6）

| 項目 | 需要什麼 |
|---|---|
| BUG-13 | 對 `*.azurewebsites.net` 預設網址加存取限制，只留自訂網域。需 Azure 資源寫入權限 |
| DoD #6 | 確認 SCM / 8172 埠是否對外開放並加 IP 限制。需 Azure 讀取權限 |

---

## 第一批實作記錄（2026-08-07 完成）

### 實際改動

| 檔案 | 改動 |
|------|------|
| `next.config.ts` | 新增 `poweredByHeader: false`；新增 `headers()` 套用 5 個標頭 + 2 個 CSP header；新增模組層級常數 `CSP_REPORT_ONLY` |
| `src/middleware.ts` | 新增 `hardenLocaleCookie()`；主函式最終回傳改為 `hardenLocaleCookie(intlResponse)` |

### 三個實作決定與理由

**一、CSP 拆成兩個 header 送出。** `frame-ancestors` 在 Report-Only 模式下會被瀏覽器忽略（CSP Level 3 §3.1），必須放在 enforce 的 header 才有效；而它不影響資源載入，可安全直接 enforce。因此 `Content-Security-Policy: frame-ancestors 'self'` 立即生效（關閉 QID 531006 與 150082），其餘指令走 `Content-Security-Policy-Report-Only` 觀察。

**二、`X-Frame-Options` 用 `SAMEORIGIN` 而非 `DENY`。** 與同時送出的 `frame-ancestors 'self'` 語義一致；規劃階段寫的 `DENY` 會與 CSP 產生語義落差（`DENY` 連同源嵌入都禁止），且本專案的 PDF 預覽有同源 iframe 的可能用法。

**三、HSTS 只送 `max-age=31536000`，不含 `includeSubDomains` 與 `preload`。** 兩者皆難以回退：`preload` 進入瀏覽器內建清單後移除需數月；`includeSubDomains` 需先確認 `rci-t.com` 全部子網域都支援 HTTPS，此事未經查證。

### 驗證方式與實測結果

以 Windows 排程任務啟動本機 dev server（port 3300，`NODE_ENV=development`），`curl -D -` 取回應標頭：

```
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Content-Security-Policy: frame-ancestors 'self'
Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; ...
set-cookie: NEXT_LOCALE=en; Path=/; HttpOnly; SameSite=lax
```

回應中**不再出現 `X-Powered-By`**。

`NEXT_LOCALE` 此處無 `Secure` 屬於預期 —— 本機 dev 走 http，`secure` 依 `NODE_ENV === 'production'` 判斷，加上會使 cookie 直接失效。Azure 環境的 standalone 容器為 `NODE_ENV=production`，該屬性會生效，**此點需於部署後複驗**。

語言偵測未被 `httpOnly` 影響（伺服器端讀取不受限），三種情況實測：

| 請求 | 結果 |
|---|---|
| `Cookie: NEXT_LOCALE=zh-TW` → `/documents` | 307 → `/zh-TW/documents` |
| `Cookie: NEXT_LOCALE=zh-CN` → `/documents` | 307 → `/zh-CN/documents` |
| 無 cookie → `/documents` | 307 → `/en/documents` |

CSP Report-Only 違規以 Playwright 開啟登入頁收集：**0 error、0 warning**（唯一的 console error 是 `favicon.ico` 404，與 CSP 無關）。

### ⚠️ 本次驗證未涵蓋的範圍

| 未涵蓋 | 原因 |
|---|---|
| 登入後的頁面（dashboard、文件預覽、報表、PDF viewer） | 本機無可用資料庫，無法登入。**這些頁面才是 CSP 違規最可能出現的地方**（react-pdf、圖表、blob URL），觀察期必須涵蓋 |
| 生產模式（`next build` + `next start`）下的 CSP | 本次僅在 dev 模式驗證。dev 有 HMR 與 eval，生產的 inline script 形態不同 |
| `NEXT_LOCALE` 的 `Secure` 屬性 | 需 `NODE_ENV=production` 環境，部署後複驗 |
| CSP 違規的集中收集 | 目前無 `report-uri` / `report-to` 端點，違規只出現在各使用者的瀏覽器 console。若要在觀察期系統性收集，需另建端點（屬新增 API，未納入本批） |

---

## 第二批實作記錄（2026-08-07，BUG-2 / BUG-11 完成）

### BUG-2：`callbackUrl` open redirect

新增 `src/lib/safe-redirect.ts`，採兩道關卡：

1. **語法排除** —— 必須以單一 `/` 開頭，擋掉絕對 URL、protocol-relative（`//evil`）、反斜線變形（`/\evil`、`\\evil`）、偽協定（`javascript:`、`data:`）
2. **解析驗證** —— 以哨兵 base（`https://safe-redirect.invalid`）解析，確認 origin 未被改寫。此為縱深防禦，涵蓋第一道未列舉的變形

通過後回傳正規化的 `pathname + search + hash`，保留使用者原本要返回的位置。

**收口策略**：不可信輸入的唯一入口是兩個頁面的 `searchParams`，因此在頁面層收斂一次，下游全部使用 `safeCallbackUrl`；另在 `router.push()` 這個實際轉址動作點再套一層，避免未來重構時元件被別處複用而失去保護。

| 位置 | 原本 | 改為 |
|---|---|---|
| `login/page.tsx` | `redirect(callbackUrl ?? '/dashboard')` | `redirect(safeCallbackUrl)` |
| `login/page.tsx` | `signIn('microsoft-entra-id', { redirectTo: callbackUrl ?? '/dashboard' })` | `redirectTo: safeCallbackUrl` |
| `login/page.tsx` | `<LoginForm callbackUrl={callbackUrl ?? '/dashboard'} />`、`<DevLoginForm callbackUrl={callbackUrl} />` | 皆傳 `safeCallbackUrl` |
| `register/page.tsx` | `redirect(callbackUrl ?? '/dashboard')`、`<RegisterForm callbackUrl={callbackUrl} />` | 同上 |
| `LoginForm.tsx` | `router.push(callbackUrl)` | `router.push(toSafeRedirect(callbackUrl))` |
| `DevLoginForm.tsx` | `router.push(callbackUrl ?? '/dashboard')` | `router.push(toSafeRedirect(callbackUrl))` |

`src/components/layout/SessionGuard.tsx` 產生 callbackUrl 的來源是 `window.location.pathname`，屬內部值；且它產生的 URL 仍會經過登入頁的 `searchParams`，因此同樣被收斂，無須另改。

**測試**：新增 `tests/unit/lib/safe-redirect.test.ts`，22 個案例涵蓋 6 種放行形態、12 種繞過形態、空值與自訂 fallback，全部通過。

### BUG-11：設定表單密碼欄位

三處補上 `autoComplete="new-password"`：`ConfigEditDialog.tsx`（系統設定 SECRET 值）、`OutlookConfigForm.tsx`、`SharePointConfigForm.tsx`（Azure AD client secret）。

取 `new-password` 而非規劃時寫的 `off`，理由有二：這三個欄位是**機器憑證**，主要風險是瀏覽器把使用者的既有密碼填進去，`new-password` 才是有效的抑制信號（瀏覽器早已不遵循 `type="password"` 上的 `off`）；且此值與專案既有做法一致（`LlmProviderForm.tsx:305` 的 API key 欄位、`AddUserDialog`、`EditUserDialog` 皆用 `new-password`）。

### 驗證

| 檢查 | 結果 |
|---|---|
| `npx vitest run tests/unit/lib/safe-redirect.test.ts` | 22 passed |
| `npm run test`（全套件） | 489 passed / 2 skipped / **0 failed**，無回歸 |
| `npm run type-check` | 通過 |
| `eslint`（8 個改動檔案） | 0 error（1 warning 為 `DevLoginForm` 既有的未使用 `catch (err)`，非本次引入，依 §Surgical Changes 不順手改） |

---

## BUG-12：查證、決策與實作（2026-08-07）

規劃時寫的前提是「需先確認是否有對外整合方依賴未認證存取」。查證後發現**依賴方在內部**：

| 依賴點 | 說明 |
|---|---|
| `src/app/[locale]/docs/page.tsx:54` | `href="/api/openapi"` 超連結 |
| `src/app/[locale]/docs/examples/page.tsx:54` | 同上 |
| `src/app/[locale]/docs/page.tsx:78,86` | `/api/docs/error-codes`、`/api/docs/version` |
| `SwaggerUIWrapper` 組件 | 載入 `/api/openapi` 渲染互動式文件 |

關鍵在於 **`/[locale]/docs` 頁面本身也是公開的** —— 它不在 `(dashboard)` 路由組，而 `src/middleware.ts` 的 `isProtectedRoute()` 只涵蓋 `/dashboard` 與 `/documents`。因此若只收攏 API 而不動頁面，未登入者點該頁連結會拿到 401，形成壞掉的公開頁。

這已經不是單純的安全修復，而是**產品決策**：API 文件要不要對未登入者公開。三個選項：

| 選項 | 作法 | 影響 |
|---|---|---|
| A | 維持公開，在文件記錄為「刻意的設計」 | 掃描仍可能標記；攻擊面維持現狀（完整 API 規格 23 KB 對外可讀） |
| **B** ✅ | **API 與 `/[locale]/docs` 頁面一併要求登入** | **需擴充 `isProtectedRoute()`，屬頁面層存取控制變更** |
| C | 只收攏 `/api/openapi`，保留 `/api/docs/*` 靜態資訊 | 折衷，但 docs 頁的 SwaggerUI 對未登入者會壞 |

**使用者於 2026-08-07 裁決採 B**，已實作。

### 實作內容

| 位置 | 改動 |
|---|---|
| `PUBLIC_API_PREFIXES` | 移除 `/api/docs` 與 `/api/openapi`；保留 `/api/auth`、`/api/health` |
| `isProtectedRoute()` | 新增 `restPath.startsWith('/docs')` |
| 檔頭 JSDoc 路由分類 | 同步更新，避免文件與實作脫節 |

動手前查證過呼叫方：`scripts/` 與 `.github/workflows/` 皆無引用，`/api/docs` 本身只是重定向到 `/docs` 頁面，因此依賴方全部是瀏覽器，收攏不影響任何自動化流程。

> ⚠️ **`/documents` 不會被 `/docs` 誤判**：`'/documents'.startsWith('/docs')` 為 false（第 5 個字元 `u` ≠ `s`）。此點已由下方實測確認。

### 實測結果（本機 dev server，`API_AUTH_GATE_MODE=enforce`）

線上 Azure DEV 的認證閘為 enforce，本機預設是 monitor（僅記錄後放行），故驗證時明確設定為 enforce 以重現線上行為。

| 請求 | 結果 | 判讀 |
|---|---|---|
| `/api/openapi` | **401** | 已收攏 |
| `/api/docs/error-codes` | **401** | 已收攏 |
| `/en/docs` | 307 → `/en/auth/login?callbackUrl=%2Fen%2Fdocs` | 已收攏，且返回路徑保留 |
| `/en/docs/examples` | 307 → `/en/auth/login?callbackUrl=%2Fen%2Fdocs%2Fexamples` | 子路由一併涵蓋 |
| `/en/documents` | 307 → `/en/auth/login?callbackUrl=%2Fen%2Fdocuments` | **回歸確認**：未被 `/docs` 誤判，路徑完整保留 |
| `/api/auth/csrf` | 200 | 白名單仍有效 |
| `/en/auth/login` | 200 | 公開頁未受影響 |
| `/api/health` | **503** | 白名單仍有效 —— 503 是健康檢查偵測到本機資料庫未啟動，**若被認證閘擋下應為 401**，回 503 正好證明它通過了閘門 |

---

## 第三批評估：認證相依套件升級（2026-08-07，尚未動手）

### 一、先更正本文件先前的一個判斷

§原因 4 原本寫：

> ⚠️ `@auth/core` 的 fail-open 模式需要特別留意：`src/middleware.ts:148` 的 `if (session?.user)` 與各 handler 的同型判斷正屬此類寫法。

**這個判斷是錯的，而且方向相反。** 查閱 advisory 原文（GHSA-8fpg-xm3f-6cx3）後確認：

| advisory 的判定 | 寫法 |
|---|---|
| **脆弱** | `const isLoggedIn = !!auth`、`if (req.auth)` —— 裸物件存在性檢查 |
| **安全（advisory 明文建議的緩解方式）** | `const isLoggedIn = !!req.auth?.user` —— 取用具體的 user 屬性 |

advisory 原文：「check for a concrete user/session property rather than the bare object, so a configuration-error object is not treated as an authenticated session」。

因此 `src/middleware.ts` 的 `if (session?.user)` 與 `auth.config.ts:273` 的 `const isLoggedIn = !!auth?.user` **本來就是安全模式**，不需要修改。

另一個更正：該 advisory 掛在 **`next-auth`**，不在 `@auth/core` 的 advisory 清單內。

### 二、實際曝險盤點

| 模式 | 數量 | 判定 |
|---|---:|---|
| 取用 `.user` 的安全模式（`session?.user` / `auth?.user`） | **369** | 符合 advisory 建議 |
| 裸物件檢查 | **3** | 脆弱 |

三處裸檢查：

| 位置 | 寫法 | fail-open 時的後果 |
|---|---|---|
| `src/app/[locale]/(auth)/auth/login/page.tsx:77` | `if (session)` | 未認證者被誤導向 `/dashboard`（非繞過保護，體感是導向後又被擋） |
| `src/app/[locale]/(auth)/auth/register/page.tsx:77` | `if (session)` | 同上 |
| `src/app/[locale]/(dashboard)/layout.tsx:50` | `if (!session)` | 🔴 **不再導向登入頁 —— 整個 `(dashboard)` 路由組的頁面對未認證者渲染** |

### 三、比 advisory 本身更值得處理的發現：頁面保護的單點依賴

盤點第三處時發現一個**獨立於 advisory 的既有落差**：

`(dashboard)` 路由組底下有 **13 個頂層路徑**，而 `src/middleware.ts` 的 `isProtectedRoute()` 只涵蓋 **3 個**：

| 有 middleware 保護（雙重防線） | 只有 layout 保護（單點） |
|---|---|
| `/dashboard`、`/documents`、`/docs` | `/admin`、`/audit`、`/companies`、`/escalations`、`/global`、`/profile`、`/reports`、`/review`、`/rollback-history`、`/rules`、`/template-instances` |

右欄 11 個路徑（含 `/admin` 底下 24 個管理模組）**唯一的頁面層防線就是那個裸檢查**。正常運作時它有效（`session` 為 `null`）；一旦 Auth.js 配置出錯（`AUTH_SECRET` 未設、provider 配置缺失），它就整批失效。

> 📌 API 層不受此影響 —— middleware 的 API 認證閘用的是 `session?.user`（安全模式），且線上為 enforce。所以 fail-open 的後果是「頁面殼渲染」，資料仍取不到。但這仍是應該補的縱深防禦缺口。

### 四、版本落差與修復版本

| 套件 | 目前 | 修復版 | 版差性質 |
|---|---|---|---|
| `next-auth` | 5.0.0-beta.30 | **5.0.0-beta.32** | 同一 beta 通道，跨 2 個 beta |
| `@auth/core` | 0.41.1 | **0.41.3** | patch |
| `@auth/prisma-adapter` | 2.11.1 | 2.11.3 | patch |
| `next` | 15.5.9 | **15.5.21 以上**（最新 15.5.23） | 同 minor，跨 14 個 patch |

`next-auth@5.0.0-beta.32` 的 release note 說明其變更為純安全修復，未列任何破壞性 API 變更：

> "Fixes auth checks failing open on provider configuration errors: a non-OK session response now yields no session instead of an error object, so checks like `!!auth` fail closed."

**這代表升級本身就會讓那 3 處裸檢查改為 fail closed** —— 修不修改那 3 行都不再 fail open。但仍建議一併改為 `.user` 形式，理由是不把安全性寄託在單一套件版本上。

### 五、🔴 升級的最大陷阱：不可使用 `npm audit fix`

```
npm view next-auth version  →  4.24.15
```

`4.24.15` 是 `latest` tag（v4 穩定版），而本專案走的是 **v5 beta 通道**。`npm audit fix` 會傾向解到 `latest`，把 `next-auth` 從 **v5 beta 降級成 v4** —— 兩者 API 完全不同（v5 的 `auth()` / `handlers` / `signIn` 匯出方式在 v4 不存在），將導致整個認證體系崩潰。

**必須明確指定版本升級**：

```bash
npm install next-auth@5.0.0-beta.32 @auth/prisma-adapter@2.11.3
npm install next@15.5.23
```

### 六、Next.js 的 middleware bypass —— 建議優先於 next-auth 處理

`next@15.5.9` 落在多條 middleware 繞過 advisory 的範圍內：

| Advisory | 嚴重度 | 影響範圍 |
|---|---|---|
| GHSA-26hh-7cqf-hhc6 | High 7.5 | Middleware / Proxy bypass via segment-prefetch routes（`<15.5.18`） |
| GHSA-267c-6grr-h53f | High 7.5 | 同型（`<15.5.16`） |
| GHSA-492v-c6pp-mqqv | High 8.1 | Middleware bypass via dynamic route parameter injection（`<15.5.16`） |
| GHSA-36qx-fr4f-26g5 | High 7.5 | Middleware bypass in i18n applications（`<15.5.16`） |

**為何這對本專案特別嚴重**：本專案的 API 認證閘（CHANGE-078）**完全建立在 middleware 上**，FIX-171 第二批把 `/api/openapi` 的保護也放在同一層。middleware 若可被繞過，這道閘就整體失效 —— 且最後一條 advisory 明確點名 i18n 應用，而本專案全站走 `/[locale]/` 路由。

就「已知可繞過的防線正在承載本專案的主要授權邏輯」而言，這比 fail-open（需要先發生配置錯誤才觸發）**更接近可直接利用**。

### 七、建議的執行順序

| 順序 | 動作 | 風險 | 驗證方式 |
|---|---|---|---|
| 1 | `next` 15.5.9 → 15.5.23 | 中（跨 14 個 patch，需完整回歸） | build + 全測試 + 本機路由驗證 + 部署後煙霧測試 |
| 2 | `next-auth` → beta.32、`@auth/prisma-adapter` → 2.11.3 | 低（純安全修復，無 API 變更） | 登入 / 登出 / session 過期 / Azure AD 流程 |
| 3 | 3 處裸檢查改為 `.user` 形式 | 極低 | 單元測試 + 路由驗證 |
| 4 | 補 `isProtectedRoute()` 缺的 11 個路徑 | 中（可能影響既有導覽） | 逐路徑未登入實測 |
| 5 | 其餘 30+ 個相依漏洞分批處理 | 依套件而定 | 個別評估 |
| 6 | 解除 CI 的 `continue-on-error`（BUG-9） | —— | PR 實測會擋 |

> ⚠️ 第 1 項的驗證有實質困難：本機無可用資料庫，登入後的頁面無法測。Next.js 跨 14 個 patch 的升級**應該要有登入後的完整回歸**，否則問題只會在部署後才浮現。建議在有資料庫的環境執行，或接受「先部署到 DEV 再驗證」的順序並準備好回滾。

> 📌 第 4 項嚴格說超出 FIX-171 原定範圍（DoD Checklist 沒有這條），但它是第三批盤點的直接產物，且與 BUG-7 同屬認證強化。是否納入本 FIX 或另開編號，待決定。

---

## 第三批實作記錄：步驟 1–3（2026-08-07 完成）

### 🔴 最重要的發現：fail-open 在本機被實際重現，並非理論風險

驗證過程中意外重現了 GHSA-8fpg-xm3f-6cx3 的完整因果鏈。這不是推論，是可對照的實測。

**觸發源**：臨時 `.env` 使用了 Auth.js v4 的變數名 `NEXTAUTH_URL`，v5 需要 `AUTH_URL`。伺服器日誌因此持續輸出：

```
[auth][error] UntrustedHost: Host must be trusted. URL was: http://localhost:3300/api/auth/session
```

這正是 advisory 所述的「server-configuration error」。

**升級前後對照**（同一份程式碼，只換 `next-auth` 版本）：

| 檢查項 | beta.30（升級前） | beta.32（升級後） |
|---|---|---|
| `/en/auth/login` 未登入 | **307 → `/dashboard`** | **200 正常顯示** |
| 重定向鏈 | **`num_redirects=10`（達上限）** | **`num_redirects=0`** |
| `/en/dashboard` | 307 → 登入頁 | 307 → 登入頁（不變） |
| `/api/documents` | 401 | 401（不變） |

**故障形態值得記錄**：本專案的 fail-open 表現**不是未授權存取，而是登入頁完全不可用** —— 未認證者被導向 `/dashboard`，middleware（用安全模式判斷）再導回登入頁，形成無限迴圈。使用者根本無法登入。

> ⚠️ **對 Azure 環境的意涵**：任何導致 Auth.js 配置錯誤的狀況（資料庫不可用、環境變數遺漏、`AUTH_URL` 與實際主機不符）都會在升級前觸發此迴圈，使全站登入失效。本專案在 Azure DEV 已有 VNet DNS 導致容器連不到資料庫的前例，屬同類觸發條件。

### 步驟 1：`next` 15.5.9 → 15.5.23

**升級前先建立跨平台相依基準**，因本專案有兩次「Windows 產生的 lock 缺 Linux 相依 → CI `npm ci` 失敗」前例：

| 指標 | 升級前 | 升級後 |
|---|---:|---:|
| 套件總數 | 1321 | 1316 |
| **linux 條目** | **59** | **59** |
| darwin 條目 | 18 | 18 |
| win32 條目 | 19 | 19 |

`@next/swc-linux-{x64,arm64}-{gnu,musl}` 等 9 個 Linux 專屬條目完整保留，不會重現該 CI 故障。

**結果**：`next` 的 **DIRECT advisory 已全部清除**，包括四條 middleware bypass（最高 CVSS 8.1，其中一條專指 i18n 應用）。目前 `npm audit` 仍將 `next` 標為 high，但來源是傳遞相依 `postcss` 與 `sharp`，非 Next.js 本體 —— 屬步驟 5 範圍。

### 步驟 2：`next-auth` → 5.0.0-beta.32、`@auth/prisma-adapter` → 2.11.3

`@auth/core` 隨之升到 0.41.3。三者的 advisory **全部清除**。

### 步驟 3：3 處裸物件檢查改寫

| 檔案 | 改動 |
|---|---|
| `src/app/[locale]/(dashboard)/layout.tsx` | `if (!session)` → `if (!session?.user)` |
| `src/app/[locale]/(auth)/auth/login/page.tsx` | `if (session)` → `if (session?.user)` |
| `src/app/[locale]/(auth)/auth/register/page.tsx` | 同上 |

改寫後全庫裸檢查歸零（`grep -rnE "if \(!?session\)|if \(!?auth\)|if \(!?req\.auth\)" src` 無結果）。

beta.32 本身已讓裸檢查 fail closed，此改寫的目的是不把保證寄託在單一套件版本上。

### 漏洞數變化（`npm audit --omit=dev`）

| | 升級前 | 升級後 |
|---|---:|---:|
| critical | 3 | **1** |
| high | 21 | 20 |
| moderate | 13 | 13 |
| low | 1 | 1 |
| **總計** | **38** | **35** |

剩餘 critical 為 `fast-xml-parser`（7 條 advisory）。剩餘 high 中有 16 個帶直接 advisory：`axios`、`nodemailer`、`lodash`、`form-data`、`postcss`、`sharp`、`js-yaml`、`minimatch`、`picomatch`、`tmp`、`defu`、`immutable`、`brace-expansion`、`hono`、`@hono/node-server`、`effect`。

### 驗證

| 檢查 | 結果 |
|---|---|
| `npm run type-check` | 通過 |
| `npm run test` | 489 passed / 2 skipped / **0 failed** |
| `npm run build` | **成功**（`Compiled successfully`） |
| 生產模式路由（`next start`） | 登入頁 200 無迴圈；`/en/dashboard`、`/en/admin/users`、`/en/companies`、`/en/reports/cost`、`/en/docs` 皆 307 導向登入頁；`/api/documents`、`/api/admin/users`、`/api/openapi` 皆 401；`/api/auth/csrf` 200 |
| 安全標頭（生產模式） | 7 個標頭齊全、無 `X-Powered-By` |
| **`NEXT_LOCALE` 的 `Secure` 屬性** | ✅ **生產模式實測確認**：`NEXT_LOCALE=en; Path=/; Secure; HttpOnly; SameSite=lax` —— 補上第一批的待驗證項 |

> 📌 過程中 `/api/auth/csrf` 一度回 500，經查為臨時 `.env` 使用 v4 變數名所致（`UntrustedHost`），補上 `AUTH_URL` 後恢復 200。**非升級回歸**。

### ⚠️ 仍未驗證

| 項目 | 原因 |
|---|---|
| **登入後的完整回歸** | 本機無可用資料庫，無法登入。Next.js 跨 14 個 patch 的升級應有登入後回歸，目前只驗證到未認證路徑 |
| standalone 模式 | 驗證用的是 `next start`，Azure 實際跑 `node .next/standalone/server.js`。`next start` 啟動時警告不適用 standalone 配置，但回應正常 |
| SwaggerUI 登入後載入 `/api/openapi` | 同樣受限於無法登入 |

---

## 第三批步驟 5：剩餘漏洞（2026-08-07，部分完成）

### 🔴 教訓：`npm audit fix` 在本專案會造成實質破壞

原本已在 §第三批評估 五 警告過不可用 `npm audit fix`（會把 `next-auth` v5 beta 降級成 v4）。實測發現**第二種破壞形態**，且更隱蔽：

執行 `npm audit fix` 後——

| 套件 | 執行前 | 執行後 |
|---|---|---|
| `prisma`（CLI，devDependency `^7.2.0`） | 7.2.0 | **7.9.1** |
| `@prisma/engines` | 7.2.0 | **7.9.1** |
| `@prisma/client` | 7.2.0 | **7.2.0（未動）** |

結果 `npx prisma generate` 直接失敗：

```
Error: Cannot find module '.../node_modules/@prisma/client/runtime/query_compiler_fast_bg.postgresql.wasm-base64.js'
```

CLI 7.9.1 要求 client 7.9.1 的 runtime 檔案，而 client 停在 7.2.0。

**根因是一個既有的相依宣告缺口**：`@prisma/client` 被 `src/` 大量直接 `import`，卻**沒有宣告在 `package.json`**（`npm ls` 顯示它只透過 `@auth/prisma-adapter` 與頂層 dedupe 存在）。因此 `npm audit fix` 升級 CLI 時，沒有對應的宣告可一併升級 client。

> 📌 **這個宣告缺口本身應該單獨修**（`@prisma/client` 是直接使用的相依，不該只靠傳遞取得），但屬於相依結構變更，不併入本 FIX。

已 `git checkout package-lock.json` + `npm ci` 完整還原，並確認 `prisma generate` 與 `type-check` 恢復正常。

### 實際採用的做法：精準 override

只針對唯一的 critical 做最小改動，`package.json` 新增：

```json
"overrides": {
  "fast-xml-parser": "^5.10.1"
}
```

`fast-xml-parser` 走兩條相依鏈，皆為傳遞相依、非專案直接使用：

```
@azure/storage-blob → @azure/core-xml → fast-xml-parser 5.3.3 → 5.10.1
@types/nodemailer → @aws-sdk/client-sesv2 → @aws-sdk/core → @aws-sdk/xml-builder → 5.2.5 → 5.10.1
```

advisory 範圍為 `<=5.6.0`，5.10.1 為同 major 內升級。

### 漏洞數變化

| | 原始 | 步驟 1–3 後 | 步驟 5 後 |
|---|---:|---:|---:|
| **critical** | **3** | 1 | **0** |
| high | 21 | 20 | 20 |
| moderate | 13 | 13 | 13 |
| low | 1 | 1 | 1 |
| **總計** | **38** | 35 | **34** |

### 驗證

`prisma generate` ✅ ・ `type-check` ✅ ・ `test` 489 passed / 0 failed ✅ ・ `build` ✅ Compiled successfully
關鍵套件版本未受 override 影響：`prisma` 7.2.0、`@prisma/client` 7.2.0、`next` 15.5.23、`next-auth` beta.32、`exceljs` 4.4.0、`@azure/storage-blob` 12.29.1

> ⚠️ `fast-xml-parser` 由 Azure Blob SDK 用於 XML 解析。本機未啟動 Azurite，**上傳／下載路徑未實測**，需部署後或在有 Azurite 的環境複驗。

### 剩餘 20 個 high 的結構性約束

| 套件 | 修復途徑 | 阻礙 |
|---|---|---|
| `next`、`postcss`、`sharp` | 三者的修復**全部綁定 `next@16.3.0`** | major 升級（15 → 16），屬 H2，需 approval |
| `nodemailer` | `nodemailer@9.0.4` | major 升級 |
| `@prisma/config`、`@prisma/dev`、`@hono/node-server`、`hono`、`effect`、`lodash` | 隨 `prisma` CLI 升級 | 受上述 `@prisma/client` 宣告缺口阻擋 |
| `axios`、`form-data`、`tmp`、`minimatch`、`picomatch`、`brace-expansion`、`defu`、`immutable`、`js-yaml` | 可比照 `fast-xml-parser` 逐一 override | 尚未做——每個都需獨立驗證，且本機無法做登入後回歸 |

### 2026-08-08 複驗：數字與「受 major 阻擋」的說法都需修正

重跑 `npm audit --omit=dev --json` 並解析，結果與上表有兩處出入：

**一、總數由 20 變 21。** `nanoid` 是 08-07 之後新增的 high advisory（2 條），屬傳遞相依。目前計數：critical 0 / high **21** / moderate 13 / low 1，總計 **35**（生產相依 763 個套件）。

**二、「受 major 升級阻擋」只適用於其中 4 個，不是全部。** 依 npm 回報的 `fixAvailable` 重新分類：

| 類別 | 數量 | 套件 | 性質 |
|---|---:|---|---|
| 真需 major 升級 | 4 | `next`、`postcss`、`sharp`（三者全綁 `next@16.3.0`）、`nodemailer`（→9.0.5） | H2，需 approval |
| 受 prisma 鏈阻擋 | 6 | `prisma`、`@prisma/config`、`@prisma/dev`、`hono`、`@hono/node-server`、`effect` | 升 `@prisma/client` 7.2.0 → 7.9.1 即可，**同 major** |
| 純傳遞、同 range 可修 | 11 | `axios`、`form-data`、`tmp`、`minimatch`、`picomatch`、`brace-expansion`、`defu`、`immutable`、`js-yaml`、`lodash`、`nanoid` | 比照 `fast-xml-parser` 逐一 `overrides`，不觸發 H2 |

**三、prisma 鏈為何出現在 `--omit=dev` 的結果中。** 查相依樹確認它是**經生產相依進來的**，不是 dev 洩漏：

```
@auth/prisma-adapter@2.11.3 → @prisma/client@7.2.0 → prisma@7.2.0
```

Prisma 7 把 CLI 變成 `@prisma/client` 的執行期相依，因此 CLI 自身的相依（`hono`、`effect` 等）全部進入生產樹。

**四、`@prisma/client` 的宣告缺口已變形，未消失。** §步驟 5 記載它「沒有宣告在 `package.json`」，現況是**已宣告，但在 `devDependencies`**（`package.json:140`）。由於 `src/` 大量直接 `import` 它，屬執行期相依，位置仍是錯的 —— 目前只靠上述傳遞路徑才沒有出事。

> ✅ **本節的待辦已由 [FIX-176](FIX-176-remaining-high-dependency-advisories.md) 於 2026-08-08 承接並大部分完成**：high 21 → **6**、總計 35 → **13**。升 `@prisma/client` + `prisma` 到 7.9.1 一次解決 7 個（不需移動宣告位置即可繞開該缺口）；另以 overrides 解決 8 個，其中 `minimatch` / `brace-expansion` / `picomatch` 採巢狀分線處理。剩餘 6 個全部需要 major 升級，屬 H2，詳見 FIX-176 §剩餘 6 個 high。
>
> 📌 `@prisma/client` 宣告位置錯誤（在 `devDependencies` 而實為執行期相依）**仍未修正** —— FIX-176 依 surgical 原則只改版本、未動宣告位置，此項續留待辦。

---

## 第三批步驟 6 / BUG-9：已採選項 B 實作（2026-08-07）

**使用者裁決採選項 B**：門檻改為 `--audit-level=critical` 並移除 `continue-on-error`。

### 動手前先揭穿了一個假綠燈

`gh pr checks` 顯示 `npm-audit` 與 `pip-audit` 皆為 **pass**，但那是 `continue-on-error` 造成的 —— job 成功不等於指令成功。查 CI 原始輸出後：

| Job | 顯示狀態 | 實際結果 |
|---|---|---|
| `npm-audit` | pass | `34 vulnerabilities (1 low, 13 moderate, 20 high)` → **exit code 1** |
| `pip-audit`（extraction） | pass | `Found 42 known vulnerabilities in 4 packages` → **exit code 1** |
| `pip-audit`（mapping） | pass | `No known vulnerabilities found` → 真的通過 |

> 📌 這是「紅燈會被追查、綠燈不會」的典型案例。若未查原始輸出，會誤以為相依掃描一直是乾淨的。

### 實作內容

| 位置 | 改動 |
|---|---|
| `security-deps.yml` npm-audit | `--audit-level=high` → `--audit-level=critical`；**移除** `continue-on-error` |
| `security-deps.yml` pip-audit | 維持 advisory，但註解改為記載真實原因（extraction 42 個漏洞、pip-audit 無 severity 門檻） |
| 檔頭註解 | 改寫為現況說明，取代原本「Week 3 升 required」的過時計畫 |

本機實測門檻行為：

```
npm audit --audit-level=critical --omit=dev  → exit 0（會通過）
npm audit --audit-level=high     --omit=dev  → exit 1（會失敗）
```

### 🔴 這個 gate 目前不會真的擋合併

查 `main` 的分支保護設定：

```
required status checks: type-check, lint, unit-tests, build, docs-check
```

**五個 required check 中沒有任何一個安全掃描 job。** 因此即使 `npm-audit` 現在會失敗，也不會阻擋合併 —— 這正是本專案記載過的「workflow 定義 ≠ GitHub 設定」。

**要讓此閘真正生效，需由 repo admin 將 `npm-audit` 加入 required status checks。** 此為分支保護設定變更，影響全團隊的合併流程，未由 AI 代為執行。已在 workflow 檔頭以 🔴 標註。

### ✅ 已解決（2026-08-08 複驗）

重新查詢分支保護設定，`npm-audit` **已在清單內**，上述缺口不再成立：

```
required status checks: type-check, lint, unit-tests, build, docs-check, npm-audit
```

同時複驗門檻行為，確認此閘不會誤擋現有 PR：

| 指令 | exit code | 意義 |
|---|---|---|
| `npm audit --omit=dev --audit-level=critical` | **0** | CI 實際使用的門檻 —— critical 已歸零，會通過 |
| `npm audit --omit=dev --audit-level=high` | 1 | 若當初未改門檻，所有 PR 會被擋 |

即這道閘現在能擋住任何新引入的 critical，且不影響既有的 21 個 high。

### 其餘三個安全 workflow 維持 advisory

`security-sast.yml`（semgrep）、`security-secrets.yml`（gitleaks）、`security-container.yml`（trivy）皆未在本次變更範圍內，仍為 advisory。使用者選擇的選項 B 僅涵蓋 npm audit。

---

## 步驟 6 原始評估：三個選項（保留供追溯）

CI 的 gate 條件是 `npm audit --audit-level=high --omit=dev`（`.github/workflows/security-deps.yml:24`）。

**目前仍有 20 個 high，直接移除 `continue-on-error` 會使所有 PR 立即被擋。** 這正是本文件自第一版起就標註的相依順序，現況未改變。

三個選項供決策：

| 選項 | 作法 | 效果 | 代價 |
|---|---|---|---|
| A | 維持 advisory 現狀 | 無 | 漏洞持續累積（這正是累積到 38 個的機制） |
| **B** | 將 gate 改為 `--audit-level=critical` 並**移除** `continue-on-error` | **立即生效**——critical 已歸零，且能擋住任何新引入的 critical | 20 個既有 high 不被擋 |
| C | 完成 `next@16` + `nodemailer@9` 等 major 升級後，維持 `--audit-level=high` 並移除 `continue-on-error` | 最徹底 | 需 H2 approval + 完整回歸，且本機無法驗證登入後行為 |

> ✅ **使用者於 2026-08-07 裁決採 B**，實作內容見上一節。

---

## 步驟 4（補 `isProtectedRoute` 缺的 11 個路徑）：不納入本 FIX

**決定：另開 FIX 編號處理，不併入 FIX-171。**

理由：

1. **它目前不是漏洞。** 步驟 3 已將 `(dashboard)/layout.tsx` 改為 `!session?.user`，那 11 個路徑的單點防禦是有效的，且用的是 advisory 建議的安全模式。
2. **性質不同。** 本 FIX 的範圍是「修補公司 DoD Checklist 掃描出的缺口」，28 項中沒有這一條。步驟 4 屬於縱深防禦強化。
3. **風險與驗證需求不同。** 擴充 `isProtectedRoute()` 可能影響既有導覽行為，需逐路徑實測，而本 FIX 已橫跨三批。

> 📌 待辦已登記於此，避免遺失：`(dashboard)` 路由組的 13 個頂層路徑中，`isProtectedRoute()` 僅涵蓋 `/dashboard`、`/documents`、`/docs`；`/admin`、`/audit`、`/companies`、`/escalations`、`/global`、`/profile`、`/reports`、`/review`、`/rollback-history`、`/rules`、`/template-instances` 共 11 個僅有 layout 一道防線。

> ✅ **已於 2026-08-08 由 [FIX-175](FIX-175-protected-route-coverage-gap.md) 完成**。清單改為具名常數 `PROTECTED_PAGE_PREFIXES`，涵蓋全部 14 個前綴；22 個案例實測通過，並以 negative control 證明係依清單攔截而非無差別攔截。此處的「另開編號」決定至此結案。

---

## 修改的檔案

| 檔案 | 修改內容 | 批次 | 狀態 |
|------|----------|------|------|
| `package.json` | 新增 `overrides.fast-xml-parser: ^5.10.1`（清除唯一 critical） | 三・步驟 5 | ✅ 已完成 |
| `package-lock.json` | 於 Linux 容器（node:22）重新生成，修復 CI `npm ci` 不同步 | 三・步驟 5 附帶 | ✅ 已完成 |
| `.github/workflows/security-deps.yml` | npm-audit 改 `--audit-level=critical` 並移除 `continue-on-error` | 三・步驟 6 | ✅ 已完成 |
| `package.json` / `package-lock.json` | `next` → 15.5.23、`next-auth` → 5.0.0-beta.32、`@auth/prisma-adapter` → 2.11.3 | 三 | ✅ 已完成 |
| `src/app/[locale]/(dashboard)/layout.tsx` | 裸檢查改為 `!session?.user` | 三 | ✅ 已完成 |
| `next.config.ts` | 加 `poweredByHeader: false` + `headers()` 五個標頭 + 兩個 CSP header | 一 | ✅ 已完成 |
| `src/middleware.ts` | 新增 `hardenLocaleCookie()` 補強 `NEXT_LOCALE` 屬性 | 一 | ✅ 已完成 |
| `src/lib/safe-redirect.ts` | **新增** —— 轉址目標白名單驗證 | 二 | ✅ 已完成 |
| `tests/unit/lib/safe-redirect.test.ts` | **新增** —— 22 個案例 | 二 | ✅ 已完成 |
| `src/app/[locale]/(auth)/auth/login/page.tsx` | 四處改用 `safeCallbackUrl` | 二 | ✅ 已完成 |
| `src/app/[locale]/(auth)/auth/register/page.tsx` | 兩處改用 `safeCallbackUrl` | 二 | ✅ 已完成 |
| `src/components/features/auth/LoginForm.tsx` | `router.push()` 套用 `toSafeRedirect()` | 二 | ✅ 已完成 |
| `src/components/features/auth/DevLoginForm.tsx` | 同上 | 二 | ✅ 已完成 |
| `src/components/features/admin/config/ConfigEditDialog.tsx` | 補 `autoComplete="new-password"` | 二 | ✅ 已完成 |
| `src/components/features/outlook/OutlookConfigForm.tsx` | 同上 | 二 | ✅ 已完成 |
| `src/components/features/sharepoint/SharePointConfigForm.tsx` | 同上 | 二 | ✅ 已完成 |
| `src/middleware.ts` | `PUBLIC_API_PREFIXES` 移除 `/api/docs` 與 `/api/openapi`；`isProtectedRoute()` 新增 `/docs` | 二 | ✅ 已完成（選項 B） |
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

- [x] `curl -s -D -` 回應含 HSTS、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`（本機 dev 實測，2026-08-07）
- [x] 同一回應**不含** `X-Powered-By`
- [x] `Set-Cookie: NEXT_LOCALE=...` 帶 `HttpOnly`
- [ ] `Set-Cookie: NEXT_LOCALE=...` 帶 `Secure` —— **需 `NODE_ENV=production`，部署到 Azure 後複驗**
- [x] 語言切換功能仍正常（三種 locale 導向皆正確）
- [x] 登入頁在 CSP Report-Only 下無違規
- [ ] **登入後頁面**（dashboard / 文件預覽 / 報表）在 CSP Report-Only 下的違規已逐項確認 —— 本機無資料庫，未涵蓋
- [ ] 生產模式（`next build`）下的 CSP 違規已確認 —— 未涵蓋
- [ ] 決定是否建立 CSP `report-uri` 端點以系統性收集違規
- [ ] 觀察期結束後，將 CSP 由 Report-Only 改為 enforce（需先導入 per-request nonce）

### 第二批

- [x] `callbackUrl=https://evil.example` 被收斂為 `/dashboard`（單元測試涵蓋）
- [x] `callbackUrl=//evil.example` 與 `callbackUrl=/\evil.example` 同樣被擋（單元測試涵蓋）
- [x] `javascript:` / `data:` 偽協定被擋（單元測試涵蓋）
- [x] 正常站內路徑連同 query 與 hash 原樣保留（單元測試涵蓋）
- [x] 全套件無回歸（489 passed / 0 failed）
- [x] 三個設定表單的密碼欄位已補 `autoComplete="new-password"`
- [ ] **端到端實測**：實際以瀏覽器走一次帶惡意 `callbackUrl` 的登入流程 —— 本機無可用資料庫，未執行
- [x] `/api/openapi` 與 `/api/docs/*` 未登入時回 401（本機 enforce 模式實測）
- [x] `/en/docs` 與 `/en/docs/examples` 未登入時導向登入頁並保留返回路徑
- [x] `/en/documents` 未被 `/docs` 誤判（回歸確認）
- [x] `/api/health`、`/api/auth/*`、登入頁仍公開（回歸確認）
- [ ] **登入後** SwaggerUI 能正常載入 `/api/openapi` —— 本機無資料庫無法登入，需部署後複驗
- [x] ~~CI 四個安全 workflow 在有 high 漏洞時確實使 PR 失敗~~ —— **已改採選項 B**：只有 `npm-audit` 移除 advisory 且門檻設為 `critical`（非 high），其餘三個 workflow 維持 advisory。2026-08-08 複驗確認 `npm-audit` 已進入 required status checks，該閘實際生效；`--audit-level=critical` exit 0、`--audit-level=high` exit 1，即擋新 critical 而不擋既有 21 個 high

### 第三批

- [ ] `npm audit --omit=dev --audit-level=high` 回報 0 筆 —— 2026-08-08 複驗仍為 **21 筆**
- [ ] 連續 **5** 次密碼錯誤後帳號被鎖定 **15 分鐘**，且錯誤訊息不洩漏帳號是否存在（參數已拍板，實作待排程）
- [ ] 鎖定到期後自動解鎖，且管理員可手動提前解鎖
- [ ] 成功登入後失敗計數歸零
- [ ] 既有登入流程（Azure AD SSO + 本地帳號）不受影響

### 全批次完成後

- [ ] 重跑本文件 §檢查方法 的全部靜態與線上檢查，28 項對照結果更新
- [ ] `npm run type-check` / `npm run lint` / `npm run test` 通過
- [ ] `npm run docs:status` 重新生成 `claudedocs/STATUS.md` 並一併提交

---

## 附錄：28 項完整對照

> 🔴 本表是 **2026-08-07 對標當下的掃描結果，不隨修復進度更新**。第一批完成後，項次 2 / 18 / 20 / 21 與項次 7 的 `NEXT_LOCALE` 部分已改善（見 §第一批實作記錄），但本表刻意維持原值以保留發現當下的基準，供日後重新掃描時對照。

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
*最後更新: 2026-08-08（複驗五項待辦：required check 已生效、漏洞分類更正、BUG-7 參數拍板、BUG-8 維持登記、步驟 4 由 FIX-175 完成）*
