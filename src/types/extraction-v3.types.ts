/**
 * @fileoverview Extraction V3/V3.1 類型定義 - 純 GPT Vision 架構
 * @description
 *   定義 Extraction V3 和 V3.1 統一提取服務的所有類型：
 *   - V3: 7 步處理管線類型（FILE_PREPARATION → ROUTING_DECISION）
 *   - V3.1: 三階段分離架構（CHANGE-024）
 *   - 統一 GPT 提取結果類型
 *   - 動態 Prompt 組裝配置
 *   - 信心度計算（V3: 5 維度 / V3.1: 5 維度基於三階段）
 *   - Feature Flags 和配置類型
 *
 * @module src/types/extraction-v3.types
 * @since CHANGE-021 - Unified Processor V3 Refactoring
 * @lastModified 2026-02-01
 *
 * @features
 *   - ProcessingStepV3: V3 7 步處理管線枚舉
 *   - ProcessingStepV3_1: V3.1 三階段分離處理管線枚舉 (CHANGE-024)
 *   - Stage1/2/3 Result Types: 三階段結果類型 (CHANGE-024)
 *   - UnifiedExtractionResult: GPT Vision 統一提取結果
 *   - DynamicPromptConfig: 動態 Prompt 組裝配置
 *   - ConfidenceWeightsV3_1: V3.1 基於三階段的信心度權重 (CHANGE-024)
 *   - ExtractionV3Flags: V3 Feature Flags
 *
 * @related
 *   - src/services/extraction-v3/ - V3 提取服務
 *   - src/services/extraction-v3/stages/ - V3.1 三階段服務 (CHANGE-024)
 *   - src/constants/processing-steps-v3.ts - V3 步驟常數
 *   - src/types/unified-processor.ts - V2 類型（向下兼容）
 */

import type { ConfidenceLevelEnum } from './confidence';
import { RoutingDecision } from './confidence';
import { UnifiedRoutingDecision, UnifiedFileType } from './unified-processor';

// Re-export for convenience
export { UnifiedFileType, UnifiedRoutingDecision, RoutingDecision };
export type { ConfidenceLevelEnum };

// ============================================================================
// V3 Processing Step Enum (7 步處理管線)
// ============================================================================

/**
 * V3 處理步驟枚舉
 * @description 定義 V3 統一處理器的 7 個處理步驟（從 V2 的 11 步簡化）
 * @since CHANGE-021
 */
export enum ProcessingStepV3 {
  /** 步驟 1: 文件準備（類型檢測 + PDF 轉換 + Base64 編碼） */
  FILE_PREPARATION = 'FILE_PREPARATION',
  /** 步驟 2: 動態 Prompt 組裝（公司識別規則 + 格式識別規則 + 欄位定義 + 術語映射） */
  DYNAMIC_PROMPT_ASSEMBLY = 'DYNAMIC_PROMPT_ASSEMBLY',
  /** 步驟 3: 統一 GPT 提取（單次 GPT-5.2 Vision 調用完成所有提取） */
  UNIFIED_GPT_EXTRACTION = 'UNIFIED_GPT_EXTRACTION',
  /** 步驟 4: 結果驗證（JSON Schema 驗證 + 公司/格式 ID 解析） */
  RESULT_VALIDATION = 'RESULT_VALIDATION',
  /** 步驟 5: 術語記錄（記錄新發現的術語） */
  TERM_RECORDING = 'TERM_RECORDING',
  /** 步驟 6: 信心度計算（簡化版 5 維度） */
  CONFIDENCE_CALCULATION = 'CONFIDENCE_CALCULATION',
  /** 步驟 7: 路由決策（AUTO_APPROVE / QUICK_REVIEW / FULL_REVIEW） */
  ROUTING_DECISION = 'ROUTING_DECISION',
}

/**
 * V3 步驟優先級
 * @description 區分必要步驟和可選步驟的錯誤處理行為
 * @since CHANGE-021
 */
export enum StepPriorityV3 {
  /** 必要步驟 - 失敗則中斷整個處理流程 */
  REQUIRED = 'REQUIRED',
  /** 可選步驟 - 失敗則記錄警告並繼續 */
  OPTIONAL = 'OPTIONAL',
}

// ============================================================================
// Field Value Types
// ============================================================================

/**
 * 欄位值結構
 * @description 單一欄位的提取結果
 * @since CHANGE-021
 */
export interface FieldValue {
  /** 欄位值（可為字串、數字或 null） */
  value: string | number | null;
  /** 信心度 (0-100) */
  confidence: number;
  /** 在文件中的位置描述（可選） */
  source?: string;
}

/**
 * 欄位定義
 * @description 用於 Prompt 組裝的欄位規範
 * @since CHANGE-021
 */
export interface FieldDefinition {
  /** 欄位鍵名 */
  key: string;
  /** 顯示名稱 */
  displayName: string;
  /** 資料類型 */
  type: 'string' | 'number' | 'date' | 'currency';
  /** 是否必填 */
  required: boolean;
  /** 驗證規則（可選） */
  validation?: {
    pattern?: string;
    min?: number;
    max?: number;
  };
  /** 提取提示（提供給 GPT） */
  extractionHints?: string[];
}

// ============================================================================
// CHANGE-042: Field Definition Entry (DB JSON Structure)
// ============================================================================

/**
 * 欄位類型：標準欄位 vs Line Item 費用欄位
 * @since CHANGE-045
 */
export type FieldDefinitionFieldType = 'standard' | 'lineItem';

/**
 * 欄位定義條目（存儲在 FieldDefinitionSet.fields JSON 中）
 * @description 定義 AI 應該提取的欄位規範，支援動態欄位集
 * @since CHANGE-042
 */
export interface FieldDefinitionEntry {
  /** 欄位鍵名（snake_case，如 "sea_freight"） */
  key: string;
  /** 顯示標籤（如 "Sea Freight"） */
  label: string;
  /** 欄位分類（如 "basic", "charges", "shipping"） */
  category: string;
  /** 資料類型 */
  dataType: 'string' | 'number' | 'date' | 'currency';
  /** 是否必填 */
  required: boolean;
  /** 欄位描述 */
  description?: string;
  /** 額外別名（補充 invoice-fields.ts 中的 aliases） */
  aliases?: string[];
  /** 提取提示（給 AI 的指引） */
  extractionHints?: string;
  /** 欄位類型：standard（預設）或 lineItem（Line Item 費用欄位） @since CHANGE-045 */
  fieldType?: FieldDefinitionFieldType;
}

// ============================================================================
// CHANGE-042: Extracted Fields V4 (Dynamic Field Structure)
// ============================================================================

/**
 * V4 動態欄位提取結果
 * @description 完全動態的欄位結構，取代固定的 StandardFieldsV3
 * @since CHANGE-042
 */
