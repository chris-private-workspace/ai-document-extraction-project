/**
 * @fileoverview 用戶服務層
 * @description
 *   提供用戶相關的業務邏輯，包含用戶查詢、創建、更新等功能。
 *   與角色服務配合實現完整的用戶管理功能。
 *
 *   主要功能：
 *   - 用戶 CRUD 操作
 *   - Azure AD 用戶同步
 *   - 用戶狀態管理
 *   - 用戶搜尋和列表
 *
 * @module src/services/user.service
 * @author Development Team
 * @since Epic 1 - Story 1.2 (User Database & Role Foundation)
 * @lastModified 2025-12-18
 *
 * @dependencies
 *   - @prisma/client - Prisma ORM 客戶端
 *   - @/lib/prisma - Prisma 單例實例
 *
 * @related
 *   - src/services/role.service.ts - 角色服務
 *   - src/types/user.ts - 用戶類型定義
 *   - src/lib/auth.ts - NextAuth 配置
 */

import { prisma } from '@/lib/prisma'
import type { User, UserStatus } from '@prisma/client'
import { assignDefaultRole } from './role.service'
import type { UserWithRoles, CreateUserFromAzureAD } from '@/types/user'
import { AppError } from '@/lib/errors'
import type { CreateUserInput, UpdateUserInput } from '@/lib/validations/user.schema'
import { logUserChange } from '@/lib/audit/logger'
// CHANGE-082: Admin 密碼管理
import { hashPassword, validatePasswordStrength } from '@/lib/password'

// ============================================================
// 用戶查詢
// ============================================================

/**
 * 根據 ID 獲取用戶
 * @param id - 用戶 ID
 * @returns 用戶或 null
 */
export async function getUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({
    where: { id },
  })
}

/**
 * 根據電子郵件獲取用戶
 * @param email - 電子郵件
 * @returns 用戶或 null
 */
export async function getUserByEmail(email: string): Promise<User | null> {
  return prisma.user.findUnique({
    where: { email },
  })
}

/**
 * 根據 Azure AD ID 獲取用戶
 * @param azureAdId - Azure AD 用戶 ID
 * @returns 用戶或 null
 */
export async function getUserByAzureAdId(azureAdId: string): Promise<User | null> {
  return prisma.user.findUnique({
    where: { azureAdId },
  })
}

/**
 * 獲取用戶（含角色資訊）
 * @param id - 用戶 ID
 * @returns 用戶（含角色）或 null
 */
export async function getUserWithRoles(id: string): Promise<UserWithRoles | null> {
  return prisma.user.findUnique({
    where: { id },
    include: {
      roles: {
        include: { role: true },
      },
    },
  })
}

/**
 * 檢查用戶是否存在
 * @param email - 電子郵件
 * @returns 是否存在
 */
export async function userExists(email: string): Promise<boolean> {
  const count = await prisma.user.count({
    where: { email },
  })
  return count > 0
}

/**
 * 檢查電子郵件是否已被使用
 *
 * @description
 *   用於新增用戶前檢查電子郵件是否重複。
 *   會將電子郵件轉為小寫進行比對。
 *
 * @param email - 電子郵件
 * @returns 是否已存在
 *
 * @since Story 1.4
 */
export async function checkEmailExists(email: string): Promise<boolean> {
  const count = await prisma.user.count({
    where: { email: email.toLowerCase() },
  })
  return count > 0
}

// ============================================================
// 用戶創建與更新
// ============================================================

/**
 * 創建新用戶（從 Azure AD 登入）
 * @param data - Azure AD 用戶資料
 * @returns 創建的用戶
 */
export async function createUserFromAzureAD(
  data: CreateUserFromAzureAD
): Promise<User> {
  const user = await prisma.user.create({
    data: {
      email: data.email,
      name: data.name,
      image: data.image,
      azureAdId: data.azureAdId,
      status: 'ACTIVE',
    },
  })

  // 分配預設角色
  await assignDefaultRole(user.id)

  return user
}

