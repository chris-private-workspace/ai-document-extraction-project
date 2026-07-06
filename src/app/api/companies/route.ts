/**
 * @fileoverview Companies API Routes - List and Create
 * @description
 *   處理 Company 列表查詢和創建的 API 端點
 *   支援多種公司類型 (FORWARDER, EXPORTER, CARRIER 等)
 *
 * @module src/app/api/companies
 * @since REFACTOR-001 (Forwarder → Company)
 * @lastModified 2025-12-22
 *
 * @features
 *   - GET: 分頁查詢 Company 列表，支援多種篩選條件
 *   - POST: 創建新 Company
 *   - 支援按類型 (type) 篩選
 *   - 支援按來源 (source) 篩選
 *
 * @related
 *   - src/services/company.service.ts - Company 服務層
 *   - src/types/company.ts - Company 類型定義
 */

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import {
  getCompanies,
  createCompany,
  type CreateCompanyInput,
} from '@/services/company.service'
import {
  CompaniesQuerySchema,
  CreateCompanySchema,
  type ValidatedCompaniesQuery,
} from '@/types/company'
import { ZodError } from 'zod'

// ============================================================
// GET /api/companies - 獲取 Company 列表
// ============================================================

export async function GET(request: NextRequest) {
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
          instance: '/api/companies',
        },
        { status: 401 }
      )
    }

    // 2. 解析查詢參數
    const { searchParams } = new URL(request.url)
    const queryParams: Record<string, string | undefined> = {
      page: searchParams.get('page') ?? undefined,
      limit: searchParams.get('limit') ?? undefined,
      search: searchParams.get('search') ?? undefined,
      status: searchParams.get('status') ?? undefined,
      type: searchParams.get('type') ?? undefined,
      source: searchParams.get('source') ?? undefined,
      city: searchParams.get('city') ?? undefined,
      sortBy: searchParams.get('sortBy') ?? undefined,
      sortOrder: searchParams.get('sortOrder') ?? undefined,
    }

    // 移除 undefined 值
    const cleanedParams = Object.fromEntries(
      Object.entries(queryParams).filter(([, v]) => v !== undefined)
    )

    // 3. 驗證查詢參數
    const validatedQuery: ValidatedCompaniesQuery = CompaniesQuerySchema.parse(cleanedParams)

    // 4. 獲取 Company 列表
    const result = await getCompanies(validatedQuery)

    // 5. 返回結果
    return NextResponse.json({
      success: true,
      data: result.data,
      meta: {
        pagination: result.pagination,
      },
    })
  } catch (error) {
    // Zod 驗證錯誤
    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/validation',
          title: 'Validation Error',
          status: 400,
          detail: 'Query parameters validation failed',
          instance: '/api/companies',
          errors: error.flatten().fieldErrors,
        },
        { status: 400 }
      )
    }

    // 其他錯誤
    console.error('[API] GET /api/companies error:', error)
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred',
        instance: '/api/companies',
      },
      { status: 500 }
    )
  }
}

// ============================================================
// POST /api/companies - 創建新 Company
// ============================================================

export async function POST(request: NextRequest) {
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
          instance: '/api/companies',
        },
        { status: 401 }
      )
    }

    // 2. 解析請求體（FIX-102: 支援 multipart/form-data 的 'data' JSON blob 與純 JSON，與 PUT 一致）
    const contentType = request.headers.get('content-type') || ''
    let body: unknown
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData()
      const jsonData = formData.get('data')
      body = typeof jsonData === 'string' ? JSON.parse(jsonData) : {}
      // Logo 上傳暫未實現（與 PUT 一致）
    } else {
      body = await request.json()
    }

    // 3. 驗證請求數據
    const validatedData = CreateCompanySchema.parse(body)

    // 4. 創建 Company
    const createInput: CreateCompanyInput = {
      ...validatedData,
      createdById: session.user.id,
    }
    const company = await createCompany(createInput)

    // 5. 返回創建結果
    return NextResponse.json(
      {
        success: true,
        data: company,
      },
      { status: 201 }
    )
  } catch (error) {
    // Zod 驗證錯誤
    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/validation',
          title: 'Validation Error',
          status: 400,
          detail: 'Request body validation failed',
          instance: '/api/companies',
          errors: error.flatten().fieldErrors,
        },
        { status: 400 }
      )
    }

    // 業務錯誤（如代碼重複）
    if (error instanceof Error && error.message.includes('already exists')) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/conflict',
          title: 'Conflict',
          status: 409,
          detail: error.message,
          instance: '/api/companies',
        },
        { status: 409 }
      )
    }

    // 其他錯誤
    console.error('[API] POST /api/companies error:', error)
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred',
        instance: '/api/companies',
      },
      { status: 500 }
    )
  }
}