export interface ExtractedFieldsV4 {
  /** 所有欄位統一為 key-value 結構 */
  fields: Record<string, FieldValue>;
  /** lineItems 保留原始結構 */
  lineItems: LineItemV3[];
  /** extraCharges 保留原始結構 */
  extraCharges?: ExtraChargeV3[];
  /** 後設數據 */
  meta: {
    /** 使用的 FieldDefinitionSet ID */
    fieldDefinitionSetId?: string;
    /** 提取版本 */
    extractionVersion: string;
    /** 整體信心度 (0-100) */
    overallConfidence: number;
    /** 提取的欄位總數 */
    fieldCount: number;
    /** 值為 null 的欄位數 */
    nullCount: number;
  };
}

/**
 * FieldDefinitionEntry 轉換為 FieldDefinition 的工具函數
 * @description 將 DB 中存儲的 FieldDefinitionEntry 轉換為 Prompt 組裝使用的 FieldDefinition
 * @since CHANGE-042
 */
export function toFieldDefinition(entry: FieldDefinitionEntry): FieldDefinition {
  return {
    key: entry.key,
    displayName: entry.label,
    type: entry.dataType,
    required: entry.required,
    extractionHints: entry.extractionHints ? [entry.extractionHints] : undefined,
  };
}

// ============================================================================
// Unified Extraction Result Types
// ============================================================================

/**
 * 發行方識別結果
 * @description GPT Vision 識別的發行方信息
 * @since CHANGE-021
 */
export interface IssuerIdentificationResultV3 {
  /** 公司名稱 */
  companyName: string;
  /** 公司 ID（如果匹配到已知公司） */
  companyId?: string;
  /** 識別方法 */
  identificationMethod: 'LOGO' | 'HEADER' | 'ADDRESS' | 'TAX_ID' | 'UNKNOWN';
  /** 信心度 (0-100) */
  confidence: number;
  /** 是否為新公司 */
  isNewCompany: boolean;
}

/**
 * 格式識別結果
 * @description GPT Vision 識別的文件格式信息
 * @since CHANGE-021
 */
export interface FormatIdentificationResultV3 {
  /** 格式名稱 */
  formatName: string;
  /** 格式 ID（如果匹配到已知格式） */
  formatId?: string;
  /** 信心度 (0-100) */
  confidence: number;
  /** 是否為新格式 */
  isNewFormat: boolean;
}

/**
 * 標準欄位集合（8 個核心欄位）
 * @since CHANGE-021
 */
export interface StandardFieldsV3 {
  /** 發票編號 */
  invoiceNumber: FieldValue;
  /** 發票日期 */
  invoiceDate: FieldValue;
  /** 到期日（可選） */
  dueDate?: FieldValue;
  /** 供應商名稱 */
  vendorName: FieldValue;
  /** 客戶名稱（可選） */
  customerName?: FieldValue;
  /** 總金額 */
  totalAmount: FieldValue;
  /** 小計（可選） */
  subtotal?: FieldValue;
  /** 幣別 */
  currency: FieldValue;
}

/**
 * 行項目
 * @description 含術語預分類的行項目
 * @since CHANGE-021
 */
export interface LineItemV3 {
  /** 描述 */
  description: string;
  /** 術語分類結果（已分類的標準術語） */
  classifiedAs?: string;
  /** 數量（可選） */
  quantity?: number;
  /** 單價（可選） */
  unitPrice?: number;
  /** 金額 */
  amount: number;
  /** 信心度 (0-100) */
  confidence: number;
  /** 是否需要人工分類 */
  needsClassification?: boolean;
}

/**
 * 額外費用項目
 * @description 含術語預分類的額外費用
 * @since CHANGE-021
 * @deprecated CHANGE-045: extraCharges removed from Stage 3 output.
 *   Data is now fully covered by lineItems and fields.
 *   Kept for backward compatibility with existing data.
 */
export interface ExtraChargeV3 {
  /** 描述 */
  description: string;
  /** 術語分類結果 */
  classifiedAs?: string;
  /** 金額 */
  amount: number;
  /** 幣別（可選） */
  currency?: string;
  /** 信心度 (0-100) */
  confidence: number;
  /** 是否需要人工分類 */
  needsClassification?: boolean;
}

/**
 * 處理元數據
 * @since CHANGE-021
 */
export interface ExtractionMetadataV3 {
  /** 使用的模型 */
  modelUsed: string;
  /** 處理時間（毫秒） */
  processingTimeMs: number;
  /** Token 消耗 */
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };
  /** 頁數 */
  pageCount: number;
  /** 警告訊息（可選） */
  warnings?: string[];
}

/**
 * GPT-5.2 Vision 統一提取結果
 * @description 單次 GPT 調用的完整輸出結構
 * @since CHANGE-021
 */
export interface UnifiedExtractionResult {
  /** 發行方識別結果 */
  issuerIdentification: IssuerIdentificationResultV3;
  /** 格式識別結果 */
  formatIdentification: FormatIdentificationResultV3;
  /** 標準欄位 (8 個核心欄位) */
  standardFields: StandardFieldsV3;
  /** 自定義欄位（公司/格式特定） */
  customFields?: Record<string, FieldValue>;
  /** FIX-045: Stage 3 原始欄位 Record（保留 FieldDefinitionSet key） */
  fields?: Record<string, FieldValue>;
  /** 行項目（含術語預分類） */
  lineItems: LineItemV3[];
  /** 額外費用（含術語預分類） */
  extraCharges?: ExtraChargeV3[];
  /** 整體信心度（GPT 自評，0-100） */
  overallConfidence: number;
  /** 處理元數據 */
  metadata: ExtractionMetadataV3;
}

// ============================================================================
// Validated Extraction Result
// ============================================================================

/**
 * 驗證結果詳情
 * @since CHANGE-021
 */
export interface ValidationResultV3 {
  /** 是否有效 */
  isValid: boolean;
  /** 錯誤列表 */
  errors: string[];
  /** 警告列表 */
  warnings: string[];
  /** 缺失的必填欄位 */
  missingRequiredFields: string[];
}

/**
 * JIT 創建標記
 * @since CHANGE-021
 */
export interface JitCreatedV3 {
  /** 是否 JIT 創建了公司 */
  company?: boolean;
  /** 是否 JIT 創建了格式 */
  format?: boolean;
}

/**
 * 驗證後的提取結果
 * @description 經過 RESULT_VALIDATION 步驟後的完整結果
 * @since CHANGE-021
 */
export interface ValidatedExtractionResult extends UnifiedExtractionResult {
  /** 解析後的公司 ID（資料庫 Company ID） */
  resolvedCompanyId: string;
  /** 解析後的格式 ID（資料庫 DocumentFormat ID，可選） */
  resolvedFormatId?: string;
  /** 驗證結果 */
  validation: ValidationResultV3;
  /** JIT 創建標記 */
  jitCreated?: JitCreatedV3;
}

// ============================================================================
// Dynamic Prompt Config Types
// ============================================================================

/**
 * 已知公司信息（用於 Prompt 組裝）
 * @since CHANGE-021
 */
