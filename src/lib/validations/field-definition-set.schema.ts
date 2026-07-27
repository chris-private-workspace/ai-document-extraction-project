/**
 * @fileoverview FieldDefinitionSet 驗證 Schema
 * @description
 *   使用 Zod 定義 FieldDefinitionSet 相關的驗證 Schema。
 *   用於前端表單驗證和後端 API 輸入驗證。
 *
 *   驗證規則：
 *   - scope: GLOBAL / COMPANY / FORMAT
 *   - COMPANY scope 需要 companyId
 *   - FORMAT scope 需要 companyId + documentFormatId
 *   - fields: FieldDefinitionEntry[] 格式
 *   - name: 必填，最多 200 字元
 *
 * @module src/lib/validations/field-definition-set.schema
 * @since CHANGE-042 Phase 3
 * @lastModified 2026-02-23
 *
 * @dependencies
 *   - zod - Schema 驗證庫
 *
 * @related
 *   - src/services/field-definition-set.service.ts - 服務層
 *   - src/types/extraction-v3.types.ts - FieldDefinitionEntry 類型
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

/** 名稱最大長度 */
const NAME_MAX_LENGTH = 200;

/** 描述最大長度 */
const DESCRIPTION_MAX_LENGTH = 1000;

/** 欄位 key 最大長度 */
const FIELD_KEY_MAX_LENGTH = 100;

/** 欄位 label 最大長度 */
const FIELD_LABEL_MAX_LENGTH = 200;

/** 單個 FieldDefinitionSet 最大欄位數 */
const MAX_FIELDS_COUNT = 200;

/** 別名最大數量 */
const MAX_ALIASES_COUNT = 20;

/** 每頁最小數量 */
const PAGE_SIZE_MIN = 1;

/** 每頁最大數量 */
const PAGE_SIZE_MAX = 100;

/** 每頁預設數量 */
const PAGE_SIZE_DEFAULT = 20;

// ============================================================================
// Shared Schemas
// ============================================================================

/**
 * FieldDefinitionScope enum Schema
 */
const fieldDefinitionScopeSchema = z.enum(['GLOBAL', 'COMPANY', 'FORMAT']);

/**
 * 欄位資料類型 Schema
 */
const fieldDataTypeSchema = z.enum(['string', 'number', 'date', 'currency']);

/**
 * 欄位類型 Schema（standard | lineItem）
 * @since CHANGE-045
 */
const fieldTypeSchema = z.enum(['standard', 'lineItem']);

/**
 * 單個欄位定義條目 Schema
 *
 * @description 對應 FieldDefinitionEntry 介面
 */
export const fieldDefinitionEntrySchema = z.object({
  key: z
    .string()
    .min(1, { message: '欄位 key 為必填' })
    .max(FIELD_KEY_MAX_LENGTH)
    .regex(/^[a-z][a-z0-9_]*$/, {
      message: '欄位 key 必須為 snake_case 格式（小寫字母開頭，僅含小寫字母、數字和底線）',
    }),
  label: z.string().min(1, { message: '欄位標籤為必填' }).max(FIELD_LABEL_MAX_LENGTH),
  category: z.string().min(1),
  dataType: fieldDataTypeSchema,
  required: z.boolean().default(false),
  description: z.string().max(DESCRIPTION_MAX_LENGTH).optional(),
  aliases: z.array(z.string()).max(MAX_ALIASES_COUNT).optional(),
  extractionHints: z.string().max(DESCRIPTION_MAX_LENGTH).optional(),
  fieldType: fieldTypeSchema.optional(),
});

// ============================================================================
// Create Schema
// ============================================================================

/**
 * 建立 FieldDefinitionSet 的驗證 Schema
 *
 * @description
 *   驗證建立時的輸入資料。
 *   包含 scope 條件約束：
 *   - GLOBAL: companyId 和 documentFormatId 必須為空
 *   - COMPANY: companyId 必填，documentFormatId 必須為空
 *   - FORMAT: companyId 和 documentFormatId 都必填
 */
