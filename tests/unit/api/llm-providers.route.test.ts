/**
 * @fileoverview LLM Providers API route handler 單元測試（Epic 23 - Story 23.2 step 2）
 * @description
 *   驗證 route 層契約（mock auth + service）：
 *   - 授權：GET 需登入；POST/PATCH/DELETE 需 globalAdmin（401 / 403）。
 *   - 驗證：無效 body → 400（RFC 7807 top-level）。
 *   - 委派：合法請求委派服務、帶入 actor，成功狀態碼（200/201）。
 *   - 錯誤映射：DUPLICATE_NAME→409、PROVIDER_NOT_FOUND→404。
 *
 * @module tests/unit/api/llm-providers.route.test
 * @since Epic 23 - Story 23.2
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

// Mock 服務單例；同時提供真實 LlmProviderError 類（供 _http.mapServiceError 的 instanceof）
vi.mock('@/services/llm-provider.service', () => {
  class LlmProviderError extends Error {
    constructor(
      message: string,
      public code: string,
    ) {
      super(message);
      this.name = 'LlmProviderError';
    }
  }
  return {
    LlmProviderError,
    llmProviderService: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      testConnection: vi.fn(),
      listModels: vi.fn(),
      createModel: vi.fn(),
    },
  };
});

import { auth } from '@/lib/auth';
import { llmProviderService, LlmProviderError } from '@/services/llm-provider.service';
import { GET, POST } from '@/app/api/v1/llm-providers/route';
import { PATCH, DELETE } from '@/app/api/v1/llm-providers/[id]/route';

const adminSession = {
  user: { id: 'u-1', name: 'Admin', email: 'admin@x.com', isGlobalAdmin: true },
};
const viewerSession = {
  user: { id: 'u-2', name: 'Viewer', email: 'viewer@x.com', isGlobalAdmin: false },
};

function post(body: unknown) {
  return new NextRequest('http://localhost/api/v1/llm-providers', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
function patch(body: unknown) {
  return new NextRequest('http://localhost/api/v1/llm-providers/p-1', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}
const idParams = { params: Promise.resolve({ id: 'p-1' }) };

describe('LLM Providers API routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /llm-providers', () => {
    it('should return 401 when unauthenticated', async () => {
      vi.mocked(auth).mockResolvedValue(null as never);
      const res = await GET();
      expect(res.status).toBe(401);
    });

    it('should return masked list for authenticated users', async () => {
      vi.mocked(auth).mockResolvedValue(viewerSession as never);
      vi.mocked(llmProviderService.list).mockResolvedValue([
        { id: 'p-1', hasApiKey: true } as never,
      ]);
      const res = await GET();
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
    });
  });

  describe('POST /llm-providers', () => {
    it('should return 401 without a session', async () => {
      vi.mocked(auth).mockResolvedValue(null as never);
      const res = await POST(post({ name: 'X', providerType: 'OPENAI' }));
      expect(res.status).toBe(401);
    });

    it('should return 403 for a non-globalAdmin', async () => {
      vi.mocked(auth).mockResolvedValue(viewerSession as never);
      const res = await POST(post({ name: 'X', providerType: 'OPENAI' }));
      expect(res.status).toBe(403);
      expect(llmProviderService.create).not.toHaveBeenCalled();
    });

    it('should return 400 for an invalid body', async () => {
      vi.mocked(auth).mockResolvedValue(adminSession as never);
      const res = await POST(post({ name: '' })); // 缺 providerType + 空 name
      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json.status).toBe(400);
      expect(json.errors).toBeDefined();
    });

    it('should create and return 201 with the actor from session', async () => {
      vi.mocked(auth).mockResolvedValue(adminSession as never);
      vi.mocked(llmProviderService.create).mockResolvedValue({ id: 'p-9' } as never);

      const res = await POST(post({ name: 'Azure', providerType: 'AZURE_OPENAI', apiKey: 'k' }));

      expect(res.status).toBe(201);
      const actor = vi.mocked(llmProviderService.create).mock.calls[0][1];
      expect(actor).toMatchObject({ userId: 'u-1', userName: 'Admin', userEmail: 'admin@x.com' });
    });

    it('should map DUPLICATE_NAME to 409', async () => {
      vi.mocked(auth).mockResolvedValue(adminSession as never);
      vi.mocked(llmProviderService.create).mockRejectedValue(
        new LlmProviderError('dup', 'DUPLICATE_NAME'),
      );
      const res = await POST(post({ name: 'dup', providerType: 'OPENAI' }));
      expect(res.status).toBe(409);
    });
  });

  describe('PATCH /llm-providers/:id', () => {
    it('should return 403 for a non-globalAdmin', async () => {
      vi.mocked(auth).mockResolvedValue(viewerSession as never);
      const res = await PATCH(patch({ isEnabled: false }), idParams);
      expect(res.status).toBe(403);
    });

    it('should map PROVIDER_NOT_FOUND to 404', async () => {
      vi.mocked(auth).mockResolvedValue(adminSession as never);
      vi.mocked(llmProviderService.update).mockRejectedValue(
        new LlmProviderError('missing', 'PROVIDER_NOT_FOUND'),
      );
      const res = await PATCH(patch({ isEnabled: false }), idParams);
      expect(res.status).toBe(404);
    });

    it('should update and return 200', async () => {
      vi.mocked(auth).mockResolvedValue(adminSession as never);
      vi.mocked(llmProviderService.update).mockResolvedValue({ id: 'p-1' } as never);
      const res = await PATCH(patch({ isEnabled: false }), idParams);
      expect(res.status).toBe(200);
      expect(vi.mocked(llmProviderService.update).mock.calls[0][0]).toBe('p-1');
    });
  });

  describe('DELETE /llm-providers/:id', () => {
    it('should return 403 for a non-globalAdmin', async () => {
      vi.mocked(auth).mockResolvedValue(viewerSession as never);
      const req = new NextRequest('http://localhost/api/v1/llm-providers/p-1', { method: 'DELETE' });
      const res = await DELETE(req, idParams);
      expect(res.status).toBe(403);
      expect(llmProviderService.remove).not.toHaveBeenCalled();
    });

    it('should delete and return 200', async () => {
      vi.mocked(auth).mockResolvedValue(adminSession as never);
      vi.mocked(llmProviderService.remove).mockResolvedValue(undefined as never);
      const req = new NextRequest('http://localhost/api/v1/llm-providers/p-1', { method: 'DELETE' });
      const res = await DELETE(req, idParams);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.data).toMatchObject({ id: 'p-1', deleted: true });
    });
  });
});