export interface KnownCompanyForPrompt {
  /** 公司 ID */
  id: string;
  /** 公司名稱 */
  name: string;
  /** 別名列表 */
  aliases: string[];
  /** 識別特徵（Logo 特徵、信頭關鍵字等） */
  identifiers: string[];
}

/**
 * 公司識別規則配置
 * @since CHANGE-021
 */
export interface IssuerIdentificationRulesConfig {
  /** 已知公司列表 */
  knownCompanies: KnownCompanyForPrompt[];
  /** 識別方法優先級 */
  identificationMethods: ('LOGO' | 'HEADER' | 'ADDRESS' | 'TAX_ID')[];
}

/**
 * 格式模式定義（用於 Prompt 組裝）
 * @since CHANGE-021
 */
export interface FormatPatternForPrompt {
  /** 格式 ID */
  formatId: string;
  /** 格式名稱 */
  formatName: string;
  /** 模式特徵 */
  patterns: string[];
  /** 關鍵字 */
  keywords: string[];
}

/**
 * 格式識別規則配置
 * @since CHANGE-021
 */
export interface FormatIdentificationRulesConfig {
  /** 格式模式列表 */
  formatPatterns: FormatPatternForPrompt[];
}

/**
 * 欄位提取規則配置
 * @since CHANGE-021
 */
export interface FieldExtractionRulesConfig {
  /** 標準欄位定義（8 個核心欄位） */
  standardFields: FieldDefinition[];
  /** 自定義欄位定義（公司/格式特定） */
  customFields: FieldDefinition[];
  /** 額外費用配置 */
  extraChargesConfig: {
    enabled: boolean;
    categories: string[];
  };
}

/**
 * 術語分類規則配置
 * @since CHANGE-021
 */
export interface TermClassificationRulesConfig {
  /** Tier 1: 通用映射 */
  universalMappings: Record<string, string>;
  /** Tier 2: 公司特定映射 */
  companyMappings: Record<string, string>;
  /** 回退行為 */
  fallbackBehavior: 'MARK_UNCLASSIFIED' | 'USE_ORIGINAL';
}

/**
 * 動態 Prompt 組裝配置
 * @description 從資料庫讀取並組裝為 GPT Prompt 的完整配置
 * @since CHANGE-021
 */
export interface DynamicPromptConfig {
  /** Section 1: 公司識別規則 */
  issuerIdentificationRules: IssuerIdentificationRulesConfig;
  /** Section 2: 格式識別規則 */
  formatIdentificationRules: FormatIdentificationRulesConfig;
  /** Section 3: 欄位提取規則 */
  fieldExtractionRules: FieldExtractionRulesConfig;
  /** Section 4: 術語分類規則 */
  termClassificationRules: TermClassificationRulesConfig;
  /** Section 5: 輸出 JSON Schema（運行時生成） */
  outputSchema?: Record<string, unknown>;
}

/**
 * 組裝後的 Prompt
 * @since CHANGE-021
 */
export interface AssembledPrompt {
  /** System Prompt */
  systemPrompt: string;
  /** User Prompt */
  userPrompt: string;
  /** 輸出 JSON Schema */
  outputSchema: Record<string, unknown>;
  /** 元數據 */
  metadata: {
    companiesCount: number;
    formatsCount: number;
    universalMappingsCount: number;
    companyMappingsCount: number;
    estimatedTokens: number;
  };
}

// ============================================================================
// Simplified Confidence Types (5 維度)
// ============================================================================

/**
 * V3 信心度計算維度（簡化為 5 維度）
 * @description 從 V2 的 7 維度簡化，移除 CONFIG_MATCH 和 TERM_MATCHING
 * @since CHANGE-021
 */
export enum ConfidenceDimensionV3 {
  /** GPT 整體提取信心度 (30%) */
  EXTRACTION = 'EXTRACTION',
  /** 發行商識別準確度 (20%) */
  ISSUER_IDENTIFICATION = 'ISSUER_IDENTIFICATION',
  /** 文件格式匹配程度 (15%) */
  FORMAT_MATCHING = 'FORMAT_MATCHING',
  /** 欄位完整性 (20%) */
  FIELD_COMPLETENESS = 'FIELD_COMPLETENESS',
  /** 歷史準確率 (15%) */
  HISTORICAL_ACCURACY = 'HISTORICAL_ACCURACY',
}

/**
 * V3 信心度權重配置
 * @since CHANGE-021
 */
export type ConfidenceWeightsV3 = Record<ConfidenceDimensionV3, number>;

/**
 * 預設 V3 信心度權重
 * @since CHANGE-021
 */
export const DEFAULT_CONFIDENCE_WEIGHTS_V3: ConfidenceWeightsV3 = {
  [ConfidenceDimensionV3.EXTRACTION]: 0.30,
  [ConfidenceDimensionV3.ISSUER_IDENTIFICATION]: 0.20,
  [ConfidenceDimensionV3.FORMAT_MATCHING]: 0.15,
  [ConfidenceDimensionV3.FIELD_COMPLETENESS]: 0.20,
  [ConfidenceDimensionV3.HISTORICAL_ACCURACY]: 0.15,
};

/**
 * V3 信心度計算輸入
 * @since CHANGE-021
 */
export interface SimplifiedConfidenceInput {
  /** GPT 回報的整體信心度 (0-100) */
  extractionConfidence: number;
  /** 發行方識別信心度 (0-100) */
  issuerConfidence: number;
  /** 格式識別信心度 (0-100) */
  formatConfidence: number;
  /** 欄位完整性數據 */
  fieldCompleteness: {
    requiredFieldsCount: number;
    filledRequiredFieldsCount: number;
  };
  /** 歷史準確率（可選，默認 80） */
  historicalAccuracy?: number;
}

/**
 * V3 維度分數詳情
 * @since CHANGE-021
 */
export interface DimensionScoreV3 {
  /** 維度類型 */
  dimension: ConfidenceDimensionV3;
  /** 原始分數 (0-100) */
  rawScore: number;
  /** 加權後分數 */
  weightedScore: number;
  /** 權重 */
  weight: number;
}

/**
 * V3 信心度計算結果
 * @since CHANGE-021
 */
export interface ConfidenceResultV3 {
  /** 總信心度分數 (0-100) */
  overallScore: number;
  /** 信心度等級 */
  level: ConfidenceLevelEnum;
  /** 各維度分數詳情 */
  dimensions: DimensionScoreV3[];
  /** 計算時間戳 */
  calculatedAt: Date;
}

// ============================================================================
// Routing Decision Types
// ============================================================================

/**
 * V3 路由決策詳情
 * @description 包含決策類型、分數和原因的完整路由決策資訊
 * @since CHANGE-021
 */
export interface RoutingDecisionDetailV3 {
  /** 決策類型 */
  decision: 'AUTO_APPROVE' | 'QUICK_REVIEW' | 'FULL_REVIEW';
  /** 信心度分數 (0-100) */
  score: number;
  /** 決策閾值 */
  threshold: number;
  /** 決策原因列表 */
  reasons: string[];
}

// ============================================================================
// Processing Input/Output Types
// ============================================================================

