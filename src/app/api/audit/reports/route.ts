/**
 * @fileoverview 審計報告 API 端點
 * @description
 *   提供審計報告生成和管理功能：
 *   - POST: 建立報告任務
 *   - GET: 取得報告任務列表
 *   - 權限控制：需 AUDIT_VIEW 或 AUDIT_EXPORT 權限（FIX-134：原以角色名稱
 *     `['AUDITOR','GLOBAL_ADMIN']` 比對，但實際角色名為 `Auditor` / `System Admin`，永遠不符）
 *
 * @module src/app/api/audit/reports/route
 * @since Epic 8 - Story 8.5 (審計報告匯出)
 * @lastModified 2025-12-22
 * @refactor REFACTOR-001 (Forwarder → Company)
 *
 * @features
 *   - AC1: 報告配置選項（類型、欄位、日期範圍）
 *   - AC2: 多格式匯出（Excel、PDF、CSV、JSON）
 *   - AC3: 大量數據背景處理
 *
 * @dependencies
 *   - @/lib/auth - 認證功能
 *   - @/services/audit-report.service - 審計報告服務
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { sessionHasAuditAccess } from '@/lib/auth/has-permission'
import { auditReportService } from '@/services/audit-report.service'
import type { AuditReportConfig } from '@/types/audit-report'
import type { AuditReportType, ReportOutputFormat, ReportJobStatus2 } from '@prisma/client'

// ============================================================
// Validation Schemas
// ============================================================

const createReportSchema = z.object({
  reportType: z.enum(['PROCESSING_RECORDS', 'CHANGE_HISTORY', 'FULL_AUDIT', 'COMPLIANCE_SUMMARY']),
  outputFormat: z.enum(['EXCEL', 'PDF', 'CSV', 'JSON']),
  title: z.string().min(1).max(200),
  dateRange: z.object({
    from: z.string().datetime(),
    to: z.string().datetime(),
  }),
  filters: z.object({
    cityIds: z.array(z.string()).optional(),
    companyIds: z.array(z.string()).optional(), // REFACTOR-001: 原 forwarderIds
    userIds: z.array(z.string()).optional(),
    statuses: z.array(z.string()).optional(),
  }).optional(),
  includedFields: z.array(z.string()).optional(),
  includeChanges: z.boolean().optional(),
  includeFiles: z.boolean().optional(),
})

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['PENDING', 'QUEUED', 'PROCESSING', 'GENERATING', 'SIGNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']).optional(),
  reportType: z.enum(['PROCESSING_RECORDS', 'CHANGE_HISTORY', 'FULL_AUDIT', 'COMPLIANCE_SUMMARY']).optional(),
})

// ============================================================
// Helper Functions
// ============================================================

/**
 * 創建 Zod 驗證錯誤響應
 */
function createValidationErrorResponse(error: z.ZodError) {
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

// ============================================================
// Handlers
// ============================================================

/**
 * POST /api/audit/reports
 *
 * 建立審計報告任務
 *
 * @description
 *   根據配置建立報告生成任務。大量數據（>5000筆）
 *   將進入背景處理佇列。
 *
 * @request
 *   - reportType: string (required) - 報告類型
 *   - outputFormat: string (required) - 輸出格式
 *   - title: string (required) - 報告標題
 *   - dateRange: { from, to } (required) - 日期範圍
 *   - filters?: object - 過濾條件
 *   - includedFields?: string[] - 包含的欄位
 *   - includeChanges?: boolean - 是否包含變更歷史
 *   - includeFiles?: boolean - 是否包含文件清單
 *
 * @response
 *   201: { success: true, data: CreateAuditReportResponse }
 *   400: Validation error (RFC 7807)
 *   401: Unauthorized
 *   403: Forbidden
 *   500: Internal server error
 */
export async function POST(request: NextRequest) {
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

    // 解析並驗證請求
    const body = await request.json()
    const validated = createReportSchema.parse(body)

    // 構建報告配置
    const config: AuditReportConfig = {
      reportType: validated.reportType as AuditReportType,
      outputFormat: validated.outputFormat as ReportOutputFormat,
      title: validated.title,
      dateRange: validated.dateRange,
      filters: validated.filters || {},
      includedFields: validated.includedFields || [],
      includeChanges: validated.includeChanges ?? true,
      includeFiles: validated.includeFiles ?? true,
    }

    // 建立報告任務
    const result = await auditReportService.createReportJob(config, session.user.id)

    return NextResponse.json(
      {
        success: true,
        data: {
          jobId: result.jobId,
          isAsync: result.isAsync,
          estimatedRecords: result.estimatedRecords,
          message: result.isAsync
            ? '報告任務已排入佇列，請稍後查詢進度'
            : '報告正在生成中，請稍候'
        }
      },
      { status: 201 }
    )
  } catch (error) {
    // Zod 驗證錯誤
    if (error instanceof z.ZodError) {
      return createValidationErrorResponse(error)
    }

    // 其他錯誤
    console.error('[Audit Reports] POST Error:', error)
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while creating the report job'
      },
      { status: 500 }
    )
  }
}

/**
 * GET /api/audit/reports
 *
 * 取得審計報告任務列表
 *
 * @description
 *   返回當前用戶建立的報告任務列表，支援分頁和狀態過濾。
 *
 * @query
 *   - page?: number - 頁碼（預設 1）
 *   - limit?: number - 每頁筆數（預設 20，最大 100）
 *   - status?: string - 狀態過濾
 *   - reportType?: string - 報告類型過濾
 *
 * @response
 *   200: { success: true, data: AuditReportListResponse }
 *   401: Unauthorized
 *   403: Forbidden
 *   500: Internal server error
 */
export async function GET(request: NextRequest) {
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

    // 解析查詢參數
    const { searchParams } = new URL(request.url)
    const query = {
      page: searchParams.get('page') || '1',
      limit: searchParams.get('limit') || '20',
      status: searchParams.get('status'),
      reportType: searchParams.get('reportType'),
    }

    const validated = listQuerySchema.parse({
      page: query.page,
      limit: query.limit,
      status: query.status || undefined,
      reportType: query.reportType || undefined,
    })

    // 取得報告列表
    const result = await auditReportService.getReportJobs(session.user.id, {
      page: validated.page,
      limit: validated.limit,
      status: validated.status as ReportJobStatus2 | undefined,
    })

    return NextResponse.json({
      success: true,
      data: {
        items: result.items.map(item => ({
          id: item.id,
          title: item.title,
          reportType: item.reportType,
          outputFormat: item.outputFormat,
          status: item.status,
          progress: item.progress,
          totalRecords: item.totalRecords,
          createdAt: item.createdAt,
          completedAt: item.completedAt,
          expiresAt: item.expiresAt,
          downloadCount: item.downloadCount,
        })),
        pagination: result.pagination
      }
    })
  } catch (error) {
    // Zod 驗證錯誤
    if (error instanceof z.ZodError) {
      return createValidationErrorResponse(error)
    }

    // 其他錯誤
    console.error('[Audit Reports] GET Error:', error)
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while fetching report jobs'
      },
      { status: 500 }
    )
  }
}
