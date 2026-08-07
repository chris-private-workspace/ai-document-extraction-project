/**
 * @fileoverview NextAuth v5 Edge-compatible 認證配置
 * @description
 *   本模組提供 Edge Runtime 兼容的認證配置，專門用於 Next.js Middleware。
 *   此配置不包含任何資料庫存取，以確保在 Edge Runtime 中正常運作。
 *
 *   Edge Runtime 限制：
 *   - 不支援 Node.js crypto 模組
 *   - 不支援 Prisma/pg 等資料庫驅動
 *   - 只能使用 Web APIs
 *
 *   設計考量：
 *   - 分離 Edge-compatible 配置和完整配置
 *   - Middleware 使用此配置進行基本認證檢查
 *   - API Routes 和 Server Components 使用完整配置
 *   - 支援本地帳號登入（Credentials 提供者）
 *   - 支援 Azure AD SSO 登入
 *
 * @module src/lib/auth.config
 * @author Development Team
 * @since Epic 1 - Story 1.1 (Azure AD SSO Login)
 * @lastModified 2026-01-19
 *
 * @features
 *   - Edge Runtime 兼容
 *   - Azure AD (Entra ID) 提供者配置
 *   - 本地帳號 Credentials 提供者（密碼驗證）
 *   - JWT session 策略
 *   - 基本頁面配置
 *   - 帳號狀態檢查（ACTIVE/SUSPENDED/DISABLED）
 *   - 郵件驗證狀態檢查
 *
 * @related
 *   - src/lib/auth.ts - 完整認證配置（含資料庫）
 *   - src/middleware.ts - 使用此配置的中間件
 *   - src/lib/password.ts - 密碼驗證工具
 */

import type { NextAuthConfig } from 'next-auth'
import type { Provider } from 'next-auth/providers'
import Credentials from 'next-auth/providers/credentials'
import { CredentialsSignin } from 'next-auth'
import { edgeLogger } from '@/lib/edge-logger'

// ============================================================
// Custom Auth Errors
// ============================================================

/**
 * 自定義認證錯誤類別
 * 用於向客戶端傳遞特定的錯誤代碼
 */
class EmailNotVerifiedError extends CredentialsSignin {
  code = 'EmailNotVerified'
}

class AccountSuspendedError extends CredentialsSignin {
  code = 'AccountSuspended'
}

class AccountDisabledError extends CredentialsSignin {
  code = 'AccountDisabled'
}

/**
 * 帳號因連續登入失敗被鎖定（FIX-171 / BUG-7）
 *
 * @description
 *   ⚠️ 拋出此錯誤等同向請求方確認「該帳號存在」，與上方 `Credential check failed`
 *   刻意合併帳號不存在/密碼錯誤的做法方向相反。這是帳號鎖定機制的固有取捨：
 *   要讓合法使用者知道自己為何登不進去，就無法對攻擊者隱藏。DoD #14 明確要求
 *   鎖定機制，故接受此取捨。
 */
class AccountLockedError extends CredentialsSignin {
  code = 'AccountLocked'
}

/**
 * Session 最大存活時間（秒）
 * 8 小時 = 8 * 60 * 60 = 28800 秒
 */
const SESSION_MAX_AGE = 8 * 60 * 60

/**
 * 連續密碼錯誤達此次數即鎖定帳號（FIX-171 / BUG-7）
 *
 * @description
 *   DoD #14 建議 3–5 次。使用者於 2026-08-07 選 5 —— 因為解鎖方式是「管理員手動」、
 *   無自動到期，誤鎖的代價是使用者必須找到管理員才能回來，故取範圍上限以降低誤鎖率。
 */
const MAX_FAILED_LOGIN_ATTEMPTS = 5

/**
 * 手動解鎖模式的鎖定期限哨兵值（FIX-171 / BUG-7）
 *
 * @description
 *   使用者選擇「管理員手動解鎖」，沒有自動到期，故寫入一個遠期時間表示
 *   「鎖定直到管理員介入」。判斷邏輯統一為 `lockedUntil > now`，
 *   未來若要改採時間解鎖，只需改寫入的值，判斷式不必動。
 */
const MANUAL_UNLOCK_SENTINEL = new Date('9999-12-31T23:59:59.000Z')

/**
 * 檢查 Azure AD 環境變數是否已正確配置
 */
function isAzureADConfigured(): boolean {
  const clientId = process.env.AZURE_AD_CLIENT_ID
  const clientSecret = process.env.AZURE_AD_CLIENT_SECRET
  const tenantId = process.env.AZURE_AD_TENANT_ID

  // 檢查是否為模擬值
  if (!clientId || !clientSecret || !tenantId) return false

  // 常見的模擬值前綴
  const mockPrefixes = ['your-', 'test-', 'placeholder', 'mock-', 'fake-', 'dummy-']
  const isMockValue = (value: string) =>
    mockPrefixes.some(prefix => value.toLowerCase().startsWith(prefix))

  if (isMockValue(clientId)) return false
  if (isMockValue(clientSecret)) return false
  if (isMockValue(tenantId)) return false

  return true
}

