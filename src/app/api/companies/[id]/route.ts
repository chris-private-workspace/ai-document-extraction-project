/**
 * @fileoverview Company Detail API Routes - Get and Update
 * @description
 *   處理單一 Company 的查詢和更新
 *   支援 Logo 上傳 (FormData)
 *
 * @module src/app/api/companies/[id]
 * @since REFACTOR-001 (Forwarder → Company)
 * @lastModified 2025-12-22
 *
 * @features
 *   - GET: 獲取單一 Company 詳情
 *   - PUT: 更新 Company 資料
 *   - 支援 Logo 文件上傳
 *
 * @related
 *   - src/services/company.service.ts - Company 服務層
 *   - src/types/company.ts - Company 類型定義
 */

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import {
  getCompanyById,
  updateCompany,
  type UpdateCompanyInput,
} from '@/services/company.service'
import { UpdateCompanySchema } from '@/types/company'
import { logAudit } from '@/lib/audit'
import { ZodError } from 'zod'

interface RouteParams {
  params: Promise<{ id: string }>
}

// ============================================================
// GET /api/companies/[id] - 獲取單一 Company
// ============================================================

export async function GET(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { id } = await params

    // 1. 驗證用戶身份
    const session = await auth()
    if (!session?.user) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: 'Authentication required',
          instance: `/api/companies/${id}`,
        },
        { status: 401 }
      )
    }

    // 2. 獲取 Company
    const company = await getCompanyById(id)

    if (!company) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/not-found',
          title: 'Not Found',
          status: 404,
          detail: `Company with id '${id}' not found`,
          instance: `/api/companies/${id}`,
        },
        { status: 404 }
      )
    }

    // 3. 返回結果
    return NextResponse.json({
      success: true,
      data: company,
    })
  } catch (error) {
    const { id } = await params
    console.error(`[API] GET /api/companies/${id} error:`, error)
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred',
        instance: `/api/companies/${id}`,
      },
      { status: 500 }
    )
  }
}

// ============================================================
// PUT /api/companies/[id] - 更新 Company
// ============================================================

export async function PUT(
  request: NextRequest,
  { params }: RouteParams
) {
  const { id } = await params

  try {
    // 1. 驗證用戶身份
    const session = await auth()
    if (!session?.user) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: 'Authentication required',
          instance: `/api/companies/${id}`,
        },
        { status: 401 }
      )
    }

    // 2. 檢查 Company 是否存在
    const existingCompany = await getCompanyById(id)
    if (!existingCompany) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/not-found',
          title: 'Not Found',
          status: 404,
          detail: `Company with id '${id}' not found`,
          instance: `/api/companies/${id}`,
        },
        { status: 404 }
      )
    }

    // 3. 解析請求體
    const contentType = request.headers.get('content-type') || ''
    let updateData: UpdateCompanyInput

    if (contentType.includes('multipart/form-data')) {
      // FormData (含 Logo 上傳)
      const formData = await request.formData()
      const jsonData = formData.get('data')

      if (typeof jsonData === 'string') {
        updateData = JSON.parse(jsonData)
      } else {
        updateData = {}
      }

      // 處理 Logo 文件
      const logoFile = formData.get('logo') as File | null
      if (logoFile) {
        // TODO: 實現文件上傳到 Azure Blob Storage
        // 暫時跳過 Logo 處理
        console.log('[API] Logo upload not implemented yet:', logoFile.name)
      }
    } else {
      // JSON 請求體
      updateData = await request.json()
    }

    // 4. 驗證更新數據
    const validatedData: UpdateCompanyInput = UpdateCompanySchema.parse(updateData)

    // 5. 更新 Company
    const updatedCompany = await updateCompany(id, validatedData)

    // 5b. CHANGE-095: code 由空補填為有值時寫入稽核記錄
    if (
      (existingCompany.code === null || existingCompany.code === '') &&
      updatedCompany.code
    ) {
      const userId = (session.user as { id: string }).id
      await logAudit({
        userId,
        action: 'FORWARDER_UPDATED',
        entityType: 'Forwarder',
        entityId: id,
        details: {
          field: 'code',
          before: existingCompany.code ?? null,
          after: updatedCompany.code,
        },
        ipAddress: request.headers.get('x-forwarded-for') ?? undefined,
      })
    }

    // 6. 返回結果
    return NextResponse.json({
      success: true,
      data: updatedCompany,
    })
  } catch (error) {
    // Zod 驗證錯誤
    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/validation',
          title: 'Validation Error',
          status: 400,
          detail: 'Request body validation failed',
          instance: `/api/companies/${id}`,
          errors: error.flatten().fieldErrors,
        },
        { status: 400 }
      )
    }

    // 業務錯誤
    if (error instanceof Error && error.message.includes('already exists')) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/conflict',
          title: 'Conflict',
          status: 409,
          detail: error.message,
          instance: `/api/companies/${id}`,
        },
        { status: 409 }
      )
    }

    // CHANGE-095: 嘗試修改已設定的 code（違反「只補空值」政策）
    if (error instanceof Error && error.message.includes('cannot be modified')) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/bad-request',
          title: 'Bad Request',
          status: 400,
          detail: error.message,
          instance: `/api/companies/${id}`,
        },
        { status: 400 }
      )
    }

    // 其他錯誤
    console.error(`[API] PUT /api/companies/${id} error:`, error)
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred',
        instance: `/api/companies/${id}`,
      },
      { status: 500 }
    )
  }
}
