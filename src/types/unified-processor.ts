/**
 * @fileoverview 統一文件處理器類型定義
 * @description
 *   定義 UnifiedDocumentProcessor 的核心類型，包含：
 *   - 11 步處理管道的步驟枚舉和配置
 *   - 處理上下文和結果類型
 *   - 文件類型和處理方法枚舉
 *   - 路由決策和功能開關類型
 *
 * @module src/types/unified-processor
 * @since Epic 15 - Story 15.1 (處理流程重構 - 統一入口)
 * @lastModified 2026-01-03
 *
 * @features
 *   - ProcessingStep: 11 步處理管道枚舉
 *   - StepPriority: 必要/可選步驟優先級
 *   - ProcessingContext: 處理上下文（逐步填充）
 *   - ProcessingResult: 最終處理結果
 *   - UnifiedProcessorFlags: 功能開關配置
 *
 * @related
 *   - src/services/unified-processor/ - 統一處理器服務
 *   - src/constants/processing-steps.ts - 步驟配置常數
 */

import type { VisualMappingConfig, MappedFieldValue } from './field-mapping';
import type { ResolvedPromptResult } from './prompt-resolution';
import type {
  DocumentType,
  DocumentSubtype,
  IdentificationRules,
} from './document-format';
// CHANGE-072: FX 換算結果（用於將原值/換算審計帶到持久化層）
import type { ExchangeRateConversionResult } from './extraction-v3.types';

// 重新導出常用類型
export type { MappedFieldValue } from './field-mapping';

// ============================================================================
// Processing Step Enum (11 步處理管道)
// ============================================================================

/**
 * 處理步驟枚舉
 * @description 定義統一處理器的 11 個處理步驟
 * @since Epic 15 - Story 15.1
 */
export enum ProcessingStep {
  /** 步驟 1: 文件類型檢測（Native PDF / Scanned PDF / Image） */
  FILE_TYPE_DETECTION = 'FILE_TYPE_DETECTION',
  /** 步驟 2: 智能路由（決定處理方法） */
  SMART_ROUTING = 'SMART_ROUTING',
  /** 步驟 6: Azure DI 提取（依據配置的 QueryFields 動態提取） */
  AZURE_DI_EXTRACTION = 'AZURE_DI_EXTRACTION',
  /** 步驟 3: 發行者識別（辨識文件發行公司，使用 GPT Vision classifyDocument） */
  ISSUER_IDENTIFICATION = 'ISSUER_IDENTIFICATION',
  /** 步驟 4: 格式匹配（匹配文件格式模板） */
  FORMAT_MATCHING = 'FORMAT_MATCHING',
  /** 步驟 5: 配置獲取（取得欄位映射和 Prompt 配置，含 QueryFields） */
  CONFIG_FETCHING = 'CONFIG_FETCHING',
  /** 步驟 7: GPT 增強提取 */
  GPT_ENHANCED_EXTRACTION = 'GPT_ENHANCED_EXTRACTION',
  /** 步驟 8: 欄位映射 */
  FIELD_MAPPING = 'FIELD_MAPPING',
  /** 步驟 9: 術語記錄（記錄新發現的術語） */
  TERM_RECORDING = 'TERM_RECORDING',
  /** 步驟 10: 信心度計算 */
  CONFIDENCE_CALCULATION = 'CONFIDENCE_CALCULATION',
  /** 步驟 11: 路由決策（決定審核路徑） */
  ROUTING_DECISION = 'ROUTING_DECISION',
}

// ============================================================================
// Step Priority Enum
// ============================================================================

/**
 * 步驟優先級
 * @description 區分必要步驟和可選步驟的錯誤處理行為
 * @since Epic 15 - Story 15.1
 */
export enum StepPriority {
  /** 必要步驟 - 失敗則中斷整個處理流程 */
  REQUIRED = 'REQUIRED',
  /** 可選步驟 - 失敗則記錄警告並繼續 */
  OPTIONAL = 'OPTIONAL',
}

// ============================================================================
// Step Configuration Types
// ============================================================================

/**
 * 步驟配置
 * @description 定義每個處理步驟的執行參數
 * @since Epic 15 - Story 15.1
 */