/**
 * V3 處理輸入
 * @description 調用 ExtractionV3Service.processFile() 的輸入參數
 * @since CHANGE-021
 */
export interface ExtractionV3Input {
  /** 文件 ID */
  fileId: string;
  /** 文件 Buffer */
  fileBuffer: Buffer;
  /** 文件名稱 */
  fileName: string;
  /** MIME 類型 */
  mimeType: string;
  /** 城市代碼 */
  cityCode: string;
  /** CHANGE-032: 地區 ID（用於 Pipeline Config resolve 和 Ref Number 匹配） */
  regionId?: string;
  /** 選項 */
  options?: {
    /** 自動創建公司（默認 true） */
    autoCreateCompany?: boolean;
    /** 自動創建格式（默認 true） */
    autoCreateFormat?: boolean;
    /** 已知公司 ID（跳過識別） */
    existingCompanyId?: string;
    /** 已知格式 ID（跳過識別） */
    existingFormatId?: string;
  };
}

/**
 * V3 步驟執行結果
 * @since CHANGE-021
 */
export interface StepResultV3<T = unknown> {
  /** 步驟類型 */
  step: ProcessingStepV3;
  /** 是否成功 */
  success: boolean;
  /** 步驟產出資料 */
  data?: T;
  /** 錯誤訊息（如失敗） */
  error?: string;
  /** 執行時間（毫秒） */
  durationMs: number;
  /** 是否被跳過 */
  skipped?: boolean;
}

/**
 * V3 處理輸出
 * @description ExtractionV3Service.processFile() 的返回結果
 * @since CHANGE-021
 */
export interface ExtractionV3Output {
  /** 是否成功 */
  success: boolean;
  /** 提取版本（v3 或 v3.1） - CHANGE-024 */
  extractionVersion?: 'v3' | 'v3.1';
  /** 提取結果（成功時填充） */
  result?: ValidatedExtractionResult;
  /** 信心度結果 */
  confidenceResult?: ConfidenceResultV3;
  /** 路由決策詳情 */
  routingDecision?: RoutingDecisionDetailV3;
  // CHANGE-025: 智能路由標記
  /** 是否檢測到新公司 */
  newCompanyDetected?: boolean;
  /** 是否檢測到新格式 */
  newFormatDetected?: boolean;
  /** 是否需要配置審核 */
  needsConfigReview?: boolean;
  /** 配置來源 */
  configSource?: ConfigSourceType;
  /** CHANGE-023: AI 詳情（用於 AI 詳情 Tab 顯示，V3 單階段） */
  aiDetails?: AiDetailsV3;
  /** CHANGE-024: 三階段 AI 詳情（V3.1 三階段） */
  stageAiDetails?: {
    stage1?: StageAiDetails;
    stage2?: StageAiDetails;
    stage3?: StageAiDetails;
  };
  /** 錯誤訊息（失敗時填充） */
  error?: string;
  /** 時間統計 */
  timing: {
    totalMs: number;
    stepTimings: Partial<Record<ProcessingStepV3 | string, number>>;
  };
  /** 步驟結果列表 */
  stepResults: StepResultV3[];
  /** 警告列表 */
  warnings: string[];
  /** CHANGE-032: 參考號碼匹配結果 */
  referenceNumberMatch?: ReferenceNumberMatchResult;
  /** CHANGE-032: 匯率轉換結果 */
  exchangeRateConversion?: ExchangeRateConversionResult;
}

// ============================================================================
// Processing Context Types
// ============================================================================

/**
 * V3 處理上下文
 * @description 整個 V3 處理流程共享的上下文
 * @since CHANGE-021
 */
export interface ProcessingContextV3 {
  /** 輸入資料 */
  input: ExtractionV3Input;
  /** 處理狀態 */
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  /** 當前步驟 */
  currentStep: ProcessingStepV3;
  /** 開始時間（毫秒時間戳） */
  startTime: number;

  // ========== Step 1: FILE_PREPARATION 結果 ==========
  /** 文件類型 */
  fileType?: UnifiedFileType;
  /** Base64 圖片陣列 */
  imageBase64Array?: string[];
  /** 頁數 */
  pageCount?: number;

  // ========== Step 2: DYNAMIC_PROMPT_ASSEMBLY 結果 ==========
  /** 組裝後的 Prompt */
  assembledPrompt?: AssembledPrompt;
  /** 動態配置（用於後續步驟） */
  promptConfig?: DynamicPromptConfig;

  // ========== Step 3: UNIFIED_GPT_EXTRACTION 結果 ==========
  /** GPT 原始提取結果 */
  extractionResult?: UnifiedExtractionResult;
  /** CHANGE-023: AI 詳情（用於 AI 詳情 Tab 顯示） */
  aiDetails?: AiDetailsV3;

  // ========== Step 4: RESULT_VALIDATION 結果 ==========
  /** 驗證後的提取結果 */
  validatedResult?: ValidatedExtractionResult;
  /** 解析後的公司 ID */
  companyId?: string;
  /** 公司名稱 */
  companyName?: string;
  /** 是否為新公司 */
  isNewCompany?: boolean;
  /** 解析後的格式 ID */
  documentFormatId?: string;
  /** 格式名稱 */
  documentFormatName?: string;
  /** 是否為新格式 */
  isNewFormat?: boolean;

  // ========== Step 5: TERM_RECORDING 結果 ==========
  /** 術語記錄統計 */
  termRecordingStats?: {
    totalDetected: number;
    newTermsCount: number;
    matchedTermsCount: number;
  };

  // ========== Step 6: CONFIDENCE_CALCULATION 結果 ==========
  /** 信心度結果 */
  confidenceResult?: ConfidenceResultV3;
  /** 整體信心度 (0-1) */
  overallConfidence?: number;

  // ========== Step 7: ROUTING_DECISION 結果 ==========
  /** 路由決策詳情 */
  routingDecision?: RoutingDecisionDetailV3;

  // ========== 元資料 ==========
  /** 步驟結果列表 */
  stepResults: StepResultV3[];
  /** 警告列表 */
  warnings: string[];
}

// ============================================================================
// CHANGE-023: AI Details Types
// ============================================================================

/**
 * AI 詳情資訊
 * @description 用於 AI 詳情 Tab 顯示的完整 GPT 提取資訊
 * @since CHANGE-023
 */
export interface AiDetailsV3 {
  /** 完整的 Prompt（System + User） */
  prompt: string;
  /** GPT 原始 JSON 響應 */
  response: string;
  /** Token 使用統計 */
  tokenUsage: {
    /** 輸入 Token 數 */
    input: number;
    /** 輸出 Token 數 */
    output: number;
    /** 總 Token 數 */
    total: number;
  };
  /** 使用的模型名稱 */
  model: string;
  /** 圖片詳情模式 */
  imageDetailMode: 'auto' | 'low' | 'high';
  /** 圖片數量 */
  imageCount: number;
}

// ============================================================================
// Feature Flags Types
// ============================================================================

