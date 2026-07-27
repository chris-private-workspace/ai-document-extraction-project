/**
 * @fileoverview LLM Provider 連線測試 API（Epic 23 - Story 23.2）
 * @description
 *   POST /api/v1/llm-providers/:id/test - 連線測試（限 globalAdmin；審計 READ）
 *   Azure 以解密憑證探測；非 Azure 目前回 `supported:false`（native provider 待 Story 23.3）。
 *
 * @module src/app/api/v1/llm-providers/[id]/test/route
 * @since Epic 23 - Story 23.2
 * @lastModified 2026-07-10
 */

import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { llmProviderService } from '@/services/llm-provider.service';
import {
  actorFromSession,
  forbidden,
  mapServiceError,
  success,
  unauthorized,
} from '../../_http';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** POST /api/v1/llm-providers/:id/test（限 globalAdmin） */
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user) return unauthorized();
    if (!session.user.isGlobalAdmin) return forbidden('僅限全域管理員測試連線');

    const { id } = await params;
    const result = await llmProviderService.testConnection(id, actorFromSession(session));
    return success(result);
  } catch (error) {
    console.error('[LlmProvider:test] %s', error);
    return mapServiceError(error);
  }
}
