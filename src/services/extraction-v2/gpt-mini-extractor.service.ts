/**
 * @fileoverview GPT-5-mini 欄位提取服務
 * @description
 *   使用輕量級 GPT 模型（GPT-5-mini/GPT-5-nano）從結構化數據中提取欄位：
 *   - 輸入：精選後的 keyValuePairs + tables（Markdown 格式）
 *   - 輸出：標準化欄位名 + 值 + 信心度
 *   - 根據 Prompt Config 定義的欄位清單提取
 *
 *   此服務是 CHANGE-020 新提取架構的核心組件，
 *   負責智能欄位提取和標準化。
 *
 * @module src/services/extraction-v2/gpt-mini-extractor
 * @since CHANGE-020 - Extraction V2 Architecture
 * @lastModified 2026-01-29
 *
 * @features
 *   - 使用輕量級 GPT 模型（成本低）
 *   - 根據 Prompt Config 自定義提取欄位
 *   - 結構化 JSON 輸出
 *   - Token 使用追蹤
 *   - 信心度評估
 *
 * @dependencies
 *   - Azure OpenAI Service
 *
 * @related
 *   - src/services/extraction-v2/azure-di-document.service.ts - Azure DI 服務
 *   - src/services/extraction-v2/data-selector.service.ts - 數據精選服務
 *   - src/services/gpt-vision.service.ts - GPT Vision 服務
 */

import { AzureOpenAI } from 'openai';
import { resolveDeploymentNameByKey } from '@/lib/constants/llm-models';
import { callGatewayByModelKey } from '@/services/llm';
import type { SelectedData } from './data-selector.service';

// ============================================================
// Types
// ============================================================

/**
 * 提取的欄位值
 */
export interface ExtractedFieldResult {
  /** 欄位值 */
  value: string | number | null;
  /** 信心度 (0-1) */
  confidence: number;
  /** 值來源 */
  source: 'keyValuePair' | 'table' | 'inferred' | 'not_found';
  /** 原始標籤（如果從 keyValuePair 提取） */
  originalLabel?: string;
}

/**
 * GPT-mini 提取結果
 */
export interface GptMiniExtractionResult {
  /** 提取成功 */
  success: boolean;
  /** 提取的欄位 */
  fields: Record<string, ExtractedFieldResult>;
  /** Token 使用量 */
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };
  /** 處理時間（毫秒） */
  processingTimeMs: number;
  /** 使用的模型 */
  modelUsed: string;
  /** 錯誤信息（如果有） */
  error?: string;
}

/**
 * 欄位定義（來自 Prompt Config）
 */
export interface FieldDefinition {
  /** 欄位名稱 */
  name: string;
  /** 欄位描述 */
  description?: string;
  /** 欄位類型 */
  type?: 'string' | 'number' | 'date' | 'currency';
  /** 可能的標籤變體 */
  aliases?: string[];
  /** 是否必填 */
  required?: boolean;
}

/**
 * GPT-mini 提取配置
 */
export interface GptMiniExtractorConfig {
  /** Azure OpenAI Endpoint */
  endpoint?: string;
  /** API Key */
  apiKey?: string;
  /** 部署名稱（預設使用 nano） */
  deploymentName?: string;
  /** API 版本 */
  apiVersion?: string;
  /** 最大 tokens（輸出） */
  maxTokens?: number;
  /** 溫度（0-1，預設 0.1 用於精確提取） */
  temperature?: number;
}

// ============================================================
// Constants
// ============================================================

/**
 * 預設配置
 */
/**
 * 本服務的預設模型 key（FIX-137）。
 * 原先硬編 `gpt-5-nano`，但該 deployment 已於 CHANGE-102 移除 → env 未設即 404。
 * 本服務為輕量純文字提取，對應到白名單的 nano。
 */
const DEFAULT_MODEL_KEY = 'gpt-5.4-nano';

const DEFAULT_CONFIG: Required<GptMiniExtractorConfig> = {
  endpoint: process.env.AZURE_OPENAI_ENDPOINT ?? '',
  apiKey: process.env.AZURE_OPENAI_API_KEY ?? '',
  deploymentName: resolveDeploymentNameByKey(DEFAULT_MODEL_KEY),
  apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? '2024-12-01-preview',
  maxTokens: 1000,
  temperature: 0.1,
};