/**
 * 更新用戶資料
 * @param id - 用戶 ID
 * @param data - 更新資料
 * @returns 更新後的用戶
 */
export async function updateUser(
  id: string,
  data: Partial<Pick<User, 'name' | 'image' | 'status'>>
): Promise<User> {
  return prisma.user.update({
    where: { id },
    data,
  })
}

/**
 * 更新用戶狀態（含審計日誌）
 *
 * @description
 *   更新用戶帳戶狀態（啟用/停用）。
 *   防止用戶停用自己的帳戶。
 *   自動記錄審計日誌。
 *
 * @param targetUserId - 目標用戶 ID
 * @param status - 新狀態 (ACTIVE/INACTIVE)
 * @param performedBy - 執行者用戶 ID
 * @returns 更新後的用戶
 * @throws {AppError} 當用戶不存在或嘗試停用自己時拋出錯誤
 *
 * @since Story 1.6
 *
 * @example
 *   const user = await updateUserStatus('target-id', 'INACTIVE', 'admin-id')
 */
export async function updateUserStatusWithAudit(
  targetUserId: string,
  status: UserStatus,
  performedBy: string
): Promise<User> {
  // 防止用戶停用自己
  if (targetUserId === performedBy && status !== 'ACTIVE') {
    throw new AppError(
      'validation_error',
      'Cannot Disable Self',
      400,
      '您無法停用自己的帳戶'
    )
  }

  // 獲取當前用戶資料
  const currentUser = await getUserById(targetUserId)
  if (!currentUser) {
    throw new AppError(
      'not_found',
      'User Not Found',
      404,
      '用戶不存在'
    )
  }

  // 如果狀態相同，直接返回
  if (currentUser.status === status) {
    return currentUser
  }

  const oldStatus = currentUser.status

  // 更新狀態
  const updatedUser = await prisma.user.update({
    where: { id: targetUserId },
    data: { status },
  })

  // 記錄審計日誌
  // 使用 UPDATE_STATUS 動作類型，在 details 中區分 enable/disable
  await logUserChange({
    userId: targetUserId,
    action: 'UPDATE_STATUS',
    oldValue: { status: oldStatus },
    newValue: { status, action: status === 'ACTIVE' ? 'enable' : 'disable' },
    performedBy,
  })

  return updatedUser
}

/**
 * 更新用戶狀態（基礎版本，無審計）
 * @deprecated 請使用 updateUserStatusWithAudit
 * @param id - 用戶 ID
 * @param status - 新狀態
 * @returns 更新後的用戶
 */
export async function updateUserStatus(
  id: string,
  status: UserStatus
): Promise<User> {
  return prisma.user.update({
    where: { id },
    data: { status },
  })
}

/**
 * 更新用戶最後登入時間
 * @param id - 用戶 ID
 * @returns 更新後的用戶
 */
export async function updateLastLoginAt(id: string): Promise<User> {
  return prisma.user.update({
    where: { id },
    data: { lastLoginAt: new Date() },
  })
}

// ============================================================
// 用戶詳情與更新（Story 1-5）
// ============================================================

/**
 * 用戶詳情（含完整角色和城市資訊）
 */
export interface UserDetailWithRoles {
  id: string
  email: string
  name: string | null
  image: string | null
  status: UserStatus
  createdAt: Date
  updatedAt: Date
  lastLoginAt: Date | null
  roles: {
    id: string
    roleId: string
    cityId: string | null
    role: {
      id: string
      name: string
      description: string | null
    }
    city: {
      id: string
      name: string
      code: string
    } | null
  }[]
}

/**
 * 根據 ID 獲取用戶詳情（含角色和城市）
 *
 * @description
 *   獲取用戶的完整資訊，包含所有角色和城市歸屬。
 *   用於用戶詳情頁面和編輯對話框。
 *
 * @param id - 用戶 ID
 * @returns 用戶詳情或 null
 *
 * @since Story 1.5
 */
