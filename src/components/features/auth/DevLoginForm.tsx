'use client'

/**
 * @fileoverview 開發模式登錄表單組件
 * @description
 *   使用客戶端 signIn 進行登錄，確保 SessionProvider 正確同步。
 *   解決 Server Action 登錄後 session 不同步的問題。
 *
 * @module src/components/features/auth/DevLoginForm
 * @since Epic 1 - Story 1.1
 * @lastModified 2026-01-18
 */

import * as React from 'react'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toSafeRedirect } from '@/lib/safe-redirect'

interface DevLoginFormProps {
  callbackUrl?: string
}

export function DevLoginForm({ callbackUrl }: DevLoginFormProps) {
  const t = useTranslations('auth')
  const router = useRouter()
  const [email, setEmail] = React.useState('admin@example.com')
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)

    try {
      const result = await signIn('credentials', {
        email,
        password: 'dev',
        redirect: false, // 不自動重定向，我們手動處理
      })

      if (result?.error) {
        setError(result.error)
        setIsLoading(false)
        return
      }

      // 登錄成功，使用 router.push 進行導航
      // 這會觸發 SessionProvider 刷新
      // FIX-170 / BUG-2：頁面層已收斂過，此處為轉址動作點的縱深防禦
      router.push(toSafeRedirect(callbackUrl))
      router.refresh() // 強制刷新頁面數據
    } catch (err) {
      setError('登錄失敗，請重試')
      setIsLoading(false)
    }
  }

  return (
    <>
      {/* 開發模式提示 */}
      <div className="mb-4 rounded-md bg-yellow-50 dark:bg-yellow-900/20 p-3">
        <p className="text-sm text-yellow-800 dark:text-yellow-200">
          {t('login.devMode.notice')}
        </p>
      </div>

      {/* 錯誤訊息 */}
      {error && (
        <div className="mb-4 rounded-md bg-red-50 dark:bg-red-900/20 p-3">
          <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="space-y-4">
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isLoading}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-gray-700 dark:text-white disabled:opacity-50"
              placeholder="test@example.com"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? '登錄中...' : t('login.devMode.loginButton')}
          </button>
        </div>
      </form>

      <div className="mt-6">
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-gray-300 dark:border-gray-600" />
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="px-2 bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400">
              {t('login.devMode.environment')}
            </span>
          </div>
        </div>
      </div>
    </>
  )
}