/**
 * 構建認證提供者列表
 * 根據環境配置選擇適當的提供者
 *
 * @description
 *   Story 18-2: 支援本地帳號登入
 *   - 本地帳號使用 Credentials 提供者進行密碼驗證
 *   - 動態導入 Prisma 和密碼工具以保持 Edge-compatible
 *   - 檢查帳號狀態和郵件驗證狀態
 */
function buildProviders(): Provider[] {
  const providers: Provider[] = []

  // 本地帳號 Credentials 提供者 - 始終啟用
  // authorize 函數只在 API Routes 中執行，不影響 Edge Runtime
  providers.push(
    Credentials({
      id: 'credentials',
      name: 'Email Login',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        try {
          // 驗證輸入
          if (!credentials?.email || !credentials?.password) {
            edgeLogger.info('[Auth] Missing email or password')
            return null
          }

          const email = (credentials.email as string).toLowerCase().trim()
          const password = credentials.password as string

          // 開發模式：如果 Azure AD 未配置，使用簡化驗證
          const isDevelopmentMode = process.env.NODE_ENV === 'development' && !isAzureADConfigured()
          edgeLogger.debug('[Auth] Auth mode resolved', {
            isDevelopmentMode,
            nodeEnv: process.env.NODE_ENV,
          })

          if (isDevelopmentMode) {
            // 開發模式下接受任何有效的 email 格式
            if (email.includes('@')) {
              // PII 保護: email 僅於 debug 級別輸出（生產環境預設不顯示）
              edgeLogger.debug('[Auth] Development mode login', { email })
              return {
                id: 'dev-user-1',
                email: email,
                name: email.split('@')[0],
                image: null,
              }
            }
            return null
          }

          // 生產模式：真正的帳號密碼驗證
          edgeLogger.info('[Auth] Production mode - verifying credentials')

          // 動態導入以保持 Edge-compatible
          const { prisma } = await import('@/lib/prisma')
          const { verifyPassword } = await import('@/lib/password')

          // 查詢用戶
          const user = await prisma.user.findUnique({
            where: { email },
            select: {
              id: true,
              email: true,
              name: true,
              image: true,
              password: true,
              status: true,
              emailVerified: true,
              failedLoginAttempts: true,
              lockedUntil: true,
            },
          })

          // 用戶不存在或密碼無效（合併兩個分支以緩解帳號列舉攻擊）
          // 注意：下方的密碼驗證只在 user 存在時執行，故此處合併後的訊息
          // 在外觀上無法區分「帳號不存在」vs「密碼錯誤」
          if (!user || !user.password) {
            edgeLogger.info('[Auth] Credential check failed')
            edgeLogger.debug('[Auth] Failure detail', {
              email,
              reason: !user ? 'USER_NOT_FOUND' : 'NO_PASSWORD',
            })
            return null
          }

          // FIX-171 / BUG-7：鎖定檢查置於密碼驗證之前 —— 已鎖定的帳號不必再消耗
          // bcrypt 運算，也避免出現「密碼其實猜對了但帳號鎖著」這種需額外處理的狀態
          if (user.lockedUntil && user.lockedUntil > new Date()) {
            edgeLogger.info('[Auth] Login blocked: account locked', { userId: user.id })
            throw new AccountLockedError()
          }

          // 驗證密碼
          const isValidPassword = await verifyPassword(password, user.password)
          if (!isValidPassword) {
            // FIX-171 / BUG-7：累加失敗次數，達閾值即鎖定
            const attempts = user.failedLoginAttempts + 1
            const shouldLock = attempts >= MAX_FAILED_LOGIN_ATTEMPTS

            await prisma.user.update({
              where: { id: user.id },
              data: {
                failedLoginAttempts: attempts,
                ...(shouldLock ? { lockedUntil: MANUAL_UNLOCK_SENTINEL } : {}),
              },
            })

            edgeLogger.info('[Auth] Credential check failed')
            edgeLogger.debug('[Auth] Failure detail', {
              email,
              reason: 'INVALID_PASSWORD',
              attempts,
              locked: shouldLock,
            })

            if (shouldLock) {
              // userId 非 PII，可於 info 級別記錄；管理員需靠這行得知有帳號被鎖
              edgeLogger.info('[Auth] Account locked after repeated failures', {
                userId: user.id,
                attempts,
              })
              throw new AccountLockedError()
            }
            return null
          }

          // FIX-171 / BUG-7：密碼正確即歸零計數 —— 密碼對了就不是暴力破解。
          // 置於狀態與郵件驗證檢查之前：那兩者失敗與密碼猜測無關，不該留下失敗計數，
          // 否則被停權的使用者重試幾次就會再被鎖一層，解鎖時徒增困惑。
          if (user.failedLoginAttempts > 0) {
            await prisma.user.update({
              where: { id: user.id },
              data: { failedLoginAttempts: 0 },
            })
          }

          // 檢查帳號狀態
          if (user.status !== 'ACTIVE') {
            edgeLogger.info('[Auth] User status not ACTIVE', {
              userId: user.id,
              status: user.status,
            })
            // 使用自定義錯誤類別，以便前端顯示正確訊息
            if (user.status === 'SUSPENDED') {
              throw new AccountSuspendedError()
            } else {
              throw new AccountDisabledError()
            }
          }

          // 檢查郵件驗證狀態
          if (!user.emailVerified) {
            edgeLogger.info('[Auth] Email not verified', { userId: user.id })
            throw new EmailNotVerifiedError()
          }

          // 登入成功僅記錄 userId（不記錄 email）
          edgeLogger.info('[Auth] Login successful', { userId: user.id })
          // 返回用戶資訊（不包含密碼和敏感資料）
          return {
            id: user.id,
            email: user.email,
            name: user.name,
            image: user.image,
          }
        } catch (error) {
          // 重新拋出已知的認證錯誤
          // ⚠️ 新增自定義認證錯誤時必須同步加進這個清單，否則會被下方吞掉、
          //    退化成一般的 return null，前端就看不到專屬訊息
          if (error instanceof EmailNotVerifiedError ||
              error instanceof AccountSuspendedError ||
              error instanceof AccountDisabledError ||
              error instanceof AccountLockedError) {
            throw error
          }
          // 記錄未預期的錯誤（不含 PII）
          edgeLogger.error('[Auth] Unexpected error during authorization', {
            error: error instanceof Error ? error.message : String(error),
          })
          return null
        }
      },
    })
  )

  // 如果 Azure AD 已配置，動態載入提供者
  if (isAzureADConfigured()) {
    // 注意：MicrosoftEntraID 在 Edge Runtime 中可能有問題
    // 這裡我們只在非 Edge 環境中添加
    // Middleware 將使用 Credentials 或現有 session
  }

  return providers
}

