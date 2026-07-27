# FIX-024b: EmailNotVerified 錯誤訊息未正確顯示

> **狀態**: ✅ 已修復

**建立日期**: 2026-01-19
**修復日期**: 2026-01-19
**嚴重程度**: 中
**狀態**: ✅ 已修復

---

## 問題描述

當未驗證帳號嘗試登入時，後端正確拋出 `EmailNotVerified` 錯誤，但前端 LoginForm 顯示「發生未知錯誤」而非預期的「請先驗證您的電郵地址」。

### 重現步驟

1. 使用未驗證的帳號嘗試登入
2. 後端日誌顯示 `[auth][error] CredentialsSignin` 和 `[auth][cause]: Error: EmailNotVerified`
3. 前端顯示通用錯誤訊息

### 預期行為

前端應顯示「請先驗證您的電郵地址。請檢查您的收件匣中的驗證連結。」並提供重新發送驗證郵件的連結。

---

## 根本原因分析

### Auth.js v5 錯誤傳遞機制

Auth.js v5 的 `signIn()` 函數返回值結構：
```typescript
interface SignInResponse {
  error?: string;    // 錯誤類型（例如 'CredentialsSignin'）
  code?: string;     // 自定義錯誤代碼（例如 'EmailNotVerified'）
  ok: boolean;
  status: number;
}
```

自定義錯誤代碼通過 `CredentialsSignin` 子類別的 `code` 屬性傳遞，而不是覆蓋 `error` 屬性。

### 原始代碼問題

`LoginForm.tsx` 只檢查 `result.error`，沒有檢查 `result.code`：

```typescript
// ❌ 原始代碼
if (result?.error) {
  setError(getErrorMessage(result.error));  // 只獲取 'CredentialsSignin'
}
```

---

## 修復方案

### 1. auth.config.ts - 自定義錯誤類別

使用 `CredentialsSignin` 子類別傳遞錯誤代碼：

```typescript
import { CredentialsSignin } from 'next-auth'

class EmailNotVerifiedError extends CredentialsSignin {
  code = 'EmailNotVerified'
}

class AccountSuspendedError extends CredentialsSignin {
  code = 'AccountSuspended'
}

class AccountDisabledError extends CredentialsSignin {
  code = 'AccountDisabled'
}

// 在 authorize 函數中使用
if (!user.emailVerified) {
  throw new EmailNotVerifiedError()
}
if (user.status === 'SUSPENDED') {
  throw new AccountSuspendedError()
}
if (user.status !== 'ACTIVE') {
  throw new AccountDisabledError()
}
```

### 2. LoginForm.tsx - 錯誤代碼獲取

優先使用 `result.code`（自定義錯誤），否則使用 `result.error`（通用錯誤）：

```typescript
// ✅ 修復後代碼
if (result?.error) {
  // Auth.js v5: 自定義錯誤代碼在 result.code 中
  const errorCode = (result as { code?: string }).code || result.error
  setError(getErrorMessage(errorCode))
}
```

---

## 修改的文件

| 文件 | 變更 |
|------|------|
| `src/lib/auth.config.ts` | 新增 `EmailNotVerifiedError`, `AccountSuspendedError`, `AccountDisabledError` 類別 |
| `src/components/features/auth/LoginForm.tsx` | 修改 `onSubmit` 函數，正確獲取 `result.code` |

---

## 測試驗證

### 測試案例

| 測試 | 預期結果 | 實際結果 |
|------|----------|----------|
| 未驗證帳號登入 | 顯示「請先驗證您的電郵地址」 | ✅ 通過 |
| 顯示重新發送連結 | 顯示「重新發送驗證郵件」連結 | ✅ 通過 |
| 錯誤密碼登入 | 顯示「電郵或密碼錯誤」 | ✅ 通過 |

### 測試帳號

- Email: `uat-test-18@example.com`
- Password: `TestPass123!`

---

## 相關資源

- [Auth.js v5 Credentials Provider](https://authjs.dev/getting-started/providers/credentials)
- [GitHub Issue #11190 - Custom Error to Client](https://github.com/nextauthjs/next-auth/issues/11190)
- [UAT 測試報告](../../../5-status/testing/reports/UAT-EPIC-18-LOCAL-AUTH-2026-01-19.md)

---

## 關聯 Story

- **Epic 18**: 本地帳號認證系統
- **Story 18-2**: 本地帳號登入

---

**修復者**: Claude AI Assistant
**審核者**: -
