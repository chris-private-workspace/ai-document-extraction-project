/**
 * @fileoverview 模版實例類型定義
 * @description
 *   提供 TemplateInstance 和 TemplateInstanceRow 的 TypeScript 類型定義
 *   包含狀態枚舉、資料結構、API 請求/響應類型
 *
 * @module src/types/template-instance
 * @since Epic 19 - Story 19.2
 * @lastModified 2026-01-22
 *
 * @features
 *   - 模版實例狀態類型（DRAFT, PROCESSING, COMPLETED, EXPORTED, ERROR）
 *   - 實例行狀態類型（PENDING, VALID, INVALID, SKIPPED）
 *   - 完整的 DTO 和摘要類型
 *   - 驗證結果類型
 *
 * @dependencies
 *   - src/types/data-template.ts - DataTemplateField 類型
 */

// ============================================================================
// Status Enums
// ============================================================================

/**
 * 模版實例狀態
 * @description
 *   - DRAFT: 草稿，可編輯
 *   - PROCESSING: 處理中
 *   - COMPLETED: 完成，數據已填充
 *   - EXPORTED: 已導出
 *   - ERROR: 錯誤
 */
export type TemplateInstanceStatus =
  | 'DRAFT'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'EXPORTED'
  | 'ERROR';

/**
 * 模版實例行狀態
 * @description
 *   - PENDING: 待驗證
 *   - VALID: 驗證通過
 *   - INVALID: 驗證失敗
 *   - SKIPPED: 跳過
 */
export type TemplateInstanceRowStatus =
  | 'PENDING'
  | 'VALID'
  | 'INVALID'
  | 'SKIPPED';

// ============================================================================
// Core Interfaces
// ============================================================================

/**
 * 模版實例（完整版）
 * @description 包含所有欄位的完整模版實例資料
 */
export interface TemplateInstance {
  /** 唯一識別碼 */
  id: string;
  /** 關聯的數據模版 ID */
  dataTemplateId: string;
  /** 實例名稱 */
  name: string;
  /** 描述 */
  description?: string | null;
  /** 狀態 */
  status: TemplateInstanceStatus;
  /** 總行數 */
  rowCount: number;
  /** 有效行數 */
  validRowCount: number;
  /** 錯誤行數 */
  errorRowCount: number;
  /** 導出時間 */
  exportedAt?: string | null;
  /** 導出者 */
  exportedBy?: string | null;
  /** 導出格式 */
  exportFormat?: string | null;
  /** 建立時間 */
  createdAt: string;
  /** 更新時間 */
  updatedAt: string;
  /** 建立者 */
  createdBy?: string | null;
}

/**
 * 模版實例（帶關聯）
 * @description 包含數據模版資訊的實例
 */
export interface TemplateInstanceWithTemplate extends TemplateInstance {
  /** 數據模版名稱 */
  dataTemplateName: string;
}

/**
 * 模版實例摘要
 * @description 用於列表顯示的精簡版本
 */
export interface TemplateInstanceSummary {
  /** 唯一識別碼 */
  id: string;
  /** 關聯的數據模版 ID */
  dataTemplateId: string;
  /** 數據模版名稱 */
  dataTemplateName: string;
  /** 實例名稱 */
  name: string;
  /** 狀態 */
  status: TemplateInstanceStatus;
  /** 總行數 */
  rowCount: number;
  /** 有效行數 */
  validRowCount: number;
  /** 錯誤行數 */
  errorRowCount: number;
  /** 導出時間 */
  exportedAt?: string | null;
  /** 更新時間 */
  updatedAt: string;
}

/**
 * 模版實例行
 * @description 實例中的單行數據
 */
export interface TemplateInstanceRow {
  /** 唯一識別碼 */
  id: string;
  /** 關聯的實例 ID */
  templateInstanceId: string;
  /** 行識別碼（如 shipment_no） */
  rowKey: string;
  /** 行索引 */
  rowIndex: number;
  /** 來源文件 IDs */
  sourceDocumentIds: string[];
  /** 來源文件（id + 檔名；CHANGE-091 1.6 列表查詢一併回傳，供 UI 顯示檔名） */
  sourceDocuments?: { id: string; fileName: string }[];
  /** 欄位值 */
  fieldValues: Record<string, unknown>;
  /** 驗證錯誤 */
  validationErrors?: Record<string, string> | null;
  /** 轉換診斷：targetField → 引用了不存在的來源 key 清單（FIX-128） */
  transformDiagnostics?: Record<string, string[]> | null;
  /** 行狀態 */
  status: TemplateInstanceRowStatus;
  /** 建立時間 */
  createdAt: string;
  /** 更新時間 */
  updatedAt: string;
}

