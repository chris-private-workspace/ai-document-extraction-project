/**
 * @fileoverview LLM 模型指派 API（CHANGE-099 → Epic 23 Story 23.4）
 * @description
 *   GET  /api/v1/model-configs - 讀取可選模型 + **各處理環節**目前的模型指派
 *   PUT  /api/v1/model-configs - 更新環節模型指派（限 globalAdmin，支援部分更新）
 *
 *   Story 23.4 起指派範圍由 extraction Stage 1-3 擴大到全部 9 個 LLM 呼叫環節。
 *   環節目錄（顯示順序 / i18n key / 是否核心提取）由前端直接讀
 *   `@/lib/constants/llm-stages`，不經此 API 傳輸。
 *
 * @module src/app/api/v1/model-configs/route
 * @since CHANGE-099 - LLM 模型選擇管理
 * @lastModified 2026-07-27
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { LlmModelConfigService } from '@/services/llm-model-config.service';
import { updateStageAssignmentsSchema } from '@/lib/validations/llm-model-config.schema';

/**
 * GET /api/v1/model-configs
 * 回傳可選模型（已啟用 provider 的已啟用模型）與各處理環節目前的模型指派（value = LlmModel.id）。
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: '需要登入',
        },
        { status: 401 },
      );
    }

    const [models, assignments] = await Promise.all([
      LlmModelConfigService.listSelectableModels(),
      LlmModelConfigService.getStageAssignments(),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        models,
        assignments,
      },
    });
  } catch (error) {
    console.error('[ModelConfigs:GET] Error: %s', error);
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while fetching model configs',
      },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/v1/model-configs
 * 更新環節模型指派（限 globalAdmin）。body 只需帶有異動的環節。
 */
export async function PUT(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: '需要登入',
        },
        { status: 401 },
      );
    }

    if (!session.user.isGlobalAdmin) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: '僅限全域管理員修改模型設定',
        },
        { status: 403 },
      );
    }

    const body = await request.json();
    const parsed = updateStageAssignmentsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/validation',
          title: 'Validation Error',
          status: 400,
          detail: 'Invalid request body',
          errors: parsed.error.flatten().fieldErrors,
        },
        { status: 400 },
      );
    }

    await LlmModelConfigService.setStageAssignments(
      parsed.data.assignments,
      session.user.id,
    );

    return NextResponse.json({
      success: true,
      data: parsed.data,
    });
  } catch (error) {
    console.error('[ModelConfigs:PUT] Error: %s', error);
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while updating model configs',
      },
      { status: 500 },
    );
  }
}