export async function getUserByIdWithRoles(
  id: string
): Promise<UserDetailWithRoles | null> {
  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      roles: {
        include: {
          role: {
            select: {
              id: true,
              name: true,
              description: true,
            },
          },
          city: {
            select: {
              id: true,
              name: true,
              code: true,
            },
          },
        },
      },
    },
  })

  return user as UserDetailWithRoles | null
}

/**
 * 更新用戶資料（含角色和城市）
 *
 * @description
 *   更新用戶的基本資料、角色和城市歸屬。
 *   使用交易確保資料一致性。
 *   自動記錄審計日誌。
 *
 * @param userId - 用戶 ID
 * @param data - 更新資料
 * @param performedBy - 執行者用戶 ID
 * @returns 更新後的用戶詳情
 * @throws {AppError} 當用戶不存在時拋出 404 錯誤
 *
 * @since Story 1.5
 *
 * @example
 *   const user = await updateUserWithRoles(
 *     'user-id',
 *     { name: 'New Name', roleIds: ['role-1', 'role-2'], cityId: 'city-id' },
 *     'admin-id'
 *   )
 */
export async function updateUserWithRoles(
  userId: string,
  data: UpdateUserInput,
  performedBy: string
): Promise<UserDetailWithRoles> {
  // 獲取當前用戶資料（用於審計日誌）
  const currentUser = await getUserByIdWithRoles(userId)
  if (!currentUser) {
    throw new AppError(
      'not_found',
      'User Not Found',
      404,
      '用戶不存在'
    )
  }

  const { name, roleIds, cityId } = data

  // 記錄舊值
  const oldValues = {
    name: currentUser.name,
    roleIds: currentUser.roles.map((r) => r.role.id),
    cityId: currentUser.roles.find((r) => r.cityId)?.cityId ?? null,
  }

  // 使用交易確保資料一致性
  const updatedUser = await prisma.$transaction(async (tx) => {
    // 1. 更新用戶基本資料
    if (name !== undefined) {
      await tx.user.update({
        where: { id: userId },
        data: {
          name,
          updatedAt: new Date(),
        },
      })
    }

    // 2. 更新角色關聯（如果有提供）
    if (roleIds !== undefined) {
      // 刪除現有角色關聯
      await tx.userRole.deleteMany({
        where: { userId },
      })

      // 建立新角色關聯
      await tx.userRole.createMany({
        data: roleIds.map((roleId) => ({
          userId,
          roleId,
          cityId: cityId ?? null,
        })),
      })
    } else if (cityId !== undefined) {
      // 只更新城市（保留現有角色）
      await tx.userRole.updateMany({
        where: { userId },
        data: { cityId: cityId ?? null },
      })
    }

    // 3. 返回更新後的用戶
    return tx.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        roles: {
          include: {
            role: {
              select: {
                id: true,
                name: true,
                description: true,
              },
            },
            city: {
              select: {
                id: true,
                name: true,
                code: true,
              },
            },
          },
        },
      },
    })
  })

  // 記錄審計日誌（非阻塞）
  // 記錄名稱變更
  if (name !== undefined && name !== oldValues.name) {
    await logUserChange({
      userId,
      action: 'UPDATE_INFO',
      oldValue: { name: oldValues.name },
      newValue: { name },
      performedBy,
    })
  }

  // 記錄角色變更
  if (roleIds !== undefined) {
    const oldRolesSorted = [...oldValues.roleIds].sort().join(',')
    const newRolesSorted = [...roleIds].sort().join(',')
    if (oldRolesSorted !== newRolesSorted) {
      await logUserChange({
        userId,
        action: 'UPDATE_ROLE',
        oldValue: oldValues.roleIds,
        newValue: roleIds,
        performedBy,
      })
    }
  }

  // 記錄城市變更
  if (cityId !== undefined && cityId !== oldValues.cityId) {
    await logUserChange({
      userId,
      action: 'UPDATE_CITY',
      oldValue: oldValues.cityId,
      newValue: cityId,
      performedBy,
    })
  }

  return updatedUser as UserDetailWithRoles
}

