/**
 * @fileoverview 審計查詢 API 端點
 * @description
 *   提供處理記錄的審計查詢功能：
 *   - POST: 執行審計查詢
 *   - 權限控制：僅 AUDITOR 和 GLOBAL_ADMIN 可訪問
 *   - 自動應用城市數據過濾
 *
 * @module src/app/api/audit/query/route
 * @since Epic 8 - Story 8.3 (處理記錄查詢)
 * @lastModified 2025-12-22
 * @refactor REFACTOR-001 (Forwarder → Company)
 *
 * @features
 *   - AC1: 多條件篩選查詢
 *   - AC2: 分頁結果（每頁 50 筆）
 *   - AC4: 大量結果處理（超過 10,000 筆警告）
 *   - AC5: 權限控制
 *
 * @dependencies
 *   - @/lib/auth - 認證功能
 *   - @/middlewares/city-filter - 城市過濾
 *   - @/middlewares/audit-log.middleware - 審計日誌
 *   - @/services/audit-query.service - 審計查詢服務
 */

import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { sessionHasAuditAccess } from '@/lib/auth/has-permission'
import { withCityFilter } from '@/middlewares/city-filter'
import { auditQueryService } from '@/services/audit-query.service'
import { auditQueryParamsSchema } from '@/types/audit-query'
import { ZodError } from 'zod'

// ============================================================
// Handler
// ============================================================

/**
 * 審計查詢處理函數
 *
 * @description
 *   使用 withCityFilter 中間件自動注入城市過濾上下文。
 *   並進行角色權限檢查（僅 AUDITOR 和 GLOBAL_ADMIN 可訪問）。
 */
const queryHandler = withCityFilter(async (request, cityFilter) => {
  // 獲取認證會話
  const session = await auth()

  if (!session?.user) {
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/unauthorized',
        title: 'Unauthorized',
        status: 401,
        detail: 'Authentication required'
      },
      { status: 401 }
    )
  }

  // 權限檢查（FIX-134）：改以 AUDIT_VIEW / AUDIT_EXPORT 權限判斷。
  // 原本比對角色名 ['AUDITOR','GLOBAL_ADMIN']，但實際角色名為 'Auditor' / 'System Admin'，永遠不符。
  if (!sessionHasAuditAccess(session.user)) {
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/forbidden',
        title: 'Forbidden',
        status: 403,
        detail: 'Audit access required. Only AUDITOR and GLOBAL_ADMIN roles can access this resource.'
      },
      { status: 403 }
    )
  }

  try {
    // 解析並驗證請求參數
    const body = await request.json()
    const params = auditQueryParamsSchema.parse(body)

    // 執行查詢
    const result = await auditQueryService.executeQuery(params, cityFilter)

    return NextResponse.json({
      success: true,
      data: result
    })
  } catch (error) {
    // Zod 驗證錯誤
    if (error instanceof ZodError) {
      const errors: Record<string, string[]> = {}
      error.issues.forEach(err => {
        const path = err.path.join('.')
        if (!errors[path]) {
          errors[path] = []
        }
        errors[path].push(err.message)
      })

      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/validation',
          title: 'Validation Error',
          status: 400,
          detail: 'One or more fields failed validation',
          errors
        },
        { status: 400 }
      )
    }

    // 其他錯誤
    console.error('[Audit Query] Error:', error)
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while processing the query'
      },
      { status: 500 }
    )
  }
})

// ============================================================
// Export
// ============================================================

/**
 * POST /api/audit/query
 *
 * 執行審計查詢
 *
 * @description
 *   根據提供的查詢參數，返回符合條件的處理記錄列表。
 *   自動應用城市權限過濾，並記錄審計日誌。
 *
 * @request
 *   - startDate: string (required) - 開始日期 (ISO 8601)
 *   - endDate: string (required) - 結束日期 (ISO 8601)
 *   - cityCodes?: string[] - 城市代碼過濾
 *   - companyIds?: string[] - Company ID 過濾 (REFACTOR-001: 原 forwarderIds)
 *   - statuses?: string[] - 狀態過濾
 *   - operatorIds?: string[] - 操作人員過濾
 *   - searchTerm?: string - 搜尋關鍵字
 *   - page?: number - 頁碼（預設 1）
 *   - pageSize?: number - 每頁筆數（預設 50）
 *   - sortBy?: string - 排序欄位
 *   - sortOrder?: 'asc' | 'desc' - 排序方向
 *
 * @response
 *   200: { success: true, data: AuditQueryResult }
 *   400: Validation error (RFC 7807)
 *   401: Unauthorized
 *   403: Forbidden
 *   500: Internal server error
 */
/**
 * POST /api/audit/query - 執行審計查詢
 */
export const POST = queryHandler
