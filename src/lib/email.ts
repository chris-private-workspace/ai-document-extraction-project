/**
 * @fileoverview 郵件服務
 * @description
 *   提供郵件發送功能，包含：
 *   - SMTP 郵件傳輸配置
 *   - 驗證郵件發送
 *   - 密碼重設郵件發送
 *
 *   開發環境如未配置 SMTP，將使用 console.log 輸出郵件內容。
 *
 * 🔴 **本模組的選項必須維持封閉（FIX-176）**
 *
 *   `nodemailer` 目前停在 8.0.11 且**無安全版本可用**：其 advisory 涵蓋 `<=9.0.0`，
 *   而 `next-auth` / `@auth/core` 宣告的 peer 範圍是 `^7.0.7 || ^8.0.5`，不接受 9.x。
 *   升到 9.x 會使相依樹變成 invalid 並讓後續所有 `npm install` 以 ERESOLVE 失敗。
 *
 *   該 advisory（CVSS 7.1）的觸發條件是 **message-level `raw` 選項**繞過
 *   `disableFileAccess` / `disableUrlAccess`，導致任意檔案讀取與 SSRF。
 *   本專案之所以不受影響，唯一的理由是 `sendEmail()` 只轉傳五個固定欄位，
 *   呼叫端無法把 `raw`、`attachments` 之類的選項送進 `sendMail()`。
 *
 *   ⚠️ 因此**不可**將 `SendEmailOptions` 改為透傳 nodemailer 的選項物件，
 *   也不可新增 `raw` / `attachments` / `envelope` 等欄位 —— 那會讓一個目前
 *   打不到的漏洞變成實際可觸發，且不會有任何警報。
 *   `tests/unit/lib/email-options-allowlist.test.ts` 對此設有回歸保護。
 *
 *   解除條件：`next-auth` 放寬 peer 範圍至接受 nodemailer 9.x 後升級，屆時可移除本限制。
 *
 * @module src/lib/email
 * @author Development Team
 * @since Epic 18 - Story 18.1
 * @lastModified 2026-08-08 (FIX-176：記錄選項封閉性的安全前提)
 *
 * @dependencies
 *   - nodemailer - SMTP 郵件傳輸
 */

import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'

// 郵件傳輸器（單例）
let transporter: Transporter | null = null

/**
 * 取得郵件傳輸器
 *
 * @description
 *   返回 nodemailer 傳輸器的單例實例。
 *   開發環境如未配置 SMTP，將使用 JSON 傳輸（僅輸出到 console）。
 *
 * @returns nodemailer Transporter 實例
 */
function getTransporter(): Transporter {
  if (transporter) return transporter

  // 開發環境使用 JSON 傳輸（僅 console.log）
  if (process.env.NODE_ENV === 'development' && !process.env.SMTP_HOST) {
    console.log('[Email] Using JSON transport for development (no SMTP configured)')
    transporter = nodemailer.createTransport({
      jsonTransport: true,
    })
    return transporter
  }

  // 生產環境使用 SMTP
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  })

  return transporter
}

/**
 * 郵件發送選項
 *
 * 🔴 **這是一份 allowlist，不是「目前用得到的欄位」** —— 新增欄位前請先讀
 * 檔頭的 FIX-176 說明。擴充為透傳 nodemailer 選項會使 CVSS 7.1 的
 * `raw` 選項漏洞變成可觸發。
 */
interface SendEmailOptions {
  /** 收件人地址 */
  to: string
  /** 郵件主題 */
  subject: string
  /** HTML 格式內容 */
  html: string
  /** 純文字內容（可選） */
  text?: string
}

/**
 * 發送郵件
 *
 * @description
 *   發送電子郵件。開發環境如未配置 SMTP，將輸出到 console。
 *
 * @param options - 郵件發送選項
 *
 * @example
 * ```typescript
 * await sendEmail({
 *   to: 'user@example.com',
 *   subject: '歡迎加入',
 *   html: '<p>歡迎！</p>',
 * });
 * ```
 */