export interface StepConfig {
  /** 步驟類型 */
  step: ProcessingStep;
  /** 步驟優先級 */
  priority: StepPriority;
  /** 超時時間（毫秒） */
  timeout: number;
  /** 重試次數 */
  retryCount: number;
  /** 是否啟用 */
  enabled: boolean;
}

/**
 * 步驟執行結果
 * @description 記錄單一步驟的執行結果
 * @since Epic 15 - Story 15.1
 */
export interface StepResult<T = unknown> {
  /** 步驟類型 */
  step: ProcessingStep;
  /** 是否成功 */
  success: boolean;
  /** 步驟產出資料 */
  data?: T;
  /** 錯誤訊息（如失敗） */
  error?: string;
  /** 執行時間（毫秒） */
  durationMs: number;
  /** 是否被跳過（可選，預設 false） */
  skipped?: boolean;
  /** 重試次數（可選，預設 0） */
  retryAttempts?: number;
}

// ============================================================================
// File Type & Processing Method Enums
// ============================================================================

/**
 * 文件類型
 * @description 區分不同類型的輸入文件
 * @since Epic 15 - Story 15.1
 */
export enum UnifiedFileType {
  /** 原生 PDF（包含可選取文字） */
  NATIVE_PDF = 'NATIVE_PDF',
  /** 掃描 PDF（純圖片） */
  SCANNED_PDF = 'SCANNED_PDF',
  /** 圖片格式（PNG、JPEG 等） */
  IMAGE = 'IMAGE',
}

/**
 * 處理方法
 * @description 根據文件類型決定的處理策略
 * @since Epic 15 - Story 15.1
 */
export enum UnifiedProcessingMethod {
  /** 雙重處理：GPT Vision 分類 + Azure DI 提取 */
  DUAL_PROCESSING = 'DUAL_PROCESSING',
  /** 僅 GPT Vision：掃描文件/圖片 */
  GPT_VISION_ONLY = 'GPT_VISION_ONLY',
  /** 僅 Azure DI：降級處理 */
  AZURE_DI_ONLY = 'AZURE_DI_ONLY',
}

/**
 * 路由決策
 * @description 根據信心度決定的審核路徑
 * @since Epic 15 - Story 15.1
 */
export enum UnifiedRoutingDecision {
  /** 自動通過（信心度 ≥ 90%） */
  AUTO_APPROVE = 'AUTO_APPROVE',
  /** 快速審核（信心度 70-89%） */
  QUICK_REVIEW = 'QUICK_REVIEW',
  /** 完整審核（信心度 < 70%） */
  FULL_REVIEW = 'FULL_REVIEW',
}

// ============================================================================
// Extracted Data Types
// ============================================================================

/**
 * 發行者識別結果
 * @since Epic 15 - Story 15.1
 */
export interface IssuerIdentificationResult {
  /** 識別方法 */
  method?: 'LOGO' | 'HEADER' | 'TEXT_MATCH';
  /** 公司名稱 */
  companyName?: string;
  /** 信心度 (0-1) */
  confidence?: number;
  /** 匹配的公司 ID */
  matchedCompanyId?: string;
  /** 是否為新公司 */
  isNewCompany?: boolean;
}

/**
 * GPT 提取結果
 * @since Epic 15 - Story 15.1
 */
export interface GptExtractionResult {
  /** GPT 提取的欄位 */
  fields?: Record<string, unknown>;
  /** 增強的明細項目 */
  enhancedLineItems?: LineItemData[];
  /** 文件分類 */
  documentClassification?: string;
  /** 原始 GPT 響應 */
  rawResponse?: unknown;
}

/**
 * 提取的文件資料
 * @description Azure DI 和 GPT Vision 提取的結構化資料
 * @since Epic 15 - Story 15.1
 */
