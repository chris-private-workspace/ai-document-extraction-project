/**
 * @fileoverview Term Classification Service using GPT-5.2
 * @description
 *   Provides AI-powered term classification for invoice terms:
 *   - Batch classification of terms using GPT-5.2
 *   - Standard charge category suggestions
 *   - Confidence scoring for classifications
 *   - Token-efficient batch processing (50 terms per batch)
 *
 * @module src/services/term-classification
 * @since Epic 0 - Story 0.5 (Term Aggregation and Initial Rules)
 * @lastModified 2025-12-24
 *
 * @features
 *   - GPT-5.2 based term classification
 *   - StandardChargeCategory mapping
 *   - Batch processing with token limits
 *   - Confidence-based suggestions
 *
 * @dependencies
 *   - openai - Azure OpenAI SDK
 *   - @prisma/client - StandardChargeCategory enum
 */

import { AzureOpenAI } from 'openai';
import type { StandardChargeCategory } from '@prisma/client';

import { resolveDeploymentNameByKey } from '@/lib/constants/llm-models';
import { LLM_STAGE_KEYS } from '@/lib/constants/llm-stages';
import { callGatewayByModelKey } from '@/services/llm';

/**
 * 本服務的預設模型 key（FIX-137）。
 * 原先硬編 `gpt-5.2`，但該 deployment 已於 CHANGE-102 移除 → env 未設即 404。
 * 改走白名單解析（env 覆蓋 → 白名單預設部署名）。
 */
const DEFAULT_MODEL_KEY = 'gpt-5.4-mini';

// ============================================================================
// Types & Interfaces
// ============================================================================

/**
 * Term classification result from AI
 */
export interface TermClassification {
  /** Original term text */
  term: string;
  /** Suggested standard category */
  category: StandardChargeCategory;
  /** Classification confidence (0-100) */
  confidence: number;
  /** Brief reasoning for classification */
  reason: string;
}

/**
 * Batch classification result
 */
export interface BatchClassificationResult {
  /** Successfully classified terms */
  classifications: TermClassification[];
  /** Terms that failed to classify */
  errors: Array<{
    term: string;
    error: string;
  }>;
  /** Processing statistics */
  stats: {
    total: number;
    successful: number;
    failed: number;
    averageConfidence: number;
  };
}

/**
 * Classification service configuration
 */
