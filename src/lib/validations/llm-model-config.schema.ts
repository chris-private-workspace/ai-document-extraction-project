/**
 * @fileoverview LLM 模型選擇配置驗證 Schema（CHANGE-099 → Epic 23 Story 23.2 step 3b）
 * @description
 *   驗證後台更新 Stage 1-3 模型選擇的請求。
 *   **step 3b（id-based）**：value 改為 `LlmModel.id`（非白名單 key）；模型是否存在 / 已啟用
 *   由服務層 `setStageModelSelection` 查庫驗證，本 schema 只驗非空字串。
 *
 * @module src/lib/validations/llm-model-config.schema
 * @since CHANGE-099 - LLM 模型選擇管理
 * @lastModified 2026-07-10
 */

import { z } from 'zod';

/** 單一 Stage 的模型 id（非空；存在性 / 啟用狀態由服務層查庫驗證） */
const modelIdSchema = z.string().min(1, { message: '請選擇模型' });

/** 更新三個 Stage 模型選擇的請求 body（value = LlmModel.id） */
export const updateStageModelsSchema = z.object({
  stage1: modelIdSchema,
  stage2: modelIdSchema,
  stage3: modelIdSchema,
});

export type UpdateStageModelsInput = z.infer<typeof updateStageModelsSchema>;
