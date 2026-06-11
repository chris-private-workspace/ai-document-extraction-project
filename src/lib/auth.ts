/**
 * @fileoverview NextAuth v5 完整認證配置
 * @description
 *   本模組配置 NextAuth v5 與 Azure AD (Entra ID) 整合，提供企業級 SSO 認證。
 *   此配置包含資料庫存取，用於 API Routes 和 Server Components。
 *
 *   設計考量：
 *   - 使用 JWT 策略以支援無狀態認證
 *   - 8 小時 session 最大時效
 *   - 自動建立用戶記錄於首次登入
 *   - 擴展 session 包含角色、權限和用戶狀態
 *   - 整合城市權限系統支援多城市資料隔離 (Story 6.1)
 *   - 支援本地帳號登入 (Story 18-2)
 *
 *   架構說明：
 *   - auth.config.ts: Edge-compatible 配置（用於 Middleware）
 *   - auth.ts: 完整配置（用於 API Routes、Server Components）
 *
 * @module src/lib/auth
 * @author Development Team
 * @since Epic 1 - Story 1.1 (Azure AD SSO Login)
 * @lastModified 2026-01-19
 *
 * @features
 *   - Azure AD (Entra ID) SSO 整合
 *   - 本地帳號密碼登入 (Story 18-2)
 *   - JWT session 策略
 *   - 自動用戶建立/更新
 *   - 多角色 RBAC 權限系統
 *   - 用戶狀態檢查
 *   - 城市權限載入 (Story 6.1)
 *   - 全域管理員/區域管理員識別 (Story 6.1)
 *
 * @dependencies
 *   - next-auth - NextAuth v5 核心
 *   - @auth/prisma-adapter - Prisma 資料庫適配器
 *   - @prisma/client - Prisma ORM 客戶端
 *   - @/services/city-access.service - 城市權限服務
 *
 * @related
 *   - src/lib/auth.config.ts - Edge-compatible 認證配置
 *   - src/app/api/auth/[...nextauth]/route.ts - API 路由
 *   - src/middleware.ts - 路由保護中間件
 *   - src/types/next-auth.d.ts - 類型擴展
 *   - src/types/role.ts - 角色類型定義
 *   - src/services/role.service.ts - 角色服務
 *   - src/services/city-access.service.ts - 城市權限服務
 */

import NextAuth from 'next-auth'
import { PrismaAdapter } from '@auth/prisma-adapter'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { SessionRole } from '@/types/role'
import { DEFAULT_ROLE } from '@/types/role-permissions'
import { assignRoleToUser, getRoleByName } from '@/services/role.service'
import { CityAccessService } from '@/services/city-access.service'
import { authConfig } from './auth.config'

/**
 * 檢查 Azure AD 環境變數是否已正確配置
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

/**
 * 檢查是否為開發/示範模式
 *
 * @description
 *   此邏輯與 auth.config.ts:129 的 Credentials Provider dev 判斷一致（皆採 &&）：
 *   僅在「本地開發（NODE_ENV=development）且 Azure AD 未配置」時才啟用開發模式認證。
 *
 *   ⚠️ 安全（CHANGE-077）：先前使用 `||`，會導致「生產環境但 Azure AD 未配置」時
 *   開發模式邏輯誤啟用（dev-bypass 後門 + JWT dev 分支 + 略過 PrismaAdapter）。
 *   改為 `&&` 後，生產環境（NODE_ENV=production）恆為非 dev 模式，後門關閉（fail-closed）。
 *
 *   注意：使用函數而非常數，確保在運行時動態計算（避免構建時烘焙）
 *
 * @returns 是否為開發/示範模式
 */
function isDevelopmentMode(): boolean {
  return process.env.NODE_ENV === 'development' && !isAzureADConfigured()
}

/**
 * 獲取用戶的角色和權限
 * @param userId - 用戶 ID
 * @returns 用戶的角色列表（含權限）
 */
async function getUserRoles(userId: string): Promise<SessionRole[]> {
  const userRoles = await prisma.userRole.findMany({
    where: { userId },
    include: {
      role: {
        select: {
          id: true,
          name: true,
          permissions: true,
        },
      },
    },
  })

  return userRoles.map((ur) => ({
    id: ur.role.id,
    name: ur.role.name,
    permissions: ur.role.permissions,
  }))
}

/**
 * NextAuth 實例導出
 * 合併 Edge 配置並加入資料庫功能
 */
