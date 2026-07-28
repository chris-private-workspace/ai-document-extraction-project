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
 *   **Story 23.3 P1（D9-a/D9-b）**：新增 `getRoutingThresholds(stage)`，解析 per-model →
 *   per-provider → null（全域預設）的信心度路由閾值 fallback 鏈，供 confidence 計算覆蓋硬編 90/70。
 *
 *   **Story 23.4（per-環節指派）**：指派範圍由 extraction stage1-3 擴大到
 *   {@link LLM_STAGES} 定義的**全部 9 個 LLM 呼叫環節**（`getStageAssignments` /
 *   `setStageAssignments`），並新增 `resolveModelIdForStage` 供 gateway 橋接直接取得
 *   `LlmModel.id` —— 低風險環節因此可真正跑在非 Azure provider 上，核心提取環節則
 *   維持 Azure 閘門（D6 + OQ-E）。
 *
 * @module src/services/llm-model-config
 * @since CHANGE-099 - LLM 模型選擇管理
 * @lastModified 2026-07-27
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
import {
  LLM_STAGES,
  LLM_STAGE_KEYS,
  getLlmStage,
  isLlmStageKey,
} from '@/lib/constants/llm-stages';
import { aiLogger } from '@/services/logging/logger.service';

/** 各 Stage 對應的 `StageModelAssignment.stageKey`（沿用 CHANGE-099 的 SystemConfig key，播種已對齊） */
const STAGE_KEYS: Record<ExtractionStage, string> = {
  stage1: LLM_STAGE_KEYS.EXTRACTION_STAGE_1,
  stage2: LLM_STAGE_KEYS.EXTRACTION_STAGE_2,
  stage3: LLM_STAGE_KEYS.EXTRACTION_STAGE_3,
};

/** Azure provider 型別（核心提取環節的閘門判準） */
const AZURE_PROVIDER_TYPE = 'AZURE_OPENAI';

/**
 * 全部環節的模型指派（Story 23.4）：`stageKey` → `LlmModel.id`（未指派/查無為空字串）。
 * @remarks 取代 Story 23.2 只涵蓋 stage1-3 的 `StageModelSelection`。
 */
export type StageAssignments = Record<string, string>;

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
 * per-model 信心度路由閾值（Story 23.3 P1 / D9-a 方案 A）。
 *
 * @description 覆蓋 `ROUTING_THRESHOLDS_V3_1` 的 AUTO_APPROVE / QUICK_REVIEW 下界。
 *   換 provider/model 後模型自評習性改變，需 per-model 重新校準（tech-spec §6.1）。
 */
export interface RoutingThresholdsOverride {
  /** AUTO_APPROVE 下界（分數 ≥ 此值即自動批准） */
  autoApprove: number;
  /** QUICK_REVIEW 下界（分數 ≥ 此值即快速審核） */
  quickReview: number;
}

/**
 * 解析 DB Json 欄位為路由閾值；格式不合即回 null（由呼叫端落下一層 fallback）。
 *
 * @param raw - `LlmModel.routingThresholds` 或 `LlmProvider.extraConfig.routingThresholds`
 * @returns 合法閾值，或 null（缺值 / 格式錯 / 值域不合理）
 */