// ============================================================
// 手動創建用戶（Story 1-4）
// ============================================================

/**
 * 手動創建用戶結果類型（含角色和城市資訊）
 */
export interface CreatedUserWithRoles {
  id: string
  email: string
  name: string | null
  image: string | null
  status: UserStatus
  createdAt: Date
  lastLoginAt: Date | null
  roles: {
    role: {
      id: string
      name: string
    }
    city: {
      id: string
      name: string
      code: string
    } | null
  }[]
}

/**
 * 手動創建新用戶（管理員操作）
 *
 * @description
 *   由系統管理員手動創建用戶帳號。
 *   用於預先註冊用戶，讓他們之後可以通過 Azure AD 登入。
 *
 *   流程：
 *   1. 檢查電子郵件是否已存在
 *   2. 創建用戶記錄
 *   3. 建立角色關聯
 *   4. 記錄審計日誌
 *   5. 返回完整用戶資料
 *
 * @param input - 創建用戶輸入
 * @param createdById - 創建者用戶 ID
 * @returns 創建的用戶（含角色）
 * @throws {AppError} 當電子郵件已存在時拋出 409 錯誤
 *
 * @since Story 1.4
 *
 * @example
 *   const user = await createUser(
 *     { email: 'user@example.com', name: 'John Doe', roleIds: ['role-id'] },
 *     currentUserId
 *   )
 */
export async function createUser(
  input: CreateUserInput,
  createdById: string
): Promise<CreatedUserWithRoles> {
  const { email, name, roleIds, cityId, password } = input

  // 檢查電子郵件是否已存在
  const emailExists = await checkEmailExists(email)
  if (emailExists) {
    throw new AppError(
      'validation_error',
      'Email Already Exists',
      409,
      '此電子郵件已被註冊'
    )
  }

  // CHANGE-082: 若提供初始密碼則先 hash（僅本地帳號；交易外計算避免拉長交易）
  const hashedPassword = password ? await hashPassword(password) : undefined

  // 使用交易確保資料一致性
  const user = await prisma.$transaction(async (tx) => {
    // 1. 創建用戶
    const newUser = await tx.user.create({
      data: {
        email: email.toLowerCase(),
        name,
        status: 'ACTIVE',
        // CHANGE-082: 僅在提供密碼時寫入
        // FIX-090: admin 手動建立的本地帳號（有設密碼）視為可信，直接標記 email 已驗證。
        // 否則登入時會被 auth.config.ts 的 EmailNotVerified 檢查擋住，而系統不會為 admin
        // 建立的帳號發驗證郵件（createUser 不寄信），導致該帳號永遠無法登入。沒設密碼的
        // 帳號走 Azure AD SSO，不經 credentials 的 emailVerified 檢查，不受影響。
        ...(hashedPassword
          ? { password: hashedPassword, emailVerified: new Date() }
          : {}),
      },
    })

    // 2. 建立角色關聯
    await tx.userRole.createMany({
      data: roleIds.map((roleId) => ({
        userId: newUser.id,
        roleId,
        cityId: cityId || null,
      })),
    })

    // 3. 記錄審計日誌
    await tx.auditLog.create({
      data: {
        userId: createdById,
        userName: 'System', // 由系統記錄，實際用戶名在中間件層設置
        action: 'CREATE',
        resourceType: 'user',
        resourceId: newUser.id,
        resourceName: name || email,
        description: `創建用戶 ${email}`,
        metadata: {
          email,
          name,
          roleIds,
          cityId,
          // CHANGE-082: 僅記錄是否設定密碼，絕不記錄密碼明文
          passwordSet: Boolean(hashedPassword),
        },
      },
    })

    // 4. 返回完整用戶資料
    const createdUser = await tx.user.findUnique({
      where: { id: newUser.id },
      include: {
        roles: {
          include: {
            role: { select: { id: true, name: true } },
            city: { select: { id: true, name: true, code: true } },
          },
        },
      },
    })

    if (!createdUser) {
      throw new AppError(
        'internal_error',
        'User Creation Failed',
        500,
        '用戶創建失敗'
      )
    }

    return createdUser
  })

  return user as CreatedUserWithRoles
}

