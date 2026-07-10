/**
 * @fileoverview LLM 模型選擇配置服務（CHANGE-099 → Epic 23 Story 23.2 step 3b）
 * @description
 *   讀寫 extraction Stage 1-3 的「全域」模型選擇。
 *
 *   **Story 23.2 step 3b（id-based）**：指派的**唯一真實來源**改為 `StageModelAssignment`
 *   （value = `LlmModel.id`），對齊 tech-spec §4；後台管理頁下拉來源改為「已啟用 provider
 *   的已啟用模型」。管線讀取（`getStageModel`）仍回 modelKey 供 gpt-caller 既有 Azure
 *   key-bridge（extraction core 零改動；非 Azure 實際執行留 Story 23.3，D6）。
 *
 *   Fallback 鏈（確保未播種 / 舊環境行為零變）：
 *     StageModelAssignment（Azure 白名單）→ 舊 SystemConfig key → DEFAULT_STAGE_MODELS。
 *
 * @module src/services/llm-model-config
 * @since CHANGE-099 - LLM 模型選擇管理
 * @lastModified 2026-07-10
 *
 * @related
 *   - src/lib/constants/llm-models.ts - 模型白名單與能力（Azure 執行 fallback 基準）
 *   - prisma/schema.prisma - LlmProvider / LlmModel / StageModelAssignment
 *   - src/services/extraction-v3/stages/gpt-caller.service.ts - 依 getStageModel(key) 決定模型
 *   - src/app/api/v1/model-configs/ - 管理 API
 */

import { prisma } from '@/lib/prisma';
import {
  DEFAULT_STAGE_MODELS,
  isValidLlmModel,
  type ExtractionStage,
} from '@/lib/constants/llm-models';

/** 各 Stage 對應的 `StageModelAssignment.stageKey`（沿用 CHANGE-099 的 SystemConfig key，播種已對齊） */
const STAGE_KEYS: Record<ExtractionStage, string> = {
  stage1: 'extraction.model.stage1',
  stage2: 'extraction.model.stage2',
  stage3: 'extraction.model.stage3',
};

const STAGES = Object.keys(STAGE_KEYS) as ExtractionStage[];

/** 三個 Stage 的模型選擇（step 3b 起 value = `LlmModel.id`；未指派為空字串） */
export interface StageModelSelection {
  stage1: string;
  stage2: string;
  stage3: string;
}

/** 後台下拉可選模型（已啟用 provider 的已啟用模型；無憑證） */
export interface SelectableModel {
  id: string;
  modelKey: string;
  label: string;
  capability: unknown;
  providerId: string;
  providerName: string;
  providerType: string;
}

/**
 * LLM 模型選擇配置服務。
 */
export class LlmModelConfigService {
  /**
   * 列出後台下拉可選模型：**已啟用 provider 的已啟用模型**（預設 provider 優先、名稱、label 排序）。
   */
  static async listSelectableModels(): Promise<SelectableModel[]> {
    const models = await prisma.llmModel.findMany({
      where: { isEnabled: true, provider: { isEnabled: true } },
      include: {
        provider: { select: { id: true, name: true, providerType: true, isDefault: true } },
      },
      orderBy: [
        { provider: { isDefault: 'desc' } },
        { provider: { name: 'asc' } },
        { label: 'asc' },
      ],
    });
    return models.map((m) => ({
      id: m.id,
      modelKey: m.modelKey,
      label: m.label,
      capability: m.capability,
      providerId: m.provider.id,
      providerName: m.provider.name,
      providerType: m.provider.providerType,
    }));
  }

  /**
   * 讀取三個 Stage 的模型選擇（value = `LlmModel.id`）。
   * 缺 assignment 時 fallback 舊 SystemConfig key → 預設 Azure provider 下對應模型 id。
   */
  static async getStageModelSelection(): Promise<StageModelSelection> {
    const rows = await prisma.stageModelAssignment.findMany({
      where: { stageKey: { in: Object.values(STAGE_KEYS) } },
      select: { stageKey: true, llmModelId: true },
    });
    const idByStageKey = new Map(rows.map((r) => [r.stageKey, r.llmModelId]));

    const resolved = await Promise.all(
      STAGES.map(async (stage) => {
        const id = idByStageKey.get(STAGE_KEYS[stage]);
        return [stage, id ?? (await this.resolveFallbackModelId(stage))] as const;
      }),
    );
    return {
      stage1: resolved.find(([s]) => s === 'stage1')?.[1] ?? '',
      stage2: resolved.find(([s]) => s === 'stage2')?.[1] ?? '',
      stage3: resolved.find(([s]) => s === 'stage3')?.[1] ?? '',
    };
  }