// ============================================================
// Helper Functions
// ============================================================

/**
 * 檢測是否為 reasoning 模型（o-series）
 * Reasoning 模型有特殊的 API 要求：
 * - 不支持 temperature
 * - 必須使用 max_completion_tokens
 * - system message 會被當作 developer message
 */
export function isReasoningModel(deploymentName: string): boolean {
  const reasoningPatterns = [
    /^o1/i,        // o1, o1-mini, o1-preview
    /^o3/i,        // o3, o3-mini
    /^o4/i,        // o4-mini
    // FIX-137：原為 /gpt-5-nano/i 與 /gpt-5-mini/i，對 5.4 系列（gpt-5.4-nano /
    // gpt-5.4-mini）**不匹配**。而 5.4 確實是 reasoning 模型——2026-07-27 實跑時
    // AI SDK 明確警告 "temperature is not supported for reasoning models"。
    // 漏判會送錯參數格式（temperature + max_tokens），比 404 更難診斷。
    // 非錨定比對，故容納 Azure 部署名後綴（如 gpt-5.4-mini-aidocprocessing）。
    /gpt-5(\.\d+)?-nano/i,
    /gpt-5(\.\d+)?-mini/i,
  ];
  return reasoningPatterns.some(pattern => pattern.test(deploymentName));
}

/**
 * 創建 Azure OpenAI 客戶端
 */
function createClient(config: GptMiniExtractorConfig): AzureOpenAI {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  if (!mergedConfig.endpoint || !mergedConfig.apiKey) {
    throw new Error('Azure OpenAI endpoint and API key are required');
  }

  return new AzureOpenAI({
    endpoint: mergedConfig.endpoint,
    apiKey: mergedConfig.apiKey,
    apiVersion: mergedConfig.apiVersion,
    deployment: mergedConfig.deploymentName,
  });
}

/**
 * 生成系統提示
 */
function generateSystemPrompt(fields: FieldDefinition[]): string {
  const fieldDescriptions = fields
    .map((f) => {
      let desc = `- ${f.name}`;
      if (f.description) desc += `: ${f.description}`;
      if (f.type) desc += ` (type: ${f.type})`;
      if (f.aliases?.length) desc += ` [may appear as: ${f.aliases.join(', ')}]`;
      if (f.required) desc += ' [REQUIRED]';
      return desc;
    })
    .join('\n');

  return `You are a document data extraction specialist. Your task is to extract specific fields from structured document data.

## Fields to Extract:
${fieldDescriptions}

## Instructions:
1. Analyze the provided key-value pairs and tables
2. Match each field to the most appropriate data point
3. Consider aliases and similar labels when matching
4. For currency/number fields, extract only the numeric value
5. For date fields, use ISO format (YYYY-MM-DD) when possible
6. Assess your confidence (0-1) for each extraction
7. If a field cannot be found, set value to null and confidence to 0

## Output Format:
Return ONLY a valid JSON object with this structure:
{
  "fieldName": {
    "value": <extracted value or null>,
    "confidence": <0-1>,
    "source": <"keyValuePair"|"table"|"inferred"|"not_found">,
    "originalLabel": <original label if from keyValuePair>
  }
}

Do not include any text before or after the JSON.`;
}

/**
 * 生成用戶提示
 */
function generateUserPrompt(selectedData: SelectedData): string {
  return `## Document Data

${selectedData.markdown}

---

Please extract the specified fields from the above data and return the JSON result.`;
}

/**
 * 解析 GPT 回應為結構化結果
 */
