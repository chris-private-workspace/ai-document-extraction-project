/**
 * @fileoverview LlmGatewayService 單元測試（Epic 23 - Story 23.1 step 3/4）
 * @description
 *   驗證 gateway 契約（tech-spec §3.3–3.8），全程 mock（無網路、無 DB）：
 *   - describeCall 請求組裝：capability gate（temperature 丟棄）、部署名解析、output 模式、圖片數。
 *   - call() 三態 output（text / json / object）+ usage 映射 + G10 降級。
 *   - resolveModelIdByKey：key → 預設 Azure provider 的 LlmModel.id / null。
 *   - 錯誤路徑：未知 modelId → success:false（不拋）。
 *
 * @module tests/unit/services/llm-gateway.service.test
 * @since Epic 23 - Story 23.1
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock AI SDK 呼叫（只用到 3 個函式）
vi.mock('ai', () => ({
  generateText: vi.fn(),
  generateObject: vi.fn(),
  jsonSchema: vi.fn((s: unknown) => s),
}));

// Mock Azure provider：createAzure(...).chat(dep) → 佔位 model
vi.mock('@ai-sdk/azure', () => {
  const chat = vi.fn((id: string) => ({ __model: id }));
  const provider = Object.assign(vi.fn((id: string) => ({ __model: id })), { chat });
  return { createAzure: vi.fn(() => provider) };
});

// Mock Prisma（gateway 只用 llmModel.findUnique / findFirst）
vi.mock('@/lib/prisma', () => ({
  prisma: {
    llmModel: { findUnique: vi.fn(), findFirst: vi.fn() },
  },
}));

import { generateText, generateObject } from 'ai';
import { prisma } from '@/lib/prisma';
import { llmGatewayService } from '@/services/llm';
import type { LlmMessage } from '@/services/llm';

/** 預設 Azure LlmModel（含 provider include），模擬 step 1 播種 */
function mockLlmModel(overrides?: Record<string, unknown>) {
  return {
    id: 'model-1',
    modelKey: 'gpt-5.2',
    isEnabled: true,
    capability: {
      maxTokens: 8192,
      supportsTemperature: true,
      temperature: 0.1,
      supportsJsonSchema: true,
      supportsVision: true,
      deploymentEnvVar: 'AZURE_OPENAI_DEPLOYMENT_NAME',
      defaultDeploymentName: 'gpt-5-2-vision',
    },
    provider: {
      name: 'Azure OpenAI (default)',
      providerType: 'AZURE_OPENAI',
      baseUrl: 'https://test.openai.azure.com',
      apiVersion: '2024-12-01-preview',
      apiKeyEnc: null,
      isEncrypted: false,
      isEnabled: true,
      isDefault: true,
    },
    ...overrides,
  };
}

const USER_MSG: LlmMessage[] = [{ role: 'user', content: 'x' }];

