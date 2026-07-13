/**
 * @fileoverview 統一 GPT 提取服務 - V3 架構
 * @description
 *   使用單次 GPT-5.2 Vision 調用完成所有提取任務：
 *   - 發行方識別（Issuer Identification）
 *   - 格式識別（Format Recognition）
 *   - 欄位提取（Field Extraction）
 *   - 術語預分類（Term Pre-classification）
 *
 * @module src/services/extraction-v3/unified-gpt-extraction
 * @since CHANGE-021 - Unified Processor V3 Refactoring
 * @lastModified 2026-01-30
 *
 * @features
 *   - 單次 GPT Vision 調用
 *   - 結構化 JSON 輸出
 *   - Token 使用追蹤
 *   - 重試機制
 *   - 錯誤處理
 *
 * @dependencies
 *   - Azure OpenAI Service
 *
 * @related
 *   - src/services/extraction-v3/extraction-v3.service.ts - V3 主服務
 *   - src/types/extraction-v3.types.ts - V3 類型定義
 */

import type {
  AssembledPrompt,
  UnifiedExtractionResult,
  ExtractionMetadataV3,
} from '@/types/extraction-v3.types';

// ============================================================================
// Types
// ============================================================================

/**
 * GPT 提取配置
 */
export interface GptExtractionConfig {
  /** Azure OpenAI 端點 */
  endpoint?: string;
  /** API 金鑰 */
  apiKey?: string;
  /** 部署名稱 */
  deploymentName?: string;
  /** 模型名稱 */
  modelName?: string;
  /** 最大 Token 數 */
  maxTokens?: number;
  /** 溫度（0-1） */
  temperature?: number;
  /** 超時時間（毫秒） */
  timeout?: number;
  /** 重試次數 */
  retryCount?: number;
  /** 重試延遲（毫秒） */
  retryDelay?: number;
  /**
   * 圖片處理模式 - CHANGE-023
   * - 'auto': 自動根據圖片大小選擇（預設）
   * - 'low': 低解析度模式，約 85 tokens/image，處理更快
   * - 'high': 高解析度模式，約 765 tokens/tile，細節更好
   */
  imageDetailMode?: 'auto' | 'low' | 'high';
}

/**
 * GPT 提取結果
 */
export interface GptExtractionServiceResult {
  /** 是否成功 */
  success: boolean;
  /** 提取結果 */
  result?: UnifiedExtractionResult;
  /** 原始 GPT 響應（調試用） */
  rawResponse?: string;
  /** 錯誤訊息 */
  error?: string;
  /** 處理時間（毫秒） */
  processingTimeMs: number;
  /** Token 使用情況 */
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
  /**
   * CHANGE-023: 完整的 Prompt 內容（用於 AI 詳情顯示）
   */
  fullPrompt?: {
    /** System Prompt */
    systemPrompt: string;
    /** User Prompt（不含圖片） */
    userPrompt: string;
    /** 組合後的完整 Prompt */
    combinedPrompt: string;
    /** 圖片數量 */
    imageCount: number;
    /** 使用的圖片詳情模式 */
    imageDetailMode: 'auto' | 'low' | 'high';
  };
}

/**
 * GPT Vision 訊息內容
 */
interface GptMessageContent {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

/**
 * GPT 訊息
 */
interface GptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | GptMessageContent[];
}

/**
 * GPT API 響應
 */