/**
 * V3 Feature Flags
 * @description 控制 V3 提取服務的功能開關
 * @since CHANGE-021
 */
export interface ExtractionV3Flags {
  /** 使用 V3 架構（主開關） */
  useExtractionV3: boolean;
  /** V3 灰度發布百分比 (0-100) */
  extractionV3Percentage: number;
  /** 錯誤時回退到 V2 */
  fallbackToV2OnError: boolean;
  /** GPT 失敗時使用 Azure DI 備選 */
  enableAzureDIFallback: boolean;

  // V3.1 三階段架構（CHANGE-024）
  /** 使用 V3.1 三階段架構（優先於 V3 單階段） */
  useExtractionV3_1: boolean;
  /** V3.1 灰度發布百分比 (0-100) */
  extractionV3_1Percentage: number;
  /** V3.1 失敗時回退到 V3 單階段 */
  fallbackToV3OnError: boolean;

  // CHANGE-032: Pipeline 功能開關
  /** 啟用參考號碼匹配 */
  enableRefNumberMatching: boolean;
  /** 啟用匯率轉換 */
  enableFxConversion: boolean;

  // 調試選項
  /** 記錄組裝的 Prompt */
  logPromptAssembly: boolean;
  /** 記錄 GPT 原始響應 */
  logGptResponse: boolean;
}

/**
 * 預設 V3 Feature Flags
 * @since CHANGE-021
 */
export const DEFAULT_EXTRACTION_V3_FLAGS: ExtractionV3Flags = {
  useExtractionV3: false, // 初始關閉
  extractionV3Percentage: 0, // 0% 流量
  fallbackToV2OnError: true, // 啟用回退
  enableAzureDIFallback: true, // 啟用 Azure DI 備選
  // V3.1 三階段架構（CHANGE-024）
  useExtractionV3_1: false, // 初始關閉
  extractionV3_1Percentage: 0, // 0% 流量
  fallbackToV3OnError: true, // 啟用回退到 V3
  // CHANGE-032: Pipeline 功能開關
  enableRefNumberMatching: false, // 預設關閉
  enableFxConversion: false, // 預設關閉
  // 調試選項
  logPromptAssembly: false,
  logGptResponse: false,
};

// ============================================================================
// Step Configuration Types
// ============================================================================

/**
 * V3 步驟配置
 * @since CHANGE-021
 */
export interface StepConfigV3 {
  /** 步驟類型 */
  step: ProcessingStepV3;
  /** 步驟優先級 */
  priority: StepPriorityV3;
  /** 超時時間（毫秒） */
  timeout: number;
  /** 重試次數 */
  retryCount: number;
  /** 是否啟用 */
  enabled: boolean;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * 檢查是否為有效的 V3 處理步驟
 */
export function isProcessingStepV3(value: unknown): value is ProcessingStepV3 {
  return (
    typeof value === 'string' &&
    Object.values(ProcessingStepV3).includes(value as ProcessingStepV3)
  );
}

/**
 * 檢查是否為有效的 V3 維度
 */
export function isConfidenceDimensionV3(
  value: unknown
): value is ConfidenceDimensionV3 {
  return (
    typeof value === 'string' &&
    Object.values(ConfidenceDimensionV3).includes(value as ConfidenceDimensionV3)
  );
}

/**
 * 檢查是否為有效的統一提取結果
 */
export function isUnifiedExtractionResult(
  value: unknown
): value is UnifiedExtractionResult {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    'issuerIdentification' in obj &&
    'formatIdentification' in obj &&
    'standardFields' in obj &&
    'lineItems' in obj &&
    'overallConfidence' in obj &&
    'metadata' in obj
  );
}

// ============================================================================
// CHANGE-024: 三階段提取架構 V3.1 類型定義
// ============================================================================

/**
 * V3.1 處理步驟枚舉（三階段分離架構）
 * @description 將 V3 的 7 步重構為三階段分離的 7 步流程
 * @since CHANGE-024
 */
export enum ProcessingStepV3_1 {
  /** 階段 0: 文件準備（類型檢測 + PDF 轉換 + Base64 編碼） */
  FILE_PREPARATION = 'FILE_PREPARATION',

  /** 階段 1: 公司識別（GPT-5-nano） */
  STAGE_1_COMPANY_IDENTIFICATION = 'STAGE_1_COMPANY_IDENTIFICATION',

  /** 階段 2: 格式識別（GPT-5-nano） */
  STAGE_2_FORMAT_IDENTIFICATION = 'STAGE_2_FORMAT_IDENTIFICATION',

  /** 階段 3: 欄位提取（GPT-5.2） */
  STAGE_3_FIELD_EXTRACTION = 'STAGE_3_FIELD_EXTRACTION',

  /** 後處理 1: 術語記錄 */
  TERM_RECORDING = 'TERM_RECORDING',

  /** 後處理 2: 信心度計算（基於三階段結果） */
  CONFIDENCE_CALCULATION = 'CONFIDENCE_CALCULATION',

  /** 後處理 3: 路由決策 */
  ROUTING_DECISION = 'ROUTING_DECISION',
}

/**
 * V3.1 步驟執行順序
 * @since CHANGE-024
 */
export const PROCESSING_STEP_ORDER_V3_1 = [
  ProcessingStepV3_1.FILE_PREPARATION,
  ProcessingStepV3_1.STAGE_1_COMPANY_IDENTIFICATION,
  ProcessingStepV3_1.STAGE_2_FORMAT_IDENTIFICATION,
  ProcessingStepV3_1.STAGE_3_FIELD_EXTRACTION,
  ProcessingStepV3_1.TERM_RECORDING,
  ProcessingStepV3_1.CONFIDENCE_CALCULATION,
  ProcessingStepV3_1.ROUTING_DECISION,
] as const;

// ============================================================================
// CHANGE-024: 階段 AI 詳情類型
// ============================================================================

/**
 * 階段 AI 詳情
 * @description 每個階段的 GPT 調用詳情，用於 AI 詳情 Tab 顯示
 * @since CHANGE-024
 */
export interface StageAiDetails {
  /** 階段標識 */
  stage: 'STAGE_1' | 'STAGE_2' | 'STAGE_3';
  /** 使用的模型名稱 */
  model: string;
  /** 完整的 Prompt */
  prompt: string;
  /** GPT 原始響應 */
  response: string;
  /** Token 使用統計 */
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
  /** 圖片詳情模式 */
  imageDetailMode?: 'auto' | 'low' | 'high';
  /** 執行時間（毫秒） */
  durationMs: number;
}

// ============================================================================
// CHANGE-024: Stage 1 公司識別結果類型
// ============================================================================

/**
 * 公司識別方法
 * @since CHANGE-024
 */
export type CompanyIdentificationMethod =
  | 'LOGO'
  | 'HEADER'
  | 'ADDRESS'
  | 'TAX_ID'
  | 'LLM_INFERRED';

/**
 * Stage 1: 公司識別結果
 * @description GPT-5-nano 識別的公司信息
 * @since CHANGE-024
 */
