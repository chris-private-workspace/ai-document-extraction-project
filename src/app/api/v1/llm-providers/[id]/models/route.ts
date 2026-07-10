/**
 * @fileoverview LLM Provider 模型子資源 API（Epic 23 - Story 23.2）
 * @description
 *   GET  /api/v1/llm-providers/:id/models - 列出該 provider 的模型（登入即可）
 *   POST /api/v1/llm-providers/:id/models - 新增模型（限 globalAdmin）
 *
 * @module src/app/api/v1/llm-providers/[id]/models/route
 * @since Epic 23 - Story 23.2
 * @lastModified 2026-07-10
 */

import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { llmProviderService } from '@/services/llm-provider.service';
import { createLlmModelSchema } from '@/lib/validations/llm-provider.schema';
import {
  actorFromSession,
  forbidden,
  mapServiceError,
  success,
  unauthorized,
  validationError,
} from '../../_http';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** GET /api/v1/llm-providers/:id/models（登入即可） */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user) return unauthorized();
    const { id } = await params;
    const data = await llmProviderService.listModels(id);
    return success(data);
  } catch (error) {
    console.error('[LlmProviderModels:GET] %s', error);
    return mapServiceError(error);
  }
}

/** POST /api/v1/llm-providers/:id/models（限 globalAdmin） */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user) return unauthorized();
    if (!session.user.isGlobalAdmin) return forbidden('僅限全域管理員新增模型');

    const { id } = await params;
    const body = await request.json().catch(() => null);
    const parsed = createLlmModelSchema.safeParse(body);
    if (!parsed.success) {
      return validationError('Invalid request body', parsed.error.flatten().fieldErrors);
    }

    const data = await llmProviderService.createModel(id, parsed.data, actorFromSession(session));
    return success(data, 201);
  } catch (error) {
    console.error('[LlmProviderModels:POST] %s', error);
    return mapServiceError(error);
  }
}
