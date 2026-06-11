/**
 * @fileoverview Next.js Middleware for i18n and authentication
 * @description
 *   結合 next-intl 語言偵測和 NextAuth 認證的中間件。
 *   處理語言路由重定向和認證保護。
 *
 *   路由處理順序：
 *   1. /api/* → API 認證閘（CHANGE-078 / WP-2）：白名單與對外 ApiKey 路徑放行，其餘要求 session
 *   2. 跳過 Next.js 內部路徑與靜態資源
 *   3. 處理 i18n 語言偵測和重定向
 *   4. 處理頁面認證保護（需登入的頁面路由）
 *
 *   路由分類：
 *   - 公開頁面：/[locale]/auth/*
 *   - 受保護頁面：/[locale]/dashboard/*、/[locale]/documents/*
 *   - 公開 API（無需認證）：/api/auth/*、/api/health、/api/docs、/api/openapi
 *   - 對外 ApiKey API（middleware 放行，由 handler 驗 ApiKey）：/api/v1/invoices、/api/v1/webhooks、/api/n8n/webhook
 *   - 受保護 API（middleware 要求 session）：其餘所有 /api/*
 *
 *   ⚠️ API 認證閘只負責「第一層：是否登入」；角色與城市範圍仍由各 route handler 驗證
 *   （Edge runtime 不查 DB，故對外 ApiKey 端點放行交由 handler）。
 *
 * @module src/middleware
 * @author Development Team
 * @since Epic 17 - Story 17.1 (i18n Infrastructure Setup)
 * @lastModified 2026-06-10 (CHANGE-078：新增 /api 統一認證閘，支援監測/強制兩階段)
 *
 * @features
 *   - Accept-Language header 語言偵測
 *   - Cookie 語言偏好持久化
 *   - 舊路徑自動重定向
 *   - 與 NextAuth 認證整合
 *
 * @dependencies
 *   - next-intl/middleware - i18n 中間件
 *   - next-auth - 認證中間件
 *
 * @related
 *   - src/i18n/config.ts - 語言配置
 *   - src/lib/auth.config.ts - Edge 認證配置
 */

import createIntlMiddleware from 'next-intl/middleware'
import NextAuth from 'next-auth'
import { NextRequest, NextResponse } from 'next/server'
import { locales, defaultLocale, type Locale } from './i18n/config'
import { authConfig } from '@/lib/auth.config'

// 建立 next-intl 中間件
const intlMiddleware = createIntlMiddleware({
  locales,
  defaultLocale,
  localePrefix: 'always',
  localeDetection: true,
})

// 建立 NextAuth 中間件
const { auth } = NextAuth(authConfig)

/**
 * 從路徑中提取 locale 和剩餘路徑
 */
function extractLocaleFromPath(pathname: string): { locale: Locale | null; restPath: string } {
  for (const loc of locales) {
    if (pathname.startsWith(`/${loc}/`) || pathname === `/${loc}`) {
      return {
        locale: loc,
        restPath: pathname.slice(`/${loc}`.length) || '/',
      }
    }
  }
  return { locale: null, restPath: pathname }
}

/**
 * 檢查路徑是否為受保護路由
 */
function isProtectedRoute(pathname: string): boolean {
  const { restPath } = extractLocaleFromPath(pathname)
  return restPath.startsWith('/dashboard') || restPath.startsWith('/documents')
}

/**
 * 檢查路徑是否為認證路由
 */
function isAuthRoute(pathname: string): boolean {
  const { restPath } = extractLocaleFromPath(pathname)
  return restPath.startsWith('/auth')
}

// ============================================================
// CHANGE-078 / WP-2：API 認證閘
// ============================================================

/**
 * 完全公開的 API 前綴（無需任何認證）
 * 來源：2026-06-10 安全審查白名單盤點（SECURITY-ASSESSMENT.md §3）
 */
const PUBLIC_API_PREFIXES = [
  '/api/auth', // NextAuth 回調 + 註冊 / 忘記密碼 / email 驗證等自助流程
  '/api/health', // 健康檢查（負載均衡器探測）
  '/api/docs', // API 文件
  '/api/openapi', // OpenAPI 規格
]

/**
 * 採對外 ApiKey 認證的 API 前綴
 * middleware 放行（Edge runtime 無法查 DB 驗 ApiKey），由各 handler 的 ApiKey middleware 驗證
 */
const APIKEY_API_PREFIXES = [
  '/api/v1/invoices', // 對外發票提交 / 查詢 API
  '/api/v1/webhooks', // 對外 webhook 發送歷史 API
  '/api/n8n/webhook', // n8n 工作流 webhook（簽章 / ApiKey）
]

/**
 * 判斷 pathname 是否命中任一前綴（精確匹配或以 `<prefix>/` 開頭）
 */
