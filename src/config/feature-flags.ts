/**
 * @fileoverview Feature Flags Configuration
 * @description
 *   Provides feature flag management for:
 *   - Dynamic Prompt System (Epic 14)
 *   - Extraction V3 Architecture (CHANGE-021)
 *
 *   Feature Flag Hierarchy:
 *   - FEATURE_DYNAMIC_PROMPT: Master toggle for all dynamic prompts
 *   - FEATURE_EXTRACTION_V3: Master toggle for V3 extraction architecture
 *   - Individual toggles: Control specific features when master is enabled
 *
 * @module src/config/feature-flags
 * @since Epic 14 - Story 14-4 (GPT Vision 服務整合)
 * @lastModified 2026-01-30
 *
 * @dependencies
 *   - Environment variables (process.env)
 *
 * @related
 *   - src/services/hybrid-prompt-provider.service.ts - Uses feature flags
 *   - src/services/gpt-vision.service.ts - Consumes prompt provider
 *   - src/services/extraction-v3/ - V3 extraction services
 */

import { PromptType } from '@/types/prompt-config';

/**
 * Feature flags interface for dynamic prompt system
 */
export interface FeatureFlags {
  /** Master toggle for all dynamic prompts */
  dynamicPromptEnabled: boolean;
  /** Enable dynamic prompts for document issuer identification */
  dynamicIssuerPromptEnabled: boolean;
  /** Enable dynamic prompts for term classification */
  dynamicTermPromptEnabled: boolean;
  /** Enable dynamic prompts for field extraction */
  dynamicFieldPromptEnabled: boolean;
  /** Enable dynamic prompts for validation */
  dynamicValidationPromptEnabled: boolean;
}

/**
 * Prompt type to feature flag key mapping
 */
const PROMPT_TYPE_TO_FLAG_KEY: Record<PromptType, keyof Omit<FeatureFlags, 'dynamicPromptEnabled'>> = {
  [PromptType.ISSUER_IDENTIFICATION]: 'dynamicIssuerPromptEnabled',
  [PromptType.TERM_CLASSIFICATION]: 'dynamicTermPromptEnabled',
  [PromptType.FIELD_EXTRACTION]: 'dynamicFieldPromptEnabled',
  [PromptType.VALIDATION]: 'dynamicValidationPromptEnabled',
  // CHANGE-025: V3.1 三階段提示類型映射
  [PromptType.STAGE_1_COMPANY_IDENTIFICATION]: 'dynamicIssuerPromptEnabled',
  [PromptType.STAGE_2_FORMAT_IDENTIFICATION]: 'dynamicFieldPromptEnabled',
  [PromptType.STAGE_3_FIELD_EXTRACTION]: 'dynamicFieldPromptEnabled',
};

/**
 * Get current feature flags from environment variables
 *
 * @description
 *   Reads feature flags from environment variables with the following defaults:
 *   - dynamicPromptEnabled: false (opt-in for safety)
 *   - Individual toggles: true when master is enabled (opt-out model)
 *
 * @returns {FeatureFlags} Current feature flag values
 *
 * @example
 * ```typescript
 * const flags = getFeatureFlags();
 * if (flags.dynamicPromptEnabled && flags.dynamicIssuerPromptEnabled) {
 *   // Use dynamic issuer prompts
 * }
 * ```
 */
export function getFeatureFlags(): FeatureFlags {
  return {
    // Master toggle - must be explicitly enabled
    dynamicPromptEnabled: process.env.FEATURE_DYNAMIC_PROMPT === 'true',
    // Individual toggles - enabled by default when master is on (opt-out model)
    dynamicIssuerPromptEnabled: process.env.FEATURE_DYNAMIC_ISSUER_PROMPT !== 'false',
    dynamicTermPromptEnabled: process.env.FEATURE_DYNAMIC_TERM_PROMPT !== 'false',
    dynamicFieldPromptEnabled: process.env.FEATURE_DYNAMIC_FIELD_PROMPT !== 'false',
    dynamicValidationPromptEnabled: process.env.FEATURE_DYNAMIC_VALIDATION_PROMPT !== 'false',
  };
}

