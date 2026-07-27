/**
 * @fileoverview LLM 處理環節目錄（Epic 23 - Story 23.4 per-環節指派）
 * @description
 *   把「系統有哪些 LLM 呼叫環節」集中在此，作為服務層 / API / 後台 UI / i18n 的**單一真實來源**。
 *   每個環節對應一筆 `StageModelAssignment`（以 `key` 為 `stageKey`）。
 *
 *   **核心提取 vs 低風險（`isCore`）** —— 依 tech-spec D6（2026-07-09 用戶 approve a+b）
 *   與 OQ-E 降級決議（2026-07-27）：
 *     - `isCore: true`（產出發票欄位值的環節）：指派非 Azure 模型時
 *       {@link LlmModelConfigService.resolveModelIdForStage} 回 `null` → **強制回退**各呼叫點的
 *       Azure 預設；後台 UI 同步顯示準確率回歸警示。切非 Azure 前須通過準確率回歸 +
 *       per-model 信心度校準（tech-spec §6.1 / §6.2）。
 *     - `isCore: false`（分類 / 驗證等低風險環節）：可直接指派非 Azure 模型。
 *       實際出境仍受 gateway 的 `allowSensitiveData` 護欄擋著（CHANGE-111 / D4）。
 *
 *   ⚠️ 新增 LLM 呼叫環節時在此加一筆，並同步 3 語言的
 *   `systemSettings.modelSettings.stages.<i18nKey>` / `<i18nKey>Description`。
 *
 * @module src/lib/constants/llm-stages
 * @since Epic 23 - Story 23.4
 * @lastModified 2026-07-27
 *
 * @related
 *   - prisma/schema.prisma - StageModelAssignment.stageKey
 *   - src/services/llm-model-config.service.ts - 讀寫指派 + Azure 閘門
 *   - src/services/llm/gateway-bridge.ts - 呼叫端依 stageKey 解析模型
 */

import { DEFAULT_STAGE_MODELS } from './llm-models';

/**
 * 環節鍵值（＝ `StageModelAssignment.stageKey`）。
 * extraction stage1-3 沿用 CHANGE-099 的既有字串（播種與舊 SystemConfig key 已對齊，**不可改**）。
 */
export const LLM_STAGE_KEYS = {
  EXTRACTION_STAGE_1: 'extraction.model.stage1',
  EXTRACTION_STAGE_2: 'extraction.model.stage2',
  EXTRACTION_STAGE_3: 'extraction.model.stage3',
  VISION_EXTRACTION: 'vision.extraction',
  VISION_CLASSIFICATION: 'vision.classification',
  TERM_CLASSIFICATION: 'term.classification',
  TERM_VALIDATION: 'term.validation',
  EXTRACTION_V2_MINI: 'extraction.v2.mini',
  EXTRACTION_V3_UNIFIED: 'extraction.v3.unified',
} as const;

/** 合法的環節鍵值 */
export type LlmStageKey = (typeof LLM_STAGE_KEYS)[keyof typeof LLM_STAGE_KEYS];

/** 單一環節的定義 */
export interface LlmStageDefinition {
  /** `StageModelAssignment.stageKey` */
  key: LlmStageKey;
  /** i18n 後綴：`systemSettings.modelSettings.stages.<i18nKey>` 與 `<i18nKey>Description` */
  i18nKey: string;
  /** 核心提取環節（見檔頭）：非 Azure 指派會被強制回退，UI 顯示準確率回歸警示 */
  isCore: boolean;
  /**
   * 指派是否**只有經 gateway 才生效**。
   *
   * @description
   *   - `false`（extraction stage1-3）：指派經 `getStageModel` 的 modelKey key-bridge 生效，
   *     **與 `FEATURE_LLM_GATEWAY_ENABLED` 無關**（CHANGE-099 起即如此）。
   *   - `true`（Story 23.4 Phase 1 遷移的 6 個呼叫點）：指派只在 `callGatewayByModelKey`
   *     內解析，而該函數第一件事就是檢查 gateway 主開關 → **主開關關閉時指派完全不生效**。
   *
   *   後台 UI 依此在主開關關閉時對受影響的環節顯示提示，避免管理員誤以為設定已生效。
   */
  requiresGateway: boolean;
  /** 未指派 / 指派失效時的白名單 fallback ——＝各呼叫點遷移前的現行模型（行為零變基準） */
  defaultModelKey: string;
}

/**
 * 全部 LLM 呼叫環節（順序即後台 UI 顯示順序：核心提取在前）。
 *
 * @remarks
 *   `defaultModelKey` 刻意等同各呼叫點在 FIX-137 後的現行模型，確保「未指派」時
 *   與遷移前完全一致。
 */
export const LLM_STAGES: readonly LlmStageDefinition[] = [
  {
    key: LLM_STAGE_KEYS.EXTRACTION_STAGE_1,
    i18nKey: 'stage1',
    isCore: true,
    requiresGateway: false,
    defaultModelKey: DEFAULT_STAGE_MODELS.stage1,
  },
  {
    key: LLM_STAGE_KEYS.EXTRACTION_STAGE_2,
    i18nKey: 'stage2',
    isCore: true,
    requiresGateway: false,
    defaultModelKey: DEFAULT_STAGE_MODELS.stage2,
  },
  {
    key: LLM_STAGE_KEYS.EXTRACTION_STAGE_3,
    i18nKey: 'stage3',
    isCore: true,
    requiresGateway: false,
    defaultModelKey: DEFAULT_STAGE_MODELS.stage3,
  },
  {
    key: LLM_STAGE_KEYS.VISION_EXTRACTION,
    i18nKey: 'visionExtraction',
    isCore: true,
    requiresGateway: true,
    defaultModelKey: 'gpt-5.4-mini',
  },
  {
    key: LLM_STAGE_KEYS.EXTRACTION_V3_UNIFIED,
    i18nKey: 'unifiedExtraction',
    isCore: true,
    requiresGateway: true,
    defaultModelKey: 'gpt-5.4-mini',
  },
  {
    key: LLM_STAGE_KEYS.EXTRACTION_V2_MINI,
    i18nKey: 'miniExtractor',
    isCore: true,
    requiresGateway: true,
    defaultModelKey: 'gpt-5.4-nano',
  },
  {
    key: LLM_STAGE_KEYS.VISION_CLASSIFICATION,
    i18nKey: 'visionClassification',
    isCore: false,
    requiresGateway: true,
    defaultModelKey: 'gpt-5.4-mini',
  },
  {
    key: LLM_STAGE_KEYS.TERM_CLASSIFICATION,
    i18nKey: 'termClassification',
    isCore: false,
    requiresGateway: true,
    defaultModelKey: 'gpt-5.4-mini',
  },
  {
    key: LLM_STAGE_KEYS.TERM_VALIDATION,
    i18nKey: 'termValidation',
    isCore: false,
    requiresGateway: true,
    defaultModelKey: 'gpt-5.4-mini',
  },
];

/** 依鍵值取得環節定義（未知鍵回 undefined） */
export function getLlmStage(key: string): LlmStageDefinition | undefined {
  return LLM_STAGES.find((s) => s.key === key);
}

/** 判斷是否為已定義的環節鍵值 */
export function isLlmStageKey(key: string): key is LlmStageKey {
  return LLM_STAGES.some((s) => s.key === key);
}