export const {
  handlers,
  auth,
  signIn,
  signOut,
} = NextAuth({
  ...authConfig,

  // 加入 Prisma adapter（僅在生產環境或 Azure AD 已配置時使用）
  // 開發模式使用 Credentials provider 時不需要 adapter
  ...(isDevelopmentMode() ? {} : { adapter: PrismaAdapter(prisma) }),

  callbacks: {
    ...authConfig.callbacks,

    /**
     * JWT callback - 在 JWT 建立/更新時調用
     * 將用戶角色、權限、城市權限和 azureAdId 加入 token
     *
     * @description
     *   Story 6.1: 新增城市權限載入
     *   - 從資料庫載入用戶可存取的城市代碼列表
     *   - 載入用戶的主要城市代碼
     *   - 識別全域管理員和區域管理員身份
     *   - 載入區域管理員負責的區域代碼
     *
     *   Story 18-2: 支援本地帳號登入
     *   - 本地帳號登入時 account.provider === 'credentials'
     *   - Session 結構與 Azure AD 登入保持一致
     */
    async jwt({ token, account, user }) {
      // 首次登入時設置基本資訊
      if (user) {
        token.sub = user.id
        token.email = user.email
        token.name = user.name
      }

      // 記錄登入方式
      if (account) {
        token.provider = account.provider
        if (account.provider === 'microsoft-entra-id') {
          token.azureAdId = account.providerAccountId
        }
      }

      // 開發模式模擬用戶：id 為 'dev-user-1'
      // 使用簡化的 token 設置，不查詢資料庫
      if (token.sub === 'dev-user-1') {
        token.status = 'ACTIVE'
        token.roles = [{
          id: 'dev-role-1',
          name: 'Administrator',
          permissions: ['*'], // 開發模式給予所有權限
        }]
        token.cityCodes = ['*'] // 開發模式可存取所有城市
        token.primaryCityCode = 'HKG'
        token.isGlobalAdmin = true
        token.isRegionalManager = false
        token.mustChangePassword = false
        return token
      }

      // 真正的用戶：從資料庫獲取用戶資訊（無論是 Azure AD 還是本地帳號）
      if (token.sub) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.sub },
          select: {
            azureAdId: true,
            status: true,
            isGlobalAdmin: true,
            isRegionalManager: true,
            preferredLocale: true, // Story 17-5: 語言偏好
            mustChangePassword: true, // FIX-074: 強制首次改密
          },
        })

        if (dbUser) {
          // 只有當 token 沒有 azureAdId 時才從資料庫取值
          // （避免覆蓋 Azure AD 登入時的值）
          if (!token.azureAdId && dbUser.azureAdId) {
            token.azureAdId = dbUser.azureAdId
          }
          token.status = dbUser.status

          // Story 6.1: 設置管理員身份
          token.isGlobalAdmin = dbUser.isGlobalAdmin
          token.isRegionalManager = dbUser.isRegionalManager

          // Story 17-5: 語言偏好
          token.preferredLocale = dbUser.preferredLocale ?? undefined

          // FIX-074: 強制首次改密旗標
          token.mustChangePassword = dbUser.mustChangePassword
        }

        // 獲取用戶角色和權限
        token.roles = await getUserRoles(token.sub)

        // Story 6.1: 獲取城市權限資訊
        token.cityCodes = await CityAccessService.getUserCityCodes(token.sub)
        token.primaryCityCode = await CityAccessService.getPrimaryCityCode(token.sub)

        // Story 6.1: 如果是區域管理員，獲取管理的區域代碼
        if (token.isRegionalManager) {
          token.regionCodes = await CityAccessService.getManagedRegionCodes(token.sub)
        }
      }

      return token
    },

    /**
     * Session callback - 在取得 session 時調用
     * 將 token 中的資料加入 session
     *
     * @description
     *   Story 6.1: 新增城市權限資料傳遞
     *   - 將城市代碼列表加入 session
     *   - 將主要城市代碼加入 session
     *   - 傳遞管理員身份標識
     *   - 傳遞區域管理員的區域代碼
     */
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub!
        session.user.azureAdId = token.azureAdId
        session.user.status = token.status ?? 'ACTIVE'
        session.user.roles = token.roles ?? []

        // Story 6.1: 城市權限資料
        session.user.cityCodes = token.cityCodes ?? []
        session.user.primaryCityCode = token.primaryCityCode ?? null
        session.user.isGlobalAdmin = token.isGlobalAdmin ?? false
        session.user.isRegionalManager = token.isRegionalManager ?? false
        session.user.regionCodes = token.regionCodes

        // Story 17-5: 語言偏好
        session.user.preferredLocale = token.preferredLocale

        // FIX-074: 強制首次改密旗標
        session.user.mustChangePassword = token.mustChangePassword ?? false
      }
      return session
    },

    /**
     * SignIn callback - 在用戶登入時調用
     * 檢查用戶狀態是否允許登入
     *
     * @description
     *   Story 1.6: 停用的用戶嘗試登入時，將被重導至錯誤頁面
     *   而非顯示通用的登入失敗訊息。
     *
     *   Story 18-2: 本地帳號登入支援
     *   - 本地帳號的狀態和郵件驗證已在 auth.config.ts 的 authorize 中檢查
     *   - 這裡只處理 Azure AD 登入的狀態檢查和最後登入時間更新
     *
     *   狀態處理：
     *   - ACTIVE: 允許登入
     *   - INACTIVE: 重導至 /auth/error?error=AccountDisabled
     *   - SUSPENDED: 重導至 /auth/error?error=AccountSuspended
     */
    async signIn({ user, account }) {
      // 開發模式模擬用戶：跳過資料庫檢查
      if (user.id === 'dev-user-1') {
        return true
      }

      // 真正的用戶：檢查用戶狀態並更新最後登入時間
      if (user.id) {
        const dbUser = await prisma.user.findUnique({
          where: { id: user.id },
          select: { status: true, emailVerified: true },
        })

        // 如果用戶存在但非 ACTIVE 狀態，重導至錯誤頁面
        // 注意：本地帳號登入時，狀態已在 authorize 中檢查並拋出錯誤
        // 這裡主要處理 Azure AD 登入的情況
        if (dbUser && dbUser.status !== 'ACTIVE') {
          // 根據不同狀態重導至相應錯誤頁面
          if (dbUser.status === 'SUSPENDED') {
            return '/auth/error?error=AccountSuspended'
          }
          // INACTIVE 或其他非 ACTIVE 狀態
          return '/auth/error?error=AccountDisabled'
        }

        // 更新最後登入時間
        await prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        })
      }

      return true
    },
  },

  events: {
    /**
     * 建立用戶時設置預設值和預設角色
     * 注意：開發模式下不會觸發此事件（因為沒有使用 PrismaAdapter）
     */
    async createUser({ user }) {
      // 開發模式下此事件不會觸發，但保留檢查以防萬一
      if (isDevelopmentMode()) {
        return
      }

      if (user.id) {
        // 設置用戶狀態為 ACTIVE
        await prisma.user.update({
          where: { id: user.id },
          data: {
            status: 'ACTIVE',
          },
        })

        // 分配預設角色
        const defaultRole = await getRoleByName(DEFAULT_ROLE)
        if (defaultRole) {
          await assignRoleToUser(user.id, defaultRole.id)
        }
      }
    },
  },
})