export interface ExtractedDocumentData {
  /** 發票資料 */
  invoiceData?: {
    /** 發票編號 */
    invoiceNumber?: string;
    /** 發票日期 */
    invoiceDate?: string;
    /** 到期日 */
    dueDate?: string;
    /** 供應商名稱 */
    vendorName?: string;
    /** 客戶名稱 */
    customerName?: string;
    /** 小計 */
    subtotal?: number;
    /** 稅額 */
    tax?: number;
    /** 總金額 */
    totalAmount?: number;
    /** 幣別 */
    currency?: string;
    /** 明細項目 */
    lineItems?: LineItemData[];
  };
  /** 明細項目（頂層，可直接存取） */
  lineItems?: LineItemData[];
  /** 文件發行者資訊（GPT Vision 識別） */
  documentIssuer?: {
    /** 識別方法 */
    method?: 'LOGO' | 'HEADER' | 'TEXT_MATCH';
    /** 公司名稱 */
    companyName?: string;
    /** 信心度 */
    confidence?: number;
  };
  /** 發行者識別結果（詳細） */
  issuerIdentification?: IssuerIdentificationResult;
  /** GPT 提取結果 */
  gptExtraction?: GptExtractionResult;
  /** GPT 整體信心度 (0-1) */
  gptConfidence?: number;
  /** 原始 OCR 文字 */
  rawText?: string;
  /** 頁數 */
  pageCount?: number;
  /** Azure DI 原始響應（JSON） */
  azureResponse?: unknown;
  /** Azure DI 原始響應（別名） */
  rawAzureResponse?: unknown;
  /** GPT Vision 原始響應（JSON） */
  gptResponse?: unknown;
}

/**
 * 明細項目資料
 * @since Epic 15 - Story 15.1
 */
export interface LineItemData {
  /** 描述 */
  description?: string;
  /** 數量 */
  quantity?: number;
  /** 單價 */
  unitPrice?: number;
  /** 金額 */
  amount?: number;
  /** 稅率 */
  taxRate?: number;
  /** 產品代碼 */
  productCode?: string;
}

// ============================================================================
// Term Recording Types
// ============================================================================

/**
 * 記錄的術語
 * @description 處理過程中發現並記錄的新術語
 * @since Epic 15 - Story 15.1
 */
export interface RecordedTerm {
  /** 術語 ID（如果已存在） */
  termId?: string;
  /** 術語名稱 */
  term: string;
  /** 出現次數 */
  occurrences: number;
  /** 是否為新術語 */
  isNew: boolean;
  /** 關聯的文件格式 ID */
  documentFormatId?: string;
}

// ============================================================================
// Format Identification Rules (Story 16.5)
// ============================================================================

/**
 * 格式識別規則（用於 Prompt 注入）
 * @description 將 DocumentFormat.identificationRules 整合到 GPT Vision Prompt
 * @since Epic 16 - Story 16.5
 */
export interface FormatIdentificationRule {
  /** 格式 ID */
  formatId: string;
  /** 格式名稱 */
  formatName: string;
  /** 文件類型 */
  documentType: DocumentType;
  /** 文件子類型 */
  documentSubtype: DocumentSubtype;
  /** 識別規則 */
  rules: IdentificationRules;
}

// ============================================================================
// Processing Context Status
// ============================================================================

/**
 * 處理狀態
 * @since Epic 15 - Story 15.1
 */
export type ProcessingStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED';

// ============================================================================
// Processing Context Type (核心上下文)
// ============================================================================

/**
 * 統一處理上下文
 * @description 整個處理流程共享的上下文，逐步填充
 * @since Epic 15 - Story 15.1
 */
export interface UnifiedProcessingContext {
  // ========== 輸入資訊（包裝為 input 物件） ==========
  /** 輸入資料 */
  input: ProcessFileInput;

  // ========== 處理狀態 ==========
  /** 當前處理狀態 */
  status: ProcessingStatus;
  /** 當前處理步驟 */
  currentStep: ProcessingStep;
  /** 開始時間（毫秒時間戳） */
  startTime: number;

