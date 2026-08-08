/**
 * @fileoverview 配置檢查 API
 * @description
 *   GET /api/v1/template-matching/check-config?companyId=xxx
 *   檢查指定公司的自動匹配配置完整度
 *
 * @module src/app/api/v1/template-matching/check-config
 * @since CHANGE-037 - Data Template 匹配流程完善
 * @lastModified 2026-02-11
 *
 * @features
 *   - 檢查 FORMAT/COMPANY/GLOBAL 三層預設模板配置
 *   - 返回配置完整度和就緒狀態
 *
 * @dependencies
 *   - auto-template-matching.service.ts - 預設模板解析
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { autoTemplateMatchingService } from '@/services/auto-template-matching.service';
import { requireApiSession } from '@/lib/auth/api-session';

// ============================================================================
// Validation Schema
// ============================================================================

const checkConfigQuerySchema = z.object({
  companyId: z.string().min(1, 'companyId is required'),
  formatId: z.string().optional(),
});

// ============================================================================
// GET - Check Template Matching Config
// ============================================================================

/**
 * 檢查自動匹配配置完整度
 *
 * @description
 *   查詢指定公司是否已配置預設模板，返回配置來源和就緒狀態。
 *   用於前端顯示配置提示。
 *
 * @param request - HTTP 請求
 * @returns 配置檢查結果
 *
 * @example
 * GET /api/v1/template-matching/check-config?companyId=xxx
 * GET /api/v1/template-matching/check-config?companyId=xxx&formatId=yyy
 */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    // 1. 解析查詢參數
    const { searchParams } = new URL(request.url);
    const params = {
      companyId: searchParams.get('companyId') ?? '',
      formatId: searchParams.get('formatId') ?? undefined,
    };

    // 2. 驗證輸入
    const validationResult = checkConfigQuerySchema.safeParse(params);

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

    const { companyId, formatId } = validationResult.data;

    // 3. 解析預設模板
    const resolved = await autoTemplateMatchingService.resolveDefaultTemplate(
      companyId,
      formatId
    );

    // 4. 返回配置檢查結果
    if (resolved) {
      return NextResponse.json({
        success: true,
        data: {
          companyId,
          hasDefaultTemplate: true,
          defaultTemplateId: resolved.templateId,
          defaultTemplateName: resolved.templateName,
          source: resolved.source,
          sourceId: resolved.sourceId,
          isReady: true,
        },
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        companyId,
        hasDefaultTemplate: false,
        defaultTemplateId: null,
        defaultTemplateName: null,
        source: null,
        sourceId: null,
        isReady: false,
      },
    });
  } catch (error) {
    console.error('[Template Matching Check Config Error]', error);

    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'https://api.example.com/errors/internal',
          title: 'Internal Server Error',
          status: 500,
          detail: error instanceof Error ? error.message : 'An unexpected error occurred',
          instance: '/api/v1/template-matching/check-config',
        },
      },
      { status: 500 }
    );
  }
}
