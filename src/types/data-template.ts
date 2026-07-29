/**
 * @fileoverview 數據模版類型定義
 * @description
 *   定義 DataTemplate 模型的 TypeScript 類型，包括：
 *   - 模版欄位定義結構
 *   - 模版詳情和摘要類型
 *   - API 響應和請求類型
 *   - 常數和選項定義
 *
 * @module src/types/data-template
 * @since Epic 16 - Story 16.7
 * @lastModified 2026-01-13
 *
 * @features
 *   - 模版欄位結構定義（DataTemplateField）
 *   - 支援多種資料類型（string, number, date, currency, boolean, array）
 *   - 欄位驗證規則定義
 *   - API 請求/響應類型
 *
 * @dependencies
 *   - Prisma DataTemplate 模型
 *   - src/types/field-mapping.ts（ConfigScope）
 */

// ============================================================================
// Field Types
// ============================================================================

/**
 * 欄位資料類型
 * @description
 *   定義模版欄位支援的資料類型，用於驗證和格式化
 */
export type DataTemplateFieldType =
  | 'string'    // 文字
  | 'number'    // 數字
  | 'date'      // 日期
  | 'currency'  // 金額
  | 'boolean'   // 布林值
  | 'array';    // 陣列

/**
 * 欄位驗證規則
 * @description
 *   定義欄位的驗證規則，用於資料輸入驗證
 */
export interface FieldValidation {
  /** 正則表達式（用於字串驗證） */
  pattern?: string;
  /** 最小值（數字/金額） */
  min?: number;
  /** 最大值（數字/金額） */
  max?: number;
  /** 最大長度（字串） */
  maxLength?: number;
  /** 最小長度（字串） */
  minLength?: number;
  /** 允許的值列表（枚舉） */
  allowedValues?: string[];
}

/**
 * 模版欄位定義
 * @description
 *   定義單一欄位的完整結構，包含名稱、類型、驗證等資訊
 */
export interface DataTemplateField {
  /** 欄位名稱（唯一識別符，snake_case） */
  name: string;
  /** 顯示標籤（用於 UI 顯示） */
  label: string;
  /** 資料類型 */
  dataType: DataTemplateFieldType;
  /** 是否必填 */
  isRequired: boolean;
  /** 預設值 */
  defaultValue?: string | number | boolean | null;
  /** 驗證規則 */
  validation?: FieldValidation;
  /** 欄位說明 */
  description?: string;
  /** 排序順序（從 1 開始） */
  order: number;
}

// ============================================================================
// Model Types
// ============================================================================

/**
 * 配置範圍
 * @description
 *   定義模版的可見範圍
 *   - GLOBAL: 全局可用，所有公司都可使用
 *   - COMPANY: 公司專屬，僅特定公司可使用
 */
export type DataTemplateScope = 'GLOBAL' | 'COMPANY';

/**
 * 行項目分列模式
 *
 * @description
 *   決定一份文件在模板實例中展開成幾列：
 *   - `PIVOT`：1 份文件 = 1 列，費用按分類聚合為欄（CHANGE-043，現行預設）
 *   - `EXPAND`：1 筆費用 = 1 列（逐筆審計核對用，原 CHANGE-044）
 *   - `GROUP`：1 個分組鍵 = 1 列，組內費用再聚合為欄 —— 供「一份發票對應多個
 *     shipment」的文件（如 DHL：一張發票含多個 AWB，各有自己的費用）
 *
 * @since CHANGE-113 階段二
 */
export type LineItemMode = 'PIVOT' | 'EXPAND' | 'GROUP';

/**
 * 行項目分列模式值域
 *
 * @description
 *   供 Zod 驗證與 UI 選單迭代使用。**不含顯示文字** —— 模式名稱與說明一律走 i18n
 *   （`dataTemplate.lineItemMode.*`），避免 CHANGE-088 治理過的「常量硬編碼中文
 *   導致英文介面顯示中文」問題重現。
 *
 * @since CHANGE-113 階段二
 */
export const LINE_ITEM_MODES = ['PIVOT', 'EXPAND', 'GROUP'] as const;

/**
 * 預設行項目分列模式（與 Prisma schema 的 `@default("PIVOT")` 一致）
 * @since CHANGE-113 階段二
 */
export const DEFAULT_LINE_ITEM_MODE: LineItemMode = 'PIVOT';

/**
 * 數據模版完整類型
 * @description
 *   對應 Prisma DataTemplate 模型的完整類型定義
 */
