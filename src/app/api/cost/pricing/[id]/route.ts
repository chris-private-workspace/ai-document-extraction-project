/**
 * @fileoverview API 計價配置詳情 API
 * @description
 *   提供單個計價配置的詳情查詢和更新功能：
 *   - 獲取計價配置詳情（含變更歷史）
 *   - 更新計價配置（自動記錄變更歷史）
 *
 *   ## 權限控制
 *   僅系統管理員可以更新計價配置。
 *
 * @module src/app/api/cost/pricing/[id]
 * @since Epic 7 - Story 7.8 (城市 AI 成本追蹤)
 * @lastModified 2025-12-19
 *
 * @features
 *   - AC9: 計價配置詳情查詢
 *   - AC10: 計價配置更新
 *   - AC11: 變更歷史追蹤
 *
 * @dependencies
 *   - @/services/city-cost.service - 城市成本服務
 *   - zod - 請求驗證
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { hasPermission } from '@/lib/auth/city-permission'
import { PERMISSIONS } from '@/types/permissions'
import { cityCostService } from '@/services/city-cost.service'
import type { CityCostApiResponse, PricingConfigDetailResponse, ApiPricingConfig } from '@/types/city-cost'

// ============================================================
// Validation Schema
// ============================================================

/**
 * 更新計價配置請求驗證 Schema
 */
const updatePricingSchema = z.object({
  pricePerCall: z.number().min(0).nullable().optional(),
  pricePerInputToken: z.number().min(0).nullable().optional(),
  pricePerOutputToken: z.number().min(0).nullable().optional(),
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  isActive: z.boolean().optional(),
  changeReason: z.string().max(500).optional(),
})

// ============================================================
// Route Handlers
// ============================================================

/**
 * GET /api/cost/pricing/[id]
 *
 * @description
 *   獲取單個計價配置的詳細信息，包含變更歷史。
 *
 * @param id - 計價配置 ID
 *
 * @returns {CityCostApiResponse<PricingConfigDetailResponse>}
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    // 驗證認證
    const session = await auth()
    if (!session?.user) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Unauthorized',
          },
        },
        { status: 401 }
      )
    }

    // 檢查權限（計價配置含內部用戶 ID 變更歷史，屬高敏感資料）
    if (!hasPermission(session.user, PERMISSIONS.ADMIN_MANAGE)) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Forbidden',
          },
        },
        { status: 403 }
      )
    }

    const { id } = await params

    // 獲取計價配置詳情
    const detail = await cityCostService.getPricingConfigDetail(id)

    if (!detail) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Pricing configuration not found',
          },
        },
        { status: 404 }
      )
    }

    // 返回成功響應
    const response: CityCostApiResponse<PricingConfigDetailResponse> = {
      success: true,
      data: detail,
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('[Pricing Config Detail API] Error:', error)
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch pricing configuration detail',
        },
      },
      { status: 500 }
    )
  }
}

/**
 * PATCH /api/cost/pricing/[id]
 *
 * @description
 *   更新計價配置。
 *   更新會自動記錄到變更歷史。
 *   僅系統管理員可以執行此操作。
 *
 * @param id - 計價配置 ID
 *
 * @body
 *   - pricePerCall: 每次呼叫價格（可選）
 *   - pricePerInputToken: 每輸入 token 價格（可選）
 *   - pricePerOutputToken: 每輸出 token 價格（可選）
 *   - effectiveTo: 生效結束時間（可選，YYYY-MM-DD）
 *   - isActive: 是否啟用（可選）
 *   - changeReason: 變更原因（可選）
 *
 * @returns {CityCostApiResponse<ApiPricingConfig>}
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    // 驗證認證
    const session = await auth()
    if (!session?.user) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Unauthorized',
          },
        },
        { status: 401 }
      )
    }

    // 檢查權限（僅系統管理員可更新計價配置）
    if (!hasPermission(session.user, PERMISSIONS.ADMIN_MANAGE)) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Forbidden',
          },
        },
        { status: 403 }
      )
    }

    const { id } = await params

    // 解析請求體
    const body = await request.json()
    const validation = updatePricingSchema.safeParse(body)

    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: validation.error.issues,
          },
        },
        { status: 400 }
      )
    }

    // 更新計價配置（變更歸屬於當前認證用戶）
    const changedBy = session.user.id
    const config = await cityCostService.updatePricingConfig(id, validation.data, changedBy)

    if (!config) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Pricing configuration not found',
          },
        },
        { status: 404 }
      )
    }

    // 返回成功響應
    const response: CityCostApiResponse<ApiPricingConfig> = {
      success: true,
      data: config,
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('[Pricing Config Update API] Error:', error)
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to update pricing configuration',
        },
      },
      { status: 500 }
    )
  }
}
