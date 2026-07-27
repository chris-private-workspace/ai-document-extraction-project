/**
 * @fileoverview 確認 PENDING 公司併入疑似目標 API
 * @description
 *   CHANGE-103 Phase 2（組件 4）：人工審核判定該 PENDING 公司是其 suspectedDuplicateOfId
 *   目標公司的變體，執行完整合併（documents + extractionResults + mappingRules 轉移、
 *   nameVariants 合併、來源設為 MERGED）。
 *
 * @module src/app/api/companies/pending/[id]/confirm-merge/route
 * @since CHANGE-103 Phase 2（組件 4）
 * @lastModified 2026-07-16
 *
 * @related
 *   - src/services/company.service.ts - confirmCompanyMerge
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { hasPermission } from '@/lib/auth/city-permission'
import { PERMISSIONS } from '@/types/permissions'
import { confirmCompanyMerge } from '@/services/company.service'
import { apiLogger } from '@/services/logging/logger.service'

interface RouteParams {
  params: Promise<{ id: string }>
}

const ParamsSchema = z.object({
  id: z.string().uuid('Invalid company id format'),
})

// ============================================================
// POST /api/companies/pending/[id]/confirm-merge - 併入疑似目標
// ============================================================

export async function POST(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const instance = `/api/companies/pending/${id}/confirm-merge`

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
          instance,
        },
        { status: 401 }
      )
    }

    // 2. 檢查權限
    if (!hasPermission(session.user, PERMISSIONS.FORWARDER_MANAGE)) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'Insufficient permissions to review pending companies',
          instance,
        },
        { status: 403 }
      )
    }

    // 3. 驗證路徑參數
    const parsed = ParamsSchema.safeParse({ id })
    if (!parsed.success) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/validation',
          title: 'Validation Error',
          status: 400,
          detail: 'Invalid company id',
          instance,
          errors: parsed.error.flatten().fieldErrors,
        },
        { status: 400 }
      )
    }

    // 4. 執行合併
    const result = await confirmCompanyMerge(parsed.data.id)

    return NextResponse.json({
      success: true,
      data: result,
      message: 'Company confirmed as duplicate and merged into suspected target',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    // 公司（或目標公司）不存在
    if (message.includes('not found')) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/not-found',
          title: 'Not Found',
          status: 404,
          detail: message,
          instance,
        },
        { status: 404 }
      )
    }

    // 公司非 PENDING 狀態，或無疑似重複目標（無法合併）
    if (
      message.includes('not in PENDING status') ||
      message.includes('no suspectedDuplicateOfId')
    ) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/conflict',
          title: 'Conflict',
          status: 409,
          detail: message,
          instance,
        },
        { status: 409 }
      )
    }

    await apiLogger.error(
      `POST ${instance} failed`,
      error instanceof Error ? error : undefined
    )
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred',
        instance,
      },
      { status: 500 }
    )
  }
}
