/**
 * @fileoverview 模版欄位映射配置列表和創建 API
 * @description
 *   提供模版欄位映射配置的列表查詢和創建功能
 *
 *   GET  /api/v1/template-field-mappings - 列出配置（支援篩選和分頁）
 *   POST /api/v1/template-field-mappings - 創建新配置
 *
 * @module src/app/api/v1/template-field-mappings
 * @since Epic 19 - Story 19.1
 * @lastModified 2026-01-22
 *
 * @features
 *   - 支援範圍、公司、格式、啟用狀態篩選
 *   - 支援關鍵字搜尋（名稱、說明）
 *   - 分頁功能
 *   - 創建時驗證範圍與關聯 ID 一致性
 *
 * @dependencies
 *   - templateFieldMappingService - 服務層
 *   - createTemplateFieldMappingSchema - Zod 驗證
 */

import { NextRequest, NextResponse } from 'next/server';
import { templateFieldMappingService } from '@/services/template-field-mapping.service';
import {
  createTemplateFieldMappingSchema,
  templateFieldMappingQuerySchema,
} from '@/validations/template-field-mapping';
import type { TemplateFieldMappingFilters } from '@/types/template-field-mapping';

// ============================================================================
// GET Handler
// ============================================================================

/**
 * GET /api/v1/template-field-mappings
 * @description
 *   列出模版欄位映射配置，支援多種篩選條件和分頁
 *
 * @param request - Next.js 請求物件
 * @returns 配置列表和分頁資訊
 *
 * @example
 *   GET /api/v1/template-field-mappings?dataTemplateId=xxx&scope=GLOBAL&page=1&limit=20
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    // 解析查詢參數
    const queryResult = templateFieldMappingQuerySchema.safeParse({
      dataTemplateId: searchParams.get('dataTemplateId') || undefined,
      scope: searchParams.get('scope') || undefined,
      companyId: searchParams.get('companyId') || undefined,
      documentFormatId: searchParams.get('documentFormatId') || undefined,
      isActive: searchParams.get('isActive') || undefined,
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

    // 查詢配置列表
    const { mappings, total } = await templateFieldMappingService.list(
      filters as TemplateFieldMappingFilters,
      page,
      limit
    );

    return NextResponse.json({
      success: true,
      data: {
        mappings,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('[GET /api/v1/template-field-mappings] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'INTERNAL_ERROR',
          title: '取得映射配置列表失敗',
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
 * POST /api/v1/template-field-mappings
 * @description
 *   創建新的模版欄位映射配置
 *
 * @param request - Next.js 請求物件（包含配置資料）
 * @returns 新建的配置
 *
 * @example
 *   POST /api/v1/template-field-mappings
 *   Body: { dataTemplateId: "xxx", scope: "GLOBAL", name: "...", mappings: [...] }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // 驗證輸入資料
    const result = createTemplateFieldMappingSchema.safeParse(body);

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

    // 創建配置
    const mapping = await templateFieldMappingService.create(result.data);

    // FIX-128: 檢查規則是否引用了不存在的來源 key（警告，不擋儲存）
    const warnings = await templateFieldMappingService.computeUnknownSourceKeyWarnings({
      scope: result.data.scope,
      companyId: result.data.companyId,
      documentFormatId: result.data.documentFormatId,
      rules: result.data.mappings,
    });

    return NextResponse.json(
      {
        success: true,
        data: mapping,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('[POST /api/v1/template-field-mappings] Error:', error);

    // 處理唯一約束違反
    if (error instanceof Error && error.message.includes('unique')) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'CONFLICT',
            title: '配置已存在',
            status: 409,
            detail: '相同範圍和關聯的映射配置已存在',
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
          title: '創建映射配置失敗',
          status: 500,
          detail: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      { status: 500 }
    );
  }
}
