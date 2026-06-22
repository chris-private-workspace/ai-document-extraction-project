# FIX-090: admin 建立的本地密碼帳號被 emailVerified 擋住無法登入

> **建立日期**: 2026-06-22
> **影響範圍**: `src/services/user.service.ts`（`createUser`）
> **優先級**: 高（P1，admin 建立的本地帳號完全無法登入）
> **狀態**: ✅ 已完成（2026-06-22）
> **相依**: CHANGE-082（admin 密碼管理 — 讓 admin 建用戶時可設初始密碼，因而暴露此缺口）、Epic 18（email 驗證機制）

---

## 問題描述

管理員在後台（`/admin/users`）建立新用戶並設定初始密碼後，該用戶用 email + 密碼登入時被「請先驗證電子郵件」（`EmailNotVerified`）擋住，**且永遠收不到驗證郵件**，導致帳號無法使用。

使用者最初的疑問：「本項目還沒接上任何發送郵件功能，又怎會有認證郵件給用戶？」——此疑問正確地指出了缺口。

---

## 根因分析

涉及三段邏輯的交互：

1. **`createUser`（`src/services/user.service.ts`）** 建立用戶時 `status: 'ACTIVE'`、（CHANGE-082 起）可寫入密碼，但**完全沒有設定 `emailVerified`**，也**不發送任何驗證郵件**（不像公開註冊 `/api/auth/register` 會產生 token 並呼叫 `sendVerificationEmail`）。

2. **`auth.config.ts`（第 209 行）** 本地帳號（credentials）登入時檢查：`if (!user.emailVerified) throw new EmailNotVerifiedError()`。`emailVerified` 為 `DateTime?`，null 即視為未驗證。

3. **`src/lib/email.ts`** 在開發環境（`NODE_ENV=development` 且未設 `SMTP_HOST`）下，`sendEmail()` 僅 `console.log` 收件人/主旨後直接 `return`，**不發信、也不印驗證連結**；生產環境才連 SMTP。

**死結**：admin 建立的本地密碼帳號 → `emailVerified = null` → 登入被擋 → 系統從未為它發過驗證信（`createUser` 不寄信）→ 本地又無 SMTP → 帳號永遠無法登入。

> 註：未設密碼的帳號走 Azure AD SSO 登入，不經 credentials 的 `emailVerified` 檢查，**不受此問題影響**。

---

## 解決方案

`createUser` 在**有設定初始密碼**（即本地帳號）時，直接將 `emailVerified` 標記為當前時間 —— admin 手動建立的帳號視為可信，免去 email 驗證（email 驗證的目的是防止公開註冊冒用他人信箱，admin 建立場景不適用）。

```typescript
// src/services/user.service.ts — createUser 的 tx.user.create
data: {
  email: email.toLowerCase(),
  name,
  status: 'ACTIVE',
  // CHANGE-082: 僅在提供密碼時寫入
  // FIX-090: admin 手動建立的本地帳號（有設密碼）視為可信，直接標記 email 已驗證。
  ...(hashedPassword
    ? { password: hashedPassword, emailVerified: new Date() }
    : {}),
},
```

- 僅在 `hashedPassword` 存在時設定 → 最小、精準，只影響「本地密碼帳號」這個出問題的場景。
- 沒設密碼的帳號（Azure AD SSO）行為不變。
- `emailVerified: new Date()` 與 `verify-email/route.ts`（第 90 行）驗證成功時的寫法一致。

---

## 影響分析

| 項目 | 說明 |
|------|------|
| 架構 (H1) | 不涉及。僅補上既有欄位的寫入，未改認證流程結構。 |
| Security (H4) | 合理。admin 建立 = 管理員已確認身份，免 email 驗證不降低安全；不涉及 PII/secrets log。 |
| i18n (H5) | 不涉及。純後端邏輯，無 UI 字串。 |
| Schema | 不涉及。`emailVerified` 欄位已存在（`DateTime?`），無 migration。 |
| 公開註冊流程 | 不受影響。`/api/auth/register` 仍走原本的 token + 驗證郵件流程。 |

---

## ⚠️ 已存在帳號的補救

本修復僅對**修復後新建**的帳號生效。在此之前已建立、`emailVerified = null` 而被擋住的本地帳號，需手動補救其中之一：

1. DB 直接更新：`UPDATE users SET email_verified = NOW() WHERE password IS NOT NULL AND email_verified IS NULL;`（僅限本地密碼帳號）
2. 或刪除後重新建立。

> 查證：2026-06-22 本地 DB 查詢「有密碼但 `email_verified` 為 null」的帳號數為 **0**，當下無待補救帳號。

---

## 後續可考慮（範圍外，未做）

- 開發環境讓 `sendEmail` 把驗證連結印到 console（方便本地測試公開註冊流程），或接上本地 SMTP（如 Mailpit）。
- admin 後台對「已存在未驗證帳號」提供一鍵標記已驗證 / 重寄驗證信的操作。
