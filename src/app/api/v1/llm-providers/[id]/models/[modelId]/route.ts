/**
 * @fileoverview LLM Provider 單一模型 API（Epic 23 - Story 23.2）
 * @description
 *   PATCH  /api/v1/llm-providers/:id/models/:modelId - 更新模型（限 globalAdmin）
 *   DELETE /api/v1/llm-providers/:id/models/:modelId - 刪除模型（限 globalAdmin）
 *
 * @module src/app/api/v1/llm-providers/[id]/models/[modelId]/route
 * @since Epic 23 - Story 23.2
 * @lastModified 2026-07-10
 */

import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { llmProviderService } from '@/services/llm-provider.service';
import { updateLlmModelSchema } from '@/lib/validations/llm-provider.schema';
import {
  actorFromSession,
  forbidden,
  mapServiceError,
  success,
  unauthorized,
  validationError,
} from '../../../_http';

interface RouteParams {
  params: Promise<{ id: string; modelId: string }>;
}

/** PATCH /api/v1/llm-providers/:id/models/:modelId（限 globalAdmin） */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user) return unauthorized();
    if (!session.user.isGlobalAdmin) return forbidden('僅限全域管理員更新模型');

    const { id, modelId } = await params;
    const body = await request.json().catch(() => null);
    const parsed = updateLlmModelSchema.safeParse(body);
    if (!parsed.success) {
      return validationError('Invalid request body', parsed.error.flatten().fieldErrors);
    }

    const data = await llmProviderService.updateModel(
      id,
      modelId,
      parsed.data,
      actorFromSession(session),
    );
    return success(data);
  } catch (error) {
    console.error('[LlmProviderModel:PATCH] %s', error);
    return mapServiceError(error);
  }
}

/** DELETE /api/v1/llm-providers/:id/models/:modelId（限 globalAdmin） */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user) return unauthorized();
    if (!session.user.isGlobalAdmin) return forbidden('僅限全域管理員刪除模型');

    const { id, modelId } = await params;
    await llmProviderService.deleteModel(id, modelId, actorFromSession(session));
    return success({ id: modelId, deleted: true });
  } catch (error) {
    console.error('[LlmProviderModel:DELETE] %s', error);
    return mapServiceError(error);
  }
}
