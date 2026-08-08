/**
 * @fileoverview FIX-176 郵件選項封閉性回歸測試
 * @description
 *   `nodemailer` 停在 8.0.11 且無安全版本可用（advisory 涵蓋 `<=9.0.0`，而
 *   `next-auth` / `@auth/core` 的 peer 範圍不接受 9.x）。該 advisory（CVSS 7.1）
 *   的觸發條件是 **message-level `raw` 選項**繞過 `disableFileAccess` /
 *   `disableUrlAccess`，導致任意檔案讀取與 SSRF。
 *
 *   本專案不受影響的**唯一**理由是 `sendEmail()` 只轉傳五個固定欄位，呼叫端
 *   無法把 `raw` 送進 `sendMail()`。這個前提沒有任何執行期防護 —— 一旦有人把
 *   `SendEmailOptions` 改成透傳 nodemailer 選項，漏洞就從「打不到」變成
 *   「可觸發」，而且不會有警報。
 *
 *   本檔即為該前提的回歸保護：若日後 `sendEmail()` 開始轉傳額外欄位，測試會失敗。
 *
 *   解除條件：`next-auth` 放寬 peer 範圍、專案升到 nodemailer 9.x 之後，
 *   本檔連同 `src/lib/email.ts` 檔頭的限制說明可一併移除。
 *
 * @module tests/unit/lib/email-options-allowlist.test
 * @since FIX-176
 * @lastModified 2026-08-08
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSendMail = vi.fn().mockResolvedValue(undefined)

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: mockSendMail })),
  },
}))

/** `sendEmail()` 允許轉傳給 nodemailer 的完整欄位集合 */
const ALLOWED_KEYS = ['from', 'html', 'subject', 'text', 'to']

/** advisory 直接點名、以及同類會擴大攻擊面的選項 */
const FORBIDDEN_KEYS = ['raw', 'attachments', 'envelope', 'dkim', 'encoding']

describe('sendEmail 的 mailOptions 必須維持封閉（FIX-176）', () => {
  beforeEach(() => {
    mockSendMail.mockClear()
    // 確保不會走進「開發環境且未配置 SMTP」的 early return 分支
    process.env.SMTP_HOST = 'smtp.test.invalid'
  })

  it('只把五個既定欄位轉傳給 nodemailer', async () => {
    const { sendEmail } = await import('@/lib/email')

    await sendEmail({
      to: 'user@example.com',
      subject: '驗證您的帳號',
      html: '<p>請點擊連結</p>',
      text: '請點擊連結',
    })

    expect(mockSendMail).toHaveBeenCalledTimes(1)
    const passed = mockSendMail.mock.calls[0][0] as Record<string, unknown>
    expect(Object.keys(passed).sort()).toEqual(ALLOWED_KEYS)
  })

  it.each(FORBIDDEN_KEYS)(
    '呼叫端夾帶的 `%s` 不會被轉傳給 nodemailer',
    async (forbiddenKey) => {
      const { sendEmail } = await import('@/lib/email')

      // 以 as 繞過型別，模擬「日後有人放寬介面」或呼叫端硬塞欄位的情境。
      // 這是本檔的核心：型別擋得住編譯期，擋不住執行期的物件展開。
      await sendEmail({
        to: 'user@example.com',
        subject: '驗證您的帳號',
        html: '<p>請點擊連結</p>',
        [forbiddenKey]: 'attacker-controlled-value',
      } as unknown as Parameters<typeof sendEmail>[0])

      expect(mockSendMail).toHaveBeenCalledTimes(1)
      const passed = mockSendMail.mock.calls[0][0] as Record<string, unknown>
      expect(passed).not.toHaveProperty(forbiddenKey)
      expect(Object.keys(passed).sort()).toEqual(ALLOWED_KEYS)
    }
  )

  it('未提供 text 時仍不會多出其他欄位', async () => {
    const { sendEmail } = await import('@/lib/email')

    await sendEmail({
      to: 'user@example.com',
      subject: '密碼重設',
      html: '<p>重設連結</p>',
    })

    const passed = mockSendMail.mock.calls[0][0] as Record<string, unknown>
    // text 為 undefined 但 key 仍存在，屬預期；重點是不得出現 ALLOWED_KEYS 以外的 key
    expect(Object.keys(passed).sort()).toEqual(ALLOWED_KEYS)
    expect(passed.text).toBeUndefined()
  })
})
