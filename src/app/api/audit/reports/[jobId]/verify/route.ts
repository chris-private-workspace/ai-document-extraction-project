/**
 * @fileoverview 審計報告完整性驗證 API 端點
 * @description
 *   提供報告完整性驗證功能：
 *   - POST: 驗證報告 checksum 和數位簽章
 *   - 權限控制：僅 AUDITOR 和 GLOBAL_ADMIN 可訪問
 *
 * @module src/app/api/audit/reports/[jobId]/verify/route
 * @since Epic 8 - Story 8.5 (審計報告匯出)
 * @lastModified 2025-12-20
 *
 * @features
 *   - AC5: 報告完整性驗證
 *   - SHA-256 checksum 比對
 *   - 數位簽章驗證
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

// ============================================================
// Types
// ============================================================

interface RouteParams {
  params: Promise<{ jobId: string }>
}

// ============================================================
// Validation Schemas
// ============================================================

const verifySchema = z.object({
  fileContent: z.string().describe('Base64 encoded file content'),
})

// ============================================================
// Helper Functions
// ============================================================

/**
 * 檢查用戶是否具有審計權限
 */
// ============================================================
// Handler
// ============================================================

/**
 * POST /api/audit/reports/[jobId]/verify
 *
 * 驗證報告完整性
 *
 * @description
 *   驗證報告的 SHA-256 checksum 和數位簽章，
 *   確保報告內容未被篡改。
 *
 * @request
 *   - fileContent: string (required) - Base64 編碼的檔案內容
 *
 * @response
 *   200: { success: true, data: VerifyReportResponse }
 *   400: Validation error
 *   401: Unauthorized
 *   403: Forbidden
 *   404: Not found
 *   500: Internal server error
 */
export async function POST(
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

    // 解析並驗證請求
    const body = await request.json()
    const validated = verifySchema.parse(body)

    // 解碼 Base64 內容
    const fileBuffer = Buffer.from(validated.fileContent, 'base64')

    // 驗證報告完整性
    const result = await auditReportService.verifyReportIntegrity(jobId, fileBuffer)

    return NextResponse.json({
      success: true,
      data: {
        isValid: result.isValid,
        details: {
          checksumMatch: result.details.checksumMatch,
          signatureValid: result.details.signatureValid,
          originalChecksum: result.details.originalChecksum,
          calculatedChecksum: result.details.calculatedChecksum,
        },
        verifiedAt: new Date().toISOString(),
      }
    })
  } catch (error) {
    // Zod 驗證錯誤
    if (error instanceof z.ZodError) {
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
    console.error('[Audit Reports] Verify Error:', error)
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while verifying the report'
      },
      { status: 500 }
    )
  }
}