function parseGptResponse(
  response: string,
  fields: FieldDefinition[]
): Record<string, ExtractedFieldResult> {
  try {
    // 嘗試提取 JSON
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const result: Record<string, ExtractedFieldResult> = {};

    // 驗證和標準化每個欄位
    for (const field of fields) {
      const fieldData = parsed[field.name];

      if (fieldData && typeof fieldData === 'object') {
        result[field.name] = {
          value: fieldData.value ?? null,
          confidence: typeof fieldData.confidence === 'number' ? fieldData.confidence : 0,
          source: fieldData.source ?? 'not_found',
          originalLabel: fieldData.originalLabel,
        };
      } else if (fieldData !== undefined) {
        // 簡單值（非物件）
        result[field.name] = {
          value: fieldData,
          confidence: 0.7,
          source: 'inferred',
        };
      } else {
        // 欄位未找到
        result[field.name] = {
          value: null,
          confidence: 0,
          source: 'not_found',
        };
      }
    }

    return result;
  } catch (error) {
    console.error('[GptMiniExtractor] Failed to parse response:', error);

    // 返回所有欄位為未找到
    const result: Record<string, ExtractedFieldResult> = {};
    for (const field of fields) {
      result[field.name] = {
        value: null,
        confidence: 0,
        source: 'not_found',
      };
    }
    return result;
  }
}

// ============================================================
// Core Functions
// ============================================================

/**
 * 使用 GPT-mini 從結構化數據中提取欄位
 *
 * @description
 *   根據 Prompt Config 定義的欄位清單，
 *   從 Azure DI 精選數據中提取欄位值。
 *
 * @param selectedData - 精選後的數據（來自 data-selector）
 * @param fields - 要提取的欄位定義
 * @param config - GPT 配置
 * @returns 提取結果
 *
 * @example
 * ```typescript
 * const result = await extractFieldsWithGptMini(
 *   selectedData,
 *   [
 *     { name: 'invoiceNumber', description: 'Invoice ID', aliases: ['Invoice No', 'Inv #'] },
 *     { name: 'totalAmount', type: 'currency' },
 *   ]
 * );
 * console.log('Extracted:', result.fields);
 * ```
 */