/**
 * Check if dynamic prompts should be used for a specific prompt type
 *
 * @description
 *   Determines whether to use dynamic prompts based on:
 *   1. Master toggle must be enabled
 *   2. Specific prompt type toggle must be enabled
 *
 * @param {PromptType} promptType - The type of prompt to check
 * @returns {boolean} True if dynamic prompts should be used
 *
 * @example
 * ```typescript
 * if (shouldUseDynamicPrompt(PromptType.ISSUER_IDENTIFICATION)) {
 *   const prompt = await dynamicResolver.resolvePrompt(...);
 * } else {
 *   const prompt = getStaticIssuerPrompt();
 * }
 * ```
 */
export function shouldUseDynamicPrompt(promptType: PromptType): boolean {
  const flags = getFeatureFlags();

  // Master toggle must be enabled
  if (!flags.dynamicPromptEnabled) {
    return false;
  }

  // Check specific prompt type toggle
  const flagKey = PROMPT_TYPE_TO_FLAG_KEY[promptType];
  return flags[flagKey] ?? false;
}

/**
 * Simplified helper for common prompt type checks using string literals
 *
 * @param {'issuer' | 'term' | 'field' | 'validation'} type - Prompt type as string
 * @returns {boolean} True if dynamic prompts should be used
 *
 * @example
 * ```typescript
 * if (shouldUseDynamicPromptByType('issuer')) {
 *   // Use dynamic issuer prompts
 * }
 * ```
 */
export function shouldUseDynamicPromptByType(
  type: 'issuer' | 'term' | 'field' | 'validation'
): boolean {
  const typeMapping: Record<typeof type, PromptType> = {
    issuer: PromptType.ISSUER_IDENTIFICATION,
    term: PromptType.TERM_CLASSIFICATION,
    field: PromptType.FIELD_EXTRACTION,
    validation: PromptType.VALIDATION,
  };

  return shouldUseDynamicPrompt(typeMapping[type]);
}

/**
 * Get a human-readable status of all feature flags
 *
 * @description
 *   Useful for logging and debugging feature flag states
 *
 * @returns {string} Formatted string showing all flag states
 *
 * @example
 * ```typescript
 * console.log(getFeatureFlagStatus());
 * // Output: "Dynamic Prompts: ON | Issuer: ON | Term: ON | Field: OFF | Validation: ON"
 * ```
 */
export function getFeatureFlagStatus(): string {
  const flags = getFeatureFlags();

  const status = [
    `Dynamic Prompts: ${flags.dynamicPromptEnabled ? 'ON' : 'OFF'}`,
    `Issuer: ${flags.dynamicIssuerPromptEnabled ? 'ON' : 'OFF'}`,
    `Term: ${flags.dynamicTermPromptEnabled ? 'ON' : 'OFF'}`,
    `Field: ${flags.dynamicFieldPromptEnabled ? 'ON' : 'OFF'}`,
    `Validation: ${flags.dynamicValidationPromptEnabled ? 'ON' : 'OFF'}`,
  ];

  return status.join(' | ');
}

// ============================================================================
// Extraction V3 Feature Flags (CHANGE-021)
// ============================================================================

/**
 * Extraction V3 Feature Flags
 * @description 控制 V3 提取架構的功能開關
 * @since CHANGE-021
 */
export interface ExtractionV3FeatureFlags {
  /** 使用 V3 架構（主開關） */
  useExtractionV3: boolean;
  /** V3 灰度發布百分比 (0-100) */
  extractionV3Percentage: number;
  /** 錯誤時回退到 V2 */
  fallbackToV2OnError: boolean;
  /** GPT 失敗時使用 Azure DI 備選 */
  enableAzureDIFallback: boolean;
  /** 記錄組裝的 Prompt（調試用） */
  logPromptAssembly: boolean;
  /** 記錄 GPT 原始響應（調試用） */
  logGptResponse: boolean;
}

/**
 * 預設 V3 Feature Flags
 * @since CHANGE-021
 */