export const createFieldDefinitionSetSchema = z
  .object({
    name: z.string().min(1, { message: '名稱為必填' }).max(NAME_MAX_LENGTH),
    scope: fieldDefinitionScopeSchema,
    companyId: z.string().uuid().optional().nullable(),
    documentFormatId: z.string().cuid().optional().nullable(),
    description: z.string().max(DESCRIPTION_MAX_LENGTH).optional().nullable(),
    isActive: z.boolean().default(true),
    fields: z
      .array(fieldDefinitionEntrySchema)
      .min(1, { message: '至少需要定義一個欄位' })
      .max(MAX_FIELDS_COUNT, { message: `最多 ${MAX_FIELDS_COUNT} 個欄位` }),
  })
  .superRefine((data, ctx) => {
    // GLOBAL scope: 不應有 companyId 或 documentFormatId
    if (data.scope === 'GLOBAL') {
      if (data.companyId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'GLOBAL scope 不需要指定公司',
          path: ['companyId'],
        });
      }
      if (data.documentFormatId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'GLOBAL scope 不需要指定文件格式',
          path: ['documentFormatId'],
        });
      }
    }

    // COMPANY scope: 需要 companyId
    if (data.scope === 'COMPANY') {
      if (!data.companyId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'COMPANY scope 必須指定公司',
          path: ['companyId'],
        });
      }
      if (data.documentFormatId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'COMPANY scope 不需要指定文件格式',
          path: ['documentFormatId'],
        });
      }
    }

    // FORMAT scope: 需要 companyId + documentFormatId
    if (data.scope === 'FORMAT') {
      if (!data.companyId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'FORMAT scope 必須指定公司',
          path: ['companyId'],
        });
      }
      if (!data.documentFormatId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'FORMAT scope 必須指定文件格式',
          path: ['documentFormatId'],
        });
      }
    }

    // 檢查 fields 中的 key 是否重複
    const keys = data.fields.map((f) => f.key);
    const duplicateKeys = keys.filter((key, index) => keys.indexOf(key) !== index);
    if (duplicateKeys.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `欄位 key 重複: ${[...new Set(duplicateKeys)].join(', ')}`,
        path: ['fields'],
      });
    }
  });

// ============================================================================
// Update Schema
// ============================================================================

/**
 * 更新 FieldDefinitionSet 的驗證 Schema
 *
 * @description 所有欄位皆為可選，只更新提供的欄位。scope 不可變更。
 */
export const updateFieldDefinitionSetSchema = z
  .object({
    name: z.string().min(1).max(NAME_MAX_LENGTH).optional(),
    description: z.string().max(DESCRIPTION_MAX_LENGTH).optional().nullable(),
    isActive: z.boolean().optional(),
    fields: z
      .array(fieldDefinitionEntrySchema)
      .min(1, { message: '至少需要定義一個欄位' })
      .max(MAX_FIELDS_COUNT, { message: `最多 ${MAX_FIELDS_COUNT} 個欄位` })
      .optional(),
  })
  .refine(
    (data) => {
      if (!data.fields) return true;
      const keys = data.fields.map((f) => f.key);
      return new Set(keys).size === keys.length;
    },
    {
      message: '欄位 key 不可重複',
      path: ['fields'],
    }
  );

// ============================================================================
// Query Schema
// ============================================================================

/**
 * FieldDefinitionSet 列表查詢的驗證 Schema
 *
 * @description
 *   支援分頁、篩選、排序。
 *   從 query string 解析，因此基礎類型為 string，需 transform。
 */
export const getFieldDefinitionSetsQuerySchema = z.object({
  page: z
    .string()
    .default('1')
    .transform(Number)
    .pipe(z.number().int().positive()),
  limit: z
    .string()
    .default(String(PAGE_SIZE_DEFAULT))
    .transform(Number)
    .pipe(z.number().int().min(PAGE_SIZE_MIN).max(PAGE_SIZE_MAX)),
  scope: fieldDefinitionScopeSchema.optional(),
  companyId: z.string().uuid().optional(),
  documentFormatId: z.string().cuid().optional(),
  isActive: z
    .string()
    .transform((v) => v === 'true')
    .optional(),
  search: z.string().optional(),
  sortBy: z
    .enum(['name', 'scope', 'version', 'createdAt', 'updatedAt'])
    .default('updatedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

// ============================================================================
// Resolve Query Schema
// ============================================================================

/**
 * 解析合併欄位的查詢 Schema
 *
 * @description 依 companyId + documentFormatId 解析三層合併的最終欄位集
 */
export const resolveFieldsQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  documentFormatId: z.string().cuid().optional(),
});

// ============================================================================
// Inferred Types
// ============================================================================

/** 欄位定義條目輸入類型 */
export type FieldDefinitionEntryInput = z.infer<typeof fieldDefinitionEntrySchema>;

/** 建立 FieldDefinitionSet 輸入類型 */
export type CreateFieldDefinitionSetInput = z.infer<typeof createFieldDefinitionSetSchema>;

/** 更新 FieldDefinitionSet 輸入類型 */
export type UpdateFieldDefinitionSetInput = z.infer<typeof updateFieldDefinitionSetSchema>;

/** FieldDefinitionSet 列表查詢類型 */
export type GetFieldDefinitionSetsQuery = z.infer<typeof getFieldDefinitionSetsQuerySchema>;

/** 欄位解析查詢類型 */
export type ResolveFieldsQuery = z.infer<typeof resolveFieldsQuerySchema>;
