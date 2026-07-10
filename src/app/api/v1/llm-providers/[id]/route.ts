/**
 * @fileoverview LLM Provider API — 單一資源（Epic 23 - Story 23.2）
 * @description
 *   GET    /api/v1/llm-providers/:id - 取單一 provider（遮罩，含末 4 碼預覽；登入即可）
 *   PATCH  /api/v1/llm-providers/:id - 更新（限 globalAdmin）
 *   DELETE /api/v1/llm-providers/:id - 刪除（cascade 移除模型；限 globalAdmin）
 *
 * @module src/app/api/v1/llm-providers/[id]/route
 * @since Epic 23 - Story 23.2
 * @lastModified 2026-07-10
 */

import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { llmProviderService } from '@/services/llm-provider.service';
import { updateLlmProviderSchema } from '@/lib/validations/llm-provider.schema';
import {
  actorFromSession,
  forbidden,
  mapServiceError,
  notFound,
  success,
  unauthorized,
  validationError,
} from '../_http';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** GET /api/v1/llm-providers/:id */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user) return unauthorized();
    const { id } = await params;
    const data = await llmProviderService.get(id);
    if (!data) return notFound('Provider 不存在');
    return success(data);
  } catch (error) {
    console.error('[LlmProvider:GET] %s', error);
    return mapServiceError(error);
  }
}

/** PATCH /api/v1/llm-providers/:id（限 globalAdmin） */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user) return unauthorized();
    if (!session.user.isGlobalAdmin) return forbidden('僅限全域管理員更新 provider');

    const { id } = await params;
    const body = await request.json().catch(() => null);
    const parsed = updateLlmProviderSchema.safeParse(body);
    if (!parsed.success) {
      return validationError('Invalid request body', parsed.error.flatten().fieldErrors);
    }

    const data = await llmProviderService.update(id, parsed.data, actorFromSession(session));
    return success(data);
  } catch (error) {
    console.error('[LlmProvider:PATCH] %s', error);
    return mapServiceError(error);
  }
}

/** DELETE /api/v1/llm-providers/:id（限 globalAdmin） */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user) return unauthorized();
    if (!session.user.isGlobalAdmin) return forbidden('僅限全域管理員刪除 provider');

    const { id } = await params;
    await llmProviderService.remove(id, actorFromSession(session));
    return success({ id, deleted: true });
  } catch (error) {
    console.error('[LlmProvider:DELETE] %s', error);
    return mapServiceError(error);
  }
}
