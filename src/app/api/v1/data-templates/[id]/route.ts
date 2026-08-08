/**
 * @fileoverview 數據模版詳情、更新、刪除 API
 * @description
 *   提供單一數據模版的 CRUD 操作
 *
 *   GET    /api/v1/data-templates/:id - 取得模版詳情
 *   PATCH  /api/v1/data-templates/:id - 更新模版
 *   DELETE /api/v1/data-templates/:id - 刪除模版（軟刪除）
 *
 * @module src/app/api/v1/data-templates/[id]
 * @since Epic 16 - Story 16.7
 * @lastModified 2026-01-13
 *
 * @features
 *   - 系統模版保護（不可修改/刪除）
 *   - 使用中模版保護（不可刪除）
 *   - 軟刪除機制
 *
 * @dependencies
 *   - dataTemplateService - 服務層
 *   - updateDataTemplateSchema - Zod 驗證
 */

import { NextRequest, NextResponse } from 'next/server';
import { dataTemplateService } from '@/services/data-template.service';
import { updateDataTemplateSchema } from '@/validations/data-template';
import { requireApiSession } from '@/lib/auth/api-session';

// ============================================================================
// GET Handler
// ============================================================================

/**
 * GET /api/v1/data-templates/:id
 * @description
 *   取得指定模版的詳細資訊
 *
 * @param request - Next.js 請求物件
 * @param params - 路由參數（包含 id）
 * @returns 模版詳情
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { id } = await params;

    const template = await dataTemplateService.getById(id);

    if (!template) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'NOT_FOUND',
            title: '模版不存在',
            status: 404,
            detail: `找不到 ID 為 ${id} 的數據模版`,
          },
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: template,
    });
  } catch (error) {
    console.error('[GET /api/v1/data-templates/:id] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'INTERNAL_ERROR',
          title: '取得模版詳情失敗',
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
 * PATCH /api/v1/data-templates/:id
 * @description
 *   更新指定模版的資訊
 *   系統模版不可修改
 *
 * @param request - Next.js 請求物件（包含更新資料）
 * @param params - 路由參數（包含 id）
 * @returns 更新後的模版
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { id } = await params;
    const body = await request.json();

    // 驗證輸入資料
    const result = updateDataTemplateSchema.safeParse(body);

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

    // 檢查模版是否存在
    const exists = await dataTemplateService.exists(id);
    if (!exists) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'NOT_FOUND',
            title: '模版不存在',
            status: 404,
            detail: `找不到 ID 為 ${id} 的數據模版`,
          },
        },
        { status: 404 }
      );
    }

    // 更新模版
    const template = await dataTemplateService.update(id, result.data);

    return NextResponse.json({
      success: true,
      data: template,
    });
  } catch (error) {
    console.error('[PATCH /api/v1/data-templates/:id] Error:', error);

    // 檢查是否為業務邏輯錯誤（如系統模版不可修改）
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const isBusinessError = errorMessage.includes('系統模版') || errorMessage.includes('不可');

    return NextResponse.json(
      {
        success: false,
        error: {
          type: isBusinessError ? 'BUSINESS_ERROR' : 'INTERNAL_ERROR',
          title: '更新模版失敗',
          status: isBusinessError ? 400 : 500,
          detail: errorMessage,
        },
      },
      { status: isBusinessError ? 400 : 500 }
    );
  }
}

// ============================================================================
// DELETE Handler
// ============================================================================

/**
 * DELETE /api/v1/data-templates/:id
 * @description
 *   刪除指定模版（軟刪除）
 *   系統模版不可刪除，使用中的模版不可刪除
 *
 * @param request - Next.js 請求物件
 * @param params - 路由參數（包含 id）
 * @returns 刪除結果
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { id } = await params;

    // 檢查模版是否存在
    const exists = await dataTemplateService.exists(id);
    if (!exists) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'NOT_FOUND',
            title: '模版不存在',
            status: 404,
            detail: `找不到 ID 為 ${id} 的數據模版`,
          },
        },
        { status: 404 }
      );
    }

    // 刪除模版
    await dataTemplateService.delete(id);

    return NextResponse.json({
      success: true,
      data: {
        id,
        deleted: true,
      },
    });
  } catch (error) {
    console.error('[DELETE /api/v1/data-templates/:id] Error:', error);

    // 檢查是否為業務邏輯錯誤
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const isBusinessError =
      errorMessage.includes('系統模版') ||
      errorMessage.includes('不可') ||
      errorMessage.includes('使用中');

    return NextResponse.json(
      {
        success: false,
        error: {
          type: isBusinessError ? 'BUSINESS_ERROR' : 'INTERNAL_ERROR',
          title: '刪除模版失敗',
          status: isBusinessError ? 400 : 500,
          detail: errorMessage,
        },
      },
      { status: isBusinessError ? 400 : 500 }
    );
  }
}
