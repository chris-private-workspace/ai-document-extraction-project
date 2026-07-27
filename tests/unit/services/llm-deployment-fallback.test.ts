/**
 * @fileoverview FIX-137 回歸測試：失效部署名 fallback + reasoning 模型偵測
 * @description
 *   驗證兩件事：
 *     1. `resolveDeploymentNameByKey` 對白名單內的 key 走 env 覆蓋 → 白名單預設，
 *        對白名單外的值原樣回傳（不干擾呼叫端顯式指定的部署名）。
 *     2. `isReasoningModel` 認得 5.4 系列 —— CHANGE-102 後實際使用的就是它們，
 *        而原 pattern（`/gpt-5-nano/i`）對 `gpt-5.4-nano` 不匹配，會導致送錯參數格式。
 *
 * @module tests/unit/services/llm-deployment-fallback.test
 * @since FIX-137
 * @lastModified 2026-07-27
 */

import { describe, it, expect, afterEach } from 'vitest';

import { resolveDeploymentNameByKey } from '@/lib/constants/llm-models';
import { isReasoningModel } from '@/services/extraction-v2/gpt-mini-extractor.service';

describe('resolveDeploymentNameByKey（FIX-137）', () => {
  const ENV_MINI = 'AZURE_OPENAI_GPT54_MINI_DEPLOYMENT_NAME';
  const original = process.env[ENV_MINI];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_MINI];
    else process.env[ENV_MINI] = original;
  });

  it('should fall back to the whitelist default deployment name when no env override is set', () => {
    delete process.env[ENV_MINI];
    expect(resolveDeploymentNameByKey('gpt-5.4-mini')).toBe('gpt-5.4-mini');
  });

  it('should prefer the env override when it is set', () => {
    // Azure DEV 的部署名帶專案後綴，正是 2026-07-14 那次 404 的成因
    process.env[ENV_MINI] = 'gpt-5.4-mini-aidocprocessing';
    expect(resolveDeploymentNameByKey('gpt-5.4-mini')).toBe('gpt-5.4-mini-aidocprocessing');
  });

  it('should return unknown keys unchanged so explicit deployment names are not rewritten', () => {
    expect(resolveDeploymentNameByKey('some-custom-deployment')).toBe('some-custom-deployment');
  });

  it('should no longer resolve to deployments removed by CHANGE-102', () => {
    // 白名單只剩 5.4 系列；舊 key 不該再解析出任何白名單條目
    for (const key of ['gpt-5.4-mini', 'gpt-5.4-nano']) {
      const resolved = resolveDeploymentNameByKey(key);
      expect(resolved).not.toBe('gpt-5.2');
      expect(resolved).not.toBe('gpt-5-nano');
      expect(resolved).not.toBe('gpt-5-2-vision');
    }
  });
});

describe('isReasoningModel（FIX-137）', () => {
  it('should detect the 5.4 series that CHANGE-102 left as the only options', () => {
    expect(isReasoningModel('gpt-5.4-nano')).toBe(true);
    expect(isReasoningModel('gpt-5.4-mini')).toBe(true);
  });

  it('should still detect Azure deployment names carrying a project suffix', () => {
    // 實跑時的實際部署名（AI SDK 於此警告 temperature 不支援）
    expect(isReasoningModel('gpt-5.4-mini-aidocprocessing')).toBe(true);
  });

  it('should not regress on the pre-CHANGE-102 names or the o-series', () => {
    expect(isReasoningModel('gpt-5-nano')).toBe(true);
    expect(isReasoningModel('gpt-5-mini')).toBe(true);
    expect(isReasoningModel('o1-preview')).toBe(true);
    expect(isReasoningModel('o3-mini')).toBe(true);
  });

  it('should not misclassify non-reasoning deployments', () => {
    expect(isReasoningModel('gpt-4o')).toBe(false);
    expect(isReasoningModel('gpt-4o-mini')).toBe(false);
  });
});