function matchesApiPrefix(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/**
 * API 認證閘（CHANGE-078 / WP-2）
 *
 * @description
 *   統一收口「所有 /api/* 的第一層登入檢查」，堵住「忘記寫 auth() 的 handler 對全網公開」的系統性風險。
 *   - 公開端點與對外 ApiKey 端點 → 直接放行
 *   - 其餘 /api/* → 要求登入 session
 *
 *   兩階段上線（由環境變數 API_AUTH_GATE_MODE 控制）：
 *   - `monitor`（預設）：未認證請求僅記錄警告後放行，用於過渡期蒐集白名單遺漏，不影響現有流量
 *   - `enforce`：未認證請求直接回 401（RFC 7807）
 *
 *   ⚠️ 角色與城市範圍不在此處理（Edge runtime 不查 DB），仍由各 handler 負責。
 */
async function handleApiAuthGate(request: NextRequest, pathname: string): Promise<NextResponse> {
  // 公開端點與對外 ApiKey 端點 → 放行
  if (
    matchesApiPrefix(pathname, PUBLIC_API_PREFIXES) ||
    matchesApiPrefix(pathname, APIKEY_API_PREFIXES)
  ) {
    return NextResponse.next()
  }

  // 其餘 /api/* → 要求登入 session
  const session = await auth()
  if (session?.user) {
    return NextResponse.next()
  }

  // 未登入：依模式決定阻擋或僅記錄
  const mode = process.env.API_AUTH_GATE_MODE === 'enforce' ? 'enforce' : 'monitor'

  if (mode === 'enforce') {
    return NextResponse.json(
      {
        type: 'https://datatracker.ietf.org/doc/html/rfc7235#section-3.1',
        title: 'Unauthorized',
        status: 401,
        detail: '需要登入才能存取此資源',
        instance: pathname,
      },
      { status: 401 }
    )
  }

  // monitor 模式：記錄但放行（過渡期蒐集白名單遺漏）
  // 註：Edge runtime 無法使用 Node logger，console.warn 為 middleware 標準做法；僅記錄方法與路徑，不含 PII
  console.warn(
    `[API-AUTH-GATE][monitor] 未認證請求（enforce 模式下將回 401）: ${request.method} ${pathname}`
  )
  return NextResponse.next()
}

/**
 * 主中間件函數
 */
export default async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // 1. API 路由 → 統一認證閘（CHANGE-078 / WP-2）
  if (pathname.startsWith('/api')) {
    return handleApiAuthGate(request, pathname)
  }

  // 2. 跳過 Next.js 內部路徑與靜態資源
  if (
    pathname.startsWith('/_next') ||
    pathname.includes('.') ||
    pathname.startsWith('/favicon')
  ) {
    return NextResponse.next()
  }

  // 3. 處理 i18n 路由
  // 檢查路徑是否已有 locale 前綴
  const { locale } = extractLocaleFromPath(pathname)

  if (!locale) {
    // 沒有 locale 前綴，需要重定向
    // 從 cookie 或 Accept-Language 取得偏好語言
    const cookieLocale = request.cookies.get('NEXT_LOCALE')?.value
    const acceptLanguage = request.headers.get('accept-language')

    let detectedLocale: Locale = defaultLocale

    if (cookieLocale && locales.includes(cookieLocale as Locale)) {
      detectedLocale = cookieLocale as Locale
    } else if (acceptLanguage) {
      // 解析 Accept-Language header
      const preferredLocales = acceptLanguage.split(',').map((lang) => lang.split(';')[0].trim())

      for (const preferred of preferredLocales) {
        // 完全匹配
        if (locales.includes(preferred as Locale)) {
          detectedLocale = preferred as Locale
          break
        }
        // 語言代碼匹配（如 zh 匹配 zh-TW）
        const langCode = preferred.split('-')[0]
        const matched = locales.find((l) => l.startsWith(langCode))
        if (matched) {
          detectedLocale = matched
          break
        }
      }
    }

    // 重定向到帶 locale 的路徑
    const redirectUrl = new URL(`/${detectedLocale}${pathname}`, request.url)
    return NextResponse.redirect(redirectUrl)
  }

  // 4. 有 locale 前綴，使用 next-intl middleware 處理
  const intlResponse = intlMiddleware(request)

  // 5. 處理頁面認證邏輯
  // 取得認證狀態
  const session = await auth()
  const isLoggedIn = !!session?.user

  // 檢查是否為受保護路由
  if (isProtectedRoute(pathname)) {
    if (!isLoggedIn) {
      // 未登入，重定向到登入頁面
      const loginUrl = new URL(`/${locale}/auth/login`, request.url)
      loginUrl.searchParams.set('callbackUrl', pathname)
      return NextResponse.redirect(loginUrl)
    }
  }

  // FIX-074: 強制首次改密 — 已登入但 mustChangePassword 者，限制只能停留改密頁（profile）
  // 改密頁本身放行（避免循環）；其餘頁面一律導向 profile。登出走 /api/auth（已於 API 閘放行）。
  if (isLoggedIn && session?.user?.mustChangePassword) {
    const { restPath } = extractLocaleFromPath(pathname)
    if (!restPath.startsWith('/profile')) {
      const profileUrl = new URL(`/${locale}/profile`, request.url)
      return NextResponse.redirect(profileUrl)
    }
  }

  // 檢查是否為認證路由（已登入用戶）
  if (isAuthRoute(pathname) && isLoggedIn) {
    // 已登入，重定向到儀表板
    const dashboardUrl = new URL(`/${locale}/dashboard`, request.url)
    return NextResponse.redirect(dashboardUrl)
  }

  // 處理根路徑 /[locale]
  const { restPath } = extractLocaleFromPath(pathname)
  if (restPath === '/') {
    if (isLoggedIn) {
      const dashboardUrl = new URL(`/${locale}/dashboard`, request.url)
      return NextResponse.redirect(dashboardUrl)
    } else {
      const loginUrl = new URL(`/${locale}/auth/login`, request.url)
      return NextResponse.redirect(loginUrl)
    }
  }

  return intlResponse
}

export const config = {
  matcher: [
    // 頁面路由：匹配所有路徑，排除 api、Next.js 內部、含副檔名的靜態資源
    '/((?!api|_next|.*\\..*).*)',
    // API 路由（CHANGE-078 / WP-2）：納入統一認證閘
    '/api/:path*',
  ],
}

