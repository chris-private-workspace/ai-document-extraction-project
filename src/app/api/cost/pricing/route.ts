/**
 * @fileoverview API 計價配置管理 API
 * @description
 *   提供 API 計價配置的列表和創建功能：
 *   - 列出所有計價配置（支援過濾和分頁）
 *   - 創建新的計價配置
 *
 *   ## 權限控制
 *   僅系統管理員可以創建計價配置。
 *
 * @module src/app/api/cost/pricing
 * @since Epic 7 - Story 7.8 (城市 AI 成本追蹤)
 * @lastModified 2025-12-19
 *
 * @features
 *   - AC7: 計價配置列表查詢
 *   - AC8: 創建新計價配置
 *   - 支援分頁和過濾
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
import type { CityCostApiResponse, PricingConfigListResponse, ApiPricingConfig } from '@/types/city-cost'

// ============================================================
// Validation Schemas
// ============================================================

/**
 * 列表查詢參數驗證 Schema
 */
const listQuerySchema = z.object({
  provider: z.enum(['AZURE_DOC_INTELLIGENCE', 'OPENAI', 'AZURE_OPENAI']).optional(),
  activeOnly: z.enum(['true', 'false']).optional(),
  page: z.string().regex(/^\d+$/).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
})

/**
 * 創建計價配置請求驗證 Schema
 */
const createPricingSchema = z.object({
  provider: z.enum(['AZURE_DOC_INTELLIGENCE', 'OPENAI', 'AZURE_OPENAI']),
  operation: z.string().min(1).max(100),
  pricePerCall: z.number().min(0).optional(),
  pricePerInputToken: z.number().min(0).optional(),
  pricePerOutputToken: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

// ============================================================
// Route Handlers
// ============================================================

/**
 * GET /api/cost/pricing
 *
 * @description
 *   獲取計價配置列表。
 *
 * @query
 *   - provider: 提供者過濾（AZURE_DOC_INTELLIGENCE/OPENAI/AZURE_OPENAI，可選）
 *   - activeOnly: 是否只顯示啟用的配置（true/false，可選）
 *   - page: 頁碼（可選，預設 1）
 *   - limit: 每頁數量（可選，預設 20）
 *
 * @returns {CityCostApiResponse<PricingConfigListResponse>}
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
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

    // 檢查權限（計價配置屬高敏感資料）
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

    // 解析查詢參數
    const searchParams = Object.fromEntries(request.nextUrl.searchParams)
    const validation = listQuerySchema.safeParse(searchParams)

    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request parameters',
            details: validation.error.issues,
          },
        },
        { status: 400 }
      )
    }

    // 獲取計價配置列表
    const result = await cityCostService.getPricingConfigs({
      provider: validation.data.provider as 'AZURE_DOC_INTELLIGENCE' | 'OPENAI' | 'AZURE_OPENAI' | undefined,
      activeOnly: validation.data.activeOnly === 'true',
      page: validation.data.page ? parseInt(validation.data.page, 10) : undefined,
      limit: validation.data.limit ? parseInt(validation.data.limit, 10) : undefined,
    })

    // 返回成功響應
    const response: CityCostApiResponse<PricingConfigListResponse> = {
      success: true,
      data: result,
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('[Pricing Config List API] Error:', error)
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch pricing configurations',
        },
      },
      { status: 500 }
    )
  }
}

/**
 * POST /api/cost/pricing
 *
 * @description
 *   創建新的計價配置。
 *   僅系統管理員可以執行此操作。
 *
 * @body
 *   - provider: API 提供者（必填）
 *   - operation: 操作類型（必填）
 *   - pricePerCall: 每次呼叫價格（可選）
 *   - pricePerInputToken: 每輸入 token 價格（可選）
 *   - pricePerOutputToken: 每輸出 token 價格（可選）
 *   - currency: 貨幣（可選，預設 USD）
 *   - effectiveFrom: 生效起始時間（必填，YYYY-MM-DD）
 *
 * @returns {CityCostApiResponse<ApiPricingConfig>}
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
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

    // 檢查權限（僅系統管理員可創建計價配置）
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

    // 解析請求體
    const body = await request.json()
    const validation = createPricingSchema.safeParse(body)

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

    // 創建計價配置
    const config = await cityCostService.createPricingConfig(validation.data)

    // 返回成功響應
    const response: CityCostApiResponse<ApiPricingConfig> = {
      success: true,
      data: config,
    }

    return NextResponse.json(response, { status: 201 })
  } catch (error) {
    console.error('[Pricing Config Create API] Error:', error)
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to create pricing configuration',
        },
      },
      { status: 500 }
    )
  }
}
