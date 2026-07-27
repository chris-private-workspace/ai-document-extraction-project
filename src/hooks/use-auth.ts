'use client'

/**
 * @fileoverview 認證 Hook
 * @description
 *   提供客戶端認證狀態存取和權限檢查功能。
 *   封裝 NextAuth 的 useSession，並提供便利的權限檢查方法。
 *
 *   主要功能：
 *   - 獲取當前用戶資訊
 *   - 檢查認證狀態
 *   - 權限檢查
 *   - 角色檢查
 *
 * @module src/hooks/use-auth
 * @author Development Team
 * @since Epic 1 - Story 1.2 (User Database & Role Foundation)
 * @lastModified 2026-07-27
 *
 * @dependencies
 *   - next-auth/react - NextAuth React 客戶端
 *   - @/lib/auth/has-permission - 統一權限判斷入口（FIX-134）
 *
 * @remarks
 *   FIX-134：三個權限方法原先只把各 role 的 permissions 展平後做精確比對，
 *   既不認 wildcard `*` 也不看 `isGlobalAdmin` —— 全域管理員（`permissions: ['*']`）
 *   在所有依賴這些方法的 UI 元素上都被判定為無權限。現統一委派
 *   `sessionHasPermission`，與 API 端共用同一份語意。
 *
 * @example
 *   const { user, isAuthenticated, hasPermission } = useAuth()
 *
 *   if (hasPermission(PERMISSIONS.INVOICE_APPROVE)) {
 *     // 顯示批准按鈕
 *   }
 */

import { useSession } from 'next-auth/react'
import { useMemo, useCallback } from 'react'
import type { Session } from 'next-auth'
import {
  sessionHasPermission,
  sessionHasAnyPermission,
  sessionHasAllPermissions,
} from '@/lib/auth/has-permission'
import type { Permission } from '@/types/permissions'

/**
 * useAuth Hook 返回類型
 */
export interface UseAuthReturn {
  /** 當前用戶資訊 */
  user: Session['user'] | null
  /** 是否正在載入 */
  isLoading: boolean
  /** 是否已認證 */
  isAuthenticated: boolean
  /** 用戶的所有權限（聚合） */
  permissions: string[]
  /** 檢查是否擁有特定權限 */
  hasPermission: (permission: Permission) => boolean
  /** 檢查是否擁有任一權限 */
  hasAnyPermission: (permissions: Permission[]) => boolean
  /** 檢查是否擁有所有權限 */
  hasAllPermissions: (permissions: Permission[]) => boolean
  /** 檢查是否擁有特定角色 */
  hasRole: (roleName: string) => boolean
  /** 檢查是否擁有任一角色 */
  hasAnyRole: (roleNames: string[]) => boolean
}

/**
 * 認證 Hook
 * 提供認證狀態存取和權限檢查功能
 *
 * @returns 認證狀態和權限檢查方法
 *
 * @example
 *   function ProtectedComponent() {
 *     const { user, isLoading, hasPermission } = useAuth()
 *
 *     if (isLoading) return <Loading />
 *
 *     if (!hasPermission(PERMISSIONS.INVOICE_VIEW)) {
 *       return <NoAccess />
 *     }
 *
 *     return <InvoiceList />
 *   }
 */
export function useAuth(): UseAuthReturn {
  const { data: session, status } = useSession()

  const isLoading = status === 'loading'
  const isAuthenticated = status === 'authenticated'
  const user = session?.user ?? null

  /**
   * 聚合用戶的所有權限（從所有角色）
   */
  const permissions = useMemo(() => {
    if (!user?.roles) return []

    const permissionSet = new Set<string>()
    for (const role of user.roles) {
      for (const permission of role.permissions) {
        permissionSet.add(permission)
      }
    }
    return Array.from(permissionSet)
  }, [user?.roles])

  /**
   * 檢查是否擁有特定權限
   *
   * @remarks FIX-134：委派統一入口，認得 wildcard `*` 與 `isGlobalAdmin`
   */
  const hasPermission = useCallback(
    (permission: Permission): boolean => {
      return sessionHasPermission(user, permission)
    },
    [user]
  )

  /**
   * 檢查是否擁有任一權限
   */
  const hasAnyPermission = useCallback(
    (requiredPermissions: Permission[]): boolean => {
      return sessionHasAnyPermission(user, requiredPermissions)
    },
    [user]
  )

  /**
   * 檢查是否擁有所有權限
   */
  const hasAllPermissions = useCallback(
    (requiredPermissions: Permission[]): boolean => {
      return sessionHasAllPermissions(user, requiredPermissions)
    },
    [user]
  )

  /**
   * 檢查是否擁有特定角色
   */
  const hasRole = useCallback(
    (roleName: string): boolean => {
      return user?.roles?.some((r) => r.name === roleName) ?? false
    },
    [user?.roles]
  )

  /**
   * 檢查是否擁有任一角色
   */
  const hasAnyRole = useCallback(
    (roleNames: string[]): boolean => {
      return roleNames.some((name) => hasRole(name))
    },
    [hasRole]
  )

  return {
    user,
    isLoading,
    isAuthenticated,
    permissions,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    hasRole,
    hasAnyRole,
  }
}