/**
 * Edge-compatible NextAuth 配置
 * 不包含資料庫存取，適用於 Middleware
 */
export const authConfig: NextAuthConfig = {
  providers: buildProviders(),

  session: {
    strategy: 'jwt',
    maxAge: SESSION_MAX_AGE,
  },

  pages: {
    signIn: '/auth/login',
    error: '/auth/error',
  },

  callbacks: {
    /**
     * Authorized callback - 用於 Middleware 的授權檢查
     * 只檢查是否有 auth token，不進行資料庫查詢
     */
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user
      const isOnDashboard = nextUrl.pathname.startsWith('/dashboard')
      const isOnApi = nextUrl.pathname.startsWith('/api/v1')
      const isAuthRoute = nextUrl.pathname.startsWith('/auth')
      const isApiAuth = nextUrl.pathname.startsWith('/api/auth')

      // API auth routes are always accessible
      if (isApiAuth) {
        return true
      }

      // Protected routes check
      if (isOnDashboard || isOnApi) {
        if (isLoggedIn) return true
        return false // Redirect to login
      }

      // Auth routes - redirect to dashboard if already logged in
      if (isAuthRoute) {
        if (isLoggedIn) {
          return Response.redirect(new URL('/dashboard', nextUrl))
        }
        return true
      }

      // Root path handling
      if (nextUrl.pathname === '/') {
        if (isLoggedIn) {
          return Response.redirect(new URL('/dashboard', nextUrl))
        }
        return Response.redirect(new URL('/auth/login', nextUrl))
      }

      return true
    },

    /**
     * Session callback (Edge / Middleware 用) - FIX-074
     *
     * @description
     *   將 token 的 mustChangePassword 旗標傳遞到 session，供 middleware 的強制改密攔截使用。
     *   完整配置（auth.ts）有自己的 session callback 會覆蓋此處；本 callback 僅供 middleware 的
     *   NextAuth(authConfig) 實例使用。Edge runtime 不查 DB，只搬移 token 既有欄位。
     */
    session({ session, token }) {
      if (session.user) {
        session.user.mustChangePassword = token.mustChangePassword ?? false
      }
      return session
    },
  },

  // 開發模式下啟用調試日誌
  debug: process.env.NODE_ENV === 'development',
}
