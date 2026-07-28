/**
 * @fileoverview LLM Gateway 模組導出（Epic 23 - Story 23.1）
 * @module src/services/llm
 * @since Epic 23 - Story 23.1
 */

export { LlmGatewayService, LlmGatewayError, llmGatewayService } from './llm-gateway.service';
export { callGatewayByModelKey } from './gateway-bridge';
export type { GatewayBridgeInput, GatewayBridgeResult } from './gateway-bridge';
export { LlmCircuitBreaker, llmCircuitBreaker } from './llm-circuit-breaker';
export type {
  CircuitState,
  CircuitSnapshotEntry,
  LlmCircuitBreakerOptions,
} from './llm-circuit-breaker';
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
