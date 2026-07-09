/**
 * @fileoverview LLM Gateway 服務 — 經 Vercel AI SDK 統一 LLM 呼叫（Epic 23 - Story 23.1 step 3）
 * @description
 *   把散落的直接 provider 呼叫收斂為單一 gateway（tech-spec §3.3–3.8）。本 step 只接
 *   `@ai-sdk/azure`（Azure OpenAI）；其他 provider（OpenAI/Claude/Gemini/Grok）於 Story 23.3 擴充。
 *
 *   流程（§3.2）：
 *     1. resolve(modelId) → `LlmModel` + `LlmProvider` + capability（讀 Story 23.1 資料模型）
 *     2. 解密憑證（**fail-closed**，走 `decryptConfigValue`）；憑證未加密前對 Azure 走 env fallback
 *     3. buildModel() → AI SDK `LanguageModel`（Azure：`useDeploymentBasedUrls` 對齊現行 wire 結構）
 *     4. generateText / generateObject（三態 output + G10 降級）
 *     5. capability gate（temperature 不支援即丟棄）+ 統一回應 usage/錯誤
 *
 *   ⚠️ **不吞呼叫端業務 fallback**（§3.7）：失敗只回 `success:false`，由呼叫端決定降級。
 *   ⚠️ 結構化 logging + 用量持久化（`ApiUsageLog`）屬 Story 23.1 step 5，本檔尚未接入。
 *
 * @module src/services/llm/llm-gateway.service
 * @since Epic 23 - Story 23.1
 * @lastModified 2026-07-09
 *
 * @related
 *   - src/services/extraction-v3/stages/gpt-caller.service.ts - 遷移前的直接 Azure 呼叫（step 4 接入）
 *   - src/lib/config-encryption.ts - 憑證解密（fail-closed）
 *   - prisma/schema.prisma - LlmProvider / LlmModel
 */

import { generateText, generateObject, jsonSchema } from 'ai';
import type { ModelMessage } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import { createAzure } from '@ai-sdk/azure';
import type { LlmProviderType } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { decryptConfigValue } from '@/lib/config-encryption';

import type {
  LlmCallInput,
  LlmCallPlan,
  LlmCallResult,
  LlmCallUsage,
  LlmImagePart,
  LlmMessage,
  LlmOutputSpec,
} from './llm-gateway.types';

// ============================================================================
// 常數
// ============================================================================

/** Azure API 版本預設值（對齊 gpt-caller.service 的 `2024-12-01-preview`） */
const DEFAULT_AZURE_API_VERSION = '2024-12-01-preview';

/** 技術層 retry 預設次數（§3.7；AI SDK 內建遞增 backoff） */
const DEFAULT_MAX_RETRIES = 2;

/** 呼叫逾時預設值（毫秒，對齊 gpt-caller 的 5 分鐘） */
const DEFAULT_TIMEOUT_MS = 300_000;

/** 圖片預設 MIME 類型 */
const DEFAULT_IMAGE_MEDIA_TYPE = 'image/png';

// ============================================================================
// 內部型別
// ============================================================================

/** 從 `LlmModel.capability`（Json）解出的能力描述 + Azure 部署解析提示（seed 寫入） */
interface StoredCapability {
  maxTokens: number;
  supportsTemperature: boolean;
  temperature?: number;
  supportsJsonSchema: boolean;
  supportsVision: boolean;
  deploymentEnvVar?: string;
  defaultDeploymentName?: string;
}

/** 解析後的 provider + 模型（含解密憑證，僅存活於單次呼叫記憶體） */
interface ResolvedModel {
  providerType: LlmProviderType;
  modelKey: string;
  deploymentName: string;
  capability: StoredCapability;
  apiKey: string;
  baseUrl: string;
  apiVersion: string;
}

/** 組裝完成、待送出的呼叫（供 call() 與 describeCall() 共用） */
interface PreparedCall {
  resolved: ResolvedModel;
  model: ReturnType<ReturnType<typeof createAzure>['chat']>;
  aiMessages: ModelMessage[];
  output: LlmOutputSpec;
  maxOutputTokens: number;
  maxRetries: number;
  temperature?: number;
  providerOptions?: ProviderOptions;
  abortSignal: AbortSignal;
}

// ============================================================================
// 錯誤
// ============================================================================

/** Gateway 解析 / 設定錯誤（未知模型、停用、缺憑證、未支援 provider 型別等） */
export class LlmGatewayError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'LlmGatewayError';
  }
}

// ============================================================================
// 純函式輔助
// ============================================================================

