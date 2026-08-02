/**
 * @fileoverview CHANGE-099 / CHANGE-102 / CHANGE-115 單元測試：LLM 模型白名單與 fallback 不變量
 * @description
 *   驗證 src/lib/constants/llm-models 的關鍵不變量：
 *   - DEFAULT_STAGE_MODELS 的值必為白名單內有效模型（保證配置缺失時 fallback 有效）
 *   - CHANGE-115：白名單只含 gpt-5.6-luna；5.4 系列與更舊的 5.2 / 5-nano 皆已移除
 *   - resolveDeploymentName 的 env 覆蓋邏輯
 *
 *   ⚠️ 能力值（capability）對應 2026-08-02 對 Azure deployment `gpt-5.6-luna` 的
 *      **實機探測**結果，非查文件推測。改動前請重新探測，勿直接調整斷言。
 *
 * @module tests/unit/lib/llm-models.test
 * @since CHANGE-099
 * @lastModified 2026-08-02 (CHANGE-115)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  AVAILABLE_LLM_MODELS,
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

  it('CHANGE-115: 三個 Stage 統一為 gpt-5.6-luna', () => {
    expect(DEFAULT_STAGE_MODELS.stage1).toBe('gpt-5.6-luna');
    expect(DEFAULT_STAGE_MODELS.stage2).toBe('gpt-5.6-luna');
    expect(DEFAULT_STAGE_MODELS.stage3).toBe('gpt-5.6-luna');
  });
});

describe('getLlmModelOption / isValidLlmModel', () => {
  it('找得到白名單模型', () => {
    expect(getLlmModelOption('gpt-5.6-luna')?.key).toBe('gpt-5.6-luna');
  });

  it('找不到的 key 回 undefined / isValidLlmModel 回 false', () => {
    expect(getLlmModelOption('nonexistent-model')).toBeUndefined();
    expect(isValidLlmModel('nonexistent-model')).toBe(false);
  });

  it('CHANGE-102 / CHANGE-115: 歷代舊模型皆已移出白名單', () => {
    // 這些 deployment 在現行 Azure 資源上都不存在，留在白名單只會讓後台顯示選了必 404 的選項
    for (const legacy of ['gpt-5.2', 'gpt-5-nano', 'gpt-5.4-mini', 'gpt-5.4-nano']) {
      expect(isValidLlmModel(legacy)).toBe(false);
      expect(getLlmModelOption(legacy)).toBeUndefined();
    }
  });
});

describe('CHANGE-115: gpt-5.6-luna 白名單與能力', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('白名單目前只有 gpt-5.6-luna 單一模型', () => {
    expect(AVAILABLE_LLM_MODELS).toHaveLength(1);
    expect(AVAILABLE_LLM_MODELS[0].key).toBe('gpt-5.6-luna');
  });

  it('能力值與實機探測一致（json_schema 支援、temperature 不支援）', () => {
    const luna = getLlmModelOption('gpt-5.6-luna');
    expect(luna?.capability.maxTokens).toBe(8192);
    // 🔴 實測：送任何非預設 temperature 一律回 400 unsupported_value
    expect(luna?.capability.supportsTemperature).toBe(false);
    expect(luna?.capability.temperature).toBeUndefined();
    expect(luna?.capability.defaultImageDetail).toBe('auto');
    // 🔴 Stage 3 structured output 的必要條件
    expect(luna?.capability.supportsJsonSchema).toBe(true);
  });

  it('部署名預設等於模型名（env 未設空值時）', () => {
    vi.stubEnv('AZURE_OPENAI_LUNA_DEPLOYMENT_NAME', '');
    const luna = getLlmModelOption('gpt-5.6-luna');
    expect(luna && resolveDeploymentName(luna)).toBe('gpt-5.6-luna');
  });

  it('env 覆蓋優先於預設部署名', () => {
    vi.stubEnv('AZURE_OPENAI_LUNA_DEPLOYMENT_NAME', 'my-luna-deploy');
    const luna = getLlmModelOption('gpt-5.6-luna');
    expect(luna && resolveDeploymentName(luna)).toBe('my-luna-deploy');
  });
});