// ============================================================================
// Validation Types
// ============================================================================

/**
 * 驗證結果
 * @description 行數據驗證的結果
 */
export interface ValidationResult {
  /** 是否通過驗證 */
  isValid: boolean;
  /** 欄位錯誤映射（欄位名 → 錯誤訊息） */
  errors?: Record<string, string>;
}

/**
 * 批量驗證結果
 * @description 多行驗證的統計結果
 */
export interface BatchValidationResult {
  /** 有效行數 */
  valid: number;
  /** 無效行數 */
  invalid: number;
  /** 總行數 */
  total: number;
}

// ============================================================================
// Filter Types
// ============================================================================

/**
 * 模版實例篩選條件
 */
export interface TemplateInstanceFilters {
  /** 按數據模版篩選 */
  dataTemplateId?: string;
  /** 按狀態篩選 */
  status?: TemplateInstanceStatus;
  /** 搜尋關鍵字（名稱、描述） */
  search?: string;
  /** 開始日期 */
  dateFrom?: string;
  /** 結束日期 */
  dateTo?: string;
  /** 建立者 */
  createdBy?: string;
}

/**
 * 模版實例行篩選條件
 */
export interface TemplateInstanceRowFilters {
  /** 按行狀態篩選 */
  status?: TemplateInstanceRowStatus;
  /** 搜尋關鍵字（rowKey） */
  search?: string;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

/**
 * 創建模版實例輸入
 */
export interface CreateTemplateInstanceInput {
  /** 數據模版 ID */
  dataTemplateId: string;
  /** 實例名稱 */
  name: string;
  /** 描述 */
  description?: string;
}

/**
 * 更新模版實例輸入
 */
export interface UpdateTemplateInstanceInput {
  /** 實例名稱 */
  name?: string;
  /** 描述 */
  description?: string | null;
}

/**
 * 添加行輸入
 */
export interface AddRowInput {
  /** 行識別碼（如 shipment_no） */
  rowKey: string;
  /** 來源文件 IDs */
  sourceDocumentIds?: string[];
  /** 欄位值 */
  fieldValues: Record<string, unknown>;
}

/**
 * 更新行輸入
 */
export interface UpdateRowInput {
  /** 行識別碼 */
  rowKey?: string;
  /** 來源文件 IDs */
  sourceDocumentIds?: string[];
  /** 欄位值 */
  fieldValues?: Record<string, unknown>;
  /** 行狀態 */
  status?: TemplateInstanceRowStatus;
}

/**
 * 狀態變更輸入
 */
export interface ChangeStatusInput {
  /** 新狀態 */
  status: TemplateInstanceStatus;
  /** 錯誤訊息（當狀態為 ERROR 時） */
  errorMessage?: string;
}

/**
 * 標記導出輸入
 */
export interface MarkExportedInput {
  /** 導出格式 */
  format: 'xlsx' | 'csv' | 'json';
  /** 導出者 */
  exportedBy?: string;
}

// ============================================================================
// Status Transition Constants
// ============================================================================

/**
 * 狀態轉換規則
 * @description
 *   定義每個狀態可以轉換到的目標狀態列表
 *
 *   DRAFT → PROCESSING, COMPLETED (CHANGE-037: 自動匹配完成後可直接轉為 COMPLETED)
 *   PROCESSING → COMPLETED, ERROR
 *   COMPLETED → EXPORTED
 *   EXPORTED → (終態)
 *   ERROR → PROCESSING (重試)
 */
export const STATUS_TRANSITIONS: Record<TemplateInstanceStatus, TemplateInstanceStatus[]> = {
  DRAFT: ['PROCESSING', 'COMPLETED'],
  PROCESSING: ['COMPLETED', 'ERROR'],
  COMPLETED: ['EXPORTED'],
  EXPORTED: [],
  ERROR: ['PROCESSING'], // 允許重試
};

/**
 * 可刪除的狀態
 * @description 只有 DRAFT 狀態可以刪除
 */
export const DELETABLE_STATUSES: TemplateInstanceStatus[] = ['DRAFT'];

/**
 * 可編輯的狀態
 * @description DRAFT 和 ERROR 狀態可以編輯
 */
export const EDITABLE_STATUSES: TemplateInstanceStatus[] = ['DRAFT', 'ERROR'];

// ============================================================================
// List Response Types
// ============================================================================

/**
 * 模版實例列表響應
 */
export interface TemplateInstanceListResponse {
  instances: TemplateInstanceSummary[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/**
 * 模版實例行列表響應
 */
export interface TemplateInstanceRowListResponse {
  rows: TemplateInstanceRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