export async function sendEmail(options: SendEmailOptions): Promise<void> {
  const transport = getTransporter()

  const mailOptions = {
    from: process.env.SMTP_FROM || 'noreply@example.com',
    to: options.to,
    subject: options.subject,
    html: options.html,
    text: options.text,
    // ⚠️ 不可加入 `...options` 之類的展開 —— 見檔頭 FIX-176 說明。
    // 那會讓呼叫端得以傳入 `raw`，使 CVSS 7.1 的 nodemailer 漏洞變成可觸發。
  }

  // 開發環境僅 console.log
  if (process.env.NODE_ENV === 'development' && !process.env.SMTP_HOST) {
    console.log('[Email] Development mode - Email would be sent:', {
      to: options.to,
      subject: options.subject,
    })
    return
  }

  await transport.sendMail(mailOptions)
}

/**
 * 發送驗證郵件
 *
 * @description
 *   發送帳號驗證郵件，包含驗證連結。
 *   連結有效期為 24 小時。
 *
 * @param email - 收件人電子郵件
 * @param name - 用戶名稱（用於個性化郵件）
 * @param token - 驗證 Token
 *
 * @example
 * ```typescript
 * await sendVerificationEmail('user@example.com', 'John', 'abc123token');
 * ```
 */
export async function sendVerificationEmail(
  email: string,
  name: string | null,
  token: string,
  locale: string = 'en'
): Promise<void> {
  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000'
  // 驗證連結經過 API 端點，包含 locale 以便重導向時使用正確的語言
  const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${token}&locale=${locale}`

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .header h1 { margin: 0; font-size: 24px; }
    .content { background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; }
    .button { display: inline-block; background: #3B82F6; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 20px 0; }
    .button:hover { background: #2563EB; }
    .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 12px; }
    .warning { background: #FEF3C7; border: 1px solid #F59E0B; border-radius: 6px; padding: 12px; margin-top: 20px; font-size: 14px; }
    .link-box { background: #f3f4f6; padding: 12px; border-radius: 4px; word-break: break-all; font-size: 12px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>AI Document Extraction</h1>
    </div>
    <div class="content">
      <h2>歡迎加入，${name || 'User'}！</h2>
      <p>感謝您註冊 AI Document Extraction 系統。</p>
      <p>請點擊以下按鈕驗證您的電子郵件地址：</p>
      <div style="text-align: center;">
        <a href="${verifyUrl}" class="button" style="color: white;">驗證電子郵件</a>
      </div>
      <p style="color: #6b7280; font-size: 14px;">
        或者複製以下連結到瀏覽器：
      </p>
      <div class="link-box">
        <code>${verifyUrl}</code>
      </div>
      <div class="warning">
        <strong>⚠️ 注意：</strong>此連結將在 24 小時後失效。
      </div>
      <p style="color: #9ca3af; font-size: 12px; margin-top: 30px;">
        如果您沒有註冊此帳號，請忽略此郵件。
      </p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} AI Document Extraction. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
  `

  const text = `
歡迎加入，${name || 'User'}！

感謝您註冊 AI Document Extraction 系統。

請點擊以下連結驗證您的電子郵件地址：
${verifyUrl}

此連結將在 24 小時後失效。

如果您沒有註冊此帳號，請忽略此郵件。

---
© ${new Date().getFullYear()} AI Document Extraction. All rights reserved.
  `

  await sendEmail({
    to: email,
    subject: '[AI Document Extraction] 請驗證您的電子郵件',
    html,
    text,
  })
}

/**
 * 發送密碼重設郵件
 *
 * @description
 *   發送密碼重設郵件，包含重設連結。
 *   連結有效期為 1 小時。
 *   此功能為 Story 18-3 預留。
 *
 * @param email - 收件人電子郵件
 * @param name - 用戶名稱
 * @param token - 重設 Token
 */
