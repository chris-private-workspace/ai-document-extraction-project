/**
 * @fileoverview 模版欄位映射類型定義
 * @description
 *   定義第二層映射（標準欄位 → 模版欄位）的 TypeScript 類型
 *   支援三層優先級解析：FORMAT > COMPANY > GLOBAL
 *
 * @module src/types/template-field-mapping
 * @since Epic 19 - Story 19.1
 * @lastModified 2026-01-22
 *
 * @features
 *   - 映射範圍類型（GLOBAL, COMPANY, FORMAT）
 *   - 轉換類型（DIRECT, FORMULA, LOOKUP）
 *   - 映射規則結構定義
 *   - API 請求/響應類型
 *
 * @dependencies
 *   - Prisma generated types
 */

// ============================================================================
// Enums (從 Prisma 導出，但這裡定義為字串聯合以便前端使用)
// ============================================================================

/**
 * 映射範圍
 * 定義配置的作用範圍和優先級
 */
export type TemplateFieldMappingScope = 'GLOBAL' | 'COMPANY' | 'FORMAT';

/**
 * 轉換類型
 * 定義標準欄位到模版欄位的轉換方式
 */
export type FieldTransformType = 'DIRECT' | 'FORMULA' | 'LOOKUP' | 'CONCAT' | 'SPLIT' | 'CUSTOM' | 'AGGREGATE';

// ============================================================================
// Transform Parameters Types
// ============================================================================

/**
 * FORMULA 轉換參數
 * 支援變數佔位符和基本運算
 */
export interface FormulaTransformParams {
  /**
   * 公式表達式
   * 支援變數佔位符 {field_name}
   * 支援基本運算符 + - * / ( )
   * @example "{sea_freight} + {terminal_handling}"
   * @example "{total_amount} * 1.1"
   */
  formula: string;
}

/**
 * LOOKUP 轉換參數
 * 查表映射，支援預設值
 */
export interface LookupTransformParams {
  /**
   * 查表映射
   * key: 源值, value: 目標值
   * @example { "USD": "美金", "TWD": "台幣" }
   */
  lookupTable: Record<string, unknown>;
  /**
   * 查表失敗時的預設值
   */
  defaultValue?: unknown;
}

/**
 * CONCAT 轉換參數
 * 字串合併
 */
export interface ConcatTransformParams {
  /**
   * 合併的欄位列表
   */
  fields: string[];
  /**
   * 分隔符
   */
  separator?: string;
}

/**
 * SPLIT 轉換參數
 * 字串分割
 */
export interface SplitTransformParams {
  /**
   * 分隔符
   */
  separator: string;
  /**
   * 取第幾部分（0-indexed）
   */
  index: number;
}

/**
 * CUSTOM 轉換參數
 * 自定義 JavaScript 表達式
 */
export interface CustomTransformParams {
  /**
   * JavaScript 表達式
   * 可用變數: value（當前值）, row（整行數據）
   * @example "value.toUpperCase()"
   */
  expression: string;
}

/**
 * AGGREGATE 轉換參數
 * 從 lineItems/extraCharges 過濾 + 聚合
 * @since CHANGE-043 Phase 2
 */
export interface AggregateTransformParams {
  /** 數據源 */
  source: 'lineItems' | 'extraCharges' | 'all';
  /** 過濾條件 */
  filter: {
    /** 精確匹配 classifiedAs */
    classifiedAs?: string;
    /** 匹配 classifiedAs 列表中的任一項 */
    classifiedAsIn?: string[];
    /** 描述模式匹配（正則） */
    descriptionPattern?: string;
  };
  /** 聚合函數 */
  aggregation: 'SUM' | 'AVG' | 'COUNT' | 'FIRST' | 'LAST' | 'MAX' | 'MIN';
  /** 聚合欄位 */
  field: 'amount' | 'quantity' | 'unitPrice';
  /** 無匹配時的預設值 */
  defaultValue?: number | null;
}

/**
 * 轉換參數（聯合類型）
 */
export type TransformParams =
  | FormulaTransformParams
  | LookupTransformParams
  | ConcatTransformParams
  | SplitTransformParams
  | CustomTransformParams
  | AggregateTransformParams
  | null;

/**
 * FIX-128: 儲存時的未知來源 key 警告
 * @description 規則引用了該 scope 欄位定義 + 標準欄位之外的來源 key
 *   （拼錯或欄位尚未建立），執行時該項會被靜默視為 0 / 空值。
 */
export interface MappingSourceKeyWarning {
  /** 受影響的目標欄位 */
  targetField: string;
  /** 引用了但不存在的來源 key */
  unknownKeys: string[];
}

// ============================================================================
// Mapping Rule Types
// ============================================================================

/**
 * 單一映射規則
 * 定義一個標準欄位到模版欄位的映射
 */
export interface TemplateFieldMappingRule {
  /**
   * 規則 ID（用於編輯和追蹤）
   */
  id: string;
  /**
   * 源欄位名（標準欄位）
   * @example "sea_freight"
   */
  sourceField: string;
  /**
   * 目標欄位名（模版欄位）
   * @example "shipping_cost"
   */
  targetField: string;
  /**
   * 轉換類型
   */
  transformType: FieldTransformType;
  /**
   * 轉換參數（根據 transformType 不同而異）
   */
  transformParams?: TransformParams;
  /**
   * 目標欄位是否必填（從 DataTemplate 繼承或覆蓋）
   */
  isRequired: boolean;
  /**
   * 處理順序（數字越小越先處理）
   */
  order: number;
  /**
   * 規則說明
   */
  description?: string;
}

