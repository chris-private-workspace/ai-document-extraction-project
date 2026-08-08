/**
 * @fileoverview 模版實例詳情 API
 * @description
 *   提供單一模版實例的詳情、更新、刪除功能
 *
 *   GET    /api/v1/template-instances/:id - 取得實例詳情
 *   PATCH  /api/v1/template-instances/:id - 更新實例
 *   DELETE /api/v1/template-instances/:id - 刪除實例（只允許 DRAFT 狀態）
 *
 * @module src/app/api/v1/template-instances/[id]
 * @since Epic 19 - Story 19.2
 * @lastModified 2026-01-22
 *
 * @features
 *   - 取得完整實例資訊
 *   - 部分更新實例元數據
 *   - 刪除實例（只有 DRAFT 可刪除）
 *
 * @dependencies
 *   - templateInstanceService - 服務層
 *   - updateTemplateInstanceSchema - Zod 驗證
 */

import { NextRequest, NextResponse } from 'next/server';
import { templateInstanceService } from '@/services/template-instance.service';
import { updateTemplateInstanceSchema } from '@/validations/template-instance';
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
 * GET /api/v1/template-instances/:id
 * @description
 *   取得模版實例詳情，包含完整的 DataTemplate 欄位定義
 *
 * @param request - Next.js 請求物件
 * @param context - 路由參數
 * @returns 實例詳情（含 DataTemplate）
 */
export async function GET(request: NextRequest, context: RouteParams) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { id } = await context.params;
    const { searchParams } = new URL(request.url);
    const includeTemplate = searchParams.get('includeTemplate') !== 'false';

    // 根據是否需要 template 資訊選擇不同的方法
    const instance = includeTemplate
      ? await templateInstanceService.getByIdWithTemplate(id)
      : await templateInstanceService.getById(id);

    if (!instance) {
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

    return NextResponse.json({
      success: true,
      data: instance,
    });
  } catch (error) {
    console.error('[GET /api/v1/template-instances/:id] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'INTERNAL_ERROR',
          title: '取得實例失敗',
          status: 500,
          detail: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      { status: 500 }
    );
  }
}

// ============================================================================
// PATCH Handler
// ============================================================================

/**
 * PATCH /api/v1/template-instances/:id
 * @description
 *   更新模版實例（部分更新）
 *   只有 DRAFT 和 ERROR 狀態的實例可以編輯
 *
 * @param request - Next.js 請求物件
 * @param context - 路由參數
 * @returns 更新後的實例
 */
export async function PATCH(request: NextRequest, context: RouteParams) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { id } = await context.params;
    const body = await request.json();

    // 驗證輸入資料
    const result = updateTemplateInstanceSchema.safeParse(body);

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

    // 更新實例
    const instance = await templateInstanceService.update(id, result.data);

    return NextResponse.json({
      success: true,
      data: instance,
    });
  } catch (error) {
    console.error('[PATCH /api/v1/template-instances/:id] Error:', error);

    // 處理實例不存在的錯誤
    if (error instanceof Error && error.message.includes('不存在')) {
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

    // 處理狀態不允許編輯的錯誤
    if (error instanceof Error && error.message.includes('不可編輯')) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'CONFLICT',
            title: '無法編輯',
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
          title: '更新實例失敗',
          status: 500,
          detail: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      { status: 500 }
    );
  }
}

// ============================================================================
// DELETE Handler
// ============================================================================

/**
 * DELETE /api/v1/template-instances/:id
 * @description
 *   刪除模版實例
 *   只有 DRAFT 狀態的實例可以刪除
 *
 * @param _request - Next.js 請求物件
 * @param context - 路由參數
 * @returns 空響應
 */
export async function DELETE(_request: NextRequest, context: RouteParams) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { id } = await context.params;

    await templateInstanceService.delete(id);

    return NextResponse.json({
      success: true,
      data: null,
    });
  } catch (error) {
    console.error('[DELETE /api/v1/template-instances/:id] Error:', error);

    // 處理實例不存在的錯誤
    if (error instanceof Error && error.message.includes('不存在')) {
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

    // 處理狀態不允許刪除的錯誤
    if (error instanceof Error && error.message.includes('不可刪除')) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'CONFLICT',
            title: '無法刪除',
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
          title: '刪除實例失敗',
          status: 500,
          detail: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      { status: 500 }
    );
  }
}
