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
    // CHANGE-100: 部署名 = 模型名（gpt-5.4-mini），共用現有 endpoint + API key
    // CHANGE-102: 舊 gpt-5.2 已移除（Azure deployment 不復存在、UI 誤導）；此為高精度主力
    key: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini（中階・平衡）',
    deploymentEnvVar: 'AZURE_OPENAI_GPT54_MINI_DEPLOYMENT_NAME',
    defaultDeploymentName: 'gpt-5.4-mini',
    capability: {
      maxTokens: 8192,
      supportsTemperature: true,
      temperature: 0.1,
      defaultImageDetail: 'auto',
      supportsJsonSchema: true,
    },
  },
  {
    // CHANGE-100: 部署名 = 模型名（gpt-5.4-nano），共用現有 endpoint + API key；能力對標 gpt-5-nano
    key: 'gpt-5.4-nano',
    label: 'GPT-5.4 Nano（快速・低成本）',
    deploymentEnvVar: 'AZURE_OPENAI_GPT54_NANO_DEPLOYMENT_NAME',
    defaultDeploymentName: 'gpt-5.4-nano',
    capability: {
      maxTokens: 4096,
      supportsTemperature: false,
      defaultImageDetail: 'low',
      supportsJsonSchema: false,
    },
  },
];

/** 各 Stage 的預設模型 key（配置缺失/無效時的向後相容 fallback） */
export const DEFAULT_STAGE_MODELS: Record<ExtractionStage, string> = {
  // CHANGE-102: 正名至 5.4（對應現有實際 deployment，行為零變）
  stage1: 'gpt-5.4-mini',
  stage2: 'gpt-5.4-nano',
  stage3: 'gpt-5.4-mini',
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
