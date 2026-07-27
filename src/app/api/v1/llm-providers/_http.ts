/**
 * @fileoverview LLM Providers API 共用回應輔助（Epic 23 - Story 23.2）
 * @description
 *   `llm-providers` 四個 route 共用的 RFC 7807（top-level）錯誤/成功回應、session→actor 轉換、
 *   服務錯誤映射。集中於此避免 4 個 route 重複 boilerplate。
 *   非 route 檔（Next.js App Router 僅將 route.ts 視為端點），可安全 colocate。
 *
 * @module src/app/api/v1/llm-providers/_http
 * @since Epic 23 - Story 23.2
 */

import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { LlmProviderError } from '@/services/llm-provider.service';
import type { LlmProviderAuditActor } from '@/services/llm-provider.service';
import { ConfigEncryptionError } from '@/lib/config-encryption';

const ERR_BASE = 'https://api.example.com/errors';

/** RFC 7807 top-level 錯誤回應 */
export function problem(
  status: number,
  slug: string,
  title: string,
  detail: string,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    { type: `${ERR_BASE}/${slug}`, title, status, detail, ...extra },
    { status },
  );
}

export const unauthorized = (): NextResponse =>
  problem(401, 'unauthorized', 'Unauthorized', '需要登入');

export const forbidden = (detail = '僅限全域管理員'): NextResponse =>
  problem(403, 'forbidden', 'Forbidden', detail);

export const validationError = (
  detail: string,
  errors?: Record<string, unknown>,
): NextResponse =>
  problem(400, 'validation', 'Validation Error', detail, errors ? { errors } : undefined);

export const notFound = (detail: string): NextResponse =>
  problem(404, 'not-found', 'Not Found', detail);

export const serverError = (detail = 'An unexpected error occurred'): NextResponse =>
  problem(500, 'internal', 'Internal Server Error', detail);

/** 成功回應 `{ success, data }` */
export function success<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ success: true, data }, { status });
}

/** session.user → 審計 actor（name 缺失退回 email→id） */
export function actorFromSession(session: Session): LlmProviderAuditActor {
  return {
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? session.user.id,
    userEmail: session.user.email ?? undefined,
  };
}

/** 服務錯誤 → RFC 7807（未知 id→404、名稱/modelKey 重複→409、憑證設定→500 不洩漏內部細節） */
export function mapServiceError(error: unknown): NextResponse {
  if (error instanceof LlmProviderError) {
    if (error.code === 'PROVIDER_NOT_FOUND') return notFound('Provider 不存在');
    if (error.code === 'MODEL_NOT_FOUND') return notFound('模型不存在');
    if (error.code === 'DUPLICATE_NAME') {
      return problem(409, 'conflict', 'Conflict', 'Provider 名稱已存在');
    }
    if (error.code === 'DUPLICATE_MODEL_KEY') {
      return problem(409, 'conflict', 'Conflict', '此 provider 下已存在相同 modelKey');
    }
  }
  if (error instanceof ConfigEncryptionError) {
    return serverError('憑證加密設定異常，請聯絡管理員');
  }
  return serverError();
}