/** 解析 `LlmModel.capability`（Json）→ StoredCapability（缺值採保守預設） */
function parseCapability(raw: unknown): StoredCapability {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LlmGatewayError('LlmModel.capability 格式錯誤', 'INVALID_CAPABILITY');
  }
  const c = raw as Record<string, unknown>;
  return {
    maxTokens: typeof c.maxTokens === 'number' ? c.maxTokens : 8192,
    supportsTemperature: c.supportsTemperature === true,
    temperature: typeof c.temperature === 'number' ? c.temperature : undefined,
    supportsJsonSchema: c.supportsJsonSchema === true,
    supportsVision: c.supportsVision === true,
    deploymentEnvVar:
      typeof c.deploymentEnvVar === 'string' ? c.deploymentEnvVar : undefined,
    defaultDeploymentName:
      typeof c.defaultDeploymentName === 'string' ? c.defaultDeploymentName : undefined,
  };
}

/** 解析實際 Azure 部署名稱（env 覆蓋 → 模型預設 → 退回 modelKey；對齊 resolveDeploymentName） */
function resolveDeploymentName(capability: StoredCapability, modelKey: string): string {
  const envName = capability.deploymentEnvVar
    ? process.env[capability.deploymentEnvVar]
    : undefined;
  return envName || capability.defaultDeploymentName || modelKey;
}

/** capability gate：不支援 temperature 即丟棄；否則採呼叫端值、缺則採模型預設（§3.4 G5） */
function resolveTemperature(
  requested: number | undefined,
  capability: StoredCapability,
): number | undefined {
  if (!capability.supportsTemperature) return undefined;
  return requested ?? capability.temperature;
}

/**
 * 圖片 → AI SDK FilePart（§3.5）。
 * ⚠️ `img.detail`（low/high/auto）目前**未**轉發至 provider option——AI SDK 各 provider 的 image
 *    detail 傳法未經查證，盲設風險高（§3.8 wire 非零風險）。`detail` 保留在資料層、由呼叫端忠實傳入，
 *    實際 wire 轉發（影響 nano 階段成本）列為 **step 4b 等價調校項**，於 shadow 比對時定案。
 */
function toFilePart(img: LlmImagePart): { type: 'file'; mediaType: string; data: string } {
  return { type: 'file', mediaType: img.mediaType ?? DEFAULT_IMAGE_MEDIA_TYPE, data: img.data };
}

/**
 * 映射 provider-agnostic 訊息 → AI SDK `ModelMessage[]`。
 * 圖片附加到**最後一則 user 訊息**，且**圖片在前、文字在後**（對齊現行 gpt-caller 擺法）。
 */
function toAiMessages(messages: LlmMessage[], images?: LlmImagePart[]): ModelMessage[] {
  const hasImages = !!images && images.length > 0;
  let lastUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') lastUserIdx = i;
  }

  const result: ModelMessage[] = messages.map((m, i) => {
    if (hasImages && m.role === 'user' && i === lastUserIdx) {
      return {
        role: 'user',
        content: [...images!.map(toFilePart), { type: 'text' as const, text: m.content }],
      };
    }
    return { role: m.role, content: m.content } as ModelMessage;
  });

  // 有圖片但無任何 user 訊息 → 補一則承載圖片的 user 訊息
  if (hasImages && lastUserIdx === -1) {
    result.push({ role: 'user', content: images!.map(toFilePart) });
  }
  return result;
}

/** AI SDK usage（inputTokens/outputTokens/totalTokens，皆可能 undefined）→ LlmCallUsage */
function mapUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}): LlmCallUsage {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const total = usage.totalTokens ?? input + output;
  return { input, output, total };
}

/** 安全序列化（object → text，供呼叫端沿用既有 text-parse 路徑） */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** G10 降級：generateObject 失敗 → generateText，補一則要求純 JSON 的指示 */
function withJsonInstruction(messages: ModelMessage[]): ModelMessage[] {
  return [
    ...messages,
    {
      role: 'user',
      content: 'Respond with valid JSON only — no prose, no markdown, no code fences.',
    },
  ];
}

// ============================================================================
// 服務
// ============================================================================

/**
 * LLM Gateway 服務。
 * @remarks 本 step 僅支援 `AZURE_OPENAI`；其他 provider 型別於 Story 23.3 擴充。
 */
