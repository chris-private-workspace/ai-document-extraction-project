/**
 * @fileoverview 模版實例列表和創建 API
 * @description
 *   提供模版實例的列表查詢和創建功能
 *
 *   GET  /api/v1/template-instances - 列出實例（支援篩選和分頁）
 *   POST /api/v1/template-instances - 創建新實例
 *
 * @module src/app/api/v1/template-instances
 * @since Epic 19 - Story 19.2
 * @lastModified 2026-01-22
 *
 * @features
 *   - 支援數據模版、狀態、日期範圍篩選
 *   - 支援關鍵字搜尋（名稱、說明）
 *   - 分頁功能
 *   - 創建時驗證數據模版存在且啟用
 *
 * @dependencies
 *   - templateInstanceService - 服務層
 *   - createTemplateInstanceSchema - Zod 驗證
 */

import { NextRequest, NextResponse } from 'next/server';
import { templateInstanceService } from '@/services/template-instance.service';
import {
  createTemplateInstanceSchema,
  templateInstanceQuerySchema,
} from '@/validations/template-instance';
import type { TemplateInstanceFilters } from '@/types/template-instance';
import { requireApiSession } from '@/lib/auth/api-session';

// ============================================================================
// GET Handler
// ============================================================================

/**
 * GET /api/v1/template-instances
 * @description
 *   列出模版實例，支援多種篩選條件和分頁
 *
 * @param request - Next.js 請求物件
 * @returns 實例列表和分頁資訊
 *
 * @example
 *   GET /api/v1/template-instances?dataTemplateId=xxx&status=DRAFT&page=1&limit=20
 */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { searchParams } = new URL(request.url);

    // 解析查詢參數
    const queryResult = templateInstanceQuerySchema.safeParse({
      dataTemplateId: searchParams.get('dataTemplateId') || undefined,
      status: searchParams.get('status') || undefined,
      search: searchParams.get('search') || undefined,
      dateFrom: searchParams.get('dateFrom') || undefined,
      dateTo: searchParams.get('dateTo') || undefined,
      createdBy: searchParams.get('createdBy') || undefined,
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

    // 查詢實例列表
    const { instances, total } = await templateInstanceService.list(
      filters as TemplateInstanceFilters,
      page,
      limit
    );

    return NextResponse.json({
      success: true,
      data: {
        instances,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('[GET /api/v1/template-instances] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'INTERNAL_ERROR',
          title: '取得實例列表失敗',
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
 * POST /api/v1/template-instances
 * @description
 *   創建新的模版實例
 *
 * @param request - Next.js 請求物件（包含實例資料）
 * @returns 新建的實例
 *
 * @example
 *   POST /api/v1/template-instances
 *   Body: { dataTemplateId: "xxx", name: "2026年1月費用", description: "..." }
 */
export async function POST(request: NextRequest) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const body = await request.json();

    // 驗證輸入資料
    const result = createTemplateInstanceSchema.safeParse(body);

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

    // 創建實例
    const instance = await templateInstanceService.create(result.data);

    return NextResponse.json(
      {
        success: true,
        data: instance,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('[POST /api/v1/template-instances] Error:', error);

    // 處理數據模版不存在或已停用的錯誤
    if (error instanceof Error && (error.message.includes('不存在') || error.message.includes('已停用'))) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'BAD_REQUEST',
            title: '創建實例失敗',
            status: 400,
            detail: error.message,
          },
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'INTERNAL_ERROR',
          title: '創建實例失敗',
          status: 500,
          detail: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      { status: 500 }
    );
  }
}
