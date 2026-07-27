/**
 * @fileoverview `callGatewayByModelKey` 橋接單元測試（Epic 23 - Story 23.4 Phase 1）
 * @description
 *   驗證橋接的**兩種回傳語意**——6 個呼叫點的遷移安全性完全建立在這兩者之上：
 *     - 回 `null`（flag 關 / 未播種）→ 呼叫端回退既有直接 Azure 路徑，行為零變。
 *     - **throw**（gateway 回 `success:false`）→ 呼叫端既有 retry / 業務降級接手，
 *       **不**回退舊路徑（否則會重複計費並掩蓋 gateway 問題）。
 *   另驗證 `modelKey` 被換成解析出的 `modelId`，其餘欄位原樣透傳。
 *
 * @module tests/unit/services/llm-gateway-bridge.test
 * @since Epic 23 - Story 23.4
 * @lastModified 2026-07-27
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/config/feature-flags', () => ({ shouldUseLlmGateway: vi.fn() }));
vi.mock('@/services/llm/llm-gateway.service', () => ({
  llmGatewayService: { resolveModelIdByKey: vi.fn(), call: vi.fn() },
}));

import { callGatewayByModelKey } from '@/services/llm/gateway-bridge';
import { shouldUseLlmGateway } from '@/config/feature-flags';
import { llmGatewayService } from '@/services/llm/llm-gateway.service';

const BASE_INPUT = {
  modelKey: 'gpt-5.4-mini',
  messages: [{ role: 'user' as const, content: 'hello' }],
  output: { mode: 'json' as const },
  temperature: 0.3,
  maxOutputTokens: 4000,
  maxRetries: 0,
};

function mockGatewaySuccess(text = 'GATEWAY_RESULT') {
  vi.mocked(llmGatewayService.call).mockResolvedValue({
    success: true,
    text,
    usage: { input: 5, output: 7, total: 12 },
    modelId: 'model-1',
    providerType: 'AZURE_OPENAI',
    durationMs: 1,
  });
}

describe('callGatewayByModelKey（Story 23.4 Phase 1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return null and never touch the gateway when the flag is off', async () => {
    vi.mocked(shouldUseLlmGateway).mockReturnValue(false);

    const result = await callGatewayByModelKey(BASE_INPUT);

    expect(result).toBeNull();
    expect(llmGatewayService.resolveModelIdByKey).not.toHaveBeenCalled();
    expect(llmGatewayService.call).not.toHaveBeenCalled();
  });

  it('should return null without calling when the model key is unseeded', async () => {
    vi.mocked(shouldUseLlmGateway).mockReturnValue(true);
    vi.mocked(llmGatewayService.resolveModelIdByKey).mockResolvedValue(null);

    const result = await callGatewayByModelKey(BASE_INPUT);

    expect(result).toBeNull();
    expect(llmGatewayService.call).not.toHaveBeenCalled();
  });

  it('should return content and usage on success', async () => {
    vi.mocked(shouldUseLlmGateway).mockReturnValue(true);
    vi.mocked(llmGatewayService.resolveModelIdByKey).mockResolvedValue('model-1');
    mockGatewaySuccess();

    const result = await callGatewayByModelKey(BASE_INPUT);

    expect(result).toEqual({
      content: 'GATEWAY_RESULT',
      usage: { input: 5, output: 7, total: 12 },
    });
  });

  it('should replace modelKey with the resolved modelId and pass the rest through', async () => {
    vi.mocked(shouldUseLlmGateway).mockReturnValue(true);
    vi.mocked(llmGatewayService.resolveModelIdByKey).mockResolvedValue('model-1');
    mockGatewaySuccess();

    await callGatewayByModelKey({
      ...BASE_INPUT,
      images: [{ data: 'data:image/png;base64,AAAA', detail: 'high' }],
      providerOptions: { openai: { reasoningEffort: 'low' } },
    });

    const callArg = vi.mocked(llmGatewayService.call).mock.calls[0][0];
    expect(callArg.modelId).toBe('model-1');
    expect(callArg).not.toHaveProperty('modelKey');
    expect(callArg.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(callArg.output).toEqual({ mode: 'json' });
    expect(callArg.temperature).toBe(0.3);
    expect(callArg.maxOutputTokens).toBe(4000);
    // 呼叫端已有自己的重試迴圈時傳 0，避免重試次數相乘
    expect(callArg.maxRetries).toBe(0);
    expect(callArg.images).toEqual([
      { data: 'data:image/png;base64,AAAA', detail: 'high' },
    ]);
    expect(callArg.providerOptions).toEqual({ openai: { reasoningEffort: 'low' } });
  });

  it('should throw the gateway error instead of falling back when the call fails', async () => {
    vi.mocked(shouldUseLlmGateway).mockReturnValue(true);
    vi.mocked(llmGatewayService.resolveModelIdByKey).mockResolvedValue('model-1');
    vi.mocked(llmGatewayService.call).mockResolvedValue({
      success: false,
      text: '',
      usage: { input: 0, output: 0, total: 0 },
      modelId: 'model-1',
      providerType: 'AZURE_OPENAI',
      durationMs: 1,
      error: 'Provider 熔斷開路: provider-1',
    });

    await expect(callGatewayByModelKey(BASE_INPUT)).rejects.toThrow(
      'Provider 熔斷開路: provider-1'
    );
  });

  it('should still throw with an identifying message when the gateway reports no error text', async () => {
    vi.mocked(shouldUseLlmGateway).mockReturnValue(true);
    vi.mocked(llmGatewayService.resolveModelIdByKey).mockResolvedValue('model-1');
    vi.mocked(llmGatewayService.call).mockResolvedValue({
      success: false,
      text: '',
      usage: { input: 0, output: 0, total: 0 },
      modelId: 'model-1',
      providerType: 'AZURE_OPENAI',
      durationMs: 1,
    });

    await expect(callGatewayByModelKey(BASE_INPUT)).rejects.toThrow('gpt-5.4-mini');
  });
});
