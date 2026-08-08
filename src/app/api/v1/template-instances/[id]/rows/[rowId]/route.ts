/**
 * @fileoverview 模版實例單行 API
 * @description
 *   提供單行數據的更新和刪除功能
 *
 *   PATCH  /api/v1/template-instances/:id/rows/:rowId - 更新行
 *   DELETE /api/v1/template-instances/:id/rows/:rowId - 刪除行
 *
 * @module src/app/api/v1/template-instances/[id]/rows/[rowId]
 * @since Epic 19 - Story 19.2
 * @lastModified 2026-01-22
 *
 * @features
 *   - 更新行數據（自動重新驗證）
 *   - 刪除行（自動更新統計）
 *
 * @dependencies
 *   - templateInstanceService - 服務層
 *   - updateRowSchema - Zod 驗證
 */

import { NextRequest, NextResponse } from 'next/server';
import { templateInstanceService } from '@/services/template-instance.service';
import { updateRowSchema } from '@/validations/template-instance';
import { requireApiSession } from '@/lib/auth/api-session';

// ============================================================================
// Types
// ============================================================================

interface RouteParams {
  params: Promise<{ id: string; rowId: string }>;
}

// ============================================================================
// PATCH Handler
// ============================================================================

/**
 * PATCH /api/v1/template-instances/:id/rows/:rowId
 * @description
 *   更新行數據
 *   如果更新 fieldValues，會自動重新驗證並更新狀態
 *
 * @param request - Next.js 請求物件
 * @param context - 路由參數
 * @returns 更新後的行
 */
export async function PATCH(request: NextRequest, context: RouteParams) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { id, rowId } = await context.params;
    const body = await request.json();

    // 驗證輸入資料
    const result = updateRowSchema.safeParse(body);

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

    // 驗證行是否屬於該實例
    const existingRow = await templateInstanceService.getRowById(rowId);
    if (!existingRow || existingRow.templateInstanceId !== id) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'NOT_FOUND',
            title: '行不存在',
            status: 404,
            detail: `在實例 ${id} 中找不到行 ${rowId}`,
          },
        },
        { status: 404 }
      );
    }

    // 更新行
    const row = await templateInstanceService.updateRow(rowId, result.data);

    return NextResponse.json({
      success: true,
      data: row,
    });
  } catch (error) {
    console.error('[PATCH /api/v1/template-instances/:id/rows/:rowId] Error:', error);

    // 處理行不存在的錯誤
    if (error instanceof Error && error.message.includes('不存在')) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'NOT_FOUND',
            title: '行不存在',
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
          title: '更新行失敗',
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
 * DELETE /api/v1/template-instances/:id/rows/:rowId
 * @description
 *   刪除行
 *   只有 DRAFT 和 ERROR 狀態的實例可以刪除行
 *
 * @param _request - Next.js 請求物件
 * @param context - 路由參數
 * @returns 空響應
 */
export async function DELETE(_request: NextRequest, context: RouteParams) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { id, rowId } = await context.params;

    // 驗證行是否屬於該實例
    const existingRow = await templateInstanceService.getRowById(rowId);
    if (!existingRow || existingRow.templateInstanceId !== id) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'NOT_FOUND',
            title: '行不存在',
            status: 404,
            detail: `在實例 ${id} 中找不到行 ${rowId}`,
          },
        },
        { status: 404 }
      );
    }

    // 刪除行
    await templateInstanceService.deleteRow(rowId);

    return NextResponse.json({
      success: true,
      data: null,
    });
  } catch (error) {
    console.error('[DELETE /api/v1/template-instances/:id/rows/:rowId] Error:', error);

    // 處理行不存在的錯誤
    if (error instanceof Error && error.message.includes('不存在')) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'NOT_FOUND',
            title: '行不存在',
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
          title: '刪除行失敗',
          status: 500,
          detail: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      { status: 500 }
    );
  }
}
