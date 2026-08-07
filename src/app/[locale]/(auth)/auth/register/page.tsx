/**
 * @fileoverview 用戶註冊頁面
 * @description
 *   提供新用戶註冊功能，使用本地電子郵件和密碼建立帳號。
 *
 *   功能特點：
 *   - 本地帳號註冊表單
 *   - 即時表單驗證
 *   - 密碼強度指示器
 *   - 郵件驗證 Token 產生
 *   - 驗證郵件發送
 *
 * @module src/app/[locale]/(auth)/auth/register/page
 * @author Development Team
 * @since Epic 18 - Story 18.1
 * @lastModified 2026-01-19
 *
 * @features
 *   - 本地帳號註冊
 *   - 密碼安全要求驗證
 *   - 電子郵件唯一性檢查
 *   - 國際化支援
 *
 * @related
 *   - src/components/features/auth/RegisterForm.tsx - 註冊表單組件
 *   - src/app/api/auth/register/route.ts - 註冊 API 端點
 *   - src/lib/password.ts - 密碼工具
 */

import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { auth } from '@/lib/auth'
import { RegisterForm } from '@/components/features/auth/RegisterForm'
import { toSafeRedirect } from '@/lib/safe-redirect'

// ============================================================
// Types
// ============================================================

interface RegisterPageProps {
  params: Promise<{ locale: string }>
  searchParams: Promise<{
    callbackUrl?: string
  }>
}

// ============================================================
// Metadata
// ============================================================

export async function generateMetadata({ params }: RegisterPageProps) {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'auth' })

  return {
    title: t('register.title'),
    description: t('register.description'),
  }
}

// ============================================================
// Page Component
// ============================================================

export default async function RegisterPage({
  params,
  searchParams,
}: RegisterPageProps) {
  const [{ locale }, { callbackUrl }] = await Promise.all([params, searchParams])
  const t = await getTranslations({ locale, namespace: 'auth' })
  const session = await auth()

  // FIX-170 / BUG-2：callbackUrl 屬使用者可控輸入，需先收斂為站內路徑
  const safeCallbackUrl = toSafeRedirect(callbackUrl)

  // 已登入用戶重定向至儀表板
  // FIX-170：取用 `session?.user` 而非裸物件，理由同登入頁
  if (session?.user) {
    redirect(safeCallbackUrl)
  }

  return (
    <>
      {/* Logo 和標題 */}
      <div className="text-center mb-6">
        <div className="mx-auto h-16 w-16 bg-blue-600 rounded-xl flex items-center justify-center mb-4">
          <svg
            className="h-10 w-10 text-white"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
        </div>
        <h2 className="text-3xl font-bold text-gray-900 dark:text-white">
          AI Document Extraction
        </h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          {t('login.description')}
        </p>
      </div>

      {/* 註冊表單 */}
      <RegisterForm callbackUrl={safeCallbackUrl} />
    </>
  )
}
