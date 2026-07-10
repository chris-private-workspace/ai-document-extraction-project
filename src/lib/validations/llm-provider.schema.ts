/**
 * @fileoverview LLM Provider 驗證 Schema（Epic 23 - Story 23.2）
 * @description
 *   後台 Provider 管理（`/api/v1/llm-providers`）的建立/更新輸入驗證。
 *   `apiKey` 為**明文**輸入——服務層以 `encryptConfigValue` 加密後才落庫；本 schema 只驗格式。
 *   自訂 `baseUrl` 的 SSRF 防護（僅 globalAdmin）屬 API 授權層，不在此 schema。
 *
 * @module src/lib/validations/llm-provider.schema
 * @since Epic 23 - Story 23.2
 * @lastModified 2026-07-10
 *
 * @related
 *   - src/services/llm-provider.service.ts - 服務層（加密/遮罩/審計）
 *   - src/app/api/v1/llm-providers/ - API 端點（Story 23.2 step 2）
 */

import { z } from 'zod';
import { LlmProviderType } from '@prisma/client';

// ============================================================================
// Constants
// ============================================================================

/** Provider 名稱長度上下限 */
const NAME_MIN_LENGTH = 1;
const NAME_MAX_LENGTH = 100;

/** baseUrl / apiVersion / apiKey 長度上限 */
const BASE_URL_MAX_LENGTH = 500;
const API_VERSION_MAX_LENGTH = 50;
const API_KEY_MAX_LENGTH = 500;

// ============================================================================
// Schemas
// ============================================================================

/** 建立 Provider（apiKey 明文，服務層加密） */
export const createLlmProviderSchema = z.object({
  name: z.string().min(NAME_MIN_LENGTH).max(NAME_MAX_LENGTH),
  providerType: z.nativeEnum(LlmProviderType),
  baseUrl: z.string().url().max(BASE_URL_MAX_LENGTH).optional(),
  apiVersion: z.string().max(API_VERSION_MAX_LENGTH).optional(),
  /** 明文 API key（可選；服務層以 aes-256-gcm 加密後落庫，永不回傳） */
  apiKey: z.string().min(1).max(API_KEY_MAX_LENGTH).optional(),
  isEnabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  allowSensitiveData: z.boolean().default(false),
  extraConfig: z.record(z.string(), z.unknown()).optional(),
});

/** 更新 Provider（皆可選；`apiKey` 有提供才 re-encrypt，省略則保留既有憑證） */
export const updateLlmProviderSchema = z.object({
  name: z.string().min(NAME_MIN_LENGTH).max(NAME_MAX_LENGTH).optional(),
  providerType: z.nativeEnum(LlmProviderType).optional(),
  baseUrl: z.string().url().max(BASE_URL_MAX_LENGTH).nullable().optional(),
  apiVersion: z.string().max(API_VERSION_MAX_LENGTH).nullable().optional(),
  apiKey: z.string().min(1).max(API_KEY_MAX_LENGTH).optional(),
  isEnabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  allowSensitiveData: z.boolean().optional(),
  extraConfig: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** 模型 key / label 長度上限 */
const MODEL_KEY_MAX_LENGTH = 200;
const MODEL_LABEL_MAX_LENGTH = 200;

/** 模型能力（已知必填欄位 + catchall 保留 seed 額外欄位如 deploymentEnvVar） */
const modelCapabilitySchema = z
  .object({
    maxTokens: z.number().int().positive(),
    supportsTemperature: z.boolean(),
    temperature: z.number().optional(),
    defaultImageDetail: z.enum(['auto', 'low', 'high']).optional(),
    supportsJsonSchema: z.boolean(),
    supportsVision: z.boolean(),
  })
  .catchall(z.unknown());

/** 模型計價（跨 provider；皆可選） */
const modelPricingSchema = z
  .object({
    inputPer1k: z.number().nonnegative(),
    outputPer1k: z.number().nonnegative(),
    currency: z.string().min(1).max(10),
  })
  .partial();

/** 於某 provider 下建立模型（`[id]/models` POST） */
export const createLlmModelSchema = z.object({
  modelKey: z.string().min(1).max(MODEL_KEY_MAX_LENGTH),
  label: z.string().min(1).max(MODEL_LABEL_MAX_LENGTH),
  capability: modelCapabilitySchema,
  pricing: modelPricingSchema.optional(),
  isEnabled: z.boolean().default(true),
});

/**
 * 更新模型（`[id]/models/[modelId]` PATCH；皆可選）。
 * `capability` 為整欄 JSON 替換（非 merge）：提供時須為完整能力物件，避免部分欄位遺失。
 * `pricing` 傳 `null` 清空。
 */
export const updateLlmModelSchema = z.object({
  modelKey: z.string().min(1).max(MODEL_KEY_MAX_LENGTH).optional(),
  label: z.string().min(1).max(MODEL_LABEL_MAX_LENGTH).optional(),
  capability: modelCapabilitySchema.optional(),
  pricing: modelPricingSchema.nullable().optional(),
  isEnabled: z.boolean().optional(),
});

// ============================================================================
// Inferred types
// ============================================================================

export type CreateLlmProviderInput = z.infer<typeof createLlmProviderSchema>;
export type UpdateLlmProviderInput = z.infer<typeof updateLlmProviderSchema>;
export type CreateLlmModelInput = z.infer<typeof createLlmModelSchema>;
export type UpdateLlmModelInput = z.infer<typeof updateLlmModelSchema>;
