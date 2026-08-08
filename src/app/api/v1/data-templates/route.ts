/**
 * @fileoverview 數據模版列表和創建 API
 * @description
 *   提供數據模版的列表查詢和創建功能
 *
 *   GET  /api/v1/data-templates - 列出模版（支援篩選和分頁）
 *   POST /api/v1/data-templates - 創建新模版
 *
 * @module src/app/api/v1/data-templates
 * @since Epic 16 - Story 16.7
 * @lastModified 2026-01-13
 *
 * @features
 *   - 支援範圍、公司、啟用狀態篩選
 *   - 支援關鍵字搜尋（名稱、說明）
 *   - 分頁功能
 *   - 創建時驗證欄位唯一性
 *
 * @dependencies
 *   - dataTemplateService - 服務層
 *   - createDataTemplateSchema - Zod 驗證
 */

import { NextRequest, NextResponse } from 'next/server';
import { dataTemplateService } from '@/services/data-template.service';
import {
  createDataTemplateSchema,
  dataTemplateQuerySchema,
} from '@/validations/data-template';
import type { DataTemplateFilters } from '@/types/data-template';
import { requireApiSession } from '@/lib/auth/api-session';

// ============================================================================
// GET Handler
// ============================================================================

/**
 * GET /api/v1/data-templates
 * @description
 *   列出數據模版，支援多種篩選條件和分頁
 *
 * @param request - Next.js 請求物件
 * @returns 模版列表和分頁資訊
 *
 * @example
 *   GET /api/v1/data-templates?scope=GLOBAL&isActive=true&page=1&limit=20
 */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { searchParams } = new URL(request.url);

    // 解析查詢參數
    const queryResult = dataTemplateQuerySchema.safeParse({
      scope: searchParams.get('scope') || undefined,
      companyId: searchParams.get('companyId') || undefined,
      isActive: searchParams.get('isActive') || undefined,
      isSystem: searchParams.get('isSystem') || undefined,
      search: searchParams.get('search') || undefined,
      page: searchParams.get('page') || 1,
      limit: searchParams.get('limit') || 20,
    });

    if (!queryResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'VALIDATION_ERROR',
            title: '查詢參數驗證失敗',
            status: 400,
            details: queryResult.error.flatten().fieldErrors,
          },
        },
        { status: 400 }
      );
    }

    const { page, limit, ...filters } = queryResult.data;

    // 查詢模版列表
    const { templates, total } = await dataTemplateService.list(
      filters as DataTemplateFilters,
      page,
      limit
    );

    return NextResponse.json({
      success: true,
      data: {
        templates,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('[GET /api/v1/data-templates] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'INTERNAL_ERROR',
          title: '取得模版列表失敗',
          status: 500,
          detail: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      { status: 500 }
    );
  }
}

// ============================================================================
// POST Handler
// ============================================================================

/**
 * POST /api/v1/data-templates
 * @description
 *   創建新的數據模版
 *
 * @param request - Next.js 請求物件（包含模版資料）
 * @returns 新建的模版
 *
 * @example
 *   POST /api/v1/data-templates
 *   Body: { name: "ERP 格式", scope: "GLOBAL", fields: [...] }
 */
export async function POST(request: NextRequest) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const body = await request.json();

    // 驗證輸入資料
    const result = createDataTemplateSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'VALIDATION_ERROR',
            title: '輸入資料驗證失敗',
            status: 400,
            details: result.error.flatten().fieldErrors,
          },
        },
        { status: 400 }
      );
    }

    // 創建模版
    const template = await dataTemplateService.create(result.data);

    return NextResponse.json(
      {
        success: true,
        data: template,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('[POST /api/v1/data-templates] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'INTERNAL_ERROR',
          title: '創建模版失敗',
          status: 500,
          detail: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      { status: 500 }
    );
  }
}
