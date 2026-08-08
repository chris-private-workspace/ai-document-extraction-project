/**
 * @fileoverview 模版實例行列表和添加 API
 * @description
 *   提供模版實例行數據的列表查詢和添加功能
 *
 *   GET  /api/v1/template-instances/:id/rows - 分頁取得行數據
 *   POST /api/v1/template-instances/:id/rows - 添加新行
 *
 * @module src/app/api/v1/template-instances/[id]/rows
 * @since Epic 19 - Story 19.2
 * @lastModified 2026-01-22
 *
 * @features
 *   - 分頁取得行數據
 *   - 按狀態和關鍵字篩選
 *   - 添加行時自動驗證和更新統計
 *
 * @dependencies
 *   - templateInstanceService - 服務層
 *   - addRowSchema - Zod 驗證
 */

import { NextRequest, NextResponse } from 'next/server';
import { templateInstanceService } from '@/services/template-instance.service';
import {
  addRowSchema,
  templateInstanceRowQuerySchema,
} from '@/validations/template-instance';
import type { TemplateInstanceRowFilters } from '@/types/template-instance';
import { requireApiSession } from '@/lib/auth/api-session';

// ============================================================================
// Types
// ============================================================================

interface RouteParams {
  params: Promise<{ id: string }>;
}

// ============================================================================
// GET Handler
// ============================================================================

/**
 * GET /api/v1/template-instances/:id/rows
 * @description
 *   分頁取得實例的行數據
 *
 * @param request - Next.js 請求物件
 * @param context - 路由參數
 * @returns 行列表和分頁資訊
 *
 * @example
 *   GET /api/v1/template-instances/xxx/rows?status=VALID&page=1&limit=50
 */
export async function GET(request: NextRequest, context: RouteParams) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    // 先檢查實例是否存在
    const exists = await templateInstanceService.exists(id);
    if (!exists) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'NOT_FOUND',
            title: '實例不存在',
            status: 404,
            detail: `找不到 ID 為 ${id} 的模版實例`,
          },
        },
        { status: 404 }
      );
    }

    // 解析查詢參數
    const queryResult = templateInstanceRowQuerySchema.safeParse({
      status: searchParams.get('status') || undefined,
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

    // 查詢行列表
    const { rows, total } = await templateInstanceService.getRows(
      id,
      filters as TemplateInstanceRowFilters,
      page,
      limit
    );

    return NextResponse.json({
      success: true,
      data: {
        rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('[GET /api/v1/template-instances/:id/rows] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'INTERNAL_ERROR',
          title: '取得行列表失敗',
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
 * POST /api/v1/template-instances/:id/rows
 * @description
 *   添加新行到實例
 *   會自動驗證欄位值並更新實例統計
 *
 * @param request - Next.js 請求物件（包含行數據）
 * @param context - 路由參數
 * @returns 新建的行
 *
 * @example
 *   POST /api/v1/template-instances/xxx/rows
 *   Body: { rowKey: "S001", fieldValues: { shipment_no: "S001", cost: 500 } }
 */
export async function POST(request: NextRequest, context: RouteParams) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { id } = await context.params;
    const body = await request.json();

    // 驗證輸入資料
    const result = addRowSchema.safeParse(body);

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

    // 添加行
    const row = await templateInstanceService.addRow(id, result.data);

    return NextResponse.json(
      {
        success: true,
        data: row,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('[POST /api/v1/template-instances/:id/rows] Error:', error);

    // 處理實例不存在的錯誤
    if (error instanceof Error && error.message.includes('實例不存在')) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'NOT_FOUND',
            title: '實例不存在',
            status: 404,
            detail: error.message,
          },
        },
        { status: 404 }
      );
    }

    // 處理狀態不允許添加的錯誤
    if (error instanceof Error && error.message.includes('不可添加')) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'CONFLICT',
            title: '無法添加行',
            status: 409,
            detail: error.message,
          },
        },
        { status: 409 }
      );
    }

    // 處理 rowKey 重複的錯誤
    if (error instanceof Error && error.message.includes('已存在')) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'CONFLICT',
            title: '行識別碼重複',
            status: 409,
            detail: error.message,
          },
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'INTERNAL_ERROR',
          title: '添加行失敗',
          status: 500,
          detail: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      { status: 500 }
    );
  }
}
