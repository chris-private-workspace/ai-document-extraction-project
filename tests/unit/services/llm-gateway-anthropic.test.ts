/**
 * @fileoverview LlmGatewayService × Anthropic provider 接線單元測試（Epic 23 - Story 23.3）
 * @description
 *   驗證非 Azure provider 首次接入 gateway 的契約（全程 mock，無網路、無 DB）：
 *   - `buildModel` 依 providerType 派發到 `@ai-sdk/anthropic`，不再丟 PROVIDER_TYPE_UNSUPPORTED。
 *   - 模型識別用 **`modelKey`**（如 `claude-opus-5`），非 Azure 的 deployment 名。
 *   - 憑證走 DB 解密（fail-closed），非 Azure 無 env fallback。
 *   - **回歸**：未填 `baseUrl` 的 Anthropic provider 不得被導向 `AZURE_OPENAI_ENDPOINT`
 *     （沿用官方預設），且不得把 Azure api-version 傳給 Anthropic。
 *   - 仍未支援的 provider 型別（如 Gemini）維持明確錯誤。
 *
 * @module tests/unit/services/llm-gateway-anthropic.test
 * @since Epic 23 - Story 23.3
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

import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { prisma } from '@/lib/prisma';
import { llmGatewayService, llmCircuitBreaker } from '@/services/llm';
import type { LlmMessage } from '@/services/llm';

const USER_MSG: LlmMessage[] = [{ role: 'user', content: 'x' }];

/** Anthropic LlmModel（含 provider include）；憑證存 DB 加密欄位 */
function mockAnthropicModel(providerOverrides?: Record<string, unknown>) {
  return {
    id: 'model-anthropic',
    modelKey: 'claude-opus-5',
    isEnabled: true,
    capability: {
      maxTokens: 8192,
      supportsTemperature: true,
      temperature: 0.1,
      supportsJsonSchema: true,
      supportsVision: true,
    },
    provider: {
      id: 'provider-anthropic',
      name: 'Anthropic',
      providerType: 'ANTHROPIC',
      baseUrl: null,
      apiVersion: null,
      apiKeyEnc: 'enc(sk-ant-test)',
      isEncrypted: true,
      isEnabled: true,
      isDefault: false,
      // CHANGE-110：本檔驗證的是接線正確性，非 D4 政策 → 一律以「已核准」為前提
      allowSensitiveData: true,
      ...providerOverrides,
    },
  };
}

describe('LlmGatewayService × Anthropic provider（Story 23.3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    llmCircuitBreaker.reset();
    // 刻意設值：用來證明非 Azure provider 不會誤用 Azure 的端點 / 憑證
    process.env.AZURE_OPENAI_ENDPOINT = 'https://should-not-leak.openai.azure.com';
    process.env.AZURE_OPENAI_API_KEY = 'azure-key-should-not-leak';
  });

  it('should route an ANTHROPIC provider to @ai-sdk/anthropic instead of throwing unsupported', async () => {
    vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(
      mockAnthropicModel() as never
    );

    const plan = await llmGatewayService.describeCall({
      modelId: 'model-anthropic',
      messages: USER_MSG,
    });

    expect(plan.providerType).toBe('ANTHROPIC');
    expect(createAnthropic).toHaveBeenCalledTimes(1);
    expect(createAzure).not.toHaveBeenCalled();
  });

  it('should identify the model by modelKey (not an Azure deployment name)', async () => {
    vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(
      mockAnthropicModel() as never
    );

    await llmGatewayService.describeCall({
      modelId: 'model-anthropic',
      messages: USER_MSG,
    });

    const provider = vi.mocked(createAnthropic).mock.results[0]?.value;
    expect(provider.languageModel).toHaveBeenCalledWith('claude-opus-5');
  });

  it('should decrypt the stored credential and never fall back to the Azure env key', async () => {
    vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(
      mockAnthropicModel() as never
    );

    await llmGatewayService.describeCall({
      modelId: 'model-anthropic',
      messages: USER_MSG,
    });

    const settings = vi.mocked(createAnthropic).mock.calls[0][0];
    expect(settings?.apiKey).toBe('sk-ant-test');
    expect(settings?.apiKey).not.toBe(process.env.AZURE_OPENAI_API_KEY);
  });

  it('should omit baseURL when the provider has none, rather than leaking AZURE_OPENAI_ENDPOINT', async () => {
    vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(
      mockAnthropicModel() as never
    );

    const plan = await llmGatewayService.describeCall({
      modelId: 'model-anthropic',
      messages: USER_MSG,
    });

    const settings = vi.mocked(createAnthropic).mock.calls[0][0];
    // 未填 baseUrl → 交給 @ai-sdk/anthropic 用官方預設，不得帶 Azure 端點
    expect(settings).not.toHaveProperty('baseURL');
    expect(plan.baseUrlHost).toBe('');
  });

  it('should pass a self-hosted proxy baseUrl through when the provider sets one', async () => {
    vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(
      mockAnthropicModel({ baseUrl: 'https://proxy.internal/v1/' }) as never
    );

    await llmGatewayService.describeCall({
      modelId: 'model-anthropic',
      messages: USER_MSG,
    });

    const settings = vi.mocked(createAnthropic).mock.calls[0][0];
    expect(settings?.baseURL).toBe('https://proxy.internal/v1');
  });

  it('should still reject provider types that are not wired yet', async () => {
    vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(
      mockAnthropicModel({ providerType: 'GOOGLE_GEMINI' }) as never
    );

    await expect(
      llmGatewayService.describeCall({ modelId: 'model-anthropic', messages: USER_MSG })
    ).rejects.toMatchObject({ code: 'PROVIDER_TYPE_UNSUPPORTED' });
  });
});
