/**
 * @fileoverview CHANGE-099 單元測試：LLM 模型白名單與 fallback 不變量
 * @description
 *   驗證 src/lib/constants/llm-models 的關鍵不變量：
 *   - DEFAULT_STAGE_MODELS 的值必為白名單內有效模型（保證配置缺失時 fallback 有效）
 *   - capability 數值與 gpt-caller 原硬編 MODEL_CONFIG 一致（向後相容）
 *   - resolveDeploymentName 的 env 覆蓋邏輯
 *
 * @module tests/unit/lib/llm-models.test
 * @since CHANGE-099
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DEFAULT_STAGE_MODELS,
  getLlmModelOption,
  isValidLlmModel,
  resolveDeploymentName,
} from '@/lib/constants/llm-models';

describe('DEFAULT_STAGE_MODELS fallback 不變量', () => {
  it('每個預設值都是白名單內有效模型（保證 fallback 不會回無效值）', () => {
    expect(isValidLlmModel(DEFAULT_STAGE_MODELS.stage1)).toBe(true);
    expect(isValidLlmModel(DEFAULT_STAGE_MODELS.stage2)).toBe(true);
    expect(isValidLlmModel(DEFAULT_STAGE_MODELS.stage3)).toBe(true);
  });

  it('預設維持向後相容（Stage 1/2 = nano、Stage 3 = gpt-5.2）', () => {
    expect(DEFAULT_STAGE_MODELS.stage1).toBe('gpt-5-nano');
    expect(DEFAULT_STAGE_MODELS.stage2).toBe('gpt-5-nano');
    expect(DEFAULT_STAGE_MODELS.stage3).toBe('gpt-5.2');
  });
});

describe('getLlmModelOption / isValidLlmModel', () => {
  it('找得到白名單模型', () => {
    expect(getLlmModelOption('gpt-5-nano')?.key).toBe('gpt-5-nano');
    expect(getLlmModelOption('gpt-5.2')?.key).toBe('gpt-5.2');
  });

  it('找不到的 key 回 undefined / isValidLlmModel 回 false', () => {
    expect(getLlmModelOption('nonexistent-model')).toBeUndefined();
    expect(isValidLlmModel('nonexistent-model')).toBe(false);
  });
});

describe('capability 與原硬編 MODEL_CONFIG 一致（向後相容）', () => {
  it('gpt-5-nano：maxTokens 4096、不支援 temperature、圖片 low', () => {
    const nano = getLlmModelOption('gpt-5-nano');
    expect(nano?.capability.maxTokens).toBe(4096);
    expect(nano?.capability.supportsTemperature).toBe(false);
    expect(nano?.capability.defaultImageDetail).toBe('low');
  });

  it('gpt-5.2：maxTokens 8192、temperature 0.1、圖片 auto、支援 json_schema', () => {
    const full = getLlmModelOption('gpt-5.2');
    expect(full?.capability.maxTokens).toBe(8192);
    expect(full?.capability.supportsTemperature).toBe(true);
    expect(full?.capability.temperature).toBe(0.1);
    expect(full?.capability.defaultImageDetail).toBe('auto');
    expect(full?.capability.supportsJsonSchema).toBe(true);
  });
});

describe('resolveDeploymentName', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('env 覆蓋優先於預設部署名', () => {
    vi.stubEnv('AZURE_OPENAI_NANO_DEPLOYMENT_NAME', 'my-nano-deploy');
    const nano = getLlmModelOption('gpt-5-nano');
    expect(nano && resolveDeploymentName(nano)).toBe('my-nano-deploy');
  });

  it('env 未設（空值）時回落到預設部署名', () => {
    vi.stubEnv('AZURE_OPENAI_DEPLOYMENT_NAME', '');
    const full = getLlmModelOption('gpt-5.2');
    expect(full && resolveDeploymentName(full)).toBe('gpt-5-2-vision');
  });
});
