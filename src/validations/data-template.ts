/**
 * @fileoverview 數據模版驗證 Schema
 * @description
 *   提供 DataTemplate 相關的 Zod 驗證 Schema，包括：
 *   - 欄位驗證規則 Schema
 *   - 模版欄位 Schema
 *   - 創建/更新模版 Schema
 *
 * @module src/validations/data-template
 * @since Epic 16 - Story 16.7
 * @lastModified 2026-01-13
 *
 * @features
 *   - 欄位名稱格式驗證（snake_case）
 *   - 範圍和公司 ID 關聯驗證
 *   - 欄位數量限制（1-100）
 *
 * @dependencies
 *   - zod - 驗證庫
 *   - src/types/data-template.ts - 類型定義
 */

import { z } from 'zod';
import { LINE_ITEM_MODES } from '@/types/data-template';

// ============================================================================
// Field Validation Schemas
// ============================================================================

/**
 * 欄位驗證規則 Schema
 * @description
 *   定義 FieldValidation 物件的驗證規則
 */
export const fieldValidationSchema = z.object({
  /** 正則表達式 */
  pattern: z.string().optional(),
  /** 最小值（數字） */
  min: z.number().optional(),
  /** 最大值（數字） */
  max: z.number().optional(),
  /** 最大長度（字串） */
  maxLength: z.number().int().positive().optional(),
  /** 最小長度（字串） */
  minLength: z.number().int().nonnegative().optional(),
  /** 允許的值列表 */
  allowedValues: z.array(z.string()).optional(),
}).optional();

/**
 * 模版欄位 Schema
 * @description
 *   定義 DataTemplateField 物件的驗證規則
 */
export const dataTemplateFieldSchema = z.object({
  /** 欄位名稱（必須為有效的識別符） */
  name: z.string()
    .min(1, '欄位名稱不能為空')
    .max(100, '欄位名稱不能超過 100 個字元')
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, '欄位名稱只能包含字母、數字和底線，且必須以字母或底線開頭'),

  /** 顯示標籤 */
  label: z.string()
    .min(1, '顯示標籤不能為空')
    .max(200, '顯示標籤不能超過 200 個字元'),

  /** 資料類型 */
  dataType: z.enum(['string', 'number', 'date', 'currency', 'boolean', 'array'], {
    message: '請選擇有效的資料類型',
  }),

  /** 是否必填 */
  isRequired: z.boolean().default(false),

  /** 預設值 */
  defaultValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),

  /** 驗證規則 */
  validation: fieldValidationSchema,

  /** 欄位說明 */
  description: z.string().max(500, '欄位說明不能超過 500 個字元').optional(),

  /** 排序順序 */
  order: z.number().int().nonnegative('排序順序必須為非負整數'),
});

// ============================================================================
// Template Schemas
// ============================================================================

/**
 * 創建模版 Schema
 * @description
 *   驗證創建新模版的輸入資料
 */
export const createDataTemplateSchema = z.object({
  /** 模版名稱 */
  name: z.string()
    .min(1, '模版名稱不能為空')
    .max(200, '模版名稱不能超過 200 個字元'),

  /** 模版說明 */
  description: z.string().max(1000, '模版說明不能超過 1000 個字元').optional(),

  /** 配置範圍 */
  scope: z.enum(['GLOBAL', 'COMPANY'], {
    message: '請選擇有效的配置範圍',
  }).default('GLOBAL'),

  /** 公司 ID */
  companyId: z.string().cuid('公司 ID 格式不正確').optional().nullable(),

  /** 欄位定義列表 */
  fields: z.array(dataTemplateFieldSchema)
    .min(1, '至少需要定義一個欄位')
    .max(100, '欄位數量不能超過 100 個'),

  /** CHANGE-113: 行項目分列模式（省略時由 Prisma 的 @default("PIVOT") 決定） */
  lineItemMode: z.enum(LINE_ITEM_MODES, {
    message: '請選擇有效的行項目分列模式',
  }).optional(),
}).refine(
  (data) => {
    // COMPANY 範圍需要 companyId
    if (data.scope === 'COMPANY' && !data.companyId) {
      return false;
    }
    return true;
  },
  { message: '公司範圍需要選擇公司', path: ['companyId'] }
).refine(
  (data) => {
    // 檢查欄位名稱唯一性
    const names = data.fields.map(f => f.name);
    return new Set(names).size === names.length;
  },
  { message: '欄位名稱必須唯一', path: ['fields'] }
);

/**
 * 更新模版 Schema
 * @description
 *   驗證更新模版的輸入資料（所有欄位可選）
 */
export const updateDataTemplateSchema = z.object({
  /** 模版名稱 */
  name: z.string()
    .min(1, '模版名稱不能為空')
    .max(200, '模版名稱不能超過 200 個字元')
    .optional(),

  /** 模版說明 */
  description: z.string().max(1000, '模版說明不能超過 1000 個字元').optional().nullable(),

  /** 欄位定義列表 */
  fields: z.array(dataTemplateFieldSchema)
    .min(1, '至少需要定義一個欄位')
    .max(100, '欄位數量不能超過 100 個')
    .optional(),

  /** CHANGE-113: 行項目分列模式 */
  lineItemMode: z.enum(LINE_ITEM_MODES, {
    message: '請選擇有效的行項目分列模式',
  }).optional(),

  /** 是否啟用 */
  isActive: z.boolean().optional(),
}).refine(
  (data) => {
    // 如果有更新欄位，檢查欄位名稱唯一性
    if (data.fields) {
      const names = data.fields.map(f => f.name);
      return new Set(names).size === names.length;
    }
    return true;
  },
  { message: '欄位名稱必須唯一', path: ['fields'] }
);

/**
 * 模版列表查詢參數 Schema
 * @description
 *   驗證列表查詢的 URL 參數
 */
export const dataTemplateQuerySchema = z.object({
  /** 按範圍篩選 */
  scope: z.enum(['GLOBAL', 'COMPANY']).optional(),
  /** 按公司篩選 */
  companyId: z.string().cuid().optional(),
  /** 按啟用狀態篩選 */
  isActive: z.coerce.boolean().optional(),
  /** 按系統模版篩選 */
  isSystem: z.coerce.boolean().optional(),
  /** 搜尋關鍵字 */
  search: z.string().optional(),
  /** 頁碼 */
  page: z.coerce.number().int().positive().default(1),
  /** 每頁數量 */
  limit: z.coerce.number().int().positive().max(100).default(20),
});

// ============================================================================
// Type Exports
// ============================================================================

/** 創建模版輸入類型 */
export type CreateDataTemplateInput = z.infer<typeof createDataTemplateSchema>;

/** 更新模版輸入類型 */
export type UpdateDataTemplateInput = z.infer<typeof updateDataTemplateSchema>;

/** 模版欄位輸入類型 */
export type DataTemplateFieldInput = z.infer<typeof dataTemplateFieldSchema>;

/** 欄位驗證規則輸入類型 */
export type FieldValidationInput = z.infer<typeof fieldValidationSchema>;

/** 列表查詢參數類型 */
export type DataTemplateQueryParams = z.infer<typeof dataTemplateQuerySchema>;