export interface Stage1CompanyResult {
  /** 階段名稱 */
  stageName: 'STAGE_1_COMPANY_IDENTIFICATION';
  /** 是否成功 */
  success: boolean;
  /** 執行時間（毫秒） */
  durationMs: number;

  // ===== 識別結果 =====
  /** 已匹配的公司 ID（如果匹配到已知公司） */
  companyId?: string;
  /** 識別出的公司名稱 */
  companyName: string;
  /** 識別方法 */
  identificationMethod: CompanyIdentificationMethod;
  /** 信心度 (0-100) */
  confidence: number;
  /** 是否為新公司（資料庫中不存在） */
  isNewCompany: boolean;

  // ===== AI 詳情 =====
  /** 階段 AI 詳情 */
  aiDetails: StageAiDetails;

  // ===== CHANGE-026: PromptConfig 來源 =====
  /** 使用的 PromptConfig（如果使用自定義配置） */
  promptConfigUsed?: {
    scope: 'GLOBAL' | 'COMPANY' | 'FORMAT';
    version: number;
  };

  // ===== 錯誤資訊 =====
  /** 錯誤訊息（如果失敗） */
  error?: string;
}

// ============================================================================
// CHANGE-024: Stage 2 格式識別結果類型
// ============================================================================

/**
 * 格式配置來源
 * @description 標識格式識別時使用的配置來源
 * @since CHANGE-024
 */
export type FormatConfigSource =
  | 'COMPANY_SPECIFIC'  // 公司特定配置
  | 'UNIVERSAL'         // 統一格式配置
  | 'LLM_INFERRED';     // LLM 自行推斷

/**
 * Stage 2: 格式識別結果
 * @description GPT-5-nano 識別的文件格式信息
 * @since CHANGE-024
 */
export interface Stage2FormatResult {
  /** 階段名稱 */
  stageName: 'STAGE_2_FORMAT_IDENTIFICATION';
  /** 是否成功 */
  success: boolean;
  /** 執行時間（毫秒） */
  durationMs: number;

  // ===== 識別結果 =====
  /** 已匹配的格式 ID（如果匹配到已知格式） */
  formatId?: string;
  /** 識別出的格式名稱 */
  formatName: string;
  /** 信心度 (0-100) */
  confidence: number;
  /** 是否為新格式（資料庫中不存在） */
  isNewFormat: boolean;

  // ===== 配置來源追蹤 =====
  /** 配置來源 */
  configSource: FormatConfigSource;
  /** 使用的配置詳情 */
  configUsed?: {
    /** 使用的格式配置 ID */
    formatConfigId?: string;
    /** 該公司有多少格式配置 */
    companyConfigCount?: number;
  };

  // ===== AI 詳情 =====
  /** 階段 AI 詳情 */
  aiDetails: StageAiDetails;

  // ===== CHANGE-026: PromptConfig 來源 =====
  /** 使用的 PromptConfig（如果使用自定義配置） */
  promptConfigUsed?: {
    scope: 'GLOBAL' | 'COMPANY' | 'FORMAT';
    version: number;
  };

  // ===== 錯誤資訊 =====
  /** 錯誤訊息（如果失敗） */
  error?: string;
}

// ============================================================================
// CHANGE-024: Stage 3 欄位提取結果類型
// ============================================================================

/**
 * Prompt 配置範圍
 * @since CHANGE-024
 */
export type PromptConfigScope = 'GLOBAL' | 'COMPANY' | 'FORMAT';

/**
 * Stage 3 配置使用詳情
 * @description 追蹤 Stage 3 使用了哪些配置
 * @since CHANGE-024
 */
export interface Stage3ConfigUsed {
  /** Prompt 配置範圍 */
  promptConfigScope: PromptConfigScope;
  /** Prompt 配置 ID */
  promptConfigId?: string;
  /** 欄位映射配置 ID */
  fieldMappingConfigId?: string;
  /** 通用映射數量（Tier 1） */
  universalMappingsCount: number;
  /** 公司特定映射數量（Tier 2） */
  companyMappingsCount: number;
}

/**
 * Stage 3: 欄位提取結果
 * @description GPT-5.2 精準提取的欄位信息
 * @since CHANGE-024
 */
export interface Stage3ExtractionResult {
  /** 階段名稱 */
  stageName: 'STAGE_3_FIELD_EXTRACTION';
  /** 是否成功 */
  success: boolean;
  /** 執行時間（毫秒） */
  durationMs: number;

  // ===== 提取結果 =====
  /** 標準欄位（8 個核心欄位，向下兼容） */
  standardFields: StandardFieldsV3;
  /** 自定義欄位（公司/格式特定） */
  customFields?: Record<string, FieldValue>;
  /** CHANGE-042: 動態欄位提取結果（所有欄位統一為 key-value Record） */
  fields?: Record<string, FieldValue>;
  /** 行項目（含術語預分類） */
  lineItems: LineItemV3[];
  /** 額外費用（含術語預分類） */
  extraCharges?: ExtraChargeV3[];
  /** GPT 自評信心度 (0-100) */
  overallConfidence: number;
  /** CHANGE-042: 使用的 FieldDefinitionSet ID */
  fieldDefinitionSetId?: string;

  // ===== 配置來源追蹤 =====
  /** 使用的配置詳情 */
  configUsed: Stage3ConfigUsed;

  // ===== Token 使用 =====
  /** Token 使用統計 */
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };

  // ===== AI 詳情 =====
  /** 階段 AI 詳情 */
  aiDetails: StageAiDetails;

  // ===== 錯誤資訊 =====
  /** 錯誤訊息（如果失敗） */
  error?: string;
}

// ============================================================================
// CHANGE-024: V3.1 信心度計算類型
// ============================================================================

/**
 * V3.1 信心度維度（基於三階段）
 * @description 重新設計的 5 維度信心度計算，對應三階段架構
 * @since CHANGE-024
 */
export enum ConfidenceDimensionV3_1 {
  /** Stage 1 公司識別信心度 (20%) */
  STAGE_1_COMPANY = 'STAGE_1_COMPANY',
  /** Stage 2 格式識別信心度 (15%) */
  STAGE_2_FORMAT = 'STAGE_2_FORMAT',
  /** Stage 3 欄位提取信心度 (30%) */
  STAGE_3_EXTRACTION = 'STAGE_3_EXTRACTION',
  /** 欄位完整性 (20%) */
  FIELD_COMPLETENESS = 'FIELD_COMPLETENESS',
  /** 配置來源加成 (15%) */
  CONFIG_SOURCE_BONUS = 'CONFIG_SOURCE_BONUS',
  /** CHANGE-032: 參考號碼匹配 (0% disabled / 5% enabled) */
  REFERENCE_NUMBER_MATCH = 'REFERENCE_NUMBER_MATCH',
}

/**
 * V3.1 信心度權重配置
 * @since CHANGE-024
 */
export type ConfidenceWeightsV3_1 = Record<ConfidenceDimensionV3_1, number>;