  // ========== 逐步填充的處理結果 ==========
  /** 步驟 1: 文件類型 */
  fileType?: UnifiedFileType;
  /** 步驟 2: 處理方法 */
  processingMethod?: UnifiedProcessingMethod;
  /** 步驟 6: 提取的資料（Azure DI 提取） */
  extractedData: ExtractedDocumentData;
  /** 步驟 3: 公司 ID（發行者識別） */
  companyId?: string;
  /** 步驟 3: 公司名稱（發行者識別） */
  companyName?: string;
  /** 步驟 3: 是否為新建公司（發行者識別） */
  isNewCompany?: boolean;
  /** 步驟 4: 文件格式 ID（格式匹配） */
  documentFormatId?: string;
  /** 步驟 4: 文件格式名稱（格式匹配） */
  documentFormatName?: string;
  /** 步驟 4: 是否為新建格式（格式匹配） */
  isNewFormat?: boolean;
  /** 步驟 5a: 欄位映射配置（配置獲取） */
  fieldMappingConfig?: VisualMappingConfig;
  /** 步驟 5a: 映射配置（別名） */
  mappingConfig?: VisualMappingConfig;
  /** 步驟 5b: Prompt 配置（配置獲取） */
  promptConfig?: ResolvedPromptResult;
  /** 步驟 5b: 解析後的 Prompt（別名） */
  resolvedPrompt?: ResolvedPromptResult;
  /** 步驟 5c: 格式識別規則列表（Story 16.5） */
  formatIdentificationRules?: FormatIdentificationRule[];
  /** 步驟 8: 映射後的欄位 */
  mappedFields?: MappedFieldValue[];
  /** 步驟 8: 未映射的欄位 */
  unmappedFields?: UnmappedField[];
  /** 步驟 9: 記錄的術語 */
  recordedTerms?: RecordedTerm[];
  /** 步驟 10: 整體信心度 (0-1) */
  overallConfidence?: number;
  /** 步驟 10: 信心度分項 */
  confidenceBreakdown?: ConfidenceBreakdown;
  /** 步驟 11: 路由決策 */
  routingDecision?: UnifiedRoutingDecision;

  // ========== 元資料 ==========
  /** 步驟結果列表 */
  stepResults: StepResult[];
  /** 警告列表 */
  warnings: ProcessingWarning[];
}

/**
 * 未映射欄位
 * @since Epic 15 - Story 15.1
 */
export interface UnmappedField {
  /** 欄位名稱 */
  fieldName: string;
  /** 原始值 */
  originalValue: unknown;
  /** 原因 */
  reason: string;
}

/**
 * 信心度分項
 * @since Epic 15 - Story 15.1
 */
export interface ConfidenceBreakdown {
  /** OCR 提取信心度 */
  extraction?: number;
  /** 發行者識別信心度 */
  issuerIdentification?: number;
  /** 格式匹配信心度 */
  formatMatching?: number;
  /** 欄位映射信心度 */
  fieldMapping?: number;
  /** GPT 增強信心度 */
  gptEnhancement?: number;
}

// ============================================================================
// Processing Result Type (最終結果)
// ============================================================================

/**
 * 統一處理結果
 * @description 處理完成後返回的最終結果
 * @since Epic 15 - Story 15.1
 */
export interface UnifiedProcessingResult {
  /** 是否成功 */
  success: boolean;
  /** 文件 ID */
  fileId: string;
  /** 處理狀態 */
  status: ProcessingStatus;
  /** 總處理時間（毫秒） */
  totalDurationMs: number;
  /** 步驟結果列表 */
  stepResults: StepResult[];
  /** 錯誤訊息（如失敗） */
  error?: string;
  /** 警告列表 */
  warnings: ProcessingWarning[];
  /** 是否使用了舊版處理器 */
  usedLegacyProcessor: boolean;

  // ========== V3 相關標記 (CHANGE-021) ==========
  /** 是否使用了 V3 處理器 */
  usedV3?: boolean;
  /** 是否從 V3 回退到 V2 */
  usedV3Fallback?: boolean;
  /** V3 處理元數據 */
  v3Metadata?: {
    /** Token 消耗 */
    tokensUsed?: {
      input: number;
      output: number;
      total: number;
    };
    /** 使用的模型 */
    modelUsed?: string;
    /** 處理時間（毫秒） */
    processingTimeMs?: number;
  };
  /** CHANGE-023: AI 詳情（用於 AI 詳情 Tab 顯示） */
  aiDetails?: {
    /** 完整的 Prompt（System + User） */
    prompt: string;
    /** GPT 原始 JSON 響應 */
    response: string;
    /** Token 使用統計 */
    tokenUsage: {
      input: number;
      output: number;
      total: number;
    };
    /** 使用的模型名稱 */
    model: string;
    /** 圖片詳情模式 */
    imageDetailMode: 'auto' | 'low' | 'high';
    /** 圖片數量 */
    imageCount: number;
  };

