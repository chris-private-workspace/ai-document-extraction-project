/**
 * @fileoverview 確認 PENDING 公司為「全新公司」API
 * @description
 *   CHANGE-103 Phase 2（組件 4）：人工審核判定該 PENDING 公司並非既有公司變體，
 *   將其升為 ACTIVE 並清除疑似重複標記（suspectedDuplicateOfId）。
 *
 * @module src/app/api/companies/pending/[id]/confirm-new/route
 * @since CHANGE-103 Phase 2（組件 4）
 * @lastModified 2026-07-16
 *
 * @related
 *   - src/services/company.service.ts - confirmCompanyAsNew
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { hasPermission } from '@/lib/auth/city-permission'
import { PERMISSIONS } from '@/types/permissions'
import { confirmCompanyAsNew } from '@/services/company.service'
import { apiLogger } from '@/services/logging/logger.service'

interface RouteParams {
  params: Promise<{ id: string }>
}

const ParamsSchema = z.object({
  id: z.string().uuid('Invalid company id format'),
})

// ============================================================
// POST /api/companies/pending/[id]/confirm-new - 確認為全新公司
// ============================================================

export async function POST(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const instance = `/api/companies/pending/${id}/confirm-new`

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

    // 4. 執行確認
    const company = await confirmCompanyAsNew(parsed.data.id)

    return NextResponse.json({
      success: true,
      data: company,
      message: 'Company confirmed as new and activated',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    // 公司不存在
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

    // 公司非 PENDING 狀態（無法確認）
    if (message.includes('not in PENDING status')) {
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
