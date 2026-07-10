/**
 * @fileoverview CHANGE-099 / CHANGE-102 單元測試：LLM 模型白名單與 fallback 不變量
 * @description
 *   驗證 src/lib/constants/llm-models 的關鍵不變量：
 *   - DEFAULT_STAGE_MODELS 的值必為白名單內有效模型（保證配置缺失時 fallback 有效）
 *   - CHANGE-102：白名單只含 gpt-5.4-mini / gpt-5.4-nano；舊 gpt-5.2 / gpt-5-nano 已移除
 *   - resolveDeploymentName 的 env 覆蓋邏輯
 *
 * @module tests/unit/lib/llm-models.test
 * @since CHANGE-099
 * @lastModified 2026-07-10 (CHANGE-102)
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

  it('CHANGE-102: 預設正名至 5.4（Stage 1/3 = gpt-5.4-mini、Stage 2 = gpt-5.4-nano）', () => {
    expect(DEFAULT_STAGE_MODELS.stage1).toBe('gpt-5.4-mini');
    expect(DEFAULT_STAGE_MODELS.stage2).toBe('gpt-5.4-nano');
    expect(DEFAULT_STAGE_MODELS.stage3).toBe('gpt-5.4-mini');
  });
});

describe('getLlmModelOption / isValidLlmModel', () => {
  it('找得到白名單模型', () => {
    expect(getLlmModelOption('gpt-5.4-mini')?.key).toBe('gpt-5.4-mini');
    expect(getLlmModelOption('gpt-5.4-nano')?.key).toBe('gpt-5.4-nano');
  });

  it('找不到的 key 回 undefined / isValidLlmModel 回 false', () => {
    expect(getLlmModelOption('nonexistent-model')).toBeUndefined();
    expect(isValidLlmModel('nonexistent-model')).toBe(false);
  });

  it('CHANGE-102: 舊 gpt-5.2 / gpt-5-nano 已移出白名單', () => {
    expect(isValidLlmModel('gpt-5.2')).toBe(false);
    expect(isValidLlmModel('gpt-5-nano')).toBe(false);
    expect(getLlmModelOption('gpt-5.2')).toBeUndefined();
    expect(getLlmModelOption('gpt-5-nano')).toBeUndefined();
  });
});

describe('CHANGE-100/102: gpt-5.4-mini / gpt-5.4-nano 白名單', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('gpt-5.4-mini 在白名單、高精度能力（maxTokens 8192、temperature 0.1、json_schema）', () => {
    expect(isValidLlmModel('gpt-5.4-mini')).toBe(true);
    const mini = getLlmModelOption('gpt-5.4-mini');
    expect(mini?.capability.maxTokens).toBe(8192);
    expect(mini?.capability.supportsTemperature).toBe(true);
    expect(mini?.capability.temperature).toBe(0.1);
    expect(mini?.capability.defaultImageDetail).toBe('auto');
    expect(mini?.capability.supportsJsonSchema).toBe(true);
  });

  it('gpt-5.4-nano 在白名單、輕量能力（maxTokens 4096、不支援 temperature、圖片 low）', () => {
    expect(isValidLlmModel('gpt-5.4-nano')).toBe(true);
    const nano = getLlmModelOption('gpt-5.4-nano');
    expect(nano?.capability.maxTokens).toBe(4096);
    expect(nano?.capability.supportsTemperature).toBe(false);
    expect(nano?.capability.defaultImageDetail).toBe('low');
    expect(nano?.capability.supportsJsonSchema).toBe(false);
  });

  it('部署名預設等於模型名（env 未設空值時）', () => {
    vi.stubEnv('AZURE_OPENAI_GPT54_MINI_DEPLOYMENT_NAME', '');
    vi.stubEnv('AZURE_OPENAI_GPT54_NANO_DEPLOYMENT_NAME', '');
    const mini = getLlmModelOption('gpt-5.4-mini');
    const nano = getLlmModelOption('gpt-5.4-nano');
    expect(mini && resolveDeploymentName(mini)).toBe('gpt-5.4-mini');
    expect(nano && resolveDeploymentName(nano)).toBe('gpt-5.4-nano');
  });

  it('env 覆蓋優先於預設部署名', () => {
    vi.stubEnv('AZURE_OPENAI_GPT54_MINI_DEPLOYMENT_NAME', 'my-mini-deploy');
    const mini = getLlmModelOption('gpt-5.4-mini');
    expect(mini && resolveDeploymentName(mini)).toBe('my-mini-deploy');
  });
});