export class LlmGatewayService {
  /**
   * 統一 LLM 呼叫。任何解析/呼叫錯誤都回 `success:false`（不拋、不吞呼叫端業務 fallback）。
   */
  async call(input: LlmCallInput): Promise<LlmCallResult> {
    const start = Date.now();
    let providerType: LlmProviderType | undefined;

    try {
      const prepared = await this.prepare(input);
      providerType = prepared.resolved.providerType;

      const settings = this.buildSettings(prepared);

      // 純文字
      if (prepared.output.mode === 'text') {
        const r = await generateText(settings);
        return this.success(input.modelId, providerType, start, {
          text: r.text,
          usage: r.usage,
          finishReason: r.finishReason,
        });
      }

      // json / object → generateObject，失敗走 G10 降級
      try {
        const r =
          prepared.output.mode === 'object'
            ? await generateObject({
                ...settings,
                schema: jsonSchema(prepared.output.jsonSchema),
                ...(prepared.output.name ? { schemaName: prepared.output.name } : {}),
              })
            : await generateObject({ ...settings, output: 'no-schema' });

        return this.success(input.modelId, providerType, start, {
          text: safeStringify(r.object),
          object: r.object,
          usage: r.usage,
          finishReason: r.finishReason,
        });
      } catch {
        // §3.6/§3.10 降級：改用 generateText + JSON 指示，呼叫端自行 parse
        const r = await generateText({
          ...settings,
          messages: withJsonInstruction(prepared.aiMessages),
        });
        return this.success(input.modelId, providerType, start, {
          text: r.text,
          usage: r.usage,
          finishReason: r.finishReason,
        });
      }
    } catch (error) {
      return {
        success: false,
        text: '',
        usage: { input: 0, output: 0, total: 0 },
        modelId: input.modelId,
        providerType,
        durationMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 去敏請求組裝快照（§3.8）：解析 + 組裝但**不送網路**，用於遷移等價比對 / 單元測試。
   * @remarks 內部會解密憑證以建立 model，但回傳的 plan **不含**任何憑證。
   */
  async describeCall(input: LlmCallInput): Promise<LlmCallPlan> {
    const prepared = await this.prepare(input);
    let baseUrlHost = '';
    try {
      baseUrlHost = new URL(prepared.resolved.baseUrl).host;
    } catch {
      baseUrlHost = '';
    }
    return {
      modelId: input.modelId,
      providerType: prepared.resolved.providerType,
      deploymentName: prepared.resolved.deploymentName,
      baseUrlHost,
      apiVersion: prepared.resolved.apiVersion,
      outputMode: prepared.output.mode,
      messageRoles: input.messages.map((m) => m.role),
      imageCount: input.images?.length ?? 0,
      maxOutputTokens: prepared.maxOutputTokens,
      temperature: prepared.temperature,
      maxRetries: prepared.maxRetries,
    };
  }

  /**
   * 解析 model **key**（如 `'gpt-5.2'`）→ 預設啟用 Azure provider 下該 modelKey 的 `LlmModel.id`。
   * 供 key-based 呼叫端（extraction gpt-caller，Story 23.1 step 4）接入 gateway；
   * 找不到即回 `null`，呼叫端據此回退既有直接 Azure 路徑（播種缺失時零風險）。
   */
  async resolveModelIdByKey(modelKey: string): Promise<string | null> {
    const model = await prisma.llmModel.findFirst({
      where: {
        modelKey,
        isEnabled: true,
        provider: { isDefault: true, isEnabled: true, providerType: 'AZURE_OPENAI' },
      },
      select: { id: true },
    });
    return model?.id ?? null;
  }

  // --------------------------------------------------------------------------
  // 內部
  // --------------------------------------------------------------------------

  /** resolve + buildModel + 組裝訊息/參數（供 call/describeCall 共用） */
  private async prepare(input: LlmCallInput): Promise<PreparedCall> {
    const resolved = await this.resolveModel(input.modelId);
    const model = this.buildModel(resolved);
    const aiMessages = toAiMessages(input.messages, input.images);
    const output: LlmOutputSpec = input.output ?? { mode: 'text' };
    const temperature = resolveTemperature(input.temperature, resolved.capability);
    const maxOutputTokens = input.maxOutputTokens ?? resolved.capability.maxTokens;
    const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES;
    const providerOptions = input.providerOptions as ProviderOptions | undefined;
    const abortSignal = AbortSignal.timeout(input.abortTimeoutMs ?? DEFAULT_TIMEOUT_MS);

    return {
      resolved,
      model,
      aiMessages,
      output,
      maxOutputTokens,
      maxRetries,
      temperature,
      providerOptions,
      abortSignal,
    };
  }

  /** 讀 LlmModel + LlmProvider，解出部署名與憑證（憑證解密 fail-closed） */
  private async resolveModel(modelId: string): Promise<ResolvedModel> {
    const model = await prisma.llmModel.findUnique({
      where: { id: modelId },
      include: { provider: true },
    });
    if (!model) {
      throw new LlmGatewayError(`未知模型 id: ${modelId}`, 'MODEL_NOT_FOUND');
    }
    if (!model.isEnabled) {
      throw new LlmGatewayError(`模型已停用: ${modelId}`, 'MODEL_DISABLED');
    }
    const provider = model.provider;
    if (!provider.isEnabled) {
      throw new LlmGatewayError(`Provider 已停用: ${provider.name}`, 'PROVIDER_DISABLED');
    }

    const capability = parseCapability(model.capability);
    const deploymentName = resolveDeploymentName(capability, model.modelKey);
    const apiKey = this.resolveApiKey(provider);

    return {
      providerType: provider.providerType,
      modelKey: model.modelKey,
      deploymentName,
      capability,
      apiKey,
      baseUrl: provider.baseUrl ?? process.env.AZURE_OPENAI_ENDPOINT ?? '',
      apiVersion: provider.apiVersion ?? DEFAULT_AZURE_API_VERSION,
    };
  }

  /**
   * 取憑證：已加密 → `decryptConfigValue`（fail-closed，解不出即拋，不把亂碼當 key 送出，§4）；
   * 尚未寫入加密憑證時（Story 23.2/3 前），Azure provider 走既有 env fallback，維持行為零變。
   */
  private resolveApiKey(provider: {
    name: string;
    providerType: LlmProviderType;
    apiKeyEnc: string | null;
    isEncrypted: boolean;
  }): string {
    if (provider.apiKeyEnc) {
      return provider.isEncrypted ? decryptConfigValue(provider.apiKeyEnc) : provider.apiKeyEnc;
    }
    if (provider.providerType === 'AZURE_OPENAI') {
      const envKey = process.env.AZURE_OPENAI_API_KEY;
      if (envKey) return envKey;
    }
    throw new LlmGatewayError(`Provider 缺少憑證: ${provider.name}`, 'MISSING_CREDENTIAL');
  }

  /** 依 provider 型別建 AI SDK model（本 step 僅 Azure） */
  private buildModel(resolved: ResolvedModel): PreparedCall['model'] {
    switch (resolved.providerType) {
      case 'AZURE_OPENAI':
        return this.buildAzureModel(resolved);
      default:
        throw new LlmGatewayError(
          `Provider 型別尚未支援（Story 23.3 擴充）: ${resolved.providerType}`,
          'PROVIDER_TYPE_UNSUPPORTED',
        );
    }
  }

  /**
   * 建 Azure chat model。`useDeploymentBasedUrls: true` + `baseURL={endpoint}/openai` 使
   * 解析 URL 為 `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...`，
   * 與現行手寫 fetch 的 wire 結構一致（§3.8 已註記 wire 非零風險，等價驗證於 step 4）。
   */
  private buildAzureModel(resolved: ResolvedModel): PreparedCall['model'] {
    const trimmed = resolved.baseUrl.replace(/\/+$/, '');
    const baseURL = trimmed.endsWith('/openai') ? trimmed : `${trimmed}/openai`;
    const provider = createAzure({
      baseURL,
      apiKey: resolved.apiKey,
      apiVersion: resolved.apiVersion,
      useDeploymentBasedUrls: true,
    });
    return provider.chat(resolved.deploymentName);
  }

  /** 組裝 generateText/generateObject 共用參數（conditional 併入 temperature/providerOptions） */
  private buildSettings(prepared: PreparedCall) {
    return {
      model: prepared.model,
      messages: prepared.aiMessages,
      maxOutputTokens: prepared.maxOutputTokens,
      maxRetries: prepared.maxRetries,
      abortSignal: prepared.abortSignal,
      ...(prepared.temperature !== undefined ? { temperature: prepared.temperature } : {}),
      ...(prepared.providerOptions ? { providerOptions: prepared.providerOptions } : {}),
    };
  }

  /** 組成成功結果（統一 usage 映射 + 耗時） */
  private success(
    modelId: string,
    providerType: LlmProviderType,
    start: number,
    r: {
      text: string;
      object?: unknown;
      usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      finishReason?: string;
    },
  ): LlmCallResult {
    return {
      success: true,
      text: r.text,
      object: r.object,
      usage: mapUsage(r.usage),
      modelId,
      providerType,
      finishReason: r.finishReason,
      durationMs: Date.now() - start,
    };
  }
}

/** 單例 */
export const llmGatewayService = new LlmGatewayService();
