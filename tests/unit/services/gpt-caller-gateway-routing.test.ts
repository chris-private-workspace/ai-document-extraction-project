/**
 * @fileoverview GptCallerService × LlmGateway 路由單元測試（Epic 23 - Story 23.1 step 4）
 * @description
 *   驗證 flag-gated 硬切換與回退（不觸網路）：
 *   - flag on + modelId 解析成功 → 走 gateway，回傳映射後的 GptCallResult，不打 fetch。
 *   - flag on + modelId 解析不到（播種缺失） → 回退既有直接 fetch 路徑。
 *   - flag off → 完全不碰 gateway，走既有 fetch 路徑（行為零變）。
 *   並驗證 GptCallInput → LlmCallInput 的映射（modelId / output 模式 / 訊息）。
 *
 * @module tests/unit/services/gpt-caller-gateway-routing.test
 * @since Epic 23 - Story 23.1 step 4
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/config/feature-flags', () => ({ isLlmGatewayEnabled: vi.fn() }));
vi.mock('@/services/llm', () => ({
  llmGatewayService: { resolveModelIdByKey: vi.fn(), call: vi.fn() },
}));

import { GptCallerService } from '@/services/extraction-v3/stages/gpt-caller.service';
import { isLlmGatewayEnabled } from '@/config/feature-flags';
import { llmGatewayService } from '@/services/llm';

/** 模擬 Azure chat/completions 成功回應（fetch 路徑用） */
function mockFetchOk() {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'FETCH_RESULT' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  });
}

const BASE_INPUT = {
  model: 'gpt-5.2',
  systemPrompt: 'sys',
  userPrompt: 'usr',
  imageBase64Array: ['data:image/png;base64,AAAA'],
  jsonSchema: { type: 'object' as const },
};

describe('GptCallerService gateway 路由（step 4）', () => {
  let service: GptCallerService;

  beforeEach(() => {
    vi.clearAllMocks();
    // fetch 路徑需要有效 Azure 配置才會實際送出
    service = new GptCallerService({
      endpoint: 'https://test.openai.azure.com',
      apiKey: 'test-key',
    });
    vi.stubGlobal('fetch', mockFetchOk());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should route through gateway and map result when flag on and modelId resolves', async () => {
    vi.mocked(isLlmGatewayEnabled).mockReturnValue(true);
    vi.mocked(llmGatewayService.resolveModelIdByKey).mockResolvedValue('model-1');
    vi.mocked(llmGatewayService.call).mockResolvedValue({
      success: true,
      text: 'GATEWAY_RESULT',
      object: { a: 1 },
      usage: { input: 5, output: 5, total: 10 },
      modelId: 'model-1',
      providerType: 'AZURE_OPENAI',
      durationMs: 1,
    });

    const r = await service.call(BASE_INPUT);

    expect(r.success).toBe(true);
    expect(r.response).toBe('GATEWAY_RESULT');
    expect(r.tokenUsage).toEqual({ input: 5, output: 5, total: 10 });
    expect(r.model).toBe('gpt-5.2');
    // 未打 fetch
    expect(fetch).not.toHaveBeenCalled();
    // GptCallInput → LlmCallInput 映射：有 jsonSchema → object 模式
    const callArg = vi.mocked(llmGatewayService.call).mock.calls[0][0];
    expect(callArg.modelId).toBe('model-1');
    expect(callArg.output).toEqual({
      mode: 'object',
      jsonSchema: { type: 'object' },
      name: 'extraction_result',
    });
    expect(callArg.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    expect(callArg.images).toHaveLength(1);
  });

  it('should map to json mode when no jsonSchema is provided', async () => {
    vi.mocked(isLlmGatewayEnabled).mockReturnValue(true);
    vi.mocked(llmGatewayService.resolveModelIdByKey).mockResolvedValue('model-1');
    vi.mocked(llmGatewayService.call).mockResolvedValue({
      success: true,
      text: '{}',
      usage: { input: 1, output: 1, total: 2 },
      modelId: 'model-1',
      providerType: 'AZURE_OPENAI',
      durationMs: 1,
    });

    await service.call({ ...BASE_INPUT, jsonSchema: undefined });

    const callArg = vi.mocked(llmGatewayService.call).mock.calls[0][0];
    expect(callArg.output).toEqual({ mode: 'json' });
  });

  it('should fall back to fetch when flag on but modelId does not resolve (unseeded)', async () => {
    vi.mocked(isLlmGatewayEnabled).mockReturnValue(true);
    vi.mocked(llmGatewayService.resolveModelIdByKey).mockResolvedValue(null);

    const r = await service.call(BASE_INPUT);

    expect(r.response).toBe('FETCH_RESULT');
    expect(llmGatewayService.call).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should never touch gateway when flag is off', async () => {
    vi.mocked(isLlmGatewayEnabled).mockReturnValue(false);

    const r = await service.call(BASE_INPUT);

    expect(r.response).toBe('FETCH_RESULT');
    expect(llmGatewayService.resolveModelIdByKey).not.toHaveBeenCalled();
    expect(llmGatewayService.call).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
