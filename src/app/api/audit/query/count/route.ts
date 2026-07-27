/**
 * @fileoverview 審計查詢結果計數預覽 API 端點
 * @description
 *   在執行完整查詢前，快速獲取結果數量：
 *   - POST: 獲取符合條件的記錄數量
 *   - 用於檢查是否超過 10,000 筆限制
 *   - 權限控制：僅 AUDITOR 和 GLOBAL_ADMIN 可訪問
 *
 * @module src/app/api/audit/query/count/route
 * @since Epic 8 - Story 8.3 (處理記錄查詢)
 * @lastModified 2025-12-22
 * @refactor REFACTOR-001 (Forwarder → Company)
 *
 * @features
 *   - AC4: 大量結果處理預覽
 *   - AC5: 權限控制
 *
 * @dependencies
 *   - @/lib/auth - 認證功能
 *   - @/middlewares/city-filter - 城市過濾
 *   - @/services/audit-query.service - 審計查詢服務
 */

import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { sessionHasAuditAccess } from '@/lib/auth/has-permission'
import { withCityFilter } from '@/middlewares/city-filter'
import { auditQueryService } from '@/services/audit-query.service'
import { AuditQueryParams } from '@/types/audit-query'

// ============================================================
// Handler
// ============================================================

/**
 * POST /api/audit/query/count
 *
 * 獲取查詢結果計數預覽
 *
 * @description
 *   快速計算符合條件的記錄數量，用於在執行完整查詢前
 *   檢查結果是否超過 10,000 筆限制。
 *
 * @request
 *   - startDate: string (required) - 開始日期 (ISO 8601)
 *   - endDate: string (required) - 結束日期 (ISO 8601)
 *   - cityCodes?: string[] - 城市代碼過濾
 *   - companyIds?: string[] - Company ID 過濾 (REFACTOR-001: 原 forwarderIds)
 *   - statuses?: string[] - 狀態過濾
 *   - operatorIds?: string[] - 操作人員過濾
 *
 * @response
 *   200: { success: true, data: { count: number, exceedsLimit: boolean } }
 *   400: Invalid request
 *   401: Unauthorized
 *   403: Forbidden
 *   500: Internal server error
 */
export const POST = withCityFilter(async (request, cityFilter) => {
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
        detail: 'Audit access required'
      },
      { status: 403 }
    )
  }

  try {
    const body = await request.json()
    const params: AuditQueryParams = body

    // 基本驗證
    if (!params.startDate || !params.endDate) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/validation',
          title: 'Validation Error',
          status: 400,
          detail: 'startDate and endDate are required'
        },
        { status: 400 }
      )
    }

    // 獲取計數預覽
    const preview = await auditQueryService.getResultCountPreview(
      params,
      cityFilter
    )

    return NextResponse.json({
      success: true,
      data: preview
    })
  } catch (error) {
    console.error('[Audit Query Count] Error:', error)
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred'
      },
      { status: 500 }
    )
  }
})
