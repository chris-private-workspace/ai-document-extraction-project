/**
 * @fileoverview LLM 模型白名單與能力定義（CHANGE-099）
 * @description
 *   定義 extraction Stage 1-3 可選用的 Azure OpenAI 模型清單、各模型能力
 *   （maxTokens / 是否支援 temperature / 圖片解析度 / 是否支援 json_schema），
 *   以及各 Stage 的預設模型。供 gpt-caller 依模型能力組請求、供後台管理頁下拉。
 *
 *   ⚠️ capability 數值刻意與 gpt-caller 原本硬編的 MODEL_CONFIG 完全一致，
 *   確保未設定配置時行為與變更前無差異（向後相容）。
 *
 * @module src/lib/constants/llm-models
 * @since CHANGE-099 - LLM 模型選擇管理
 * @lastModified 2026-07-09
 */

/** 圖片解析度模式 */
export type ImageDetailMode = 'auto' | 'low' | 'high';

/** 文件處理階段 */
export type ExtractionStage = 'stage1' | 'stage2' | 'stage3';

/** 單一模型的能力描述 */
export interface LlmModelCapability {
  /** 最大輸出 token（對應 API 的 max_completion_tokens） */
  maxTokens: number;
  /** 是否支援自定義 temperature（如 gpt-5-nano 不支援，只能用預設值） */
  supportsTemperature: boolean;
  /** 支援時採用的 temperature 值 */
  temperature?: number;
  /** 預設圖片解析度 */
  defaultImageDetail: ImageDetailMode;
  /** 是否支援 json_schema structured output（Stage 3 提取用） */
  supportsJsonSchema: boolean;
}

/** 白名單中的一個可選模型 */
export interface LlmModelOption {
  /** 內部模型識別符（傳給 gpt-caller / 存入配置） */
  key: string;
  /** 顯示名稱（管理頁下拉顯示） */
  label: string;
  /** 對應 Azure 部署名稱的環境變數名 */
  deploymentEnvVar: string;
  /** 環境變數未設時的預設部署名稱 */
  defaultDeploymentName: string;
  /** 模型能力 */
  capability: LlmModelCapability;
}

/**
 * 可選 LLM 模型白名單。
 * ⚠️ 新增模型時在此加一筆（含正確 capability + 對應 Azure 部署 env）；
 *    管理頁下拉與 gpt-caller 會自動反映，無需改其他程式碼。
 */
export const AVAILABLE_LLM_MODELS: LlmModelOption[] = [
  {
    // CHANGE-115: 全面切換至 gpt-5.6-luna。
    //
    //   capability 全部經**實機探測**確認（2026-08-02，對 deployment `gpt-5.6-luna`
    //   實呼叫 Azure，非查文件推測）：
    //     - vision（圖片輸入）  → 支援（提取管線全靠它，必要條件）
    //     - json_schema        → 支援（Stage 3 structured output 的必要條件）
    //     - temperature        → **不支援**，送任何非預設值回 400
    //       `Unsupported value: 'temperature' does not support 0.1 with this model.`
    //     - max_completion_tokens 上限 → 128000（此處仍設 8192，見下）
    //
    //   maxTokens 沿用舊 mini 的 8192 而非拉到 128000：輸出上限不影響品質，
    //   放大只在異常情況多燒 token。需要更長輸出時再單獨調整。
    key: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna（單一主力）',
    deploymentEnvVar: 'AZURE_OPENAI_LUNA_DEPLOYMENT_NAME',
    defaultDeploymentName: 'gpt-5.6-luna',
    capability: {
      maxTokens: 8192,
      supportsTemperature: false,
      defaultImageDetail: 'auto',
      supportsJsonSchema: true,
    },
  },
];

/**
 * 各 Stage 的預設模型 key（配置缺失/無效時的向後相容 fallback）
 *
 * CHANGE-115: 三個 Stage 統一指向 gpt-5.6-luna。
 *
 *   圖片解析度**不受本次切換影響** —— 三個 Stage 都顯式傳入 `imageDetailMode`
 *   （`stage-1-company.service.ts:856` 與 `stage-2-format.service.ts:715` 為 `'low'`，
 *   Stage 3 為 `'auto'`），而 gpt-caller 取值是 `input.imageDetailMode ||
 *   capability.defaultImageDetail`（呼叫端優先）。下方的 `defaultImageDetail`
 *   只對「未指定 detail 的呼叫端」生效。
 */
export const DEFAULT_STAGE_MODELS: Record<ExtractionStage, string> = {
  stage1: 'gpt-5.6-luna',
  stage2: 'gpt-5.6-luna',
  stage3: 'gpt-5.6-luna',
};

/** 依 key 取得模型選項（找不到回 undefined） */
export function getLlmModelOption(key: string): LlmModelOption | undefined {
  return AVAILABLE_LLM_MODELS.find((m) => m.key === key);
}

/** 判斷 key 是否為白名單內的有效模型 */
export function isValidLlmModel(key: string): boolean {
  return AVAILABLE_LLM_MODELS.some((m) => m.key === key);
}

/** 解析模型的實際 Azure 部署名稱（env 覆蓋 → 預設部署名） */
export function resolveDeploymentName(option: LlmModelOption): string {
  return process.env[option.deploymentEnvVar] || option.defaultDeploymentName;
}

/**
 * 依模型 key 解析實際 Azure 部署名稱（FIX-137）。
 *
 * @description
 *   供白名單**之外**的直接呼叫端（gpt-vision / term-classification / ai-term-validator /
 *   gpt-mini-extractor / unified-gpt-extraction）取得預設部署名，取代各自硬編的舊模型名。
 *   這些服務原本各自讀散落的 `AZURE_OPENAI_DEPLOYMENT*` 並 fallback 到 CHANGE-102 已移除的
 *   `gpt-5.2` / `gpt-5-nano`，env 未設即 404 DeploymentNotFound。
 *
 *   白名單外的 key 原樣回傳——呼叫端顯式指定的部署名不受此函數干擾。
 */
export function resolveDeploymentNameByKey(key: string): string {
  const option = getLlmModelOption(key);
  return option ? resolveDeploymentName(option) : key;
}