function parseRoutingThresholds(raw: unknown): RoutingThresholdsOverride | null {
  if (!raw || typeof raw !== 'object') return null;

  const { autoApprove, quickReview } = raw as Record<string, unknown>;
  if (typeof autoApprove !== 'number' || typeof quickReview !== 'number') return null;
  if (!Number.isFinite(autoApprove) || !Number.isFinite(quickReview)) return null;
  // 值域：0 ≤ quickReview ≤ autoApprove ≤ 100（倒置或超界視為設定錯誤）
  if (quickReview < 0 || autoApprove > 100 || quickReview > autoApprove) return null;

  return { autoApprove, quickReview };
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
   * 讀取**全部環節**的模型指派（value = `LlmModel.id`；Story 23.4）。
   *
   * @description
   *   缺 assignment 時逐層 fallback：舊 SystemConfig key（CHANGE-099 遷移前環境）→
   *   環節的 `defaultModelKey` → 預設 Azure provider 下對應的 `LlmModel.id`；
   *   全部查無回空字串（UI 顯示 placeholder）。
   *
   *   刻意用 3 次批次查詢（assignment / legacy config / fallback 模型）而非逐環節查，
   *   避免環節數成長後變成 N+1。
   *
   * @returns `stageKey` → `LlmModel.id` 的對照（涵蓋 {@link LLM_STAGES} 全部環節）
   */
  static async getStageAssignments(): Promise<StageAssignments> {
    const stageKeys = LLM_STAGES.map((s) => s.key);

    const [assignments, legacyConfigs] = await Promise.all([
      prisma.stageModelAssignment.findMany({
        where: { stageKey: { in: stageKeys } },
        select: { stageKey: true, llmModelId: true },
      }),
      // 舊 SystemConfig key 與 stageKey 同字串（僅 extraction stage1-3 會有值）
      prisma.systemConfig.findMany({
        where: { key: { in: stageKeys } },
        select: { key: true, value: true },
      }),
    ]);

    const idByStageKey = new Map(assignments.map((r) => [r.stageKey, r.llmModelId]));
    const legacyByStageKey = new Map(legacyConfigs.map((r) => [r.key, r.value]));

    /** 該環節在缺 assignment 時應回退到哪個白名單 modelKey */
    const fallbackModelKey = (stage: (typeof LLM_STAGES)[number]): string => {
      const legacy = legacyByStageKey.get(stage.key);
      return legacy && isValidLlmModel(legacy) ? legacy : stage.defaultModelKey;
    };

    const neededKeys = [...new Set(LLM_STAGES.map(fallbackModelKey))];
    const fallbackModels = await prisma.llmModel.findMany({
      where: {
        modelKey: { in: neededKeys },
        isEnabled: true,
        provider: { isDefault: true, isEnabled: true, providerType: AZURE_PROVIDER_TYPE },
      },
      select: { id: true, modelKey: true },
    });
    const idByModelKey = new Map(fallbackModels.map((m) => [m.modelKey, m.id]));

    const result: StageAssignments = {};
    for (const stage of LLM_STAGES) {
      result[stage.key] =
        idByStageKey.get(stage.key) ?? idByModelKey.get(fallbackModelKey(stage)) ?? '';
    }
    return result;
  }

  /**
   * 設定環節模型指派（id-based，upsert `StageModelAssignment`；Story 23.4）。
   *
   * @description
   *   任一 id 非「已啟用 provider 的已啟用模型」即**整批拒絕**（單一交易）。
   *   未知的 `stageKey` 直接忽略，不讓前端寫入未定義環節。
   *
   *   ⚠️ 這裡**不**擋「核心提取環節 × 非 Azure 模型」——指派會存下來，但執行期由
   *   {@link resolveModelIdForStage} 強制回退 Azure，後台 UI 同步顯示準確率回歸警示。
   *   如此管理員可先完成指派、待準確率回歸通過後再放行，而非設定被靜默丟棄。
   *
   * @param assignments `stageKey` → `LlmModel.id`
   * @param userId 異動者（寫入 `updatedBy`）
   */
  static async setStageAssignments(
    assignments: StageAssignments,
    userId?: string,
  ): Promise<void> {
    const entries = Object.entries(assignments).filter(([key]) => isLlmStageKey(key));
    if (entries.length === 0) return;

    const ids = [...new Set(entries.map(([, id]) => id))];
    const rows = await prisma.llmModel.findMany({
      where: { id: { in: ids }, isEnabled: true, provider: { isEnabled: true } },
      select: { id: true },
    });
    const validIds = new Set(rows.map((r) => r.id));
    for (const [stageKey, id] of entries) {
      if (!validIds.has(id)) {
        throw new Error(`無效或已停用的模型: ${id}（環節=${stageKey}）`);
      }
    }

    await prisma.$transaction(
      entries.map(([stageKey, id]) =>
        prisma.stageModelAssignment.upsert({
          where: { stageKey },
          update: { llmModelId: id, updatedBy: userId ?? null },
          create: { stageKey, llmModelId: id, updatedBy: userId ?? null },
        }),
      ),
    );
  }

  /**
   * 解析某環節實際該用的 `LlmModel.id`（Story 23.4：供 gateway 橋接的 per-環節路由）。
   *
   * @description
   *   回 `null` 的情況一律代表「呼叫端應回退自己的 Azure 預設」，涵蓋：
   *     - 未定義的環節鍵值 / 尚未指派
   *     - 指派的模型或其 provider 已停用
   *     - **核心提取環節指派了非 Azure 模型**（D6 + OQ-E 閘門）——設定保留但不生效，
   *       須先通過準確率回歸與 per-model 信心度校準（tech-spec §6.1/§6.2）
   *
   *   與 {@link getStageModel} 的差別：後者回 **modelKey** 供 gpt-caller 既有的 Azure
   *   key-bridge（stage1-3 專用）；本方法回 **id**，讓 gateway 直接解析 provider + 憑證，
   *   因此低風險環節可真正跑在非 Azure provider 上。
   *
   * @param stageKey 環節鍵值
   * @returns `LlmModel.id`；`null` 表示應回退呼叫端預設
   */
  static async resolveModelIdForStage(stageKey: string): Promise<string | null> {
    const stage = getLlmStage(stageKey);
    if (!stage) return null;

    const assignment = await prisma.stageModelAssignment.findUnique({
      where: { stageKey },
      select: {
        llmModel: {
          select: {
            id: true,
            isEnabled: true,
            provider: { select: { isEnabled: true, providerType: true } },
          },
        },
      },
    });

    const model = assignment?.llmModel;
    if (!model?.isEnabled || !model.provider.isEnabled) return null;

    // 核心提取環節的 Azure 閘門（D6 + OQ-E 決議）
    if (stage.isCore && model.provider.providerType !== AZURE_PROVIDER_TYPE) {
      return null;
    }

    return model.id;
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
   * 讀取某 Stage 實際指派模型的 per-model 路由閾值（Story 23.3 P1 / D9-b fallback 鏈）。
   *
   * @description
   *   fallback 鏈：
   *     1. `LlmModel.routingThresholds`（per-model，主粒度）
   *     2. `LlmProvider.extraConfig.routingThresholds`（per-provider，同 provider 共用）
   *     3. **回 null** → 呼叫端不覆蓋 → `ConfidenceV3_1Service` 用全域 `ROUTING_THRESHOLDS_V3_1`
   *        （90/70），即**未校準時行為零變**。
   *
   *   第 3 層刻意回 null 而非回全域值，讓「全域預設」的唯一來源留在 confidence service
   *   （本服務不反向依賴 extraction 層）。
   *
   * @param stage - extraction 階段（校準對象通常是 stage3 核心提取）
   * @returns 該模型的閾值覆蓋，或 null（未校準 / 未指派 / 已停用 / 設定格式不合法）
   */
  static async getRoutingThresholds(
    stage: ExtractionStage,
  ): Promise<RoutingThresholdsOverride | null> {
    const assignment = await prisma.stageModelAssignment.findUnique({
      where: { stageKey: STAGE_KEYS[stage] },
      select: {
        llmModel: {
          select: {
            id: true,
            routingThresholds: true,
            isEnabled: true,
            provider: { select: { id: true, isEnabled: true, extraConfig: true } },
          },
        },
      },
    });

    const model = assignment?.llmModel;
    if (!model?.isEnabled || !model.provider.isEnabled) return null;

    // 第 1 層：per-model
    const perModel = parseRoutingThresholds(model.routingThresholds);
    if (perModel) return perModel;
    if (model.routingThresholds != null) {
      void aiLogger
        .warn(`忽略格式不合法的 per-model routingThresholds（LlmModel ${model.id}）`, {
          details: { stage, llmModelId: model.id, raw: model.routingThresholds },
          methodName: 'getRoutingThresholds',
        })
        .catch(() => undefined);
    }

    // 第 2 層：per-provider
    const extraConfig = model.provider.extraConfig;
    const rawProvider =
      extraConfig && typeof extraConfig === 'object'
        ? (extraConfig as Record<string, unknown>).routingThresholds
        : undefined;
    const perProvider = parseRoutingThresholds(rawProvider);
    if (perProvider) return perProvider;
    if (rawProvider != null) {
      void aiLogger
        .warn(
          `忽略格式不合法的 per-provider routingThresholds（LlmProvider ${model.provider.id}）`,
          {
            details: { stage, llmProviderId: model.provider.id, raw: rawProvider },
            methodName: 'getRoutingThresholds',
          },
        )
        .catch(() => undefined);
    }

    // 第 3 層：交由 confidence service 的全域預設
    return null;
  }

}
