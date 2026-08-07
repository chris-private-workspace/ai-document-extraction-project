'use client'

/**
 * @fileoverview 本地帳號登入表單組件
 * @description
 *   提供電子郵件和密碼登入功能，整合 NextAuth Credentials Provider。
 *
 *   功能特點：
 *   - React Hook Form + Zod 表單驗證
 *   - 錯誤處理（帳號暫停/停用/未驗證/密碼錯誤）
 *   - 載入狀態顯示
 *   - 忘記密碼和註冊連結
 *   - i18n 多語言支援
 *
 * @module src/components/features/auth/LoginForm
 * @author Development Team
 * @since Epic 18 - Story 18.2 (Local Account Login)
 * @lastModified 2026-01-19
 *
 * @dependencies
 *   - react-hook-form - 表單狀態管理
 *   - @hookform/resolvers/zod - Zod 驗證整合
 *   - next-auth/react - signIn 函數
 *   - next-intl - 翻譯
 *
 * @related
 *   - src/lib/auth.config.ts - Credentials Provider
 *   - src/validations/auth.ts - 登入驗證 Schema
 *   - messages/{locale}/auth.json - 翻譯文件
 */

import * as React from 'react'
import { signIn } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Link } from '@/i18n/routing'
import { loginSchema, type LoginInput } from '@/validations/auth'
import { toSafeRedirect } from '@/lib/safe-redirect'

// ============================================================
// Types
// ============================================================

interface LoginFormProps {
  /** 登入成功後的回調 URL */
  callbackUrl?: string
}

// ============================================================
// Component
// ============================================================

/**
 * 本地帳號登入表單
 *
 * @component
 * @description
 *   提供電子郵件和密碼登入的表單組件。
 *   使用 NextAuth Credentials Provider 進行驗證。
 */
export function LoginForm({ callbackUrl = '/dashboard' }: LoginFormProps) {
  const t = useTranslations('auth')
  const router = useRouter()
  const searchParams = useSearchParams()
  const registered = searchParams.get('registered')
  const verified = searchParams.get('verified')

  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  })

  /**
   * 根據錯誤代碼獲取翻譯後的錯誤訊息
   */
  const getErrorMessage = React.useCallback(
    (errorCode: string): string => {
      const errorMap: Record<string, string> = {
        AccountSuspended: t('errorPage.AccountSuspended.description'),
        AccountDisabled: t('errorPage.AccountDisabled.description'),
        EmailNotVerified: t('login.error.emailNotVerified'),
        CredentialsSignin: t('errors.invalidCredentials'),
      }
      return errorMap[errorCode] || t('errors.Default')
    },
    [t]
  )

  /**
   * 處理登入表單提交
   *
   * @description
   *   Auth.js v5 的 signIn 返回值結構：
   *   - error: 錯誤類型（例如 'CredentialsSignin'）
   *   - code: 自定義錯誤代碼（例如 'EmailNotVerified'）
   *   - ok: 是否成功
   *   - status: HTTP 狀態碼
   */
  const onSubmit = async (data: LoginInput) => {
    setIsLoading(true)
    setError(null)

    try {
      const result = await signIn('credentials', {
        email: data.email,
        password: data.password,
        redirect: false,
      })

      if (result?.error) {
        // Auth.js v5: 自定義錯誤代碼在 result.code 中
        // 優先使用 code（自定義錯誤），否則使用 error（通用錯誤）
        const errorCode = (result as { code?: string }).code || result.error
        setError(getErrorMessage(errorCode))
        setIsLoading(false)
        return
      }

      // 登入成功，導航到回調 URL
      // FIX-171 / BUG-2：頁面層已收斂過，此處為轉址動作點的縱深防禦
      router.push(toSafeRedirect(callbackUrl))
      router.refresh()
    } catch {
      setError(t('errors.networkError'))
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* 註冊成功提示 */}
      {registered === 'true' && (
        <Alert className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20">
          <AlertDescription className="text-green-800 dark:text-green-200">
            {t('login.registeredSuccess')}
          </AlertDescription>
        </Alert>
      )}

      {/* 郵件驗證成功提示 */}
      {verified === 'true' && (
        <Alert className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20">
          <AlertDescription className="text-green-800 dark:text-green-200">
            {t('login.verifiedSuccess')}
          </AlertDescription>
        </Alert>
      )}

      {/* 錯誤訊息 */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}
            {/* 未驗證郵件時顯示重新發送連結 */}
            {error === t('login.error.emailNotVerified') && (
              <Link
                href="/auth/verify-email"
                className="block mt-2 text-primary hover:underline"
              >
                {t('login.error.resendVerification')}
              </Link>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* 登入表單 */}
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {/* Email 輸入 */}
        <div className="space-y-2">
          <Label htmlFor="email">{t('login.email')}</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            disabled={isLoading}
            {...register('email')}
            className={errors.email ? 'border-destructive' : ''}
          />
          {errors.email && (
            <p className="text-sm text-destructive">{errors.email.message}</p>
          )}
        </div>

        {/* 密碼輸入 */}
        <div className="space-y-2">
          <Label htmlFor="password">{t('login.password')}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            disabled={isLoading}
            {...register('password')}
            className={errors.password ? 'border-destructive' : ''}
          />
          {errors.password && (
            <p className="text-sm text-destructive">{errors.password.message}</p>
          )}
        </div>

        {/* 忘記密碼連結 */}
        <div className="flex justify-end">
          <Link
            href="/auth/forgot-password"
            className="text-sm text-primary hover:underline"
          >
            {t('login.forgotPassword')}
          </Link>
        </div>

        {/* 登入按鈕 */}
        <Button type="submit" className="w-full" disabled={isLoading}>
          {isLoading ? t('login.submitting') : t('login.submit')}
        </Button>
      </form>

      {/* 註冊連結 */}
      <p className="text-center text-sm text-muted-foreground">
        {t('login.noAccount')}{' '}
        <Link href="/auth/register" className="text-primary hover:underline">
          {t('login.register')}
        </Link>
      </p>
    </div>
  )
}