/**
 * 創建映射規則時的輸入（不含 ID）
 */
export type TemplateFieldMappingRuleInput = Omit<TemplateFieldMappingRule, 'id'>;

// ============================================================================
// Model Types
// ============================================================================

/**
 * 模版欄位映射配置
 * 完整的配置物件，包含所有欄位
 */
export interface TemplateFieldMapping {
  id: string;
  dataTemplateId: string;
  scope: TemplateFieldMappingScope;
  companyId: string | null;
  documentFormatId: string | null;
  name: string;
  description: string | null;
  mappings: TemplateFieldMappingRule[];
  priority: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

/**
 * 映射配置摘要（用於列表）
 * 簡化版本，減少數據傳輸
 */
export interface TemplateFieldMappingSummary {
  id: string;
  dataTemplateId: string;
  dataTemplateName: string;
  scope: TemplateFieldMappingScope;
  companyId: string | null;
  companyName: string | null;
  documentFormatId: string | null;
  documentFormatName: string | null;
  name: string;
  ruleCount: number;
  priority: number;
  isActive: boolean;
  updatedAt: string;
}

/**
 * 映射配置詳情（包含關聯資訊）
 */
export interface TemplateFieldMappingDetail extends TemplateFieldMapping {
  dataTemplateName: string;
  companyName: string | null;
  documentFormatName: string | null;
}

// ============================================================================
// Resolved Types (三層優先級解析後的結果)
// ============================================================================

/**
 * 解析後的映射配置
 * 合併多層配置後的結果
 */
export interface ResolvedMappingConfig {
  /**
   * 數據模版 ID
   */
  dataTemplateId: string;
  /**
   * 配置來源追蹤（從高優先級到低優先級）
   */
  resolvedFrom: Array<{
    id: string;
    scope: TemplateFieldMappingScope;
    name: string;
  }>;
  /**
   * 合併後的映射規則（高優先級覆蓋低優先級）
   */
  mappings: TemplateFieldMappingRule[];
}

// ============================================================================
// API Types
// ============================================================================

/**
 * 創建映射配置輸入
 */
export interface CreateTemplateFieldMappingInput {
  dataTemplateId: string;
  scope: TemplateFieldMappingScope;
  companyId?: string;
  documentFormatId?: string;
  name: string;
  description?: string;
  mappings: TemplateFieldMappingRuleInput[];
  priority?: number;
}

/**
 * 更新映射配置輸入
 */
export interface UpdateTemplateFieldMappingInput {
  name?: string;
  description?: string | null;
  mappings?: TemplateFieldMappingRuleInput[];
  priority?: number;
  isActive?: boolean;
}

/**
 * 列表篩選參數
 */
export interface TemplateFieldMappingFilters {
  dataTemplateId?: string;
  scope?: TemplateFieldMappingScope;
  companyId?: string;
  documentFormatId?: string;
  isActive?: boolean;
  search?: string;
}

/**
 * 解析請求參數
 */
export interface ResolveMappingParams {
  dataTemplateId: string;
  companyId?: string;
  documentFormatId?: string;
}

/**
 * 列表查詢參數
 */
export interface TemplateFieldMappingQueryParams extends TemplateFieldMappingFilters {
  page?: number;
  limit?: number;
}

// ============================================================================
// API Response Types
// ============================================================================

/**
 * 列表響應
 */
export interface TemplateFieldMappingListResponse {
  mappings: TemplateFieldMappingSummary[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * 範圍顯示名稱
 */
export const SCOPE_LABELS: Record<TemplateFieldMappingScope, string> = {
  GLOBAL: '全局',
  COMPANY: '公司',
  FORMAT: '格式',
};

/**
 * 範圍優先級（數字越大優先級越高）
 */
export const SCOPE_PRIORITY: Record<TemplateFieldMappingScope, number> = {
  GLOBAL: 1,
  COMPANY: 2,
  FORMAT: 3,
};

/**
 * 轉換類型顯示名稱
 */
export const TRANSFORM_TYPE_LABELS: Record<FieldTransformType, string> = {
  DIRECT: '直接映射',
  FORMULA: '公式計算',
  LOOKUP: '查表映射',
  CONCAT: '字串合併',
  SPLIT: '字串分割',
  CUSTOM: '自定義',
  AGGREGATE: '行項目聚合',
};

/**
 * 範圍選項（用於下拉選單）
 */
export const SCOPE_OPTIONS = [
  { value: 'GLOBAL' as const, label: '全局' },
  { value: 'COMPANY' as const, label: '公司' },
  { value: 'FORMAT' as const, label: '格式' },
];

/**
 * 轉換類型選項（用於下拉選單）
 */
export const TRANSFORM_TYPE_OPTIONS = [
  { value: 'DIRECT' as const, label: '直接映射', description: '一對一直接對應' },
  { value: 'FORMULA' as const, label: '公式計算', description: '支援 {field} + {field} 運算' },
  { value: 'LOOKUP' as const, label: '查表映射', description: '根據對照表轉換值' },
  { value: 'CONCAT' as const, label: '字串合併', description: '合併多個欄位' },
  { value: 'SPLIT' as const, label: '字串分割', description: '分割欄位取部分值' },
  { value: 'CUSTOM' as const, label: '自定義', description: 'JavaScript 表達式' },
  { value: 'AGGREGATE' as const, label: '行項目聚合', description: '從 lineItems 過濾並聚合費用' },
];