export interface ClassificationConfig {
  /** Azure OpenAI Endpoint */
  endpoint?: string;
  /** API Key */
  apiKey?: string;
  /** Deployment name */
  deploymentName?: string;
  /** API version */
  apiVersion?: string;
  /** Batch size (max terms per API call) */
  batchSize?: number;
  /** Maximum retries per batch */
  maxRetries?: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default configuration
 */
const DEFAULT_CONFIG: ClassificationConfig = {
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  deploymentName: resolveDeploymentNameByKey(DEFAULT_MODEL_KEY),
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2025-03-01-preview',
  batchSize: 50,
  maxRetries: 3,
};

/**
 * Standard charge categories with Chinese descriptions
 */
const CATEGORY_DESCRIPTIONS: Record<StandardChargeCategory, string> = {
  OCEAN_FREIGHT: '海運費 - 海上運輸的主要費用',
  AIR_FREIGHT: '空運費 - 航空運輸的主要費用',
  HANDLING_FEE: '操作費 - 貨物搬運、裝卸操作費用',
  CUSTOMS_CLEARANCE: '清關費 - 海關報關、清關手續費用',
  DOCUMENTATION_FEE: '文件費 - 提單、發票等文件處理費用',
  TERMINAL_HANDLING: '碼頭操作費 - 港口/機場碼頭處理費用',
  INLAND_TRANSPORT: '內陸運輸 - 陸路運輸、拖車費用',
  INSURANCE: '保險費 - 貨物運輸保險費用',
  STORAGE: '倉儲費 - 貨物存放、倉庫費用',
  FUEL_SURCHARGE: '燃油附加費 - 燃料成本附加費',
  SECURITY_FEE: '安全費 - 安檢、保安相關費用',
  OTHER: '其他 - 無法歸類的其他費用',
};

/**
 * Classification prompt template
 */
const CLASSIFICATION_PROMPT = `你是一個物流費用分類專家。
請將以下發票術語分類到標準費用類別。

標準費用類別包括：
${Object.entries(CATEGORY_DESCRIPTIONS)
  .map(([code, desc]) => `- ${code}: ${desc}`)
  .join('\n')}

分類規則：
1. 仔細分析術語的含義和常見用途
2. 選擇最匹配的標準類別
3. 如果無法確定，選擇 OTHER
4. 提供 0-100 的信心度分數
5. 簡短說明分類理由

請返回 JSON 格式的對象，包含 classifications 陣列：
{
  "classifications": [
    {
      "term": "原始術語",
      "category": "標準類別代碼",
      "confidence": 0-100 的信心度,
      "reason": "分類理由（簡短）"
    }
  ]
}

待分類術語：
{terms}

請只返回 JSON 對象，不要包含其他文字。`;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Creates Azure OpenAI client
 *
 * @param config - Configuration options
 * @returns OpenAI client
 */
function createClient(config: ClassificationConfig = {}): AzureOpenAI {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  if (!mergedConfig.endpoint || !mergedConfig.apiKey) {
    throw new Error('Azure OpenAI endpoint and API key are required');
  }

  return new AzureOpenAI({
    endpoint: mergedConfig.endpoint,
    apiKey: mergedConfig.apiKey,
    apiVersion: mergedConfig.apiVersion,
  });
}

/**
 * Parses GPT response to extract JSON array
 *
 * @param content - GPT response content
 * @returns Parsed classification array
 */
function parseClassificationResponse(content: string): TermClassification[] {
  // Try direct parse
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    // Handle wrapped object
    if (parsed.classifications && Array.isArray(parsed.classifications)) {
      return parsed.classifications;
    }
  } catch {
    // Try to extract JSON array
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  }

  throw new Error('Failed to parse classification response as JSON array');
}

/**
 * Validates and normalizes a classification result
 *
 * @param item - Raw classification item
 * @returns Validated classification or null if invalid
 */
function validateClassification(
  item: Record<string, unknown>
): TermClassification | null {
  if (!item.term || typeof item.term !== 'string') {
    return null;
  }

  const category = String(item.category || 'OTHER') as StandardChargeCategory;
  const validCategories = Object.keys(CATEGORY_DESCRIPTIONS);

  if (!validCategories.includes(category)) {
    // Default to OTHER if invalid category
    item.category = 'OTHER';
  }

  return {
    term: String(item.term),
    category: (item.category as StandardChargeCategory) || 'OTHER',
    confidence: Math.min(100, Math.max(0, Number(item.confidence) || 50)),
    reason: String(item.reason || ''),
  };
}

/**
 * Delays execution for specified milliseconds
 *
 * @param ms - Milliseconds to delay
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Classifies a batch of terms using GPT-5.2
 *
 * @description
 *   Sends terms to GPT-5.2 for classification into standard charge categories.
 *   Handles batching, retries, and error recovery.
 *
 * @param terms - Array of terms to classify
 * @param config - Optional configuration overrides
 * @returns Classification results with statistics
 *
 * @example
 * ```typescript
 * const result = await classifyTerms([
 *   'OCEAN FREIGHT',
 *   'THC - TERMINAL HANDLING',
 *   'CUSTOMS CLEARANCE FEE'
 * ]);
 * ```
 */