/**
 * 預設 V3.1 信心度權重
 * @since CHANGE-024
 */
export const DEFAULT_CONFIDENCE_WEIGHTS_V3_1: ConfidenceWeightsV3_1 = {
  [ConfidenceDimensionV3_1.STAGE_1_COMPANY]: 0.20,
  [ConfidenceDimensionV3_1.STAGE_2_FORMAT]: 0.15,
  [ConfidenceDimensionV3_1.STAGE_3_EXTRACTION]: 0.30,
  [ConfidenceDimensionV3_1.FIELD_COMPLETENESS]: 0.20,
  [ConfidenceDimensionV3_1.CONFIG_SOURCE_BONUS]: 0.15,
  // CHANGE-032: 預設 disabled 時 weight=0，不影響現有計算
  [ConfidenceDimensionV3_1.REFERENCE_NUMBER_MATCH]: 0,
};

/**
 * 配置來源加成分數
 * @description 根據配置來源給予不同的加成分數
 * @since CHANGE-024
 */
export const CONFIG_SOURCE_BONUS_SCORES: Record<FormatConfigSource, number> = {
  /** 公司特定配置：滿分加成 */
  COMPANY_SPECIFIC: 100,
  /** 統一配置：80 分 */
  UNIVERSAL: 80,
  /** LLM 推斷：50 分 */
  LLM_INFERRED: 50,
};

/**
 * V3.1 維度分數詳情
 * @since CHANGE-024
 */
export interface DimensionScoreV3_1 {
  /** 維度類型 */
  dimension: ConfidenceDimensionV3_1;
  /** 原始分數 (0-100) */
  rawScore: number;
  /** 加權後分數 */
  weightedScore: number;
  /** 權重 */
  weight: number;
}

/**
 * V3.1 信心度計算結果
 * @since CHANGE-024
 */
export interface ConfidenceResultV3_1 {
  /** 總信心度分數 (0-100) */
  overallScore: number;
  /** 信心度等級 */
  level: ConfidenceLevelEnum;
  /** 各維度分數詳情 */
  dimensions: DimensionScoreV3_1[];
  /** 計算時間戳 */
  calculatedAt: Date;
}

// ============================================================================
// CHANGE-024: V3.1 三階段處理上下文
// ============================================================================

/**
 * V3.1 三階段處理上下文
 * @description 整個 V3.1 處理流程共享的上下文
 * @since CHANGE-024
 */
export interface ProcessingContextV3_1 {
  /** 輸入資料 */
  input: ExtractionV3Input;
  /** 處理狀態 */
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  /** 當前步驟 */
  currentStep: ProcessingStepV3_1;
  /** 開始時間（毫秒時間戳） */
  startTime: number;

  // ===== FILE_PREPARATION 結果 =====
  /** 文件類型 */
  fileType?: UnifiedFileType;
  /** Base64 圖片陣列 */
  imageBase64Array?: string[];
  /** 頁數 */
  pageCount?: number;

  // ===== STAGE_1_COMPANY_IDENTIFICATION 結果 =====
  /** Stage 1 結果 */
  stage1Result?: Stage1CompanyResult;

  // ===== STAGE_2_FORMAT_IDENTIFICATION 結果 =====
  /** Stage 2 結果 */
  stage2Result?: Stage2FormatResult;

  // ===== STAGE_3_FIELD_EXTRACTION 結果 =====
  /** Stage 3 結果 */
  stage3Result?: Stage3ExtractionResult;

  // ===== TERM_RECORDING 結果 =====
  /** 術語記錄統計 */
  termRecordingStats?: {
    totalDetected: number;
    newTermsCount: number;
    matchedTermsCount: number;
  };

  // ===== CONFIDENCE_CALCULATION 結果 =====
  /** V3.1 信心度結果 */
  confidenceResult?: ConfidenceResultV3_1;
  /** 整體信心度 (0-100) */
  overallConfidence?: number;

  // ===== ROUTING_DECISION 結果 =====
  /** 路由決策詳情 */
  routingDecision?: RoutingDecisionDetailV3;

  // ===== 元資料 =====
  /** 步驟結果列表 */
  stepResults: StepResultV3_1[];
  /** 警告列表 */
  warnings: string[];
}

/**
 * V3.1 步驟執行結果
 * @since CHANGE-024
 */
export interface StepResultV3_1<T = unknown> {
  /** 步驟類型 */
  step: ProcessingStepV3_1;
  /** 是否成功 */
  success: boolean;
  /** 步驟產出資料 */
  data?: T;
  /** 錯誤訊息（如失敗） */
  error?: string;
  /** 執行時間（毫秒） */
  durationMs: number;
  /** 是否被跳過 */
  skipped?: boolean;
}

/**
 * V3.1 處理輸出
 * @description ExtractionV3_1Service.processFile() 的返回結果
 * @since CHANGE-024
 */
export interface ExtractionV3_1Output {
  /** 是否成功 */
  success: boolean;

  // ===== 三階段結果 =====
  /** Stage 1 公司識別結果 */
  stage1Result?: Stage1CompanyResult;
  /** Stage 2 格式識別結果 */
  stage2Result?: Stage2FormatResult;
  /** Stage 3 欄位提取結果 */
  stage3Result?: Stage3ExtractionResult;

  // ===== 驗證後結果（整合三階段） =====
  /** 驗證後的提取結果 */
  result?: ValidatedExtractionResult;

  // ===== 信心度和路由 =====
  /** V3.1 信心度結果 */
  confidenceResult?: ConfidenceResultV3_1;
  /** 路由決策詳情 */
  routingDecision?: RoutingDecisionDetailV3;

  // ===== 錯誤處理 =====
  /** 錯誤訊息（失敗時填充） */
  error?: string;

  // ===== 時間統計 =====
  /** 時間統計 */
  timing: {
    totalMs: number;
    stepTimings: Partial<Record<ProcessingStepV3_1, number>>;
  };

  /** 步驟結果列表 */
  stepResults: StepResultV3_1[];
  /** 警告列表 */
  warnings: string[];
}

// ============================================================================
// CHANGE-024: Type Guards for V3.1
// ============================================================================

/**
 * 檢查是否為有效的 V3.1 處理步驟
 * @since CHANGE-024
 */
export function isProcessingStepV3_1(
  value: unknown
): value is ProcessingStepV3_1 {
  return (
    typeof value === 'string' &&
    Object.values(ProcessingStepV3_1).includes(value as ProcessingStepV3_1)
  );
}

/**
 * 檢查是否為有效的 V3.1 信心度維度
 * @since CHANGE-024
 */
export function isConfidenceDimensionV3_1(
  value: unknown
): value is ConfidenceDimensionV3_1 {
  return (
    typeof value === 'string' &&
    Object.values(ConfidenceDimensionV3_1).includes(
      value as ConfidenceDimensionV3_1
    )
  );
}

/**
 * 檢查是否為 Stage 1 結果
 * @since CHANGE-024
 */
export function isStage1CompanyResult(
  value: unknown
): value is Stage1CompanyResult {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return obj.stageName === 'STAGE_1_COMPANY_IDENTIFICATION';
}

