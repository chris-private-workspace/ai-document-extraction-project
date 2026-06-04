'use client'

/**
 * @fileoverview 客戶端 Session 守衛組件
 * @description
 *   監聽 NextAuth session 狀態，當 session 在頁面開啟期間「確實」過期時，
 *   自動將用戶導向登入頁，並以 callbackUrl 保留當前路徑，登入後可返回原頁。
 *
 *   解決問題（FIX-061）：
 *   - Middleware 與 dashboard layout 僅在導航 / SSR 時檢查 session，
 *     頁面開啟後閒置過期不會導回，導致 React Query 背景刷新持續 401。
 *   - 本守衛補上「頁面執行期」的客戶端防護，掛載於 dashboard 佈局，
 *     覆蓋所有 (dashboard) 頁面。
 *
 *   防誤判設計（FIX-061 修訂，2026-06-04）：
 *   - next-auth v5 (beta) 的 useSession 可能在輪詢 / 視窗聚焦重新驗證 /
 *     開發模式 HMR 重編譯時，因單次 session 請求短暫失敗而「瞬間」回報
 *     unauthenticated，但伺服器 session 其實仍有效（實測 /api/auth/session
 *     全程回傳有效 session，卻仍會被導走）。
 *   - 因此偵測到 unauthenticated 後，先延遲一小段時間讓瞬間狀態自行恢復，
 *     再以權威的 getSession() 二次確認；確認真的取不到 session 才導向。
 *
 * @module src/components/layout/SessionGuard
 * @author Development Team
 * @since FIX-061 - Session 過期導向修復
 * @lastModified 2026-06-04
 *
 * @dependencies
 *   - next-auth/react - useSession / getSession
 *   - @/i18n/routing - locale-aware useRouter
 *
 * @related
 *   - src/components/layout/DashboardLayout.tsx - 掛載位置
 *   - src/providers/AuthProvider.tsx - SessionProvider（refetchInterval）
 *   - claudedocs/4-changes/bug-fixes/FIX-061-session-expiry-no-redirect-401-flood.md
 */

import * as React from 'react'
import { useSession, getSession } from 'next-auth/react'
import { useRouter } from '@/i18n/routing'

// ============================================================
// Constants
// ============================================================

/** 偵測到 unauthenticated 後，延遲二次確認的毫秒數（讓瞬間誤判自行恢復） */
const REVERIFY_DELAY_MS = 1500

// ============================================================
// Component
// ============================================================

/**
 * @component SessionGuard
 * @description
 *   無可見 UI 的行為守衛。當 session「確實」失效時導向登入頁。
 *   初次載入的 'loading' 狀態不觸發；瞬間的 'unauthenticated' 經二次確認後忽略。
 */
export function SessionGuard() {
  const { status } = useSession()
  const router = useRouter()

  React.useEffect(() => {
    if (status !== 'unauthenticated') {
      return
    }

    let cancelled = false

    // 延遲後再二次確認：若狀態在延遲內恢復為 authenticated，effect 會重跑並由
    // cleanup 取消此計時器，避免瞬間誤判造成的錯誤導向。
    const timer = setTimeout(async () => {
      if (cancelled) return

      let session
      try {
        session = await getSession()
      } catch {
        // getSession 失敗（網路問題 / 開發模式重編譯）不視為登出，避免誤導向
        return
      }

      // 仍有有效 session → 屬瞬間誤判，忽略
      if (cancelled || session) return

      // 確認 session 真的失效：導向登入頁，保留當前完整路徑（含 locale 前綴）為 callbackUrl。
      // LoginForm 使用 next/navigation 的 router.push(callbackUrl)，需完整路徑才能保留 locale。
      const callbackUrl = window.location.pathname + window.location.search
      router.replace({
        pathname: '/auth/login',
        query: { callbackUrl },
      })
    }, REVERIFY_DELAY_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [status, router])

  return null
}