  // ========== V3.1 三階段架構 (CHANGE-024) ==========
  /** 提取版本 */
  extractionVersion?: 'v2' | 'v3' | 'v3.1';
  /** V3.1 三階段 AI 詳情 */
  stageAiDetails?: {
    stage1?: {
      model: string;
      prompt: string;
      response: string;
      tokenUsage: { input: number; output: number; total: number };
      durationMs: number;
    };
    stage2?: {
      model: string;
      prompt: string;
      response: string;
      tokenUsage: { input: number; output: number; total: number };
      durationMs: number;
    };
    stage3?: {
      model: string;
      prompt: string;
      response: string;
      tokenUsage: { input: number; output: number; total: number };
      durationMs: number;
    };
  };
  /** V3.1 Stage 1 結果（公司識別） */
  stage1Result?: {
    companyId?: string;
    companyName: string;
    confidence: number;
    isNewCompany: boolean;
    configSource?: string;
  };
  /** V3.1 Stage 2 結果（格式識別） */
  stage2Result?: {
    formatId?: string;
    formatName: string;
    confidence: number;
    isNewFormat: boolean;
    configSource?: string;
  };
  /** V3.1 Stage 3 結果（欄位提取） */
  stage3Result?: {
    success: boolean;
    fieldCount: number;
    lineItemCount: number;
    overallConfidence: number;
    /** FIX-044: 保留完整 standardFields 數據 */
    standardFields?: Record<string, unknown>;
    /** FIX-044: 保留完整 customFields 數據 */
    customFields?: Record<string, unknown>;
    /** FIX-045: 保留原始 FieldDefinitionSet key */
    fields?: Record<string, unknown>;
    /** FIX-044: 保留完整 lineItems 數據 */
    lineItems?: unknown[];
  };

  /** CHANGE-072: FX 換算結果（含原值/換算值/匯率，供持久化審計；覆蓋寫回後原值僅存於此） */
  exchangeRateConversion?: ExchangeRateConversionResult;

  // ========== CHANGE-025: 智能路由標記 ==========
  /** 是否檢測到新公司（需要配置審核） */
  newCompanyDetected?: boolean;
  /** 是否檢測到新格式（需要配置審核） */
  newFormatDetected?: boolean;
  /** 是否需要配置審核（新公司 || 新格式 || 使用預設配置） */
  needsConfigReview?: boolean;
  /** 配置來源（用於智能路由） */
  configSource?: 'FORMAT' | 'COMPANY' | 'GLOBAL' | 'DEFAULT';

  // ========== 成功時填充的資料 ==========
  /** 文件類型 */
  fileType?: UnifiedFileType;
  /** 處理方法 */
  processingMethod?: UnifiedProcessingMethod;
  /** 提取的資料 */
  extractedData?: ExtractedDocumentData;
  /** 公司 ID */
  companyId?: string;
  /** 公司名稱 */
  companyName?: string;
  /** 是否為新建公司 */
  isNewCompany?: boolean;
  /** 文件格式 ID */
  documentFormatId?: string;
  /** 文件格式名稱 */
  documentFormatName?: string;
  /** 是否為新建格式 */
  isNewFormat?: boolean;
  /** 映射後的欄位 */
  mappedFields?: MappedFieldValue[];
  /** 未映射的欄位 */
  unmappedFields?: UnmappedField[];
  /** 記錄的術語 */
  recordedTerms?: RecordedTerm[];
  /** 整體信心度 (0-1) */
  overallConfidence?: number;
  /** 信心度分項 */
  confidenceBreakdown?: ConfidenceBreakdown;
  /** 路由決策 */
  routingDecision?: UnifiedRoutingDecision;
}

// ============================================================================
// Warning Type
// ============================================================================

/**
 * 處理警告
 * @description 可選步驟失敗或其他非致命問題的記錄
 * @since Epic 15 - Story 15.1
 */