/**
 * 檢查是否為 Stage 2 結果
 * @since CHANGE-024
 */
export function isStage2FormatResult(
  value: unknown
): value is Stage2FormatResult {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return obj.stageName === 'STAGE_2_FORMAT_IDENTIFICATION';
}

/**
 * 檢查是否為 Stage 3 結果
 * @since CHANGE-024
 */
export function isStage3ExtractionResult(
  value: unknown
): value is Stage3ExtractionResult {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return obj.stageName === 'STAGE_3_FIELD_EXTRACTION';
}

// ============================================================================
// CHANGE-025: 智能路由類型定義
// ============================================================================

/**
 * 配置來源類型（用於智能路由）
 * @since CHANGE-025
 */
export type ConfigSourceType = 'FORMAT' | 'COMPANY' | 'GLOBAL' | 'DEFAULT';

/**
 * 智能路由輸入參數
 * @description 用於智能路由決策的輸入資料
 * @since CHANGE-025
 */
export interface SmartRoutingInput {
  /** 整體信心度 (0-100) */
  overallConfidence: number;
  /** 是否為新公司 */
  isNewCompany: boolean;
  /** 是否為新格式 */
  isNewFormat: boolean;
  /** 配置來源 */
  configSource: ConfigSourceType;
}

/**
 * 智能路由輸出
 * @description 智能路由決策的結果
 * @since CHANGE-025
 */
export interface SmartRoutingOutput {
  /** 審核類型 */
  reviewType: 'AUTO_APPROVE' | 'QUICK_REVIEW' | 'FULL_REVIEW';
  /** 路由原因說明 */
  reason: string;
  /** 是否需要配置審核 */
  needsConfigReview: boolean;
}

/**
 * Logo 識別模式
 * @description 用於格式識別的 Logo 模式定義
 * @since CHANGE-025
 */
export interface LogoPattern {
  /** Logo 描述 */
  description: string;
  /** Logo 位置 */
  position?: 'TOP_LEFT' | 'TOP_RIGHT' | 'TOP_CENTER' | 'BOTTOM_LEFT' | 'BOTTOM_RIGHT';
  /** Logo 中可能包含的文字 */
  keywords?: string[];
}

/**
 * 擴展的格式模式定義（用於 Prompt 組裝）
 * @description 完整使用 identificationRules 的格式模式
 * @since CHANGE-025
 */
export interface FormatPatternForPromptExtended extends FormatPatternForPrompt {
  /** 文件類型 */
  documentType?: string;
  /** 文件子類型 */
  documentSubtype?: string;
  /** Logo 識別規則 */
  logoPatterns?: LogoPattern[];
  /** 版面特徵提示 */
  layoutHints?: string;
  /** 識別優先級（數字越小優先級越高） */
  priority?: number;
}

/**
 * 版本檢測邏輯：判斷是 V3 還是 V3.1 架構
 * @since CHANGE-024
 */
export function detectExtractionVersion(
  steps: Array<{ step: string }>
): 'v3' | 'v3.1' {
  const stepNames = steps.map((s) => s.step);

  // V3.1 特有步驟
  if (
    stepNames.includes('STAGE_1_COMPANY_IDENTIFICATION') ||
    stepNames.includes('STAGE_2_FORMAT_IDENTIFICATION') ||
    stepNames.includes('STAGE_3_FIELD_EXTRACTION')
  ) {
    return 'v3.1';
  }

  // V3 特有步驟
  if (stepNames.includes('UNIFIED_GPT_EXTRACTION')) {
    return 'v3';
  }

  return 'v3'; // 預設
}

// ============================================================================
// CHANGE-032: Pipeline Reference Number Matching & FX Conversion Types
// ============================================================================

/**
 * 參考號碼匹配結果中的單筆匹配
 * @since CHANGE-032
 */
export interface ReferenceNumberMatch {
  /** 候選字串（從文件名提取） */
  candidate: string;
  /** 匹配的 DB reference number ID */
  referenceNumberId: string;
  /** 匹配的 reference number value */
  referenceNumber: string;
  /** 參考號碼類型 */
  type: string;
  /** 匹配信心度 */
  confidence: number;
}

/**
 * 參考號碼匹配結果
 * @since CHANGE-032
 */
export interface ReferenceNumberMatchResult {
  /** 功能是否啟用 */
  enabled: boolean;
  /** 匹配結果列表 */
  matches: ReferenceNumberMatch[];
  /** 摘要 */
  summary: {
    /** 候選數量 */
    candidatesFound: number;
    /** 匹配數量 */
    matchesFound: number;
    /** 來源（filename/content） */
    sources: string[];
  };
  /** 處理時間（毫秒） */
  processingTimeMs: number;
  /** FIX-036: 是否應中止 pipeline（enabled=true 且 matchesFound=0） */
  shouldAbortPipeline?: boolean;
}

/**
 * 匯率轉換項目
 * @since CHANGE-032
 */
export interface FxConversionItem {
  /** 欄位名稱 */
  field: string;
  /** 原始金額 */
  originalAmount: number;
  /** 原始貨幣 */
  originalCurrency: string;
  /** 轉換後金額 */
  convertedAmount: number;
  /** 目標貨幣 */
  targetCurrency: string;
  /** 使用的匯率 */
  rate: number;
  /** 欄位路徑（如 lineItems[0].amount） */
  path?: string;
}

/**
 * 匯率轉換結果
 * @since CHANGE-032
 */
export interface ExchangeRateConversionResult {
  /** 功能是否啟用 */
  enabled: boolean;
  /** 轉換項目列表 */
  conversions: FxConversionItem[];
  /** 來源貨幣 */
  sourceCurrency?: string;
  /** 目標貨幣 */
  targetCurrency?: string;
  /** 警告列表 */
  warnings: string[];
  /** 處理時間（毫秒） */
  processingTimeMs: number;
}

/**
 * 有效的 Pipeline 配置（resolve 後的合併結果）
 * @since CHANGE-032
 * @modified CHANGE-036 - 移除 regex 相關欄位，改為 DB substring 匹配
 */
export interface EffectivePipelineConfig {
  /** Reference Number Matching */
  refMatchEnabled: boolean;
  refMatchTypes: string[];
  /** CHANGE-036: 最大匹配結果數（原 refMatchMaxCandidates） */
  refMatchMaxResults: number;
  /** FX Conversion */
  fxConversionEnabled: boolean;
  fxTargetCurrency: string | null;
  fxConvertLineItems: boolean;
  fxConvertExtraCharges: boolean;
  fxRoundingPrecision: number;
  fxFallbackBehavior: 'skip' | 'warn' | 'error';
  /** CHANGE-071: 只轉指定來源幣別清單（null/空 = 全轉，向後相容） */
  fxSourceCurrencies: string[] | null;
  /** 配置來源摘要 */
  resolvedFrom: {
    global?: string;
    region?: string;
    company?: string;
    format?: string;
  };
}
