/**
 * @fileoverview 驗證映射配置 API
 * @description
 *   POST /api/v1/template-matching/validate
 *   驗證映射配置是否完整有效
 *
 * @module src/app/api/v1/template-matching/validate
 * @since Epic 19 - Story 19.3
 * @lastModified 2026-01-22
 *
 * @features
 *   - 檢查映射規則是否存在
 *   - 驗證轉換參數是否有效
 *   - 檢查必填欄位是否覆蓋
 *
 * @dependencies
 *   - template-matching-engine.service.ts - 匹配引擎
 *   - template-matching.ts - 驗證 Schema
 */

import { NextRequest, NextResponse } from 'next/server';
import { templateMatchingEngineService } from '@/services/template-matching-engine.service';
import { validateMappingRequestSchema } from '@/validations/template-matching';
import { MatchingEngineError } from '@/types/template-matching-engine';
import { requireApiSession } from '@/lib/auth/api-session';

// ============================================================================
// POST - Validate Mapping Configuration
// ============================================================================

/**
 * 驗證映射配置
 *
 * @description
 *   檢查指定的映射配置是否完整且有效
 *
 * @param request - HTTP 請求
 * @returns 驗證結果
 *
 * @example
 * POST /api/v1/template-matching/validate
 * {
 *   "dataTemplateId": "template1",
 *   "companyId": "company1",
 *   "formatId": "format1"
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    // 1. 解析請求體
    const body = await request.json();

    // 2. 驗證輸入
    const validationResult = validateMappingRequestSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'https://api.example.com/errors/validation',
            title: 'Validation Error',
            status: 400,
            detail: 'One or more fields failed validation',
            errors: validationResult.error.flatten().fieldErrors,
          },
        },
        { status: 400 }
      );
    }

    const { dataTemplateId, companyId, formatId } = validationResult.data;

    // 3. 執行驗證
    const result = await templateMatchingEngineService.validateMapping({
      dataTemplateId,
      companyId,
      formatId,
    });

    // 4. 返回結果
    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error) {
    // 處理特定錯誤
    if (error instanceof MatchingEngineError) {
      const statusMap: Record<string, number> = {
        TEMPLATE_NOT_FOUND: 404,
        MAPPING_NOT_FOUND: 404,
      };

      const status = statusMap[error.code] || 500;

      return NextResponse.json(
        {
          success: false,
          error: {
            type: `https://api.example.com/errors/${error.code.toLowerCase()}`,
            title: error.code,
            status,
            detail: error.message,
            instance: '/api/v1/template-matching/validate',
            ...error.details,
          },
        },
        { status }
      );
    }

    // 通用錯誤處理
    console.error('[Template Matching Validate Error]', error);

    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'https://api.example.com/errors/internal',
          title: 'Internal Server Error',
          status: 500,
          detail: error instanceof Error ? error.message : 'An unexpected error occurred',
          instance: '/api/v1/template-matching/validate',
        },
      },
      { status: 500 }
    );
  }
}
