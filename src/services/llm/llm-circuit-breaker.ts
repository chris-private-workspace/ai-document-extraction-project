/**
 * @fileoverview LLM Provider Circuit Breaker（Epic 23 - Story 23.3 韌性骨架）
 * @description
 *   per-provider 熔斷器，補三輪審視「炸彈②」的營運缺口之一：provider 掛掉時整批**空燒 retry**
 *   （tech-spec §11.5「provider 韌性（D7 備援）」）。標準三態機：
 *     - `CLOSED`：正常放行；連續失敗達 `failureThreshold` → 開路。
 *     - `OPEN`：**fail-fast**（不再送出、不空燒 retry）；經 `cooldownMs` → 進 `HALF_OPEN` 試探。
 *     - `HALF_OPEN`：放行至多 `halfOpenMax` 個試探；成功 → `CLOSED`，失敗 → 立即 `OPEN`。
 *
 *   in-house 實作（無新依賴，H2）；純記憶體、單一 process、同步。時鐘可注入（`now`）供測試控制時間。
 *   由 `LlmGatewayService` 以 `providerId` 為 key 使用；整體受 `FEATURE_LLM_GATEWAY_ENABLED` 與
 *   `FEATURE_LLM_CIRCUIT_BREAKER` 控制（見 `src/config/feature-flags.ts`）。
 *
 * @module src/services/llm/llm-circuit-breaker
 * @since Epic 23 - Story 23.3
 * @lastModified 2026-07-10
 *
 * @related
 *   - src/services/llm/llm-gateway.service.ts - 消費端（call() 熔斷 + failover）
 *   - src/config/feature-flags.ts - getLlmResilienceConfig（閾值 / 冷卻 / 開關）
 */

import { getLlmResilienceConfig } from '@/config/feature-flags';

/** 熔斷狀態 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** 熔斷器建構選項 */
export interface LlmCircuitBreakerOptions {
  /** 連續失敗達此數即開路（CLOSED → OPEN） */
  failureThreshold: number;
  /** OPEN → HALF_OPEN 的冷卻時間（毫秒） */
  cooldownMs: number;
  /** HALF_OPEN 期間允許的試探數 */
  halfOpenMax: number;
  /** 時鐘（可注入供測試控制時間；預設 Date.now） */
  now?: () => number;
}

/** 單一 key（provider）的內部狀態 */
interface KeyState {
  status: CircuitState;
  failures: number;
  openedAt: number;
  halfOpenInFlight: number;
}

/** 對外快照（供健康檢視 / 除錯） */
export interface CircuitSnapshotEntry {
  state: CircuitState;
  failures: number;
}

/**
 * per-key LLM provider 熔斷器（三態機）。
 */
export class LlmCircuitBreaker {
  private readonly states = new Map<string, KeyState>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenMax: number;
  private readonly now: () => number;

  constructor(options: LlmCircuitBreakerOptions) {
    this.failureThreshold = Math.max(1, options.failureThreshold);
    this.cooldownMs = Math.max(0, options.cooldownMs);
    this.halfOpenMax = Math.max(1, options.halfOpenMax);
    this.now = options.now ?? Date.now;
  }

  /**
   * 是否放行本次請求。
   * OPEN 且冷卻已過 → 轉 HALF_OPEN 並放行試探；HALF_OPEN 超過試探額度 → 拒絕。
   */
  canRequest(key: string): boolean {
    const s = this.ensure(key);

    if (s.status === 'OPEN') {
      if (this.now() - s.openedAt >= this.cooldownMs) {
        s.status = 'HALF_OPEN';
        s.halfOpenInFlight = 0;
      } else {
        return false;
      }
    }

    if (s.status === 'HALF_OPEN') {
      if (s.halfOpenInFlight < this.halfOpenMax) {
        s.halfOpenInFlight++;
        return true;
      }
      return false;
    }

    // CLOSED
    return true;
  }

  /** 記錄成功 → 回復 CLOSED、清零失敗計數 */
  recordSuccess(key: string): void {
    const s = this.ensure(key);
    s.status = 'CLOSED';
    s.failures = 0;
    s.openedAt = 0;
    s.halfOpenInFlight = 0;
  }

  /** 記錄失敗 → HALF_OPEN 立即重開；CLOSED 累計達閾值則開路 */
  recordFailure(key: string): void {
    const s = this.ensure(key);
    if (s.status === 'HALF_OPEN') {
      s.status = 'OPEN';
      s.openedAt = this.now();
      s.halfOpenInFlight = 0;
      return;
    }
    s.failures++;
    if (s.failures >= this.failureThreshold) {
      s.status = 'OPEN';
      s.openedAt = this.now();
      s.failures = 0;
    }
  }

  /** 目前狀態（未知 key 視為 CLOSED） */
  getState(key: string): CircuitState {
    return this.states.get(key)?.status ?? 'CLOSED';
  }

  /** 重置（省略 key 則清空全部）；供健康檢查手動 reset / 測試 */
  reset(key?: string): void {
    if (key === undefined) {
      this.states.clear();
    } else {
      this.states.delete(key);
    }
  }

  /** 全部 key 的狀態快照 */
  snapshot(): Record<string, CircuitSnapshotEntry> {
    const out: Record<string, CircuitSnapshotEntry> = {};
    for (const [k, s] of this.states) {
      out[k] = { state: s.status, failures: s.failures };
    }
    return out;
  }

  private ensure(key: string): KeyState {
    let s = this.states.get(key);
    if (!s) {
      s = { status: 'CLOSED', failures: 0, openedAt: 0, halfOpenInFlight: 0 };
      this.states.set(key, s);
    }
    return s;
  }
}

/**
 * 單例（由 env 韌性設定建構；prod 於 process 啟動時讀一次）。
 * 閾值 / 冷卻 / 試探額度來自 `getLlmResilienceConfig()`。
 */
const resilienceConfig = getLlmResilienceConfig();
export const llmCircuitBreaker = new LlmCircuitBreaker({
  failureThreshold: resilienceConfig.failureThreshold,
  cooldownMs: resilienceConfig.cooldownMs,
  halfOpenMax: resilienceConfig.halfOpenMax,
});