export const DEFAULT_EXTRACTION_V3_FLAGS: ExtractionV3FeatureFlags = {
  useExtractionV3: false, // 初始關閉
  extractionV3Percentage: 0, // 0% 流量
  fallbackToV2OnError: true, // 啟用回退
  enableAzureDIFallback: true, // 啟用 Azure DI 備選
  logPromptAssembly: false,
  logGptResponse: false,
};

/**
 * 從環境變量獲取 V3 Feature Flags
 *
 * @description
 *   環境變量：
 *   - FEATURE_EXTRACTION_V3: 主開關 ('true'/'false')
 *   - FEATURE_EXTRACTION_V3_PERCENTAGE: 灰度百分比 (0-100)
 *   - FEATURE_EXTRACTION_V3_FALLBACK: 錯誤回退 ('true'/'false')
 *   - FEATURE_EXTRACTION_V3_AZURE_FALLBACK: Azure DI 備選 ('true'/'false')
 *   - DEBUG_EXTRACTION_V3_PROMPT: 記錄 Prompt ('true'/'false')
 *   - DEBUG_EXTRACTION_V3_RESPONSE: 記錄響應 ('true'/'false')
 *
 * @returns {ExtractionV3FeatureFlags} V3 Feature Flags
 *
 * @example
 * ```typescript
 * const v3Flags = getExtractionV3Flags();
 * if (v3Flags.useExtractionV3) {
 *   // Use V3 extraction
 * }
 * ```
 */
export function getExtractionV3Flags(): ExtractionV3FeatureFlags {
  return {
    useExtractionV3: process.env.FEATURE_EXTRACTION_V3 === 'true',
    extractionV3Percentage: parseInt(
      process.env.FEATURE_EXTRACTION_V3_PERCENTAGE ?? '0',
      10
    ),
    fallbackToV2OnError: process.env.FEATURE_EXTRACTION_V3_FALLBACK !== 'false',
    enableAzureDIFallback:
      process.env.FEATURE_EXTRACTION_V3_AZURE_FALLBACK !== 'false',
    logPromptAssembly: process.env.DEBUG_EXTRACTION_V3_PROMPT === 'true',
    logGptResponse: process.env.DEBUG_EXTRACTION_V3_RESPONSE === 'true',
  };
}

/**
 * 判斷是否應該使用 V3 提取架構
 *
 * @description
 *   根據以下邏輯決定是否使用 V3：
 *   1. 主開關必須啟用
 *   2. 灰度百分比檢查（如果設置）
 *   3. 可選：基於文件 ID 的一致性路由
 *
 * @param {string} [fileId] - 文件 ID（用於灰度發布的一致性路由）
 * @returns {boolean} 是否使用 V3
 *
 * @example
 * ```typescript
 * if (shouldUseExtractionV3('doc_123')) {
 *   const result = await extractionV3Service.processFile(input);
 * } else {
 *   const result = await extractionV2Service.processFile(input);
 * }
 * ```
 */
export function shouldUseExtractionV3(fileId?: string): boolean {
  const flags = getExtractionV3Flags();

  // 主開關必須啟用
  if (!flags.useExtractionV3) {
    return false;
  }

  // 如果百分比是 100%，直接返回 true
  if (flags.extractionV3Percentage >= 100) {
    return true;
  }

  // 如果百分比是 0%，返回 false
  if (flags.extractionV3Percentage <= 0) {
    return false;
  }

  // 灰度發布：基於文件 ID 的一致性路由
  if (fileId) {
    // 使用簡單的 hash 函數確保同一文件始終走同一路徑
    const hash = simpleHash(fileId);
    return hash % 100 < flags.extractionV3Percentage;
  }

  // 無文件 ID 時使用隨機數
  return Math.random() * 100 < flags.extractionV3Percentage;
}

/**
 * 簡單的字符串 hash 函數（用於灰度路由）
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * 獲取 V3 Feature Flags 狀態字符串
 *
 * @returns {string} 格式化的狀態字符串
 *
 * @example
 * ```typescript
 * console.log(getExtractionV3FlagStatus());
 * // Output: "V3: OFF | Percentage: 0% | Fallback: ON | Azure DI: ON"
 * ```
 */
