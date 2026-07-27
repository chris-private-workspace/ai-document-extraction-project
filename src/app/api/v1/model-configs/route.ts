/**
 * @fileoverview LLM 模型選擇配置 API（CHANGE-099）
 * @description
 *   GET  /api/v1/model-configs - 讀取可選模型白名單 + 目前 Stage 1-3 選擇
 *   PUT  /api/v1/model-configs - 更新 Stage 1-3 模型選擇（限 globalAdmin）
 *
 * @module src/app/api/v1/model-configs/route
 * @since CHANGE-099 - LLM 模型選擇管理
 * @lastModified 2026-07-09
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { LlmModelConfigService } from '@/services/llm-model-config.service';
import { updateStageModelsSchema } from '@/lib/validations/llm-model-config.schema';

/**
 * GET /api/v1/model-configs
 * 回傳可選模型（已啟用 provider 的已啟用模型）與目前各 Stage 的模型選擇（value = LlmModel.id）。
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

    const [models, selection] = await Promise.all([
      LlmModelConfigService.listSelectableModels(),
      LlmModelConfigService.getStageModelSelection(),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        models,
        selection,
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
 * 更新 Stage 1-3 模型選擇（限 globalAdmin）。
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
    const parsed = updateStageModelsSchema.safeParse(body);
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

    await LlmModelConfigService.setStageModelSelection(parsed.data, session.user.id);

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
