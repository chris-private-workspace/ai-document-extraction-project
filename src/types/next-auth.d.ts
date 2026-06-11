/**
 * @fileoverview NextAuth v5 類型擴展
 * @description
 *   擴展 NextAuth 的 Session 和 JWT 類型，加入自定義屬性。
 *
 *   擴展屬性：
 *   - user.id: 用戶唯一標識符
 *   - user.status: 用戶狀態 (ACTIVE | INACTIVE | SUSPENDED)
 *   - user.azureAdId: Azure AD 用戶 ID
 *   - user.roles: 角色列表（含權限）
 *   - user.cityCodes: 可存取的城市代碼列表 (Story 6.1)
 *   - user.primaryCityCode: 主要城市代碼 (Story 6.1)
 *   - user.isGlobalAdmin: 是否為全域管理員 (Story 6.1)
 *   - user.isRegionalManager: 是否為區域管理員 (Story 6.1)
 *
 * @module src/types/next-auth
 * @author Development Team
 * @since Epic 1 - Story 1.1 (Azure AD SSO Login)
 * @lastModified 2025-12-19
 *
 * @related
 *   - src/lib/auth.ts - NextAuth 配置
 *   - src/types/role.ts - 角色類型定義
 *   - src/services/city-access.service.ts - 城市權限服務
 *   - prisma/schema.prisma - 用戶模型定義
 */

import type { UserStatus } from '@prisma/client'
import type { DefaultSession, DefaultUser } from 'next-auth'
import type { DefaultJWT } from 'next-auth/jwt'
import type { SessionRole } from './role'

declare module 'next-auth' {
  /**
   * 擴展 Session 類型
   * 在 session.user 中加入自定義屬性
   */
  interface Session {
    user: {
      /** 用戶唯一標識符 */
      id: string
      /** Azure AD 用戶 ID */
      azureAdId?: string
      /** 用戶狀態 */
      status: UserStatus
      /** 用戶角色列表（含權限） */
      roles: SessionRole[]
      /** 可存取的城市代碼列表 (Story 6.1) */
      cityCodes: string[]
      /** 主要城市代碼 (Story 6.1) */
      primaryCityCode: string | null
      /** 是否為全域管理員 (Story 6.1) */
      isGlobalAdmin: boolean
      /** 是否為區域管理員 (Story 6.1) */
      isRegionalManager: boolean
      /** 區域管理員管理的區域代碼列表 (Story 6.1) */
      regionCodes?: string[]
      /** 用戶語言偏好 (Story 17-5) */
      preferredLocale?: string
      /** 是否必須先修改密碼才能使用系統 (FIX-074) */
      mustChangePassword?: boolean
    } & DefaultSession['user']
  }

  /**
   * 擴展 User 類型
   * 對應 Prisma User 模型的自定義欄位
   */
  interface User extends DefaultUser {
    /** Azure AD 用戶 ID */
    azureAdId?: string
    /** 用戶狀態 */
    status?: UserStatus
    /** 可存取的城市代碼列表 (Story 6.1) */
    cityCodes?: string[]
    /** 主要城市代碼 (Story 6.1) */
    primaryCityCode?: string | null
    /** 是否為全域管理員 (Story 6.1) */
    isGlobalAdmin?: boolean
    /** 是否為區域管理員 (Story 6.1) */
    isRegionalManager?: boolean
    /** 區域管理員管理的區域代碼列表 (Story 6.1) */
    regionCodes?: string[]
    /** 用戶語言偏好 (Story 17-5) */
    preferredLocale?: string
  }
}

declare module 'next-auth/jwt' {
  /**
   * 擴展 JWT 類型
   * 在 JWT token 中存儲自定義屬性
   */
  interface JWT extends DefaultJWT {
    /** Azure AD 用戶 ID */
    azureAdId?: string
    /** 用戶狀態 */
    status?: UserStatus
    /** 用戶角色列表（含權限） */
    roles?: SessionRole[]
    /** 可存取的城市代碼列表 (Story 6.1) */
    cityCodes?: string[]
    /** 主要城市代碼 (Story 6.1) */
    primaryCityCode?: string | null
    /** 是否為全域管理員 (Story 6.1) */
    isGlobalAdmin?: boolean
    /** 是否為區域管理員 (Story 6.1) */
    isRegionalManager?: boolean
    /** 區域管理員管理的區域代碼列表 (Story 6.1) */
    regionCodes?: string[]
    /** 用戶語言偏好 (Story 17-5) */
    preferredLocale?: string
    /** 登入提供者 (Story 18-2) */
    provider?: string
    /** 是否必須先修改密碼 (FIX-074) */
    mustChangePassword?: boolean
  }
}