interface GptApiResponse {
  id: string;
  choices: Array<{
    message: {
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ============================================================================
// Constants
// ============================================================================

/** 預設配置 */
const DEFAULT_CONFIG: Required<GptExtractionConfig> = {
  endpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
  apiKey: process.env.AZURE_OPENAI_API_KEY || '',
  deploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'gpt-5-2-vision',
  modelName: 'gpt-5.2-vision',
  maxTokens: 4096,
  temperature: 0.1, // 低溫度以獲得更一致的輸出
  timeout: 300000, // 5 分鐘 - GPT Vision 處理多頁文件可能需要較長時間
  retryCount: 4, // FIX-107 弱點A：2→4（共 5 次嘗試），配合下方指數退避
  retryDelay: 1000,
  imageDetailMode: 'auto', // CHANGE-023: 預設使用自動模式
};

/** FIX-107 弱點A：單次重試退避上限（毫秒），避免指數退避無限增長 */
const MAX_RETRY_BACKOFF_MS = 15000;

/** API 版本 */
const API_VERSION = '2024-06-01';

// ============================================================================
// Service Class
// ============================================================================

/**
 * 統一 GPT 提取服務
 *
 * @description 使用 GPT-5.2 Vision 進行統一文件提取
 *
 * @example
 * ```typescript
 * const result = await UnifiedGptExtractionService.extract(
 *   assembledPrompt,
 *   ['data:image/png;base64,...']
 * );
 * if (result.success) {
 *   console.log(result.result.standardFields);
 * }
 * ```
 */
export class UnifiedGptExtractionService {
  private config: Required<GptExtractionConfig>;

  constructor(config: GptExtractionConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 執行統一 GPT 提取
   *
   * @param prompt - 組裝後的 Prompt
   * @param imageBase64Array - Base64 圖片陣列
   * @returns 提取結果
   */
  async extract(
    prompt: AssembledPrompt,
    imageBase64Array: string[]
  ): Promise<GptExtractionServiceResult> {
    const startTime = Date.now();

    try {
      // 驗證配置
      if (!this.config.endpoint || !this.config.apiKey) {
        return {
          success: false,
          error: 'Azure OpenAI 配置缺失（endpoint 或 apiKey）',
          processingTimeMs: Date.now() - startTime,
        };
      }

      // 驗證輸入
      if (!imageBase64Array || imageBase64Array.length === 0) {
        return {
          success: false,
          error: '沒有提供圖片',
          processingTimeMs: Date.now() - startTime,
        };
      }

      // 構建訊息
      const messages = this.buildMessages(prompt, imageBase64Array);

      // 調用 GPT API（帶重試）
      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= this.config.retryCount; attempt++) {
        try {
          const response = await this.callGptApi(messages);

          // 解析響應
          const parseResult = this.parseResponse(
            response,
            imageBase64Array.length,
            Date.now() - startTime
          );

          // CHANGE-023: 構建完整的 Prompt 資訊
          const fullPrompt = {
            systemPrompt: prompt.systemPrompt,
            userPrompt: prompt.userPrompt,
            combinedPrompt: `${prompt.systemPrompt}\n\n---USER PROMPT---\n\n${prompt.userPrompt}`,
            imageCount: imageBase64Array.length,
            imageDetailMode: this.config.imageDetailMode,
          };

          return {
            success: parseResult.success,
            result: parseResult.result,
            rawResponse: response.choices[0]?.message.content,
            error: parseResult.error,
            processingTimeMs: Date.now() - startTime,
            tokenUsage: {
              input: response.usage.prompt_tokens,
              output: response.usage.completion_tokens,
              total: response.usage.total_tokens,
            },
            fullPrompt,
          };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));

          // 如果是最後一次嘗試，不再重試
          if (attempt === this.config.retryCount) break;

          // FIX-107 弱點A：指數退避 + jitter（原線性 1s/2s 過短，無法騎過 provider
          // 短暫降級；jitter 避免併發重試同步化造成 retry storm）
          const backoffBase = Math.min(
            this.config.retryDelay * Math.pow(2, attempt),
            MAX_RETRY_BACKOFF_MS
          );
          await this.delay(backoffBase / 2 + Math.random() * (backoffBase / 2));
        }
      }

      return {
        success: false,
        error: lastError?.message || '未知錯誤',
        processingTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '未知錯誤',
        processingTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * 構建 GPT 訊息
   */
  private buildMessages(
    prompt: AssembledPrompt,
    imageBase64Array: string[]
  ): GptMessage[] {
    const messages: GptMessage[] = [];

    // System message
    messages.push({
      role: 'system',
      content: prompt.systemPrompt,
    });

    // User message with images
    const userContent: GptMessageContent[] = [];

    // 添加圖片 - CHANGE-023: 使用配置的 imageDetailMode
    for (const imageBase64 of imageBase64Array) {
      userContent.push({
        type: 'image_url',
        image_url: {
          url: imageBase64,
          detail: this.config.imageDetailMode,
        },
      });
    }

    // 添加用戶指示文字
    userContent.push({
      type: 'text',
      text: prompt.userPrompt,
    });

    messages.push({
      role: 'user',
      content: userContent,
    });

    return messages;
  }

  /**
   * 調用 GPT API
   */
  private async callGptApi(messages: GptMessage[]): Promise<GptApiResponse> {
    const url = `${this.config.endpoint}/openai/deployments/${this.config.deploymentName}/chat/completions?api-version=${API_VERSION}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.config.apiKey,
        },
        body: JSON.stringify({
          messages,
          max_completion_tokens: this.config.maxTokens,
          temperature: this.config.temperature,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GPT API 錯誤: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 解析 GPT 響應
   */
  private parseResponse(
    response: GptApiResponse,
    pageCount: number,
    processingTimeMs: number
  ): { success: boolean; result?: UnifiedExtractionResult; error?: string } {
    try {
      const content = response.choices[0]?.message.content;
      if (!content) {
        return { success: false, error: 'GPT 響應為空' };
      }

      // 嘗試解析 JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        // 嘗試提取 JSON（可能被包裹在 markdown 代碼塊中）
        const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[1]);
        } else {
          return { success: false, error: 'GPT 響應不是有效的 JSON' };
        }
      }

      // 驗證基本結構
      if (!this.isValidExtractionResult(parsed)) {
        return { success: false, error: 'GPT 響應結構不符合預期' };
      }

      // 構建完整結果
      const result: UnifiedExtractionResult = {
        ...(parsed as Omit<UnifiedExtractionResult, 'metadata'>),
        metadata: {
          modelUsed: this.config.modelName,
          processingTimeMs,
          tokensUsed: {
            input: response.usage.prompt_tokens,
            output: response.usage.completion_tokens,
            total: response.usage.total_tokens,
          },
          pageCount,
        },
      };

      return { success: true, result };
    } catch (error) {
      return {
        success: false,
        error: `解析 GPT 響應失敗: ${error instanceof Error ? error.message : '未知錯誤'}`,
      };
    }
  }

  /**
   * 驗證提取結果結構
   */
  private isValidExtractionResult(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const obj = value as Record<string, unknown>;

    // 檢查必要欄位
    return (
      'issuerIdentification' in obj &&
      'formatIdentification' in obj &&
      'standardFields' in obj &&
      'lineItems' in obj &&
      'overallConfidence' in obj
    );
  }

  /**
   * 延遲函數
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ============================================================================
  // Static Methods
  // ============================================================================

  /**
   * 靜態提取方法（使用預設配置）
   */
  static async extract(
    prompt: AssembledPrompt,
    imageBase64Array: string[],
    config?: GptExtractionConfig
  ): Promise<GptExtractionServiceResult> {
    const service = new UnifiedGptExtractionService(config);
    return service.extract(prompt, imageBase64Array);
  }

  /**
   * 估算提取成本（USD）
   *
   * @description
   *   基於 Azure OpenAI GPT-4V 定價估算：
   *   - 輸入: $0.01 / 1K tokens
   *   - 輸出: $0.03 / 1K tokens
   *   - 圖片: 額外計費（依解析度）
   *
   * @param imageCount - 圖片數量
   * @param estimatedOutputTokens - 預估輸出 Token 數
   * @returns 預估成本（USD）
   */
  static estimateCost(
    imageCount: number,
    estimatedOutputTokens: number = 2000
  ): number {
    // 每張高解析度圖片約 765 tokens（512x512 tiles）
    const imageTokens = imageCount * 765;
    const promptTokens = 3000; // 預估 System Prompt tokens

    const inputCost = ((imageTokens + promptTokens) / 1000) * 0.01;
    const outputCost = (estimatedOutputTokens / 1000) * 0.03;

    return Math.round((inputCost + outputCost) * 10000) / 10000;
  }

  /**
   * 檢查服務是否可用
   */
  static async checkHealth(config?: GptExtractionConfig): Promise<boolean> {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };

    if (!mergedConfig.endpoint || !mergedConfig.apiKey) {
      return false;
    }

    try {
      const url = `${mergedConfig.endpoint}/openai/deployments/${mergedConfig.deploymentName}/chat/completions?api-version=${API_VERSION}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': mergedConfig.apiKey,
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'ping' }],
          max_completion_tokens: 5,
        }),
        signal: AbortSignal.timeout(10000),
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * 快速提取（使用預設配置）
 */
export async function extractWithGpt(
  prompt: AssembledPrompt,
  imageBase64Array: string[],
  config?: GptExtractionConfig
): Promise<GptExtractionServiceResult> {
  return UnifiedGptExtractionService.extract(prompt, imageBase64Array, config);
}

/**
 * 估算提取成本
 */
export function estimateExtractionCost(
  imageCount: number,
  estimatedOutputTokens?: number
): number {
  return UnifiedGptExtractionService.estimateCost(imageCount, estimatedOutputTokens);
}

/**
 * 檢查 GPT 服務健康狀態
 */
export async function checkGptServiceHealth(
  config?: GptExtractionConfig
): Promise<boolean> {
  return UnifiedGptExtractionService.checkHealth(config);
}