export interface ProcessingWarning {
  /** 相關步驟 */
  step: ProcessingStep;
  /** 警告代碼（可選） */
  code?: string;
  /** 警告訊息 */
  message: string;
  /** 時間戳（ISO 8601 格式） */
  timestamp: string;
}

// ============================================================================
// Feature Flags Type
// ============================================================================

/**
 * 統一處理器功能開關
 * @description 控制漸進式啟用各項功能
 * @since Epic 15 - Story 15.1
 */
export interface UnifiedProcessorFlags {
  /** 啟用統一處理器（主開關，false 時使用舊版處理器） */
  enableUnifiedProcessor: boolean;
  /** 啟用發行者識別（步驟 3） */
  enableIssuerIdentification: boolean;
  /** 啟用格式匹配（步驟 4） */
  enableFormatMatching: boolean;
  /** 啟用動態配置（步驟 5） */
  enableDynamicConfig: boolean;
  /** 啟用術語記錄（步驟 9） */
  enableTermRecording: boolean;
  /** 啟用增強信心度計算（步驟 10） */
  enableEnhancedConfidence: boolean;
  /** 自動創建公司（當識別到新公司時） */
  autoCreateCompany: boolean;
  /** 自動創建格式（當匹配到新格式時） */
  autoCreateFormat: boolean;
}

// ============================================================================
// Input Type
// ============================================================================

/**
 * 處理文件輸入
 * @description 調用 UnifiedDocumentProcessor.process() 的輸入參數
 * @since Epic 15 - Story 15.1
 */
export interface ProcessFileInput {
  /** 文件 ID */
  fileId: string;
  /** 批次 ID（可選） */
  batchId?: string;
  /** 文件名稱 */
  fileName: string;
  /** 文件 Buffer */
  fileBuffer: Buffer;
  /** MIME 類型 */
  mimeType: string;
  /** 用戶 ID */
  userId: string;
  /** 城市代碼（V3 使用，可選） */
  cityCode?: string;
  /** 已知公司 ID（可選，跳過公司識別） */
  companyId?: string;
}

// ============================================================================
// Step Handler Types
// ============================================================================

/**
 * 步驟處理器類型
 * @description 每個步驟的處理函數簽名
 * @since Epic 15 - Story 15.1
 */
export type StepHandler<T = unknown> = (
  context: UnifiedProcessingContext
) => Promise<StepResult<T>>;

// ============================================================================
// Constants for Thresholds
// ============================================================================

/**
 * 信心度閾值常數
 * @since Epic 15 - Story 15.1
 */
export const UNIFIED_CONFIDENCE_THRESHOLDS = {
  /** 自動通過閾值 (0-1 scale) */
  AUTO_APPROVE: 0.9,
  /** 快速審核閾值 (0-1 scale) */
  QUICK_REVIEW: 0.7,
  /** 完整審核閾值 (0-1 scale) */
  FULL_REVIEW: 0,
} as const;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * 檢查是否為有效的處理步驟
 */
export function isProcessingStep(value: unknown): value is ProcessingStep {
  return (
    typeof value === 'string' &&
    Object.values(ProcessingStep).includes(value as ProcessingStep)
  );
}

/**
 * 檢查是否為有效的步驟優先級
 */
export function isStepPriority(value: unknown): value is StepPriority {
  return (
    typeof value === 'string' &&
    Object.values(StepPriority).includes(value as StepPriority)
  );
}

/**
 * 檢查是否為有效的文件類型
 */
export function isUnifiedFileType(value: unknown): value is UnifiedFileType {
  return (
    typeof value === 'string' &&
    Object.values(UnifiedFileType).includes(value as UnifiedFileType)
  );
}

/**
 * 檢查是否為有效的處理方法
 */
export function isUnifiedProcessingMethod(
  value: unknown
): value is UnifiedProcessingMethod {
  return (
    typeof value === 'string' &&
    Object.values(UnifiedProcessingMethod).includes(
      value as UnifiedProcessingMethod
    )
  );
}

/**
 * 檢查是否為有效的路由決策
 */
export function isUnifiedRoutingDecision(
  value: unknown
): value is UnifiedRoutingDecision {
  return (
    typeof value === 'string' &&
    Object.values(UnifiedRoutingDecision).includes(
      value as UnifiedRoutingDecision
    )
  );
}
