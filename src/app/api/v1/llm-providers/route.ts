/**
 * @fileoverview LLM Providers API — 列表 / 新增（Epic 23 - Story 23.2）
 * @description
 *   GET  /api/v1/llm-providers - 列出全部 provider（憑證遮罩；登入即可）
 *   POST /api/v1/llm-providers - 新增 provider（加密憑證；限 globalAdmin）
 *   自訂 `baseUrl` 的 SSRF 防護＝本 route 寫入操作全限 globalAdmin（§11）。
 *
 * @module src/app/api/v1/llm-providers/route
 * @since Epic 23 - Story 23.2
 * @lastModified 2026-07-10
 */

import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { llmProviderService } from '@/services/llm-provider.service';
import { createLlmProviderSchema } from '@/lib/validations/llm-provider.schema';
import {
  actorFromSession,
  forbidden,
  mapServiceError,
  success,
  unauthorized,
  validationError,
} from './_http';

/** GET /api/v1/llm-providers — 遮罩列表（登入即可） */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) return unauthorized();
    const data = await llmProviderService.list();
    return success(data);
  } catch (error) {
    console.error('[LlmProviders:GET] %s', error);
    return mapServiceError(error);
  }
}

/** POST /api/v1/llm-providers — 新增（限 globalAdmin） */
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) return unauthorized();
    if (!session.user.isGlobalAdmin) return forbidden('僅限全域管理員新增 provider');

    const body = await request.json().catch(() => null);
    const parsed = createLlmProviderSchema.safeParse(body);
    if (!parsed.success) {
      return validationError('Invalid request body', parsed.error.flatten().fieldErrors);
    }

    const data = await llmProviderService.create(parsed.data, actorFromSession(session));
    return success(data, 201);
  } catch (error) {
    console.error('[LlmProviders:POST] %s', error);
    return mapServiceError(error);
  }
}
