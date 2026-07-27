/**
 * @fileoverview LLM 模型指派驗證 Schema（CHANGE-099 → Epic 23 Story 23.2 step 3b → Story 23.4）
 * @description
 *   驗證後台更新**各處理環節**模型指派的請求。
 *
 *   - **step 3b（id-based）**：value 為 `LlmModel.id`（非白名單 key）；模型是否存在 / 已啟用
 *     由服務層 `setStageAssignments` 查庫驗證，本 schema 只驗非空字串。
 *   - **Story 23.4（per-環節）**：由固定的 `{ stage1, stage2, stage3 }` 改為
 *     `{ assignments: { <stageKey>: <LlmModel.id> } }`，涵蓋 {@link LLM_STAGES} 全部環節，
 *     並支援只送出有異動的環節（部分更新）。
 *
 *   未定義的 `stageKey` 在此**直接拒絕**（回 400），而非交由服務層靜默忽略——
 *   前端送錯環節名應該要看得見。
 *
 * @module src/lib/validations/llm-model-config.schema
 * @since CHANGE-099 - LLM 模型選擇管理
 * @lastModified 2026-07-27
 */

import { z } from 'zod';

import { LLM_STAGES, isLlmStageKey } from '@/lib/constants/llm-stages';

/** 單一環節的模型 id（非空；存在性 / 啟用狀態由服務層查庫驗證） */
const modelIdSchema = z.string().min(1, { message: '請選擇模型' });

/** 更新環節模型指派的請求 body（key = stageKey，value = LlmModel.id） */
export const updateStageAssignmentsSchema = z.object({
  assignments: z
    .record(z.string(), modelIdSchema)
    .refine((value) => Object.keys(value).length > 0, {
      message: '至少需指派一個處理環節',
    })
    .refine((value) => Object.keys(value).every(isLlmStageKey), {
      message: `包含未定義的處理環節（可用：${LLM_STAGES.map((s) => s.key).join(', ')}）`,
    }),
});

export type UpdateStageAssignmentsInput = z.infer<typeof updateStageAssignmentsSchema>;
