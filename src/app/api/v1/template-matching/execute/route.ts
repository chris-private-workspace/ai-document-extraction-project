/**
 * @fileoverview 執行模版匹配 API
 * @description
 *   POST /api/v1/template-matching/execute
 *   將文件數據匹配並填入模版實例
 *
 * @module src/app/api/v1/template-matching/execute
 * @since Epic 19 - Story 19.3
 * @lastModified 2026-01-22
 *
 * @features
 *   - 批量文件處理
 *   - 映射規則解析
 *   - 數據驗證
 *   - 統計結果返回
 *
 * @dependencies
 *   - template-matching-engine.service.ts - 匹配引擎
 *   - template-matching.ts - 驗證 Schema
 */

import { NextRequest, NextResponse } from 'next/server';
import { templateMatchingEngineService } from '@/services/template-matching-engine.service';
import { executeMatchRequestSchema } from '@/validations/template-matching';
import { MatchingEngineError } from '@/types/template-matching-engine';
import { requireApiSession } from '@/lib/auth/api-session';

// ============================================================================
// POST - Execute Template Matching
// ============================================================================

/**
 * 執行模版匹配
 *
 * @description
 *   將指定文件的 mappedFields 轉換並填入模版實例
 *
 * @param request - HTTP 請求
 * @returns 匹配結果
 *
 * @example
 * POST /api/v1/template-matching/execute
 * {
 *   "documentIds": ["doc1", "doc2"],
 *   "templateInstanceId": "inst1",
 *   "options": {
 *     "rowKeyField": "shipment_no",
 *     "batchSize": 100
 *   }
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    // 1. 解析請求體
    const body = await request.json();

    // 2. 驗證輸入
    const validationResult = executeMatchRequestSchema.safeParse(body);

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

    const { documentIds, templateInstanceId, options } = validationResult.data;

    // 3. 執行匹配
    const result = await templateMatchingEngineService.matchDocuments({
      documentIds,
      templateInstanceId,
      options,
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
        INSTANCE_NOT_FOUND: 404,
        TEMPLATE_NOT_FOUND: 404,
        DOCUMENT_NOT_FOUND: 404,
        MAPPING_NOT_FOUND: 404,
        INVALID_INSTANCE_STATUS: 400,
        TRANSFORM_FAILED: 500,
        VALIDATION_FAILED: 400,
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
            instance: '/api/v1/template-matching/execute',
            ...error.details,
          },
        },
        { status }
      );
    }

    // 通用錯誤處理
    console.error('[Template Matching Execute Error]', error);

    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'https://api.example.com/errors/internal',
          title: 'Internal Server Error',
          status: 500,
          detail: error instanceof Error ? error.message : 'An unexpected error occurred',
          instance: '/api/v1/template-matching/execute',
        },
      },
      { status: 500 }
    );
  }
}