describe('LlmGatewayService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AZURE_OPENAI_API_KEY = 'test-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
    // 確保部署名走 capability.defaultDeploymentName（不被 env 覆蓋）
    delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
    delete process.env.AZURE_OPENAI_NANO_DEPLOYMENT_NAME;
  });

  afterEach(() => {
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_ENDPOINT;
  });

  describe('describeCall（請求組裝快照，§3.8）', () => {
    it('should assemble Azure object-mode plan with capability-driven params', async () => {
      vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(mockLlmModel() as never);

      const plan = await llmGatewayService.describeCall({
        modelId: 'model-1',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'usr' },
        ],
        images: [{ data: 'data:image/png;base64,AAAA' }],
        output: { mode: 'object', jsonSchema: { type: 'object' } },
      });

      expect(plan.providerType).toBe('AZURE_OPENAI');
      expect(plan.deploymentName).toBe('gpt-5-2-vision');
      expect(plan.baseUrlHost).toBe('test.openai.azure.com');
      expect(plan.apiVersion).toBe('2024-12-01-preview');
      expect(plan.outputMode).toBe('object');
      expect(plan.maxOutputTokens).toBe(8192);
      expect(plan.temperature).toBe(0.1);
      expect(plan.imageCount).toBe(1);
      expect(plan.messageRoles).toEqual(['system', 'user']);
      expect(plan.maxRetries).toBe(2);
    });

    it('should drop temperature when model capability does not support it (gate)', async () => {
      vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(
        mockLlmModel({
          capability: {
            maxTokens: 4096,
            supportsTemperature: false,
            supportsJsonSchema: false,
            supportsVision: true,
            deploymentEnvVar: 'AZURE_OPENAI_NANO_DEPLOYMENT_NAME',
            defaultDeploymentName: 'gpt-5-nano',
          },
        }) as never,
      );

      const plan = await llmGatewayService.describeCall({
        modelId: 'model-1',
        messages: USER_MSG,
        temperature: 0.7, // 呼叫端要求，但模型不支援 → 應丟棄
      });

      expect(plan.temperature).toBeUndefined();
      expect(plan.maxOutputTokens).toBe(4096);
      expect(plan.deploymentName).toBe('gpt-5-nano');
    });

    it('should let AZURE_OPENAI_DEPLOYMENT_NAME env override the default deployment', async () => {
      process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'gpt-5-4-mini-aidocprocessing';
      vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(mockLlmModel() as never);

      const plan = await llmGatewayService.describeCall({ modelId: 'model-1', messages: USER_MSG });

      expect(plan.deploymentName).toBe('gpt-5-4-mini-aidocprocessing');
    });
  });

  describe('call()（三態 output + usage 映射）', () => {
    it('should call generateText and map usage for text mode', async () => {
      vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(mockLlmModel() as never);
      vi.mocked(generateText).mockResolvedValue({
        text: 'hello',
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        finishReason: 'stop',
      } as never);

      const r = await llmGatewayService.call({
        modelId: 'model-1',
        messages: USER_MSG,
        output: { mode: 'text' },
      });

      expect(r.success).toBe(true);
      expect(r.text).toBe('hello');
      expect(r.object).toBeUndefined();
      expect(r.usage).toEqual({ input: 3, output: 2, total: 5 });
      expect(r.providerType).toBe('AZURE_OPENAI');
      expect(generateText).toHaveBeenCalledTimes(1);
      expect(generateObject).not.toHaveBeenCalled();
    });

    it('should call generateObject and stringify object for object mode', async () => {
      vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(mockLlmModel() as never);
      vi.mocked(generateObject).mockResolvedValue({
        object: { a: 1 },
        usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
        finishReason: 'stop',
      } as never);

      const r = await llmGatewayService.call({
        modelId: 'model-1',
        messages: USER_MSG,
        output: { mode: 'object', jsonSchema: { type: 'object' } },
      });

      expect(r.success).toBe(true);
      expect(r.object).toEqual({ a: 1 });
      expect(r.text).toBe(JSON.stringify({ a: 1 }));
      expect(r.usage).toEqual({ input: 4, output: 6, total: 10 });
      expect(generateObject).toHaveBeenCalledTimes(1);
    });

    it('should derive total usage from input+output when totalTokens is missing', async () => {
      vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(mockLlmModel() as never);
      vi.mocked(generateText).mockResolvedValue({
        text: 'x',
        usage: { inputTokens: 7, outputTokens: 8, totalTokens: undefined },
        finishReason: 'stop',
      } as never);

      const r = await llmGatewayService.call({
        modelId: 'model-1',
        messages: USER_MSG,
        output: { mode: 'text' },
      });

      expect(r.usage).toEqual({ input: 7, output: 8, total: 15 });
    });
  });

  describe('G10 降級（§3.6）', () => {
    it('should fall back to generateText when generateObject fails', async () => {
      vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(mockLlmModel() as never);
      vi.mocked(generateObject).mockRejectedValue(new Error('schema unsupported'));
      vi.mocked(generateText).mockResolvedValue({
        text: '{"a":1}',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'stop',
      } as never);

      const r = await llmGatewayService.call({
        modelId: 'model-1',
        messages: USER_MSG,
        output: { mode: 'json' },
      });

      expect(r.success).toBe(true);
      expect(r.text).toBe('{"a":1}');
      expect(r.object).toBeUndefined();
      expect(generateObject).toHaveBeenCalledTimes(1);
      expect(generateText).toHaveBeenCalledTimes(1);
    });
  });

  describe('錯誤路徑（不拋、回 success:false）', () => {
    it('should return success:false when modelId is unknown', async () => {
      vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(null as never);

      const r = await llmGatewayService.call({ modelId: 'nope', messages: USER_MSG });

      expect(r.success).toBe(false);
      expect(r.error).toContain('未知模型');
      expect(r.usage).toEqual({ input: 0, output: 0, total: 0 });
      expect(generateText).not.toHaveBeenCalled();
    });

    it('should return success:false when provider is disabled', async () => {
      vi.mocked(prisma.llmModel.findUnique).mockResolvedValue(
        mockLlmModel({
          provider: { ...mockLlmModel().provider, isEnabled: false },
        }) as never,
      );

      const r = await llmGatewayService.call({ modelId: 'model-1', messages: USER_MSG });

      expect(r.success).toBe(false);
      expect(r.error).toContain('Provider 已停用');
    });
  });

  describe('resolveModelIdByKey', () => {
    it('should return the LlmModel id for a known key under the default Azure provider', async () => {
      vi.mocked(prisma.llmModel.findFirst).mockResolvedValue({ id: 'm-9' } as never);

      const id = await llmGatewayService.resolveModelIdByKey('gpt-5.2');

      expect(id).toBe('m-9');
    });

    it('should return null when no matching model exists', async () => {
      vi.mocked(prisma.llmModel.findFirst).mockResolvedValue(null as never);

      const id = await llmGatewayService.resolveModelIdByKey('nonexistent');

      expect(id).toBeNull();
    });
  });
});