export async function sendPasswordResetEmail(
  email: string,
  name: string | null,
  token: string
): Promise<void> {
  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000'
  const resetUrl = `${baseUrl}/auth/reset-password?token=${token}`

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .header h1 { margin: 0; font-size: 24px; }
    .content { background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; }
    .button { display: inline-block; background: #3B82F6; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 20px 0; }
    .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 12px; }
    .warning { background: #FEF3C7; border: 1px solid #F59E0B; border-radius: 6px; padding: 12px; margin-top: 20px; font-size: 14px; }
    .link-box { background: #f3f4f6; padding: 12px; border-radius: 4px; word-break: break-all; font-size: 12px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>AI Document Extraction</h1>
    </div>
    <div class="content">
      <h2>密碼重設請求</h2>
      <p>您好，${name || 'User'}！</p>
      <p>我們收到了您的密碼重設請求。請點擊以下按鈕重設您的密碼：</p>
      <div style="text-align: center;">
        <a href="${resetUrl}" class="button" style="color: white;">重設密碼</a>
      </div>
      <p style="color: #6b7280; font-size: 14px;">
        或者複製以下連結到瀏覽器：
      </p>
      <div class="link-box">
        <code>${resetUrl}</code>
      </div>
      <div class="warning">
        <strong>⚠️ 注意：</strong>此連結將在 1 小時後失效。
      </div>
      <p style="color: #9ca3af; font-size: 12px; margin-top: 30px;">
        如果您沒有請求重設密碼，請忽略此郵件。您的帳號是安全的。
      </p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} AI Document Extraction. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
  `

  const text = `
密碼重設請求

您好，${name || 'User'}！

我們收到了您的密碼重設請求。請點擊以下連結重設您的密碼：
${resetUrl}

此連結將在 1 小時後失效。

如果您沒有請求重設密碼，請忽略此郵件。您的帳號是安全的。

---
© ${new Date().getFullYear()} AI Document Extraction. All rights reserved.
  `

  await sendEmail({
    to: email,
    subject: '[AI Document Extraction] 密碼重設請求',
    html,
    text,
  })
}

/**
 * 發送密碼變更通知郵件
 *
 * @description
 *   發送密碼已變更的通知郵件，讓用戶知道密碼已被更改。
 *   此為安全功能，當密碼被重設時通知用戶。
 *
 * @param email - 收件人電子郵件
 * @param name - 用戶名稱
 */
export async function sendPasswordChangedEmail(
  email: string,
  name: string | null
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .header h1 { margin: 0; font-size: 24px; }
    .content { background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; }
    .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 12px; }
    .alert { background: #FEE2E2; border: 1px solid #EF4444; border-radius: 6px; padding: 16px; margin-top: 20px; }
    .alert-icon { color: #EF4444; font-size: 24px; margin-bottom: 8px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>AI Document Extraction</h1>
    </div>
    <div class="content">
      <h2>密碼已變更</h2>
      <p>您好，${name || 'User'}！</p>
      <p>您的帳號密碼已成功變更。</p>
      <p>如果這是您本人的操作，您可以忽略此郵件。</p>
      <div class="alert">
        <div class="alert-icon">⚠️</div>
        <strong>重要提醒：</strong>如果您沒有進行此操作，請立即聯繫系統管理員，您的帳號可能已被未經授權的人員存取。
      </div>
      <p style="color: #6b7280; font-size: 14px; margin-top: 30px;">
        變更時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}
      </p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} AI Document Extraction. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
  `

  const text = `
密碼已變更

您好，${name || 'User'}！

您的帳號密碼已成功變更。

如果這是您本人的操作，您可以忽略此郵件。

⚠️ 重要提醒：如果您沒有進行此操作，請立即聯繫系統管理員，您的帳號可能已被未經授權的人員存取。

變更時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}

---
© ${new Date().getFullYear()} AI Document Extraction. All rights reserved.
  `

  await sendEmail({
    to: email,
    subject: '[AI Document Extraction] 您的密碼已變更',
    html,
    text,
  })
}
