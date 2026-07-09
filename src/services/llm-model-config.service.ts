/**
 * @fileoverview LLM 模型選擇配置服務（CHANGE-099）
 * @description
 *   讀寫 extraction Stage 1-3 的「全域」模型選擇，儲存於 system_configs（key-value，
 *   category=AI_MODEL、scope=GLOBAL）。讀取時對無效/缺失值 fallback 到
 *   DEFAULT_STAGE_MODELS，確保未設定的環境行為與變更前完全一致。
 *
 * @module src/services/llm-model-config
 * @since CHANGE-099 - LLM 模型選擇管理
 * @lastModified 2026-07-09
 *
 * @related
 *   - src/lib/constants/llm-models.ts - 模型白名單與能力
 *   - src/services/extraction-v3/stages/gpt-caller.service.ts - 依此配置決定模型
 *   - src/app/api/v1/model-configs/ - 管理 API
 */

import { prisma } from '@/lib/prisma';
import { ConfigCategory, ConfigValueType, ConfigScope } from '@prisma/client';
import {
  DEFAULT_STAGE_MODELS,
  isValidLlmModel,
  type ExtractionStage,
} from '@/lib/constants/llm-models';

/** system_configs 中對應各 Stage 的 config key */
const CONFIG_KEYS: Record<ExtractionStage, string> = {
  stage1: 'extraction.model.stage1',
  stage2: 'extraction.model.stage2',
  stage3: 'extraction.model.stage3',
};

/** 首次建立 config 時的 name / description（資料層，供 system settings hub 顯示） */
const CONFIG_META: Record<ExtractionStage, { name: string; description: string }> = {
  stage1: {
    name: 'Stage 1 模型（公司識別）',
    description: '文件處理 Stage 1 公司識別使用的 LLM 模型',
  },
  stage2: {
    name: 'Stage 2 模型（格式匹配）',
    description: '文件處理 Stage 2 格式匹配使用的 LLM 模型',
  },
  stage3: {
    name: 'Stage 3 模型（欄位提取）',
    description: '文件處理 Stage 3 欄位提取使用的 LLM 模型',
  },
};

/** 三個 Stage 的模型選擇 */
export interface StageModelSelection {
  stage1: string;
  stage2: string;
  stage3: string;
}

/**
 * LLM 模型選擇配置服務。
 */
export class LlmModelConfigService {
  /**
   * 讀取三個 Stage 的模型選擇。
   * 無效/缺失值一律 fallback 到 DEFAULT_STAGE_MODELS。
   */
  static async getStageModels(): Promise<StageModelSelection> {
    const rows = await prisma.systemConfig.findMany({
      where: { key: { in: Object.values(CONFIG_KEYS) } },
      select: { key: true, value: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const pick = (stage: ExtractionStage): string => {
      const v = byKey.get(CONFIG_KEYS[stage]);
      return v && isValidLlmModel(v) ? v : DEFAULT_STAGE_MODELS[stage];
    };
    return {
      stage1: pick('stage1'),
      stage2: pick('stage2'),
      stage3: pick('stage3'),
    };
  }

  /**
   * 讀取單一 Stage 的模型 key（無效/缺失 fallback 到預設）。
   */
  static async getStageModel(stage: ExtractionStage): Promise<string> {
    const row = await prisma.systemConfig.findUnique({
      where: { key: CONFIG_KEYS[stage] },
      select: { value: true },
    });
    return row?.value && isValidLlmModel(row.value)
      ? row.value
      : DEFAULT_STAGE_MODELS[stage];
  }

  /**
   * 設定三個 Stage 的模型（upsert）。
   * 任一模型不在白名單內即整批拒絕。
   */
  static async setStageModels(
    selection: StageModelSelection,
    userId?: string,
  ): Promise<void> {
    const stages = Object.keys(CONFIG_KEYS) as ExtractionStage[];

    for (const stage of stages) {
      if (!isValidLlmModel(selection[stage])) {
        throw new Error(`無效的模型: ${selection[stage]}（stage=${stage}）`);
      }
    }

    await prisma.$transaction(
      stages.map((stage) => {
        const key = CONFIG_KEYS[stage];
        const value = selection[stage];
        const meta = CONFIG_META[stage];
        return prisma.systemConfig.upsert({
          where: { key },
          update: { value, updatedBy: userId ?? null },
          create: {
            key,
            value,
            name: meta.name,
            description: meta.description,
            category: ConfigCategory.AI_MODEL,
            valueType: ConfigValueType.STRING,
            scope: ConfigScope.GLOBAL,
            defaultValue: DEFAULT_STAGE_MODELS[stage],
            updatedBy: userId ?? null,
          },
        });
      }),
    );
  }
}
