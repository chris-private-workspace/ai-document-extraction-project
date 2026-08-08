/**
 * @fileoverview 預覽模版匹配 API
 * @description
 *   POST /api/v1/template-matching/preview
 *   預覽文件匹配結果（不實際創建數據）
 *
 * @module src/app/api/v1/template-matching/preview
 * @since Epic 19 - Story 19.3
 * @lastModified 2026-01-22
 *
 * @features
 *   - 預覽轉換結果
 *   - 預覽驗證結果
 *   - 不實際寫入數據
 *
 * @dependencies
 *   - template-matching-engine.service.ts - 匹配引擎
 *   - template-matching.ts - 驗證 Schema
 */

import { NextRequest, NextResponse } from 'next/server';
import { templateMatchingEngineService } from '@/services/template-matching-engine.service';
import { previewMatchRequestSchema } from '@/validations/template-matching';
import { MatchingEngineError } from '@/types/template-matching-engine';
import { requireApiSession } from '@/lib/auth/api-session';

// ============================================================================
// POST - Preview Template Matching
// ============================================================================

/**
 * 預覽模版匹配
 *
 * @description
 *   預覽文件匹配結果，用於用戶確認轉換是否正確
 *
 * @param request - HTTP 請求
 * @returns 預覽結果
 *
 * @example
 * POST /api/v1/template-matching/preview
 * {
 *   "documentIds": ["doc1", "doc2"],
 *   "dataTemplateId": "template1",
 *   "companyId": "company1",
 *   "rowKeyField": "shipment_no"
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    // 1. 解析請求體
    const body = await request.json();

    // 2. 驗證輸入
    const validationResult = previewMatchRequestSchema.safeParse(body);

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

    const { documentIds, dataTemplateId, companyId, formatId, rowKeyField } = validationResult.data;

    // 3. 執行預覽
    const result = await templateMatchingEngineService.previewMatch({
      documentIds,
      dataTemplateId,
      companyId,
      formatId,
      rowKeyField,
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
        DOCUMENT_NOT_FOUND: 404,
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
            instance: '/api/v1/template-matching/preview',
            ...error.details,
          },
        },
        { status }
      );
    }

    // 通用錯誤處理
    console.error('[Template Matching Preview Error]', error);

    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'https://api.example.com/errors/internal',
          title: 'Internal Server Error',
          status: 500,
          detail: error instanceof Error ? error.message : 'An unexpected error occurred',
          instance: '/api/v1/template-matching/preview',
        },
      },
      { status: 500 }
    );
  }
}