// ============================================================
// Admin 密碼管理（CHANGE-082）
// ============================================================

/**
 * Admin 重設用戶密碼
 *
 * @description
 *   由管理員直接為**本地帳號**設定新密碼（不需舊密碼）。
 *   Azure AD 用戶（azureAdId 存在）不可重設 —— 密碼由 Azure AD 管理。
 *   審計日誌僅記錄重設動作，**絕不記錄密碼明文**。
 *
 * @param userId - 目標用戶 ID
 * @param newPassword - 新密碼（明文，將以 bcrypt hash）
 * @param performedBy - 執行操作的管理員 ID（審計用）
 * @throws AppError 用戶不存在（404）/ Azure AD 帳號（400）/ 密碼強度不足（400）
 */
export async function adminResetPassword(
  userId: string,
  newPassword: string,
  performedBy: string
): Promise<void> {
  // 1. 取得目標用戶（判斷是否本地帳號）
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, azureAdId: true },
  })

  if (!user) {
    throw new AppError('not_found', 'User Not Found', 404, '用戶不存在')
  }

  // 2. Azure AD 用戶不可重設（與 /api/v1/users/me/password 一致）
  if (user.azureAdId) {
    throw new AppError(
      'validation_error',
      'Azure AD Account',
      400,
      '此帳號密碼由 Azure AD 管理，無法在此重設'
    )
  }

  // 3. 密碼強度驗證
  const strength = validatePasswordStrength(newPassword)
  if (!strength.isValid) {
    throw new AppError(
      'validation_error',
      'Weak Password',
      400,
      strength.errors[0] || '密碼強度不足'
    )
  }

  // 4. hash 並更新
  const hashedPassword = await hashPassword(newPassword)
  await prisma.user.update({
    where: { id: userId },
    data: { password: hashedPassword },
  })

  // 5. 審計日誌（不含密碼明文）
  await prisma.auditLog.create({
    data: {
      userId: performedBy,
      userName: 'System',
      action: 'UPDATE',
      resourceType: 'user',
      resourceId: userId,
      resourceName: user.name || user.email,
      description: `重設用戶 ${user.email} 的密碼`,
      metadata: { passwordReset: true },
    },
  })
}

// ============================================================
// Azure AD 同步
// ============================================================

/**
 * 從 Azure AD 同步用戶（創建或更新）
 * @param data - Azure AD 用戶資料
 * @returns 同步後的用戶
 */
export async function syncUserFromAzureAD(
  data: CreateUserFromAzureAD
): Promise<User> {
  const existing = await getUserByEmail(data.email)

  if (existing) {
    // 更新現有用戶
    return prisma.user.update({
      where: { id: existing.id },
      data: {
        name: data.name,
        image: data.image,
        azureAdId: data.azureAdId,
        lastLoginAt: new Date(),
      },
    })
  }

  // 創建新用戶
  return createUserFromAzureAD(data)
}

// ============================================================
// 用戶列表和搜尋（Story 1-3）
// ============================================================

/**
 * 用戶列表查詢參數
 */
export interface GetUsersParams {
  /** 頁碼（從 1 開始）*/
  page: number
  /** 每頁數量 */
  pageSize: number
  /** 搜尋關鍵字（名稱或電子郵件）*/
  search?: string
  /** 角色 ID 篩選 */
  roleId?: string
  /** 城市 ID 篩選 */
  cityId?: string
  /** 狀態篩選 */
  status?: UserStatus
  /** 排序欄位 */
  sortBy?: 'name' | 'email' | 'createdAt' | 'lastLoginAt'
  /** 排序方向 */
  sortOrder?: 'asc' | 'desc'
}

/**
 * 用戶列表項目（含城市資訊）
 */
