/**
 * @fileoverview LLM Gateway 模組導出（Epic 23 - Story 23.1）
 * @module src/services/llm
 * @since Epic 23 - Story 23.1
 */

export { LlmGatewayService, LlmGatewayError, llmGatewayService } from './llm-gateway.service';
export type {
  LlmCallInput,
  LlmCallResult,
  LlmCallUsage,
  LlmCallPlan,
  LlmMessage,
  LlmMessageRole,
  LlmImagePart,
  LlmOutputSpec,
} from './llm-gateway.types';
