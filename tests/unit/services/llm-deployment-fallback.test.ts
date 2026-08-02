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
  const ENV_LUNA = 'AZURE_OPENAI_LUNA_DEPLOYMENT_NAME';
  const original = process.env[ENV_LUNA];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_LUNA];
    else process.env[ENV_LUNA] = original;
  });

  it('should fall back to the whitelist default deployment name when no env override is set', () => {
    delete process.env[ENV_LUNA];
    expect(resolveDeploymentNameByKey('gpt-5.6-luna')).toBe('gpt-5.6-luna');
  });

  it('should prefer the env override when it is set', () => {
    // 任意的覆蓋值，只為證明 env 優先於白名單預設。
    // ⚠️ luna 的**實際**部署名就是 `gpt-5.6-luna`（不帶任何後綴）—— 此處刻意用一個
    //    明顯虛構的值，避免被誤讀為真實部署名。
    process.env[ENV_LUNA] = 'some-other-luna-deployment';
    expect(resolveDeploymentNameByKey('gpt-5.6-luna')).toBe('some-other-luna-deployment');
  });

  it('should return unknown keys unchanged so explicit deployment names are not rewritten', () => {
    expect(resolveDeploymentNameByKey('some-custom-deployment')).toBe('some-custom-deployment');
  });

  it('should no longer resolve to deployments removed by CHANGE-102 / CHANGE-115', () => {
    // 白名單只剩 gpt-5.6-luna；歷代舊 key 都不該再解析出白名單條目，
    // 而是原樣回傳（呼叫端顯式指定的部署名不被改寫）
    for (const key of ['gpt-5.2', 'gpt-5-nano', 'gpt-5.4-mini', 'gpt-5.4-nano']) {
      expect(resolveDeploymentNameByKey(key)).toBe(key);
    }
  });
});

describe('isReasoningModel（FIX-137 / CHANGE-115）', () => {
  it('should detect gpt-5.6-luna, the only whitelisted model after CHANGE-115', () => {
    // 🔴 實機探測確認 luna 不支援 temperature（送 0.1 回 400 unsupported_value）。
    //    漏判會送 temperature + max_tokens 而非 max_completion_tokens → 每次呼叫都 400。
    //    這是與 FIX-137 完全同型的漏判（當時是 5.4 系列不匹配 /gpt-5-nano/）。
    expect(isReasoningModel('gpt-5.6-luna')).toBe(true);
  });

  it('should detect the 5.4 series that CHANGE-102 left as the only options', () => {
    expect(isReasoningModel('gpt-5.4-nano')).toBe(true);
    expect(isReasoningModel('gpt-5.4-mini')).toBe(true);
  });

  it('should still detect Azure deployment names carrying a project suffix', () => {
    // `gpt-5.4-mini-aidocprocessing` 是舊資源上**真實存在過**的部署名
    // （AI SDK 於此警告 temperature 不支援）。
    // ⚠️ luna 目前的實際部署名是 `gpt-5.6-luna`，**不帶後綴**；此處僅驗證 pattern
    //    為非錨定比對，未來若改用帶後綴的命名也不會漏判。
    expect(isReasoningModel('gpt-5.4-mini-aidocprocessing')).toBe(true);
    expect(isReasoningModel('prefix-gpt-5.6-luna-suffix')).toBe(true);
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
