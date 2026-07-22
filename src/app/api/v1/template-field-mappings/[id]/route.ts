/**
 * @fileoverview 模版欄位映射配置詳情 API
 * @description
 *   提供單一映射配置的詳情、更新、刪除功能
 *
 *   GET    /api/v1/template-field-mappings/:id - 取得配置詳情
 *   PATCH  /api/v1/template-field-mappings/:id - 更新配置
 *   DELETE /api/v1/template-field-mappings/:id - 刪除配置（軟刪除）
 *
 * @module src/app/api/v1/template-field-mappings/[id]
 * @since Epic 19 - Story 19.1
 * @lastModified 2026-01-22
 *
 * @features
 *   - 取得完整配置資訊（含映射規則）
 *   - 部分更新配置
 *   - 軟刪除（設為非啟用）
 *
 * @dependencies
 *   - templateFieldMappingService - 服務層
 *   - updateTemplateFieldMappingSchema - Zod 驗證
 */

import { NextRequest, NextResponse } from 'next/server';
import { templateFieldMappingService } from '@/services/template-field-mapping.service';
import { updateTemplateFieldMappingSchema } from '@/validations/template-field-mapping';

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
 * GET /api/v1/template-field-mappings/:id
 * @description
 *   取得映射配置詳情，包含完整的映射規則列表
 *
 * @param _request - Next.js 請求物件
 * @param context - 路由參數
 * @returns 配置詳情
 */
export async function GET(_request: NextRequest, context: RouteParams) {
  try {
    const { id } = await context.params;

    const mapping = await templateFieldMappingService.getById(id);

    if (!mapping) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'NOT_FOUND',
            title: '映射配置不存在',
            status: 404,
            detail: `找不到 ID 為 ${id} 的映射配置`,
          },
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: mapping,
    });
  } catch (error) {
    console.error('[GET /api/v1/template-field-mappings/:id] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'INTERNAL_ERROR',
          title: '取得映射配置失敗',
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
 * PATCH /api/v1/template-field-mappings/:id
 * @description
 *   更新映射配置（部分更新）
 *   不能更改範圍和關聯（dataTemplateId, scope, companyId, documentFormatId）
 *
 * @param request - Next.js 請求物件
 * @param context - 路由參數
 * @returns 更新後的配置
 */
export async function PATCH(request: NextRequest, context: RouteParams) {
  try {
    const { id } = await context.params;
    const body = await request.json();

    // 驗證輸入資料
    const result = updateTemplateFieldMappingSchema.safeParse(body);

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

    // 更新配置
    const mapping = await templateFieldMappingService.update(id, result.data);

    // FIX-128: 規則有變更時，檢查是否引用了不存在的來源 key（警告，不擋儲存）
    const warnings = result.data.mappings
      ? await templateFieldMappingService.computeUnknownSourceKeyWarnings({
          scope: mapping.scope,
          companyId: mapping.companyId,
          documentFormatId: mapping.documentFormatId,
          rules: result.data.mappings,
        })
      : [];

    return NextResponse.json({
      success: true,
      data: mapping,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } catch (error) {
    console.error('[PATCH /api/v1/template-field-mappings/:id] Error:', error);

    // 處理配置不存在的錯誤
    if (error instanceof Error && error.message.includes('不存在')) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'NOT_FOUND',
            title: '映射配置不存在',
            status: 404,
            detail: error.message,
          },
        },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'INTERNAL_ERROR',
          title: '更新映射配置失敗',
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
 * DELETE /api/v1/template-field-mappings/:id
 * @description
 *   刪除映射配置（軟刪除，設為非啟用）
 *
 * @param _request - Next.js 請求物件
 * @param context - 路由參數
 * @returns 空響應
 */
export async function DELETE(_request: NextRequest, context: RouteParams) {
  try {
    const { id } = await context.params;

    await templateFieldMappingService.delete(id);

    return NextResponse.json({
      success: true,
      data: null,
    });
  } catch (error) {
    console.error('[DELETE /api/v1/template-field-mappings/:id] Error:', error);

    // 處理配置不存在的錯誤
    if (error instanceof Error && error.message.includes('不存在')) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'NOT_FOUND',
            title: '映射配置不存在',
            status: 404,
            detail: error.message,
          },
        },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'INTERNAL_ERROR',
          title: '刪除映射配置失敗',
          status: 500,
          detail: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      { status: 500 }
    );
  }
}