export async function classifyTerms(
  terms: string[],
  config: ClassificationConfig = {}
): Promise<BatchClassificationResult> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const batchSize = mergedConfig.batchSize || 50;
  const maxRetries = mergedConfig.maxRetries || 3;

  const client = createClient(mergedConfig);
  const deploymentName =
    mergedConfig.deploymentName || resolveDeploymentNameByKey(DEFAULT_MODEL_KEY);

  // Epic 23 Story 23.4 Phase 1：deployment 被呼叫端覆蓋時不改道 gateway
  //（gateway 以 modelKey 解析部署，會忽略該覆蓋 → 改道會違反呼叫端意圖）
  const gatewayEligible =
    deploymentName === resolveDeploymentNameByKey(DEFAULT_MODEL_KEY);

  const allClassifications: TermClassification[] = [];
  const allErrors: Array<{ term: string; error: string }> = [];

  // Process in batches
  for (let i = 0; i < terms.length; i += batchSize) {
    const batch = terms.slice(i, i + batchSize);
    let retryCount = 0;
    let success = false;

    while (!success && retryCount < maxRetries) {
      try {
        const prompt = CLASSIFICATION_PROMPT.replace(
          '{terms}',
          batch.map((t, idx) => `${idx + 1}. ${t}`).join('\n')
        );

        // Epic 23 Story 23.4 Phase 1（呼叫點 #3）：flag 開啟且 modelKey 已播種時經 gateway。
        // `maxRetries: 0` —— 外層 while 迴圈已是唯一重試權威，避免重試次數相乘。
        // 回 null（flag 關 / 未播種）即落到下方既有直接 Azure 呼叫，行為零變。
        const viaGateway = gatewayEligible
          ? await callGatewayByModelKey({
              modelKey: DEFAULT_MODEL_KEY,
              stageKey: LLM_STAGE_KEYS.TERM_CLASSIFICATION,
              messages: [{ role: 'user', content: prompt }],
              output: { mode: 'json' }, // 對應既有 response_format: json_object
              temperature: 0.3,
              maxOutputTokens: 4000,
              maxRetries: 0,
            })
          : null;

        let content: string;
        if (viaGateway) {
          content = viaGateway.content;
        } else {
          const response = await client.chat.completions.create({
            model: deploymentName,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3, // Lower temperature for more consistent classifications
            max_tokens: 4000,
            response_format: { type: 'json_object' },
          });

          content = response.choices[0]?.message?.content || '';
        }

        // Parse response - handle both array and object formats
        let rawClassifications: unknown[];
        try {
          const parsed = JSON.parse(content) as unknown;

          // 類型安全的陣列提取
          if (Array.isArray(parsed)) {
            rawClassifications = parsed;
          } else if (
            typeof parsed === 'object' &&
            parsed !== null &&
            'classifications' in parsed &&
            Array.isArray((parsed as Record<string, unknown>).classifications)
          ) {
            rawClassifications = (parsed as Record<string, unknown>)
              .classifications as unknown[];
          } else if (
            typeof parsed === 'object' &&
            parsed !== null &&
            'results' in parsed &&
            Array.isArray((parsed as Record<string, unknown>).results)
          ) {
            rawClassifications = (parsed as Record<string, unknown>)
              .results as unknown[];
          } else if (typeof parsed === 'object' && parsed !== null) {
            // Try to find any array in the response
            const values = Object.values(parsed as Record<string, unknown>);
            const arrayValue = values.find(
              (v): v is unknown[] => Array.isArray(v)
            );
            if (arrayValue) {
              rawClassifications = arrayValue;
            } else {
              throw new Error('No classification array found in response');
            }
          } else {
            throw new Error('Invalid response format');
          }
        } catch {
          rawClassifications = parseClassificationResponse(content);
        }

        // 類型安全的分類驗證
        const classifications: TermClassification[] = rawClassifications
          .filter(
            (item): item is Record<string, unknown> =>
              typeof item === 'object' && item !== null
          )
          .map((item) => validateClassification(item))
          .filter((item): item is TermClassification => item !== null);

        // Add validated classifications (已在上方 pipeline 中驗證過)
        allClassifications.push(...classifications);

        success = true;
      } catch (error) {
        retryCount++;
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';

        if (retryCount >= maxRetries) {
          // Add all batch terms as errors
          for (const term of batch) {
            allErrors.push({
              term,
              error: `Failed after ${maxRetries} retries: ${errorMessage}`,
            });
          }
        } else {
          // Exponential backoff
          await delay(1000 * Math.pow(2, retryCount));
        }
      }
    }
  }

  // Calculate statistics
  const totalConfidence = allClassifications.reduce(
    (sum, c) => sum + c.confidence,
    0
  );

  return {
    classifications: allClassifications,
    errors: allErrors,
    stats: {
      total: terms.length,
      successful: allClassifications.length,
      failed: allErrors.length,
      averageConfidence:
        allClassifications.length > 0
          ? Math.round(totalConfidence / allClassifications.length)
          : 0,
    },
  };
}