  /**
   * 設定三個 Stage 的模型（id-based，upsert `StageModelAssignment`）。
   * 任一 id 非「已啟用 provider 的已啟用模型」即整批拒絕。
   */
  static async setStageModelSelection(
    selection: StageModelSelection,
    userId?: string,
  ): Promise<void> {
    const ids = STAGES.map((s) => selection[s]);
    const rows = await prisma.llmModel.findMany({
      where: { id: { in: ids }, isEnabled: true, provider: { isEnabled: true } },
      select: { id: true },
    });
    const validIds = new Set(rows.map((r) => r.id));
    for (const stage of STAGES) {
      if (!validIds.has(selection[stage])) {
        throw new Error(`無效或已停用的模型: ${selection[stage]}（stage=${stage}）`);
      }
    }

    await prisma.$transaction(
      STAGES.map((stage) =>
        prisma.stageModelAssignment.upsert({
          where: { stageKey: STAGE_KEYS[stage] },
          update: { llmModelId: selection[stage], updatedBy: userId ?? null },
          create: {
            stageKey: STAGE_KEYS[stage],
            llmModelId: selection[stage],
            updatedBy: userId ?? null,
          },
        }),
      ),
    );
  }

  /**
   * 讀取單一 Stage 的模型 **key**（供 gpt-caller 既有 Azure key-bridge）。
   * 來源：StageModelAssignment（限已啟用 Azure 白名單模型）→ 舊 SystemConfig key → DEFAULT。
   * @remarks 非 Azure 指派**不**回其 key（gateway 尚未支援，Story 23.3）→ 走 Azure fallback，行為零變。
   */
  static async getStageModel(stage: ExtractionStage): Promise<string> {
    const assignment = await prisma.stageModelAssignment.findUnique({
      where: { stageKey: STAGE_KEYS[stage] },
      select: {
        llmModel: {
          select: {
            modelKey: true,
            isEnabled: true,
            provider: { select: { isEnabled: true, providerType: true } },
          },
        },
      },
    });
    const m = assignment?.llmModel;
    if (
      m?.isEnabled &&
      m.provider.isEnabled &&
      m.provider.providerType === 'AZURE_OPENAI' &&
      isValidLlmModel(m.modelKey)
    ) {
      return m.modelKey;
    }

    // 舊 SystemConfig key（CHANGE-099 遷移前 / 未播種環境）
    const cfg = await prisma.systemConfig.findUnique({
      where: { key: STAGE_KEYS[stage] },
      select: { value: true },
    });
    if (cfg?.value && isValidLlmModel(cfg.value)) return cfg.value;

    return DEFAULT_STAGE_MODELS[stage];
  }

  /**
   * Fallback：由舊 SystemConfig key（或 DEFAULT）反查預設 Azure provider 下對應 `LlmModel.id`。
   * 供 getStageModelSelection 在缺 assignment 時仍能顯示合理現值；查無回空字串（UI 顯示 placeholder）。
   */
  private static async resolveFallbackModelId(stage: ExtractionStage): Promise<string> {
    const cfg = await prisma.systemConfig.findUnique({
      where: { key: STAGE_KEYS[stage] },
      select: { value: true },
    });
    const key =
      cfg?.value && isValidLlmModel(cfg.value) ? cfg.value : DEFAULT_STAGE_MODELS[stage];
    const model = await prisma.llmModel.findFirst({
      where: {
        modelKey: key,
        isEnabled: true,
        provider: { isDefault: true, isEnabled: true, providerType: 'AZURE_OPENAI' },
      },
      select: { id: true },
    });
    return model?.id ?? '';
  }
}
