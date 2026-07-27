/**
 * @fileoverview 模版匹配引擎類型定義
 * @description
 *   定義模版匹配引擎相關的 TypeScript 類型
 *   包含匹配參數、結果、進度回調等
 *
 * @module src/types/template-matching-engine
 * @since Epic 19 - Story 19.3
 * @lastModified 2026-01-22
 *
 * @features
 *   - 匹配參數定義
 *   - 匹配結果定義
 *   - 進度回調定義
 *   - 錯誤類型定義
 *
 * @dependencies
 *   - src/types/template-instance.ts - 實例類型
 */

// TemplateInstanceRowStatus 已在 types 中直接定義，無需從 template-instance 導入

// ============================================================================
// Match Parameters
// ============================================================================

/**
 * 匹配選項
 * @description 控制匹配行為的配置選項
 */
export interface MatchOptions {
  /**
   * 用於提取 rowKey 的欄位名稱
   * @default 'shipment_no'
   */
  rowKeyField?: string;

  /**
   * 公司 ID（用於解析映射規則）
   */
  companyId?: string;

  /**
   * 文件格式 ID（用於解析映射規則）
   */
  formatId?: string;

  /**
   * 批量處理大小
   * @default 100
   */
  batchSize?: number;

  /**
   * 是否跳過驗證
   * @default false
   */
  skipValidation?: boolean;

  /**
   * 進度回調函數
   */
  onProgress?: (progress: MatchProgress) => void;
}

/**
 * 匹配文件參數
 * @description matchDocuments 方法的輸入參數
 */
export interface MatchDocumentsParams {
  /**
   * 要處理的文件 ID 列表
   */
  documentIds: string[];

  /**
   * 目標模版實例 ID
   */
  templateInstanceId: string;

  /**
   * 匹配選項
   */
  options?: MatchOptions;
}

// ============================================================================
// Match Progress
// ============================================================================

/**
 * 匹配進度
 * @description 進度回調函數接收的參數
 */
export interface MatchProgress {
  /**
   * 已處理的文件數量
   */
  processed: number;

  /**
   * 總文件數量
   */
  total: number;

  /**
   * 目前正在處理的批次編號（從 1 開始）
   */
  currentBatch?: number;

  /**
   * 總批次數量
   */
  totalBatches?: number;

  /**
   * 進度百分比 (0-100)
   */
  percentage?: number;
}

// ============================================================================
// Match Results
// ============================================================================

/**
 * 單行匹配結果
 * @description 單一文件/行的處理結果
 */
export interface RowResult {
  /**
   * 來源文件 ID
   */
  documentId: string;

  /**
   * 建立的行 ID（如果成功）
   */
  rowId: string | null;

  /**
   * 行識別碼
   */
  rowKey: string | null;

  /**
   * 處理狀態
   */
  status: 'VALID' | 'INVALID' | 'ERROR' | 'SKIPPED';

  /**
   * 錯誤詳情（欄位名 → 錯誤訊息）
   */
  errors?: Record<string, string>;

  /**
   * 轉換診斷：targetField → 引用了 row 中不存在的來源 key 清單
   * @description 非空表示該目標欄位的映射規則引用了不存在的來源欄位
   *   （拼錯或欄位定義缺失），對應項在計算時被靜默視為 0 / 空值。
   * @since FIX-128
   */
  unresolvedSourceKeys?: Record<string, string[]>;
}

/**
 * 匹配結果
 * @description matchDocuments 方法的返回值
 */
export interface MatchResult {
  /**
   * 模版實例 ID
   */
  instanceId: string;

  /**
   * 處理的文件總數
   */
  totalDocuments: number;

  /**
   * 產生的行總數
   */
  totalRows: number;

  /**
   * 有效行數
   */
  validRows: number;

  /**
   * 無效行數
   */
  invalidRows: number;

  /**
   * 錯誤行數
   */
  errorRows: number;

  /**
   * 各行的詳細結果
   */
  results: RowResult[];
}

// ============================================================================
// Preview Types
// ============================================================================

/**
 * 預覽匹配參數
 * @description preview 方法的輸入參數
 */
export interface PreviewMatchParams {
  /**
   * 要預覽的文件 ID 列表
   */
  documentIds: string[];

  /**
   * 數據模版 ID
   */
  dataTemplateId: string;

  /**
   * 公司 ID（用於解析映射規則）
   */
  companyId?: string;

  /**
   * 文件格式 ID（用於解析映射規則）
   */
  formatId?: string;

  /**
   * 用於提取 rowKey 的欄位名稱
   */
  rowKeyField?: string;
}

/**
 * 預覽行結果
 * @description 單行的預覽結果
 */
export interface PreviewRowResult {
  /**
   * 來源文件 ID
   */
  documentId: string;

