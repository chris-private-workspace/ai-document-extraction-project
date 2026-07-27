/**
 * @fileoverview 審計報告任務詳情 API 端點
 * @description
 *   提供單一報告任務的詳情查詢功能：
 *   - GET: 取得報告任務詳情
 *   - 權限控制：僅 AUDITOR 和 GLOBAL_ADMIN 可訪問
 *
 * @module src/app/api/audit/reports/[jobId]/route
 * @since Epic 8 - Story 8.5 (審計報告匯出)
 * @lastModified 2025-12-22
 * @refactor REFACTOR-001 (Forwarder → Company)
 *
 * @features
 *   - AC3: 報告進度追蹤
 *   - 查看報告詳情和下載記錄
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

// ============================================================
// Handler
// ============================================================

/**
 * GET /api/audit/reports/[jobId]
 *
 * 取得報告任務詳情
 *
 * @description
 *   返回指定報告任務的完整詳情，包含下載記錄。
 *
 * @response
 *   200: { success: true, data: AuditReportDetailResponse }
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

    // 取得報告詳情
    const job = await auditReportService.getReportJob(jobId)

    // 檢查是否為該用戶建立的報告（或全域管理員）
    const isGlobalAdmin = session.user.roles?.some(r => r.name === 'GLOBAL_ADMIN')
    if (job.requestedById !== session.user.id && !isGlobalAdmin) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'You can only view reports created by yourself'
        },
        { status: 403 }
      )
    }

    return NextResponse.json({
      success: true,
      data: {
        job: {
          id: job.id,
          reportType: job.reportType,
          outputFormat: job.outputFormat,
          title: job.title,
          queryParams: job.queryParams,
          dateFrom: job.dateFrom,
          dateTo: job.dateTo,
          cityIds: job.cityIds,
          companyIds: job.companyIds, // REFACTOR-001: 原 forwarderIds
          includedFields: job.includedFields,
          includeChanges: job.includeChanges,
          includeFiles: job.includeFiles,
          status: job.status,
          progress: job.progress,
          totalRecords: job.totalRecords,
          processedRecords: job.processedRecords,
          fileUrl: job.fileUrl,
          fileSize: job.fileSize,
          checksum: job.checksum,
          digitalSignature: job.digitalSignature,
          errorMessage: job.errorMessage,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          expiresAt: job.expiresAt,
        },
        downloads: job.downloads.map(d => ({
          id: d.id,
          downloadedAt: d.downloadedAt,
          downloadedBy: {
            id: d.downloadedBy.id,
            name: d.downloadedBy.name,
            email: d.downloadedBy.email,
          },
          ipAddress: d.ipAddress,
          userAgent: d.userAgent,
        })),
        requestedBy: {
          id: job.requestedBy.id,
          name: job.requestedBy.name,
          email: job.requestedBy.email,
        }
      }
    })
  } catch (error) {
    // 檢查是否為不存在的記錄
    if (error instanceof Error && error.message.includes('No AuditReportJob found')) {
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

    // 其他錯誤
    console.error('[Audit Reports] GET [jobId] Error:', error)
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while fetching report job details'
      },
      { status: 500 }
    )
  }
}
