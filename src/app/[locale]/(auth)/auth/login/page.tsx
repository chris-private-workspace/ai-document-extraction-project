/**
 * @fileoverview 登入頁面
 * @description
 *   提供 Azure AD SSO 和本地帳號雙重登入入口。
 *
 *   登入選項：
 *   - Microsoft 企業帳號登入（Azure AD SSO）
 *   - 本地帳號登入（電子郵件 + 密碼）
 *
 *   功能特點：
 *   - 自動重定向已登入用戶
 *   - 保留原始請求路徑（callbackUrl）
 *   - 開發模式支援簡化登入
 *   - i18n 多語言支援
 *
 * @module src/app/[locale]/(auth)/auth/login/page
 * @author Development Team
 * @since Epic 1 - Story 1.1 (Azure AD SSO Login)
 * @lastModified 2026-01-19
 *
 * @features
 *   - Azure AD SSO 登入
 *   - 本地帳號登入 (Story 18-2)
 *   - 回調 URL 支援
 *   - 錯誤訊息顯示
 *   - 響應式設計
 *
 * @related
 *   - src/lib/auth.ts - NextAuth 配置
 *   - src/lib/auth.config.ts - Edge 認證配置
 *   - src/components/features/auth/LoginForm.tsx - 本地登入表單
 *   - src/app/(auth)/auth/error/page.tsx - 錯誤頁面
 */

import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { auth, signIn } from '@/lib/auth'
import { LoginForm } from '@/components/features/auth/LoginForm'
import { DevLoginForm } from '@/components/features/auth/DevLoginForm'
import { Separator } from '@/components/ui/separator'
import { toSafeRedirect } from '@/lib/safe-redirect'

/**
 * 檢查 Azure AD 是否已正確配置
 */
function isAzureADConfigured(): boolean {
  const clientId = process.env.AZURE_AD_CLIENT_ID
  const clientSecret = process.env.AZURE_AD_CLIENT_SECRET
  const tenantId = process.env.AZURE_AD_TENANT_ID

  if (!clientId || !clientSecret || !tenantId) return false
  if (clientId.startsWith('your-') || clientId === 'placeholder') return false
  if (clientSecret.startsWith('your-') || clientSecret === 'placeholder') return false
  if (tenantId.startsWith('your-') || tenantId === 'placeholder') return false

  return true
}

interface LoginPageProps {
  searchParams: Promise<{
    callbackUrl?: string
    error?: string
  }>
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const t = await getTranslations('auth')
  const session = await auth()
  const { callbackUrl, error } = await searchParams

  // FIX-171 / BUG-2：callbackUrl 來自查詢參數，屬使用者可控輸入。
  // 未驗證即轉址會構成 open redirect（真實登入頁 + 外部落點 = 釣魚）。
  // 此處為唯一的不可信入口，收口在此，下游一律使用 safeCallbackUrl。
  const safeCallbackUrl = toSafeRedirect(callbackUrl)

  // 已登入用戶重定向至儀表板或回調 URL
  // FIX-171：取用 `session?.user` 而非裸物件 —— 配置錯誤時 auth() 會回傳帶 error 的
  // 物件，裸檢查會把未認證者導向 dashboard，再被 middleware 導回本頁，形成無限重定向
  // （本機以 beta.30 實測重現，升級 beta.32 後消失）。
  if (session?.user) {
    redirect(safeCallbackUrl)
  }

  const errorMessage = error ? t(`errors.${error}`) ?? t('errors.Default') : null
  const azureConfigured = isAzureADConfigured()
  const isDevelopment = process.env.NODE_ENV === 'development'

  // 開發模式且 Azure AD 未配置：顯示簡化的開發登入
  const showDevMode = isDevelopment && !azureConfigured

  return (
    <>
      {/* Logo 和標題 */}
      <div className="text-center">
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

      {/* 錯誤訊息 */}
      {errorMessage && (
        <div className="rounded-md bg-red-50 dark:bg-red-900/20 p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg
                className="h-5 w-5 text-red-400"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div className="ml-3">
              <p className="text-sm font-medium text-red-800 dark:text-red-200">
                {errorMessage}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 登入表單 */}
      <div className="bg-white dark:bg-gray-800 py-8 px-4 shadow-lg sm:rounded-lg sm:px-10">
        {/* 開發模式登入 */}
        {showDevMode ? (
          <DevLoginForm callbackUrl={safeCallbackUrl} />
        ) : (
          <>
            {/* Azure AD 登入 */}
            {azureConfigured && (
              <>
                <form
                  action={async () => {
                    'use server'
                    await signIn('microsoft-entra-id', {
                      redirectTo: safeCallbackUrl,
                    })
                  }}
                >
                  <button
                    type="submit"
                    className="w-full flex justify-center items-center gap-3 py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                  >
                    <svg className="h-5 w-5" viewBox="0 0 21 21" fill="currentColor">
                      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                    </svg>
                    {t('login.microsoftLogin')}
                  </button>
                </form>

                {/* 分隔線 */}
                <div className="my-6 relative">
                  <Separator />
                  <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-gray-800 px-3 text-sm text-gray-500 dark:text-gray-400">
                    {t('login.orDivider')}
                  </span>
                </div>
              </>
            )}

            {/* 本地帳號登入表單 */}
            <LoginForm callbackUrl={safeCallbackUrl} />
          </>
        )}
      </div>

      {/* 頁腳資訊 */}
      <p className="text-center text-xs text-gray-500 dark:text-gray-400 whitespace-pre-line">
        {showDevMode
          ? t('login.devMode.footer')
          : azureConfigured
          ? t('login.productionFooter')
          : t('login.localAccountFooter')}
      </p>
    </>
  )
}
