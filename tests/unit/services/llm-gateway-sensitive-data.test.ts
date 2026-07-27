/**
 * @fileoverview LlmGatewayService × D4 資料出境護欄單元測試（CHANGE-110）
 * @description
 *   驗證 `LlmProvider.allowSensitiveData` 在 gateway 呼叫路徑上**確實生效**（全程 mock）：
 *   - 未核准的非 Azure provider → 拒絕，且**在送出前**攔截（SDK 完全未被呼叫）。
 *   - 政策拒絕**不計入熔斷器**（政策問題 ≠ provider 健康問題）。
 *   - 已核准的非 Azure provider → 正常送出（不誤擋）。
 *   - Azure 不受此護欄約束（§7 既定合規基準，見 CHANGE-110 決策 2）。
 *
 * @module tests/unit/services/llm-gateway-sensitive-data.test
 * @since CHANGE-110
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn(),
  generateObject: vi.fn(),
  jsonSchema: vi.fn((s: unknown) => s),
}));

vi.mock('@ai-sdk/azure', () => {
  const chat = vi.fn((id: string) => ({ __azure: id }));
  const provider = Object.assign(vi.fn((id: string) => ({ __azure: id })), { chat });
  return { createAzure: vi.fn(() => provider) };
});

vi.mock('@ai-sdk/anthropic', () => {
  const languageModel = vi.fn((id: string) => ({ __anthropic: id }));
  const provider = Object.assign(vi.fn((id: string) => ({ __anthropic: id })), {
    languageModel,
  });
  return { createAnthropic: vi.fn(() => provider) };
});

vi.mock('@/lib/prisma', () => ({
  prisma: {
    llmProvider: { findFirst: vi.fn() },
    llmModel: { findUnique: vi.fn(), findFirst: vi.fn() },
    document: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/config-encryption', () => ({
  decryptConfigValue: vi.fn((v: string) => v.replace(/^enc\(/, '').replace(/\)$/, '')),
}));

vi.mock('@/services/logging/logger.service', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/services/ai-cost.service', () => ({
  aiCostService: { logUsage: vi.fn() },
}));

import { generateText, generateObject } from 'ai';
import { prisma } from '@/lib/prisma';
import { llmGatewayService, llmCircuitBreaker } from '@/services/llm';
import type { LlmMessage } from '@/services/llm';

const USER_MSG: LlmMessage[] = [{ role: 'user', content: 'x' }];
const ANTHROPIC_PROVIDER_ID = 'provider-anthropic';

/** 可調整 providerType / allowSensitiveData 的模型 mock */
function mockModel(providerOverrides: Record<string, unknown>) {
  return {
    id: 'model-1',
    modelKey: 'claude-opus-5',
    isEnabled: true,
    capability: {
      maxTokens: 8192,
      supportsTemperature: false,
      supportsJsonSchema: true,
      supportsVision: true,
    },
    provider: {
      id: ANTHROPIC_PROVIDER_ID,
      name: 'Anthropic',
      providerType: 'ANTHROPIC',
      baseUrl: null,
      apiVersion: null,
      apiKeyEnc: 'enc(sk-ant-test)',
      isEncrypted: true,
      isEnabled: true,
      isDefault: false,
      allowSensitiveData: false,
      ...providerOverrides,
    },
  };
}

describe('LlmGatewayService × allowSensitiveData 護欄（CHANGE-110）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    llmCircuitBreaker.reset();
    process.env.AZURE_OPENAI_API_KEY = 'test-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
    delete process.env.FEATURE_LLM_CIRCUIT_BREAKER;
    delete process.env.FEATURE_LLM_FAILOVER;
  });

  it('should refuse a non-Azure provider that is not approved for sensitive data', async () => {
    vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(mockModel({}) as never);

    const r = await llmGatewayService.call({
      modelId: 'model-1',
      messages: USER_MSG,
      output: { mode: 'text' },
    });

    expect(r.success).toBe(false);
    // gateway 既有 pattern：錯誤碼供內部辨識，對外由 message 呈現（同 MODEL_DISABLED 等）
    expect(r.error).toContain('未經核准');
    // 註：`providerType` 在此為 undefined——prepare() 拋錯時 call() Phase 1 以
    // resolved:undefined 組結果，所有設定類錯誤皆然（非本護欄特有）。
    // provider 身分改由錯誤訊息攜帶。
    expect(r.error).toContain('provider-anthropic');
  });

  it('should intercept before dispatch so no request ever leaves', async () => {
    vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(mockModel({}) as never);

    await llmGatewayService.call({
      modelId: 'model-1',
      messages: USER_MSG,
      output: { mode: 'text' },
    });

    expect(generateText).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('should not count a policy refusal as a circuit-breaker failure', async () => {
    vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(mockModel({}) as never);

    await llmGatewayService.call({
      modelId: 'model-1',
      messages: USER_MSG,
      output: { mode: 'text' },
    });

    // 政策拒絕不是 provider 健康問題 → 熔斷器不得留下任何失敗記錄
    expect(llmCircuitBreaker.snapshot()).not.toHaveProperty(ANTHROPIC_PROVIDER_ID);
    expect(llmCircuitBreaker.getState(ANTHROPIC_PROVIDER_ID)).toBe('CLOSED');
  });

  it('should allow an approved non-Azure provider through', async () => {
    vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(
      mockModel({ allowSensitiveData: true }) as never,
    );
    vi.mocked(generateText).mockResolvedValue({
      text: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    } as never);

    const r = await llmGatewayService.call({
      modelId: 'model-1',
      messages: USER_MSG,
      output: { mode: 'text' },
    });

    expect(r.success).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('should leave Azure unaffected even when the flag is false', async () => {
    // §7 既定合規基準：Azure 不受此護欄約束（CHANGE-110 決策 2 的已知取捨）
    vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(
      mockModel({
        id: 'provider-azure',
        providerType: 'AZURE_OPENAI',
        baseUrl: 'https://test.openai.azure.com',
        apiKeyEnc: null,
        isEncrypted: false,
        isDefault: true,
        allowSensitiveData: false,
      }) as never,
    );
    vi.mocked(generateText).mockResolvedValue({
      text: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    } as never);

    const r = await llmGatewayService.call({
      modelId: 'model-1',
      messages: USER_MSG,
      output: { mode: 'text' },
    });

    expect(r.success).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});