/**
 * Classifies a single term using GPT-5.2
 *
 * @param term - Term to classify
 * @param config - Optional configuration overrides
 * @returns Classification result or null if failed
 */
export async function classifyTerm(
  term: string,
  config: ClassificationConfig = {}
): Promise<TermClassification | null> {
  const result = await classifyTerms([term], config);
  return result.classifications[0] || null;
}

/**
 * Gets suggested category for a term based on keyword matching
 * (Fallback when AI is unavailable)
 *
 * @param term - Term to analyze
 * @returns Suggested category or null if no match
 */
export function getSuggestedCategoryFromKeywords(
  term: string
): StandardChargeCategory | null {
  const upperTerm = term.toUpperCase();

  const keywordMap: Record<string, StandardChargeCategory[]> = {
    OCEAN: ['OCEAN_FREIGHT'],
    SEA: ['OCEAN_FREIGHT'],
    'O/F': ['OCEAN_FREIGHT'],
    AIR: ['AIR_FREIGHT'],
    'A/F': ['AIR_FREIGHT'],
    THC: ['TERMINAL_HANDLING'],
    TERMINAL: ['TERMINAL_HANDLING'],
    HANDLING: ['HANDLING_FEE', 'TERMINAL_HANDLING'],
    CUSTOMS: ['CUSTOMS_CLEARANCE'],
    CLEARANCE: ['CUSTOMS_CLEARANCE'],
    DOC: ['DOCUMENTATION_FEE'],
    B: ['DOCUMENTATION_FEE'], // B/L related
    DOCUMENT: ['DOCUMENTATION_FEE'],
    TRUCKING: ['INLAND_TRANSPORT'],
    DRAYAGE: ['INLAND_TRANSPORT'],
    HAULAGE: ['INLAND_TRANSPORT'],
    TRANSPORT: ['INLAND_TRANSPORT'],
    INSURANCE: ['INSURANCE'],
    CARGO: ['INSURANCE'],
    STORAGE: ['STORAGE'],
    DEMURRAGE: ['STORAGE'],
    WAREHOUSE: ['STORAGE'],
    FUEL: ['FUEL_SURCHARGE'],
    BAF: ['FUEL_SURCHARGE'],
    BUNKER: ['FUEL_SURCHARGE'],
    SECURITY: ['SECURITY_FEE'],
    ISPS: ['SECURITY_FEE'],
  };

  for (const [keyword, categories] of Object.entries(keywordMap)) {
    if (upperTerm.includes(keyword)) {
      return categories[0];
    }
  }

  return null;
}

/**
 * Gets category descriptions for UI display
 *
 * @returns Map of category codes to descriptions
 */
export function getCategoryDescriptions(): Record<string, string> {
  return { ...CATEGORY_DESCRIPTIONS };
}

/**
 * Gets all valid category codes
 *
 * @returns Array of valid StandardChargeCategory values
 */
export function getValidCategories(): StandardChargeCategory[] {
  return Object.keys(CATEGORY_DESCRIPTIONS) as StandardChargeCategory[];
}