export interface UserListItemWithCity {
  id: string
  email: string
  name: string | null
  image: string | null
  status: UserStatus
  createdAt: Date
  lastLoginAt: Date | null
  roles: {
    role: {
      id: string
      name: string
    }
    cityId: string | null
    city?: {
      id: string
      name: string
      code: string
    } | null
  }[]
}

/**
 * 用戶列表查詢結果
 */
export interface UsersResult {
  data: UserListItemWithCity[]
  meta: {
    total: number
    page: number
    pageSize: number
    totalPages: number
  }
}

/**
 * 獲取用戶列表（分頁、搜尋、篩選）
 *
 * @description
 *   支援分頁、關鍵字搜尋、角色/城市/狀態篩選、排序
 *   使用 Prisma transaction 確保資料一致性
 *
 * @param params - 查詢參數
 * @returns 用戶列表和分頁資訊
 *
 * @example
 *   const result = await getUsers({
 *     page: 1,
 *     pageSize: 20,
 *     search: 'john',
 *     roleId: 'role-id',
 *   })
 */
export async function getUsers(params: GetUsersParams): Promise<UsersResult> {
  const {
    page = 1,
    pageSize = 20,
    search,
    roleId,
    cityId,
    status,
    sortBy = 'createdAt',
    sortOrder = 'desc',
  } = params

  // 構建 where 條件
  const where: import('@prisma/client').Prisma.UserWhereInput = {
    // 搜尋條件
    ...(search && {
      OR: [
        { name: { contains: search, mode: 'insensitive' as const } },
        { email: { contains: search, mode: 'insensitive' as const } },
      ],
    }),
    // 角色篩選
    ...(roleId && {
      roles: { some: { roleId } },
    }),
    // 城市篩選
    ...(cityId && {
      roles: { some: { cityId } },
    }),
    // 狀態篩選
    ...(status && { status }),
  }

  // 執行並行查詢（資料 + 總數）
  const [data, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { [sortBy]: sortOrder },
      include: {
        roles: {
          include: {
            role: {
              select: { id: true, name: true },
            },
            city: {
              select: { id: true, name: true, code: true },
            },
          },
        },
      },
    }),
    prisma.user.count({ where }),
  ])

  return {
    data: data as UserListItemWithCity[],
    meta: {
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    },
  }
}

/**
 * 獲取所有用戶（含角色資訊）
 * @returns 用戶列表
 */
export async function getAllUsersWithRoles(): Promise<UserWithRoles[]> {
  return prisma.user.findMany({
    orderBy: { name: 'asc' },
    include: {
      roles: {
        include: { role: true },
      },
    },
  })
}

/**
 * 搜尋用戶（分頁）
 * @param params - 搜尋參數
 * @returns 用戶列表和總數
 */
export async function searchUsers(params: {
  search?: string
  status?: UserStatus
  roleId?: string
  page?: number
  limit?: number
}): Promise<{ users: UserWithRoles[]; total: number }> {
  const { search, status, roleId, page = 1, limit = 20 } = params
  const skip = (page - 1) * limit

  const where = {
    AND: [
      // 搜尋條件
      search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { email: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {},
      // 狀態篩選
      status ? { status } : {},
      // 角色篩選
      roleId
        ? {
            roles: {
              some: { roleId },
            },
          }
        : {},
    ],
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: { name: 'asc' },
      include: {
        roles: {
          include: { role: true },
        },
      },
    }),
    prisma.user.count({ where }),
  ])

  return { users, total }
}

// ============================================================
// 用戶狀態檢查
// ============================================================

/**
 * 檢查用戶是否為活躍狀態
 * @param userId - 用戶 ID
 * @returns 是否為活躍狀態
 */
export async function isUserActive(userId: string): Promise<boolean> {
  const user = await getUserById(userId)
  return user?.status === 'ACTIVE'
}

/**
 * 檢查用戶是否可以登入
 * @param userId - 用戶 ID
 * @returns 是否可以登入（只有 ACTIVE 狀態可登入）
 */
export async function canUserLogin(userId: string): Promise<boolean> {
  return isUserActive(userId)
}
