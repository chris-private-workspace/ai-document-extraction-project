/**
 * @fileoverview PENDING 疑似重複公司審核佇列 API
 * @description
 *   CHANGE-103 Phase 2（組件 4）：列出灰帶 JIT 建立的 PENDING 公司審核佇列。
 *   僅回傳 status=PENDING 且 suspectedDuplicateOfId 非空的公司，附帶：
 *   - 該 PENDING 公司的文件數
 *   - 疑似重複目標公司（id / name / displayName / 文件數）
 *
 * @module src/app/api/companies/pending/route
 * @since CHANGE-103 Phase 2（組件 4）
 * @lastModified 2026-07-16
 *
 * @related
 *   - src/services/company.service.ts - listPendingReviewCompanies
 *   - src/app/api/companies/pending/[id]/confirm-new/route.ts - 確認為新公司
 *   - src/app/api/companies/pending/[id]/confirm-merge/route.ts - 併入疑似目標
 */

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { hasPermission } from '@/lib/auth/city-permission'
import { PERMISSIONS } from '@/types/permissions'
import { listPendingReviewCompanies } from '@/services/company.service'
import { apiLogger } from '@/services/logging/logger.service'

const INSTANCE = '/api/companies/pending'

// ============================================================
// GET /api/companies/pending - 待審核 PENDING 公司佇列
// ============================================================

/**
 * 取得 PENDING 疑似重複公司審核佇列
 *
 * @param request - Next.js 請求對象
 * @returns 待審核公司列表
 */
export async function GET(_request: NextRequest) {
  try {
    // 1. 驗證認證
    const session = await auth()
    if (!session?.user) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: 'Authentication required',
          instance: INSTANCE,
        },
        { status: 401 }
      )
    }

    // 2. 檢查權限
    if (!hasPermission(session.user, PERMISSIONS.FORWARDER_VIEW)) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'Insufficient permissions to view pending companies',
          instance: INSTANCE,
        },
        { status: 403 }
      )
    }

    // 3. 查詢審核佇列
    const companies = await listPendingReviewCompanies()

    return NextResponse.json({
      success: true,
      data: {
        companies: companies.map((company) => ({
          id: company.id,
          name: company.name,
          displayName: company.displayName,
          firstSeenAt: company.createdAt.toISOString(),
          documentCount: company.documentCount,
          suspectedDuplicateOf: company.suspectedDuplicateOf,
        })),
        total: companies.length,
      },
    })
  } catch (error) {
    await apiLogger.error(
      'GET /api/companies/pending failed',
      error instanceof Error ? error : undefined
    )
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred',
        instance: INSTANCE,
      },
      { status: 500 }
    )
  }
}
