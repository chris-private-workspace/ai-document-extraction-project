/**
 * @fileoverview LlmCircuitBreaker 單元測試（Epic 23 - Story 23.3 韌性骨架）
 * @description
 *   驗證 per-key 三態機（CLOSED/OPEN/HALF_OPEN）契約，時鐘注入控制時間：
 *   - 連續失敗達閾值 → 開路 fail-fast；成功清零計數。
 *   - OPEN 冷卻後轉 HALF_OPEN；試探額度用盡即拒絕。
 *   - HALF_OPEN 成功 → CLOSED；失敗 → 立即重開（新冷卻）。
 *   - per-key 隔離、reset、snapshot。
 *
 * @module tests/unit/services/llm-circuit-breaker.test
 * @since Epic 23 - Story 23.3
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LlmCircuitBreaker } from '@/services/llm/llm-circuit-breaker';

const KEY = 'provider-A';

describe('LlmCircuitBreaker', () => {
  let now: number;
  let breaker: LlmCircuitBreaker;

  beforeEach(() => {
    now = 1_000_000;
    breaker = new LlmCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 10_000,
      halfOpenMax: 1,
      now: () => now,
    });
  });

  it('should start CLOSED and allow requests', () => {
    expect(breaker.getState(KEY)).toBe('CLOSED');
    expect(breaker.canRequest(KEY)).toBe(true);
  });

  it('should open after reaching the failure threshold', () => {
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    expect(breaker.getState(KEY)).toBe('CLOSED'); // 2 < 3
    breaker.recordFailure(KEY);
    expect(breaker.getState(KEY)).toBe('OPEN'); // 3 >= 3
  });

  it('should fail-fast (reject) while OPEN before cooldown', () => {
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    expect(breaker.getState(KEY)).toBe('OPEN');
    expect(breaker.canRequest(KEY)).toBe(false);
    now += 9_999; // 尚未達冷卻
    expect(breaker.canRequest(KEY)).toBe(false);
  });

  it('should reset failure count on success (no premature open)', () => {
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    breaker.recordSuccess(KEY);
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    expect(breaker.getState(KEY)).toBe('CLOSED'); // 計數已被成功清零
  });

  it('should transition OPEN → HALF_OPEN after cooldown and allow one probe', () => {
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    now += 10_000; // 冷卻已過
    expect(breaker.canRequest(KEY)).toBe(true); // 進 HALF_OPEN，放行試探
    expect(breaker.getState(KEY)).toBe('HALF_OPEN');
    expect(breaker.canRequest(KEY)).toBe(false); // halfOpenMax=1，第二個試探被拒
  });

  it('should close on a successful half-open probe', () => {
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    now += 10_000;
    breaker.canRequest(KEY); // 進 HALF_OPEN
    breaker.recordSuccess(KEY);
    expect(breaker.getState(KEY)).toBe('CLOSED');
    expect(breaker.canRequest(KEY)).toBe(true);
  });

  it('should re-open immediately on a failed half-open probe', () => {
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    now += 10_000;
    breaker.canRequest(KEY); // 進 HALF_OPEN
    breaker.recordFailure(KEY); // 試探失敗
    expect(breaker.getState(KEY)).toBe('OPEN');
    expect(breaker.canRequest(KEY)).toBe(false); // 新冷卻開始
    now += 10_000;
    expect(breaker.canRequest(KEY)).toBe(true); // 再次進 HALF_OPEN
  });

  it('should isolate state per key', () => {
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    expect(breaker.getState(KEY)).toBe('OPEN');
    expect(breaker.getState('provider-B')).toBe('CLOSED');
    expect(breaker.canRequest('provider-B')).toBe(true);
  });

  it('should reset a single key and all keys', () => {
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    breaker.reset(KEY);
    expect(breaker.getState(KEY)).toBe('CLOSED');

    breaker.recordFailure('provider-B');
    breaker.recordFailure('provider-B');
    breaker.recordFailure('provider-B');
    breaker.reset();
    expect(breaker.snapshot()).toEqual({});
  });

  it('should expose a snapshot of states', () => {
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    const snap = breaker.snapshot();
    expect(snap[KEY].state).toBe('OPEN');
  });
});