/**
 * 開發模式的模擬 Session
 * 用於腳本測試時繞過認證
 */
const DEV_MOCK_SESSION = {
  user: {
    id: 'dev-user-1',
    name: 'Development User',
    email: 'dev@example.com',
    status: 'ACTIVE' as const,
    roles: [{
      id: 'dev-role-1',
      name: 'Administrator',
      permissions: ['*'],
    }],
    cityCodes: ['*'],
    primaryCityCode: 'HKG',
    isGlobalAdmin: true,
    isRegionalManager: false,
  },
  expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
}

/**
 * 獲取 Session（支援開發模式繞過）
 *
 * @description
 *   用於 API Routes 中獲取認證 Session。
 *   在開發模式下，如果請求包含 `X-Dev-Bypass-Auth: true` header，
 *   將返回模擬的管理員 Session，方便腳本測試。
 *
 * @param request - Next.js Request 物件（可選）
 * @returns Session 物件或 null
 *
 * @example
 * ```typescript
 * // 在 API Route 中使用
 * export async function GET(request: NextRequest) {
 *   const session = await getAuthSession(request)
 *   if (!session?.user?.id) {
 *     return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
 *   }
 *   // ...
 * }
 * ```
 */
export async function getAuthSession(request?: NextRequest) {
  // 檢查開發模式繞過
  // CHANGE-077（縱深防禦）：獨立硬性要求 NODE_ENV=development，與 isDevelopmentMode() 解耦，
  // 確保即使 isDevelopmentMode 未來再被改寬，此後門在生產環境仍被 NODE_ENV 擋住。
  if (process.env.NODE_ENV === 'development' && request) {
    const bypassHeader = request.headers.get('X-Dev-Bypass-Auth')
    if (bypassHeader === 'true') {
      console.log('[Auth] Development mode bypass enabled via X-Dev-Bypass-Auth header')
      return DEV_MOCK_SESSION
    }
  }

  // 正常認證流程
  return auth()
}
