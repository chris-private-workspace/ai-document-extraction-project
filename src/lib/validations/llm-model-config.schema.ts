/**
 * @fileoverview LLM 模型選擇配置驗證 Schema（CHANGE-099）
 * @description
 *   驗證後台更新 Stage 1-3 模型選擇的請求。model key 限定於白名單
 *   AVAILABLE_LLM_MODELS，非白名單值一律拒絕。
 *
 * @module src/lib/validations/llm-model-config.schema
 * @since CHANGE-099 - LLM 模型選擇管理
 * @lastModified 2026-07-09
 */

import { z } from 'zod';
import { AVAILABLE_LLM_MODELS } from '@/lib/constants/llm-models';

/** 白名單模型 key 的動態 enum（隨白名單自動反映） */
const modelKeys = AVAILABLE_LLM_MODELS.map((m) => m.key) as [
  string,
  ...string[],
];

const modelKeyEnum = z.enum(modelKeys, {
  message: '模型不在允許清單內',
});

/** 更新三個 Stage 模型選擇的請求 body */
export const updateStageModelsSchema = z.object({
  stage1: modelKeyEnum,
  stage2: modelKeyEnum,
  stage3: modelKeyEnum,
});

export type UpdateStageModelsInput = z.infer<typeof updateStageModelsSchema>;