export function getExtractionV3FlagStatus(): string {
  const flags = getExtractionV3Flags();

  const status = [
    `V3: ${flags.useExtractionV3 ? 'ON' : 'OFF'}`,
    `Percentage: ${flags.extractionV3Percentage}%`,
    `Fallback: ${flags.fallbackToV2OnError ? 'ON' : 'OFF'}`,
    `Azure DI: ${flags.enableAzureDIFallback ? 'ON' : 'OFF'}`,
  ];

  return status.join(' | ');
}

// ============================================================================
// Extraction V3.1 Feature Flags (CHANGE-024 - Three-Stage Architecture)
// ============================================================================

/**
 * Extraction V3.1 Feature Flags
 * @description 控制 V3.1 三階段提取架構的功能開關
 * @since CHANGE-024
 */
export interface ExtractionV3_1FeatureFlags {
  /** 使用 V3.1 三階段架構（主開關） */
  useExtractionV3_1: boolean;
  /** V3.1 灰度發布百分比 (0-100) */
  extractionV3_1Percentage: number;
  /** V3.1 失敗時回退到 V3 單階段 */
  fallbackToV3OnError: boolean;
}

/**
 * 從環境變量獲取 V3.1 Feature Flags
 *
 * @description
 *   環境變量：
 *   - FEATURE_EXTRACTION_V3_1: 主開關 ('true'/'false')
 *   - FEATURE_EXTRACTION_V3_1_PERCENTAGE: 灰度百分比 (0-100)，預設 100
 *   - FEATURE_EXTRACTION_V3_1_FALLBACK: V3.1 失敗時回退到 V3 ('true'/'false')
 *
 * @returns {ExtractionV3_1FeatureFlags} V3.1 Feature Flags
 *
 * @example
 * ```typescript
 * const v3_1Flags = getExtractionV3_1Flags();
 * if (v3_1Flags.useExtractionV3_1) {
 *   // Use V3.1 three-stage extraction
 * }
 * ```
 */
export function getExtractionV3_1Flags(): ExtractionV3_1FeatureFlags {
  return {
    useExtractionV3_1: process.env.FEATURE_EXTRACTION_V3_1 === 'true',
    extractionV3_1Percentage: parseInt(
      process.env.FEATURE_EXTRACTION_V3_1_PERCENTAGE ?? '100',
      10
    ),
    fallbackToV3OnError: process.env.FEATURE_EXTRACTION_V3_1_FALLBACK !== 'false',
  };
}

/**
 * 獲取 V3.1 Feature Flags 狀態字符串
 *
 * @returns {string} 格式化的狀態字符串
 *
 * @example
 * ```typescript
 * console.log(getExtractionV3_1FlagStatus());
 * // Output: "V3.1: ON | Percentage: 100% | Fallback to V3: ON"
 * ```
 */
export function getExtractionV3_1FlagStatus(): string {
  const flags = getExtractionV3_1Flags();

  const status = [
    `V3.1: ${flags.useExtractionV3_1 ? 'ON' : 'OFF'}`,
    `Percentage: ${flags.extractionV3_1Percentage}%`,
    `Fallback to V3: ${flags.fallbackToV3OnError ? 'ON' : 'OFF'}`,
  ];

  return status.join(' | ');
}

// ============================================================================
// LLM Gateway Feature Flag (Epic 23 - Story 23.1 step 4)
// ============================================================================

/**
 * 是否經 `LlmGatewayService`（Vercel AI SDK）路由 extraction 的 LLM 呼叫。
 *
 * @description
 *   step 4 採**全域硬切換**（無百分比灰度）：
 *   - `FEATURE_LLM_GATEWAY_ENABLED='true'` → gpt-caller 走 gateway（同一批 Azure 模型）。
 *   - 預設 / 其他值 → 走既有直接 Azure `fetch`，**行為零變**（opt-in 安全模型）。
 *   百分比灰度 + shadow mode（新舊並行比對 confidence 分佈）留 **step 4b**——
 *   需先把 `fileId` 串到呼叫點才能做一致性灰度路由（`simpleHash(fileId)`）。
 *
 * @returns 是否啟用 gateway 路由
 */
export function isLlmGatewayEnabled(): boolean {
  return process.env.FEATURE_LLM_GATEWAY_ENABLED === 'true';
}