  /**
   * 行識別碼
   */
  rowKey: string;

  /**
   * 轉換後的欄位值
   */
  fieldValues: Record<string, unknown>;

  /**
   * 驗證結果
   */
  validation: {
    isValid: boolean;
    errors?: Record<string, string>;
  };

  /**
   * 轉換診斷：targetField → 引用了 row 中不存在的來源 key 清單
   * @since FIX-128
   */
  unresolvedSourceKeys?: Record<string, string[]>;
}

/**
 * 預覽匹配結果
 * @description preview 方法的返回值
 */
export interface PreviewMatchResult {
  /**
   * 數據模版 ID
   */
  dataTemplateId: string;

  /**
   * 使用的映射配置來源
   */
  mappingSources: Array<{
    id: string;
    scope: string;
    name: string;
  }>;

  /**
   * 預覽行列表
   */
  rows: PreviewRowResult[];

  /**
   * 預覽統計
   */
  summary: {
    totalDocuments: number;
    validRows: number;
    invalidRows: number;
  };
}

// ============================================================================
// Validation Types
// ============================================================================

/**
 * 驗證映射配置參數
 */
export interface ValidateMappingParams {
  /**
   * 數據模版 ID
   */
  dataTemplateId: string;

  /**
   * 公司 ID
   */
  companyId?: string;

  /**
   * 文件格式 ID
   */
  formatId?: string;
}

/**
 * 驗證映射配置結果
 */
export interface ValidateMappingResult {
  /**
   * 是否有效
   */
  isValid: boolean;

  /**
   * 映射配置來源
   */
  sources: Array<{
    id: string;
    scope: string;
    name: string;
  }>;

  /**
   * 映射規則數量
   */
  ruleCount: number;

  /**
   * 目標欄位列表
   */
  targetFields: string[];

  /**
   * 缺失的必填欄位
   */
  missingRequiredFields: string[];

  /**
   * 驗證錯誤
   */
  errors: Array<{
    targetField: string;
    error: string;
  }>;
}

// ============================================================================
// Upsert Row Types
// ============================================================================

/**
 * Upsert 行參數
 * @description 用於創建或更新行的內部參數
 */
export interface UpsertRowParams {
  /**
   * 模版實例 ID
   */
  instanceId: string;

  /**
   * 行識別碼
   */
  rowKey: string;

  /**
   * 來源文件 ID
   */
  documentId: string;

  /**
   * 轉換後的欄位值
   */
  fieldValues: Record<string, unknown>;

  /**
   * 驗證結果
   */
  validation: {
    isValid: boolean;
    errors?: Record<string, string>;
  };

  /**
   * 轉換診斷：targetField → 引用了 row 中不存在的來源 key 清單
   * @since FIX-128
   */
  unresolvedSourceKeys?: Record<string, string[]>;

  /**
   * 新列使用的 rowIndex（由 processBatch 於交易前統一分配並遞增，
   * 取代每列各查一次 findFirst；僅在建立新列時生效）
   * @since FIX-132
   */
  rowIndex: number;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

/**
 * 執行匹配 API 請求
 */
export interface ExecuteMatchRequest {
  documentIds: string[];
  templateInstanceId: string;
  options?: {
    rowKeyField?: string;
    companyId?: string;
    formatId?: string;
    batchSize?: number;
    skipValidation?: boolean;
  };
}

/**
 * 預覽匹配 API 請求
 */
export interface PreviewMatchRequest {
  documentIds: string[];
  dataTemplateId: string;
  companyId?: string;
  formatId?: string;
  rowKeyField?: string;
}

/**
 * 驗證映射 API 請求
 */
export interface ValidateMappingRequest {
  dataTemplateId: string;
  companyId?: string;
  formatId?: string;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * 匹配引擎錯誤代碼
 */
export enum MatchingErrorCode {
  /** 實例不存在 */
  INSTANCE_NOT_FOUND = 'INSTANCE_NOT_FOUND',
  /** 模版不存在 */
  TEMPLATE_NOT_FOUND = 'TEMPLATE_NOT_FOUND',
  /** 文件不存在 */
  DOCUMENT_NOT_FOUND = 'DOCUMENT_NOT_FOUND',
  /** 映射配置不存在 */
  MAPPING_NOT_FOUND = 'MAPPING_NOT_FOUND',
  /** 轉換失敗 */
  TRANSFORM_FAILED = 'TRANSFORM_FAILED',
  /** 驗證失敗 */
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  /** 實例狀態不允許 */
  INVALID_INSTANCE_STATUS = 'INVALID_INSTANCE_STATUS',
}

/**
 * 匹配引擎錯誤
 */
export class MatchingEngineError extends Error {
  constructor(
    message: string,
    public code: MatchingErrorCode,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'MatchingEngineError';
  }
}
