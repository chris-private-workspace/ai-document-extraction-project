/**
 * @fileoverview shouldUseLlmGateway 一致性百分比灰度單元測試（Epic 23 - Story 23.1 step 4b）
 * @description
 *   驗證 gateway 灰度旗標的確定性分支（純函式、無副作用）：
 *   - master `FEATURE_LLM_GATEWAY_ENABLED` 關 → 恆 false（行為零變）。
 *   - `FEATURE_LLM_GATEWAY_PERCENTAGE` 預設 100（維持 step 4 硬切換語意）。
 *   - ≥100 全開、≤0 全關。
 *   - 中間值 + fileId：`simpleHash` 一致性路由（同一 fileId 恆得同一結果）。
 *   隨機分流分支（中間值 + 無 fileId）不確定，不納入斷言。
 *
 * @module tests/unit/services/llm-gateway-rollout-flag.test
 * @since Epic 23 - Story 23.1 step 4b
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shouldUseLlmGateway } from '@/config/feature-flags';

describe('shouldUseLlmGateway（step 4b 一致性百分比灰度）', () => {
  beforeEach(() => {
    delete process.env.FEATURE_LLM_GATEWAY_ENABLED;
    delete process.env.FEATURE_LLM_GATEWAY_PERCENTAGE;
  });

  afterEach(() => {
    delete process.env.FEATURE_LLM_GATEWAY_ENABLED;
    delete process.env.FEATURE_LLM_GATEWAY_PERCENTAGE;
  });

  it('should return false when master toggle is off (regardless of percentage)', () => {
    process.env.FEATURE_LLM_GATEWAY_PERCENTAGE = '100';
    expect(shouldUseLlmGateway('doc-1')).toBe(false);
  });

  it('should default to 100% (full switch) when master on and percentage unset', () => {
    process.env.FEATURE_LLM_GATEWAY_ENABLED = 'true';
    expect(shouldUseLlmGateway('doc-1')).toBe(true);
    expect(shouldUseLlmGateway()).toBe(true);
  });

  it('should return true when percentage >= 100', () => {
    process.env.FEATURE_LLM_GATEWAY_ENABLED = 'true';
    process.env.FEATURE_LLM_GATEWAY_PERCENTAGE = '100';
    expect(shouldUseLlmGateway('doc-1')).toBe(true);
  });

  it('should return false when percentage <= 0', () => {
    process.env.FEATURE_LLM_GATEWAY_ENABLED = 'true';
    process.env.FEATURE_LLM_GATEWAY_PERCENTAGE = '0';
    expect(shouldUseLlmGateway('doc-1')).toBe(false);
  });

  it('should route the same fileId consistently at an intermediate percentage', () => {
    process.env.FEATURE_LLM_GATEWAY_ENABLED = 'true';
    process.env.FEATURE_LLM_GATEWAY_PERCENTAGE = '50';

    const first = shouldUseLlmGateway('doc-consistent');
    const second = shouldUseLlmGateway('doc-consistent');
    const third = shouldUseLlmGateway('doc-consistent');

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(typeof first).toBe('boolean');
  });

  it('should split distinct fileIds across the boundary at 50% (deterministic hash)', () => {
    process.env.FEATURE_LLM_GATEWAY_ENABLED = 'true';
    process.env.FEATURE_LLM_GATEWAY_PERCENTAGE = '50';

    // 對一批固定 fileId，路由結果須同時包含 true 與 false（證明雜湊有分流、非全同）
    const ids = Array.from({ length: 40 }, (_, i) => `doc-${i}`);
    const results = ids.map((id) => shouldUseLlmGateway(id));

    expect(results).toContain(true);
    expect(results).toContain(false);
  });
});
