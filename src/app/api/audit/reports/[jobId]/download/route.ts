/**
 * @fileoverview 審計報告下載 API 端點
 * @description
 *   提供報告下載功能：
 *   - GET: 取得報告下載 URL
 *   - 自動記錄下載追蹤
 *   - 權限控制：僅 AUDITOR 和 GLOBAL_ADMIN 可訪問
 *
 * @module src/app/api/audit/reports/[jobId]/download/route
 * @since Epic 8 - Story 8.5 (審計報告匯出)
 * @lastModified 2025-12-20
 *
 * @features
 *   - AC4: 報告下載與追蹤
 *   - 生成簽名 URL（24小時有效）
 *   - 記錄下載審計日誌
 *
 * @dependencies
 *   - @/lib/auth - 認證功能
 *   - @/services/audit-report.service - 審計報告服務
 */

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { sessionHasAuditAccess } from '@/lib/auth/has-permission'
import { auditReportService } from '@/services/audit-report.service'

// ============================================================
// Types
// ============================================================

interface RouteParams {
  params: Promise<{ jobId: string }>
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * 取得客戶端 IP
 */
function getClientIp(request: NextRequest): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    return forwarded.split(',')[0].trim()
  }
  return request.headers.get('x-real-ip') || undefined
}

// ============================================================
// Handler
// ============================================================

/**
 * GET /api/audit/reports/[jobId]/download
 *
 * 取得報告下載 URL
 *
 * @description
 *   生成報告的簽名下載 URL（24小時有效），
 *   並記錄下載審計日誌。
 *
 * @response
 *   200: { success: true, data: DownloadReportResponse }
 *   400: Report not ready or expired
 *   401: Unauthorized
 *   403: Forbidden
 *   404: Not found
 *   500: Internal server error
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    // 認證檢查
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

    // 權限檢查
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

    const { jobId } = await params

    // 取得客戶端資訊
    const ipAddress = getClientIp(request)
    const userAgent = request.headers.get('user-agent') || undefined

    // 下載報告
    const result = await auditReportService.downloadReport(
      jobId,
      session.user.id,
      ipAddress,
      userAgent
    )

    // FIX-085: server-side 串流檔案 bytes。Storage 私有端點，瀏覽器無法直連 blob SAS URL，
    // 改由 app 經私有端點下載後串流（稽核紀錄已在 downloadReport 內寫入）。
    return new NextResponse(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Content-Length': String(result.buffer.length),
        'Content-Disposition': `attachment; filename="${encodeURIComponent(result.fileName)}"`,
        'X-Report-Checksum': result.checksum,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    // 檢查具體錯誤類型
    if (error instanceof Error) {
      if (error.message.includes('No AuditReportJob found')) {
        return NextResponse.json(
          {
            type: 'https://api.example.com/errors/not-found',
            title: 'Not Found',
            status: 404,
            detail: 'Report job not found'
          },
          { status: 404 }
        )
      }

      if (error.message === '報告尚未完成') {
        return NextResponse.json(
          {
            type: 'https://api.example.com/errors/bad-request',
            title: 'Bad Request',
            status: 400,
            detail: 'Report is not yet completed. Please wait for the report to be generated.'
          },
          { status: 400 }
        )
      }

      if (error.message === '報告已過期') {
        return NextResponse.json(
          {
            type: 'https://api.example.com/errors/bad-request',
            title: 'Bad Request',
            status: 400,
            detail: 'Report has expired. Please generate a new report.'
          },
          { status: 400 }
        )
      }

      if (error.message === '報告檔案不存在') {
        return NextResponse.json(
          {
            type: 'https://api.example.com/errors/not-found',
            title: 'Not Found',
            status: 404,
            detail: 'Report file not found'
          },
          { status: 404 }
        )
      }
    }

    // 其他錯誤
    console.error('[Audit Reports] Download Error:', error)
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while preparing the download'
      },
      { status: 500 }
    )
  }
}
