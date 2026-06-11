/**
 * @fileoverview 當前用戶密碼修改 API
 * @description
 *   僅限本地帳號用戶修改密碼。
 *   Azure AD 用戶不可使用此端點（密碼由 Azure AD 管理）。
 *
 * @module src/app/api/v1/users/me/password
 * @author Development Team
 * @since CHANGE-049 - User Profile Page
 * @lastModified 2026-02-26
 *
 * @api
 *   - POST /api/v1/users/me/password - 修改密碼
 *
 * @related
 *   - src/lib/password.ts - 密碼工具函數
 *   - src/hooks/use-profile.ts - 前端 Hook
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { hashPassword, verifyPassword, validatePasswordStrength } from '@/lib/password'

// ============================================================
// Validation Schema
// ============================================================

/**
 * 密碼修改驗證 Schema
 */
const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z.string().min(8, 'New password must be at least 8 characters'),
    confirmPassword: z.string().min(1, 'Confirm password is required'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })

// ============================================================
// API Handlers
// ============================================================

/**
 * POST /api/v1/users/me/password
 * 修改當前用戶密碼（僅限本地帳號）
 *
 * @param request - Next.js Request 物件
 * @returns 成功或錯誤訊息
 *
 * @example Request
 * ```json
 * {
 *   "currentPassword": "OldPass123",
 *   "newPassword": "NewPass456",
 *   "confirmPassword": "NewPass456"
 * }
 * ```
 */
export async function POST(request: NextRequest) {
  try {
    // 1. 驗證認證
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'https://api.example.com/errors/unauthorized',
            title: 'Unauthorized',
            status: 401,
            detail: 'Authentication required',
          },
        },
        { status: 401 }
      )
    }

    // 2. 查詢用戶（取得 provider 和密碼 hash）
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        azureAdId: true,
        password: true,
      },
    })

    if (!user) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'https://api.example.com/errors/not-found',
            title: 'Not Found',
            status: 404,
            detail: 'User not found',
          },
        },
        { status: 404 }
      )
    }

    // 3. 檢查是否為本地帳號
    if (user.azureAdId) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'https://api.example.com/errors/bad-request',
            title: 'Bad Request',
            status: 400,
            detail:
              'Password is managed by Azure AD. Please use your organization portal to change it.',
          },
        },
        { status: 400 }
      )
    }

    // 4. 解析和驗證請求
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'https://api.example.com/errors/invalid-json',
            title: 'Invalid JSON',
            status: 400,
            detail: 'Request body must be valid JSON',
          },
        },
        { status: 400 }
      )
    }

    const validationResult = ChangePasswordSchema.safeParse(body)
    if (!validationResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'https://api.example.com/errors/validation',
            title: 'Validation Error',
            status: 400,
            detail: 'Invalid input data',
            errors: validationResult.error.flatten().fieldErrors,
          },
        },
        { status: 400 }
      )
    }

    const { currentPassword, newPassword } = validationResult.data

    // 5. 驗證舊密碼
    if (!user.password) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'https://api.example.com/errors/bad-request',
            title: 'Bad Request',
            status: 400,
            detail: 'No password set for this account',
          },
        },
        { status: 400 }
      )
    }

    const isCurrentPasswordValid = await verifyPassword(
      currentPassword,
      user.password
    )
    if (!isCurrentPasswordValid) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'https://api.example.com/errors/bad-request',
            title: 'Bad Request',
            status: 400,
            detail: 'Current password is incorrect',
          },
        },
        { status: 400 }
      )
    }

    // 6. 驗證新密碼強度
    const strengthResult = validatePasswordStrength(newPassword)
    if (!strengthResult.isValid) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'https://api.example.com/errors/validation',
            title: 'Validation Error',
            status: 400,
            detail: 'New password does not meet requirements',
            errors: { newPassword: strengthResult.errors },
          },
        },
        { status: 400 }
      )
    }

    // 7. 加密並更新密碼
    const hashedPassword = await hashPassword(newPassword)
    await prisma.user.update({
      where: { id: session.user.id },
      // FIX-074: 改密成功一併清除強制改密旗標
      data: { password: hashedPassword, mustChangePassword: false },
    })

    // 8. 返回成功
    return NextResponse.json({
      success: true,
      data: { message: 'Password changed successfully' },
    })
  } catch (error) {
    console.error('Failed to change password:', error)
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'https://api.example.com/errors/internal',
          title: 'Internal Server Error',
          status: 500,
          detail: 'Failed to change password',
        },
      },
      { status: 500 }
    )
  }
}
