/**
 * @fileoverview 可用數據模版 API
 * @description
 *   提供下拉選單使用的可用模版列表
 *
 *   GET /api/v1/data-templates/available - 取得可用模版選項
 *
 * @module src/app/api/v1/data-templates/available
 * @since Epic 16 - Story 16.7
 * @lastModified 2026-01-13
 *
 * @features
 *   - 返回啟用中的模版
 *   - 包含全局模版和指定公司的模版
 *   - 輕量化回應（僅返回 id 和 name）
 *
 * @dependencies
 *   - dataTemplateService - 服務層
 */

import { NextRequest, NextResponse } from 'next/server';
import { dataTemplateService } from '@/services/data-template.service';
import { requireApiSession } from '@/lib/auth/api-session';

// ============================================================================
// GET Handler
// ============================================================================

/**
 * GET /api/v1/data-templates/available
 * @description
 *   取得可用模版選項，用於下拉選單
 *   返回啟用中的全局模版和指定公司的模版
 *
 * @param request - Next.js 請求物件
 * @returns 可用模版選項列表
 *
 * @example
 *   GET /api/v1/data-templates/available?companyId=xxx
 */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { searchParams } = new URL(request.url);
    const companyId = searchParams.get('companyId') || undefined;

    const templates = await dataTemplateService.getAvailable(companyId);

    return NextResponse.json({
      success: true,
      data: templates,
    });
  } catch (error) {
    console.error('[GET /api/v1/data-templates/available] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'INTERNAL_ERROR',
          title: '取得可用模版失敗',
          status: 500,
          detail: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      { status: 500 }
    );
  }
}
