/**
 * @fileoverview 映射配置解析 API
 * @description
 *   提供三層優先級配置解析功能
 *   按 FORMAT → COMPANY → GLOBAL 優先級合併映射規則
 *
 *   POST /api/v1/template-field-mappings/resolve - 解析映射配置
 *
 * @module src/app/api/v1/template-field-mappings/resolve
 * @since Epic 19 - Story 19.1
 * @lastModified 2026-01-22
 *
 * @features
 *   - 三層優先級解析（FORMAT > COMPANY > GLOBAL）
 *   - 映射規則合併（高優先級覆蓋低優先級）
 *   - 配置來源追蹤
 *   - 快取機制（5 分鐘 TTL）
 *
 * @dependencies
 *   - templateFieldMappingService - 服務層
 *   - resolveMappingParamsSchema - Zod 驗證
 */

import { NextRequest, NextResponse } from 'next/server';
import { templateFieldMappingService } from '@/services/template-field-mapping.service';
import { resolveMappingParamsSchema } from '@/validations/template-field-mapping';
import { requireApiSession } from '@/lib/auth/api-session';

// ============================================================================
// POST Handler
// ============================================================================

/**
 * POST /api/v1/template-field-mappings/resolve
 * @description
 *   解析映射配置，按三層優先級合併規則：
 *   1. FORMAT 級別（最高優先級）
 *   2. COMPANY 級別
 *   3. GLOBAL 級別（最低優先級）
 *
 *   同一目標欄位只保留最高優先級的規則
 *
 * @param request - Next.js 請求物件
 * @returns 合併後的映射配置
 *
 * @example
 *   POST /api/v1/template-field-mappings/resolve
 *   Body: {
 *     dataTemplateId: "xxx",
 *     companyId: "yyy",        // 可選
 *     documentFormatId: "zzz"  // 可選
 *   }
 *
 * @response
 *   {
 *     success: true,
 *     data: {
 *       dataTemplateId: "xxx",
 *       resolvedFrom: [
 *         { id: "...", scope: "FORMAT", name: "..." },
 *         { id: "...", scope: "GLOBAL", name: "..." }
 *       ],
 *       mappings: [
 *         { sourceField: "sea_freight", targetField: "shipping_cost", ... },
 *         ...
 *       ]
 *     }
 *   }
 */
export async function POST(request: NextRequest) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const body = await request.json();

    // 驗證輸入資料
    const result = resolveMappingParamsSchema.safeParse(body);

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

    // 解析配置
    const resolvedConfig = await templateFieldMappingService.resolveMapping(
      result.data
    );

    return NextResponse.json({
      success: true,
      data: resolvedConfig,
    });
  } catch (error) {
    console.error('[POST /api/v1/template-field-mappings/resolve] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'INTERNAL_ERROR',
          title: '解析映射配置失敗',
          status: 500,
          detail: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      { status: 500 }
    );
  }
}