export interface DataTemplate {
  /** 唯一識別符（CUID） */
  id: string;
  /** 模版名稱 */
  name: string;
  /** 模版說明 */
  description?: string | null;
  /** 配置範圍 */
  scope: DataTemplateScope;
  /** 公司 ID（範圍為 COMPANY 時必填） */
  companyId?: string | null;
  /** 欄位定義列表 */
  fields: DataTemplateField[];
  /** CHANGE-113: 行項目分列模式 */
  lineItemMode: LineItemMode;
  /** 是否啟用 */
  isActive: boolean;
  /** 是否為系統模版（系統模版不可修改/刪除） */
  isSystem: boolean;
  /** 創建時間 */
  createdAt: string;
  /** 更新時間 */
  updatedAt: string;
  /** 創建者 ID */
  createdBy?: string | null;
}

/**
 * 數據模版摘要（列表顯示用）
 * @description
 *   用於列表頁面顯示的精簡版模版資訊
 */
export interface DataTemplateSummary {
  /** 唯一識別符 */
  id: string;
  /** 模版名稱 */
  name: string;
  /** 模版說明 */
  description?: string | null;
  /** 配置範圍 */
  scope: DataTemplateScope;
  /** 公司 ID */
  companyId?: string | null;
  /** 公司名稱（JOIN 取得） */
  companyName?: string | null;
  /** 欄位數量 */
  fieldCount: number;
  /** 是否啟用 */
  isActive: boolean;
  /** 是否為系統模版 */
  isSystem: boolean;
  /** 更新時間 */
  updatedAt: string;
  /** 使用中的映射配置數量 */
  usageCount: number;
}

// ============================================================================
// API Types
// ============================================================================

/**
 * 創建模版輸入
 */
export interface CreateDataTemplateInput {
  /** 模版名稱 */
  name: string;
  /** 模版說明 */
  description?: string;
  /** 配置範圍 */
  scope: DataTemplateScope;
  /** 公司 ID（範圍為 COMPANY 時必填） */
  companyId?: string;
  /** 欄位定義列表 */
  fields: DataTemplateField[];
  /** CHANGE-113: 行項目分列模式（未指定時為 PIVOT） */
  lineItemMode?: LineItemMode;
}

/**
 * 更新模版輸入
 */
export interface UpdateDataTemplateInput {
  /** 模版名稱 */
  name?: string;
  /** 模版說明 */
  description?: string | null;
  /** 欄位定義列表 */
  fields?: DataTemplateField[];
  /** CHANGE-113: 行項目分列模式 */
  lineItemMode?: LineItemMode;
  /** 是否啟用 */
  isActive?: boolean;
}

/**
 * 模版列表篩選條件
 */
export interface DataTemplateFilters {
  /** 按範圍篩選 */
  scope?: DataTemplateScope;
  /** 按公司篩選 */
  companyId?: string;
  /** 按啟用狀態篩選 */
  isActive?: boolean;
  /** 按系統模版篩選 */
  isSystem?: boolean;
  /** 搜尋關鍵字（名稱或說明） */
  search?: string;
}

/**
 * 模版列表響應
 */
export interface DataTemplateListResponse {
  /** 模版列表 */
  templates: DataTemplateSummary[];
  /** 分頁資訊 */
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/**
 * 可用模版選項（下拉選單用）
 */
export interface DataTemplateOption {
  /** 模版 ID */
  id: string;
  /** 模版名稱 */
  name: string;
  /** 配置範圍 */
  scope: DataTemplateScope;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * 範圍顯示名稱
 */
export const SCOPE_LABELS: Record<DataTemplateScope, string> = {
  GLOBAL: '全局',
  COMPANY: '公司',
};

/**
 * 範圍選項（下拉選單用）
 */
export const SCOPE_OPTIONS: Array<{ value: DataTemplateScope; label: string }> = [
  { value: 'GLOBAL', label: '全局' },
  { value: 'COMPANY', label: '公司' },
];

/**
 * 欄位類型顯示名稱
 */
export const FIELD_TYPE_LABELS: Record<DataTemplateFieldType, string> = {
  string: '文字',
  number: '數字',
  date: '日期',
  currency: '金額',
  boolean: '布林值',
  array: '陣列',
};

/**
 * 欄位類型選項（下拉選單用）
 */
export const FIELD_TYPE_OPTIONS: Array<{ value: DataTemplateFieldType; label: string }> =
  Object.entries(FIELD_TYPE_LABELS).map(([value, label]) => ({
    value: value as DataTemplateFieldType,
    label,
  }));

/**
 * 欄位類型圖示
 */
export const FIELD_TYPE_ICONS: Record<DataTemplateFieldType, string> = {
  string: 'Type',
  number: 'Hash',
  date: 'Calendar',
  currency: 'DollarSign',
  boolean: 'ToggleLeft',
  array: 'List',
};

/**
 * 預設欄位驗證規則
 */
export const DEFAULT_FIELD_VALIDATION: Record<DataTemplateFieldType, FieldValidation | undefined> = {
  string: { maxLength: 500 },
  number: undefined,
  date: undefined,
  currency: { min: 0 },
  boolean: undefined,
  array: undefined,
};