export async function extractFieldsWithGptMini(
  selectedData: SelectedData,
  fields: FieldDefinition[],
  config: GptMiniExtractorConfig = {}
): Promise<GptMiniExtractionResult> {
  const startTime = Date.now();
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  try {
    // 檢查配置
    if (!mergedConfig.endpoint || !mergedConfig.apiKey) {
      console.warn('[GptMiniExtractor] Not configured, returning mock result');
      return createMockResult(fields, startTime, mergedConfig.deploymentName);
    }

    // 創建客戶端
    const client = createClient(mergedConfig);

    // 生成提示
    const systemPrompt = generateSystemPrompt(fields);
    const userPrompt = generateUserPrompt(selectedData);

    const isReasoning = isReasoningModel(mergedConfig.deploymentName);
    console.log(
      `[GptMiniExtractor] Extracting ${fields.length} fields ` +
        `with ${mergedConfig.deploymentName}` +
        (isReasoning ? ' (reasoning model detected)' : '') +
        '...'
    );

    // Epic 23 Story 23.4 Phase 1（呼叫點 #5）：flag 開啟且 modelKey 已播種時經 gateway；
    // 回 null（flag 關 / 未播種 / deployment 被呼叫端覆蓋）即落到下方既有直接呼叫，行為零變。
    // reasoning 模型的 developer role 由 `@ai-sdk/openai` 自動處理（tech-spec §3.5），
    // 故此處統一送 system；`reasoning_effort` 經 providerOptions 忠實轉發（G4）。
    const viaGateway =
      mergedConfig.deploymentName === resolveDeploymentNameByKey(DEFAULT_MODEL_KEY)
        ? await callGatewayByModelKey({
            modelKey: DEFAULT_MODEL_KEY,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            output: { mode: 'text' }, // 既有呼叫不帶 response_format
            maxOutputTokens: isReasoning ? 4000 : mergedConfig.maxTokens,
            temperature: isReasoning ? undefined : mergedConfig.temperature,
            providerOptions: isReasoning
              ? { openai: { reasoningEffort: 'low' } }
              : undefined,
          })
        : null;

    let content: string;
    let tokensUsed: { input: number; output: number; total: number };

    if (viaGateway) {
      content = viaGateway.content;
      tokensUsed = {
        input: viaGateway.usage.input,
        output: viaGateway.usage.output,
        total: viaGateway.usage.total,
      };
    } else {
      // 調用 GPT
      // 注意：
      // - 新版 Azure OpenAI API 使用 max_completion_tokens 而非 max_tokens
      // - Reasoning 模型（o1/o3/gpt-5-nano/gpt-5-mini）：
      //   - 不支持 temperature, top_p 等參數
      //   - system message 會被當作 developer message
      //   - 建議使用 developer role
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages: any[] = isReasoning
        ? [
            // Reasoning 模型：使用 developer role
            { role: 'developer', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ]
        : [
            // 標準 GPT 模型：使用 system role
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const requestParams: any = {
        model: mergedConfig.deploymentName,
        messages,
      };

      // Reasoning 模型特殊處理
      // 重要：reasoning_tokens 會消耗 max_completion_tokens 額度！
      // 例如：設定 1000，可能 1000 全用於推理，輸出為空
      // 因此 reasoning 模型需要更大的 token 限制
      if (isReasoning) {
        // Reasoning 模型需要更多 tokens（推理 + 輸出）
        // 使用 low effort 減少推理 token 消耗，留更多給輸出
        requestParams.max_completion_tokens = 4000; // 大幅增加以容納推理
        requestParams.reasoning_effort = 'low';      // 使用 low 減少推理消耗
      } else {
        // 標準模型
        requestParams.max_completion_tokens = mergedConfig.maxTokens;
        requestParams.temperature = mergedConfig.temperature;
      }

      const response = await client.chat.completions.create(requestParams);

      // 調試：輸出完整的 response 結構
      console.log(`[GptMiniExtractor] Response structure:`, {
        choices: response.choices?.length,
        finishReason: response.choices?.[0]?.finish_reason,
        messageRole: response.choices?.[0]?.message?.role,
        contentLength: response.choices?.[0]?.message?.content?.length ?? 0,
        usage: response.usage,
      });

      // 提取回應內容
      content = response.choices[0]?.message?.content ?? '';

      // 計算 token 使用
      tokensUsed = {
        input: response.usage?.prompt_tokens ?? 0,
        output: response.usage?.completion_tokens ?? 0,
        total: response.usage?.total_tokens ?? 0,
      };
    }

    // 調試：輸出 GPT 回應內容（前 500 字符）
    console.log(`[GptMiniExtractor] GPT Response (first 500 chars): ${content.substring(0, 500)}`);

    // 解析回應
    const extractedFields = parseGptResponse(content, fields);

    const processingTimeMs = Date.now() - startTime;

    // 計算成功提取的欄位數
    const extractedCount = Object.values(extractedFields).filter(
      (f) => f.value !== null
    ).length;

    console.log(
      `[GptMiniExtractor] Extracted ${extractedCount}/${fields.length} fields, ` +
        `tokens: ${tokensUsed.total}, time: ${processingTimeMs}ms`
    );

    return {
      success: true,
      fields: extractedFields,
      tokensUsed,
      processingTimeMs,
      modelUsed: mergedConfig.deploymentName,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[GptMiniExtractor] Extraction error: ${errorMessage}`);

    return {
      success: false,
      fields: fields.reduce(
        (acc, f) => ({
          ...acc,
          [f.name]: { value: null, confidence: 0, source: 'not_found' as const },
        }),
        {} as Record<string, ExtractedFieldResult>
      ),
      tokensUsed: { input: 0, output: 0, total: 0 },
      processingTimeMs: Date.now() - startTime,
      modelUsed: mergedConfig.deploymentName,
      error: errorMessage,
    };
  }
}

/**
 * 創建模擬結果（用於測試或未配置時）
 */
function createMockResult(
  fields: FieldDefinition[],
  startTime: number,
  modelUsed: string
): GptMiniExtractionResult {
  const mockValues: Record<string, unknown> = {
    invoiceNumber: 'INV-2024-001',
    invoiceDate: '2024-01-15',
    dueDate: '2024-02-15',
    vendorName: 'Sample Logistics Ltd.',
    customerName: 'RICOH ASIA PACIFIC',
    totalAmount: 1554.80,
    subtotal: 1554.80,
    currency: 'HKD',
  };

  const extractedFields: Record<string, ExtractedFieldResult> = {};

  for (const field of fields) {
    const mockValue = mockValues[field.name];
    if (mockValue !== undefined) {
      extractedFields[field.name] = {
        value: mockValue as string | number,
        confidence: 0.85,
        source: 'keyValuePair',
        originalLabel: field.name,
      };
    } else {
      extractedFields[field.name] = {
        value: null,
        confidence: 0,
        source: 'not_found',
      };
    }
  }

  return {
    success: true,
    fields: extractedFields,
    tokensUsed: { input: 500, output: 200, total: 700 },
    processingTimeMs: Date.now() - startTime,
    modelUsed: `${modelUsed} (mock)`,
  };
}

/**
 * 驗證 Azure OpenAI 配置
 */
export function validateConfig(): {
  valid: boolean;
  missing: string[];
  deploymentName: string;
} {
  const missing: string[] = [];

  if (!process.env.AZURE_OPENAI_ENDPOINT) {
    missing.push('AZURE_OPENAI_ENDPOINT');
  }
  if (!process.env.AZURE_OPENAI_API_KEY) {
    missing.push('AZURE_OPENAI_API_KEY');
  }

  // FIX-137：與 DEFAULT_CONFIG 同源，避免兩處各自 fallback 到不同（且已移除的）部署名
  const deploymentName = resolveDeploymentNameByKey(DEFAULT_MODEL_KEY);

  return {
    valid: missing.length === 0,
    missing,
    deploymentName,
  };
}

/**
 * 從 Prompt Config 轉換為 FieldDefinition
 *
 * @description
 *   將 Prompt Config 中定義的欄位轉換為 FieldDefinition 格式
 */
export function convertPromptConfigFields(
  promptConfig: {
    extractionPrompt?: string;
    fieldDefinitions?: Array<{
      name: string;
      description?: string;
      type?: string;
      aliases?: string[];
      required?: boolean;
    }>;
  } | null
): FieldDefinition[] {
  if (!promptConfig?.fieldDefinitions) {
    // 返回預設欄位清單
    return [
      { name: 'invoiceNumber', description: 'Invoice number or ID', aliases: ['Invoice No', 'Inv #', 'Invoice ID'] },
      { name: 'invoiceDate', description: 'Invoice date', type: 'date', aliases: ['Date', 'Invoice Date'] },
      { name: 'dueDate', description: 'Payment due date', type: 'date', aliases: ['Due Date', 'Payment Due'] },
      { name: 'vendorName', description: 'Vendor/Supplier name', aliases: ['Vendor', 'Supplier', 'From'] },
      { name: 'customerName', description: 'Customer/Buyer name', aliases: ['Customer', 'Bill To', 'Buyer'] },
      { name: 'totalAmount', description: 'Total amount', type: 'currency', aliases: ['Total', 'Amount Due', 'Grand Total'] },
      { name: 'subtotal', description: 'Subtotal before tax', type: 'currency', aliases: ['Subtotal', 'Sub Total'] },
      { name: 'currency', description: 'Currency code', aliases: ['Currency', 'Curr'] },
    ];
  }

  return promptConfig.fieldDefinitions.map((f) => ({
    name: f.name,
    description: f.description,
    type: f.type as FieldDefinition['type'],
    aliases: f.aliases,
    required: f.required,
  }));
}

/**
 * 測試 Azure OpenAI 連線
 */
export async function testConnection(): Promise<{
  success: boolean;
  message: string;
  latencyMs?: number;
  modelUsed?: string;
}> {
  const startTime = Date.now();

  try {
    const configCheck = validateConfig();
    if (!configCheck.valid) {
      return {
        success: false,
        message: `Missing configuration: ${configCheck.missing.join(', ')}`,
      };
    }

    const client = createClient({});
    const isReasoning = isReasoningModel(configCheck.deploymentName);

    // 使用簡單的測試請求
    // 注意：Reasoning 模型使用 max_completion_tokens，不使用 max_tokens
    const response = await client.chat.completions.create({
      model: configCheck.deploymentName,
      messages: [{ role: 'user', content: 'Test connection. Reply with "OK".' }],
      max_completion_tokens: 50, // 使用 max_completion_tokens（對所有模型兼容）
    });

    const content = response.choices[0]?.message?.content ?? '';

    return {
      success: true,
      message: `Connection successful. Model response: "${content}"${isReasoning ? ' (reasoning model)' : ''}`,
      latencyMs: Date.now() - startTime,
      modelUsed: configCheck.deploymentName,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Connection failed: ${errorMessage}`,
      latencyMs: Date.now() - startTime,
    };
  }
}
