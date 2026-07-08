/**
 * @fileoverview Reference Number 驗證 Schema
 * @description
 *   使用 Zod 定義 Reference Number 相關的驗證 Schema。
 *   用於前端表單驗證和後端 API 輸入驗證。
 *
 *   驗證規則：
 *   - code: 可選，自動生成或手動指定，唯一
 *   - number: 必填、1-100 字元
 *   - type: 必須為有效的 ReferenceNumberType enum 值
 *   - year: 必填、2000-2100 年份
 *   - regionId: 必填、CUID 格式
 *   - 唯一約束：(number, type, year, regionId) 組合唯一
 *
 * @module src/lib/validations/reference-number.schema
 * @since Epic 20 - Story 20.3
 * @lastModified 2026-02-05 (Story 20.4: Import/Export/Validate schemas)
 *
 * @dependencies
 *   - zod - Schema 驗證庫
 *
 * @related
 *   - src/services/reference-number.service.ts - 服務層
 *   - src/app/api/v1/reference-numbers/ - API 端點
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

/** 號碼最小長度 */
const NUMBER_MIN_LENGTH = 1;

/** 號碼最大長度 */
const NUMBER_MAX_LENGTH = 100;

/** Code 最大長度 */
const CODE_MAX_LENGTH = 50;

/** 描述最大長度 */
const DESCRIPTION_MAX_LENGTH = 500;

/** 搜尋關鍵字最大長度 */
const SEARCH_MAX_LENGTH = 100;

/** 年份最小值 */
const YEAR_MIN = 2000;

/** 年份最大值 */
const YEAR_MAX = 2100;

/** 每頁最小數量 */
const PAGE_SIZE_MIN = 1;

/** 每頁最大數量 */
const PAGE_SIZE_MAX = 100;

/** 每頁預設數量 */
const PAGE_SIZE_DEFAULT = 20;

// ============================================================================
// Enum Schemas
// ============================================================================

/**
 * Reference Number 類型 Schema
 */
export const referenceNumberTypeSchema = z.enum(
  [
    'SHIPMENT',
    'DELIVERY',
    'BOOKING',
    'CONTAINER',
    'HAWB',
    'MAWB',
    'BL',
    'CUSTOMS',
    'OTHER',
  ],
  {
    message: '無效的參考號碼類型',
  }
);

/**
 * Reference Number 狀態 Schema
 */
export const referenceNumberStatusSchema = z.enum(
  ['ACTIVE', 'EXPIRED', 'CANCELLED'],
  {
    message: '無效的參考號碼狀態',
  }
);

/**
 * Reference Number 文件子類型 Schema（CHANGE-086）
 */
export const referenceNumberSubTypeSchema = z.enum(
  ['IMPORT', 'EXPORT', 'BOTH', 'UNKNOWN'],
  {
    message: '無效的文件子類型',
  }
);

// ============================================================================
// Create Reference Number Schema
// ============================================================================

/**
 * 建立 Reference Number Schema
 */
export const createReferenceNumberSchema = z
  .object({
    /** 唯一識別碼（可選，未提供時自動生成） */
    code: z
      .string()
      .max(CODE_MAX_LENGTH, `識別碼不能超過 ${CODE_MAX_LENGTH} 字元`)
      .regex(
        /^[A-Z0-9_-]+$/i,
        '識別碼只能包含英數字、底線和連字號'
      )
      .optional(),

    /** 號碼值 */
    number: z
      .string()
      .min(NUMBER_MIN_LENGTH, '號碼不能為空')
      .max(NUMBER_MAX_LENGTH, `號碼不能超過 ${NUMBER_MAX_LENGTH} 字元`),

    /** 類型 */
    type: referenceNumberTypeSchema,

    /** 文件子類型（CHANGE-086，獨立維度，可空） */
    documentSubType: referenceNumberSubTypeSchema.optional().nullable(),

    /** 年份 */
    year: z
      .number()
      .int('年份必須是整數')
      .min(YEAR_MIN, `年份不能小於 ${YEAR_MIN}`)
      .max(YEAR_MAX, `年份不能大於 ${YEAR_MAX}`),

    /** 地區 ID */
    regionId: z.string().uuid('無效的地區 ID'),

    /** 描述 */
    description: z
      .string()
      .max(DESCRIPTION_MAX_LENGTH, `描述不能超過 ${DESCRIPTION_MAX_LENGTH} 字元`)
      .optional()
      .nullable(),

    /** 有效起始日 */
    validFrom: z.string().datetime({ offset: true, message: '無效的日期時間格式' }).optional().nullable(),

    /** 有效結束日 */
    validUntil: z.string().datetime({ offset: true, message: '無效的日期時間格式' }).optional().nullable(),
  })
  .refine(
    (data) => {
      // 驗證有效期範圍
      if (data.validFrom && data.validUntil) {
        return new Date(data.validFrom) <= new Date(data.validUntil);
      }
      return true;
    },
    {
      message: '有效起始日不能大於結束日',
      path: ['validUntil'],
    }
  );

/** 建立 Reference Number 輸入類型 */
export type CreateReferenceNumberInput = z.infer<typeof createReferenceNumberSchema>;

// ============================================================================
// Update Reference Number Schema
// ============================================================================

/**
 * 更新 Reference Number Schema
 */
export const updateReferenceNumberSchema = z
  .object({
    /** 號碼值 */
    number: z
      .string()
      .min(NUMBER_MIN_LENGTH, '號碼不能為空')
      .max(NUMBER_MAX_LENGTH, `號碼不能超過 ${NUMBER_MAX_LENGTH} 字元`)
      .optional(),

    /** 類型 */
    type: referenceNumberTypeSchema.optional(),

    /** 狀態 */
    status: referenceNumberStatusSchema.optional(),

    /** 文件子類型（CHANGE-086，獨立維度，可空） */
    documentSubType: referenceNumberSubTypeSchema.optional().nullable(),

    /** 年份 */
    year: z
      .number()
      .int('年份必須是整數')
      .min(YEAR_MIN, `年份不能小於 ${YEAR_MIN}`)
      .max(YEAR_MAX, `年份不能大於 ${YEAR_MAX}`)
      .optional(),

    /** 地區 ID */
    regionId: z.string().uuid('無效的地區 ID').optional(),

    /** 描述 */
    description: z
      .string()
      .max(DESCRIPTION_MAX_LENGTH, `描述不能超過 ${DESCRIPTION_MAX_LENGTH} 字元`)
      .optional()
      .nullable(),

    /** 有效起始日 */
    validFrom: z.string().datetime({ offset: true, message: '無效的日期時間格式' }).optional().nullable(),

    /** 有效結束日 */
    validUntil: z.string().datetime({ offset: true, message: '無效的日期時間格式' }).optional().nullable(),

    /** 是否啟用 */
    isActive: z.boolean().optional(),
  })
  .refine(
    (data) => {
      // 驗證有效期範圍
      if (data.validFrom && data.validUntil) {
        return new Date(data.validFrom) <= new Date(data.validUntil);
      }
      return true;
    },
    {
      message: '有效起始日不能大於結束日',
      path: ['validUntil'],
    }
  );

/** 更新 Reference Number 輸入類型 */
export type UpdateReferenceNumberInput = z.infer<typeof updateReferenceNumberSchema>;

// ============================================================================
// Query Parameters Schema
// ============================================================================

/**
 * 查詢 Reference Number 參數 Schema
 */
export const getReferenceNumbersQuerySchema = z.object({
  /** 頁碼（從 1 開始） */
  page: z
    .string()
    .default('1')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive()),

  /** 每頁數量 */
  limit: z
    .string()
    .default(String(PAGE_SIZE_DEFAULT))
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(PAGE_SIZE_MIN).max(PAGE_SIZE_MAX)),

  /** 篩選年份 */
  year: z
    .string()
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int())
    .optional(),

  /** 篩選地區 ID */
  regionId: z.string().uuid().optional(),

  /** 篩選類型 */
  type: referenceNumberTypeSchema.optional(),

  /** 篩選狀態 */
  status: referenceNumberStatusSchema.optional(),

  /** 篩選文件子類型（CHANGE-086） */
  documentSubType: referenceNumberSubTypeSchema.optional(),

  /** 篩選啟用狀態 */
  isActive: z
    .string()
    .transform((val) => val === 'true')
    .optional(),

  /** 搜尋關鍵字（模糊搜尋 number） */
  search: z
    .string()
    .max(SEARCH_MAX_LENGTH, `搜尋關鍵字不能超過 ${SEARCH_MAX_LENGTH} 字元`)
    .optional(),

  /** 排序欄位 */
  sortBy: z
    .enum(['number', 'year', 'createdAt', 'updatedAt', 'matchCount'])
    .default('createdAt'),

  /** 排序方向 */
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/** 查詢 Reference Number 參數類型 */
export type GetReferenceNumbersQuery = z.infer<typeof getReferenceNumbersQuerySchema>;

// ============================================================================
// ID Parameter Schema
// ============================================================================

/**
 * Reference Number ID 參數 Schema
 */
export const referenceNumberIdParamSchema = z.object({
  id: z.string().cuid('無效的 Reference Number ID'),
});

/** Reference Number ID 參數類型 */
export type ReferenceNumberIdParam = z.infer<typeof referenceNumberIdParamSchema>;

// ============================================================================
// Import Reference Numbers Schema (Story 20.4)
// ============================================================================

/** 導入批次最大數量（SI-3：受限於前端 ExcelJS 解析 + React 狀態的瀏覽器承載能力，與前端 MAX_ITEMS 必須同步） */
const IMPORT_MAX_ITEMS = 5000;

/** Region Code 最大長度 */
const REGION_CODE_MAX_LENGTH = 20;

/** Region Code 最小長度 */
const REGION_CODE_MIN_LENGTH = 2;

/**
 * 導入單一項目 Schema
 */
const importItemSchema = z.object({
  /** 唯一識別碼（可選，用於匹配更新現有記錄） */
  code: z.string().max(CODE_MAX_LENGTH).optional(),

  /** 號碼值 */
  number: z
    .string()
    .min(NUMBER_MIN_LENGTH, '號碼不能為空')
    .max(NUMBER_MAX_LENGTH, `號碼不能超過 ${NUMBER_MAX_LENGTH} 字元`),

  /** 類型 */
  type: referenceNumberTypeSchema,

  /** 文件子類型（CHANGE-086，可空） */
  documentSubType: referenceNumberSubTypeSchema.optional(),

  /** 年份 */
  year: z
    .number()
    .int('年份必須是整數')
    .min(YEAR_MIN, `年份不能小於 ${YEAR_MIN}`)
    .max(YEAR_MAX, `年份不能大於 ${YEAR_MAX}`),

  /** 地區代碼（使用 region.code 而非 regionId） */
  regionCode: z
    .string()
    .min(REGION_CODE_MIN_LENGTH, `地區代碼至少 ${REGION_CODE_MIN_LENGTH} 字元`)
    .max(REGION_CODE_MAX_LENGTH, `地區代碼不能超過 ${REGION_CODE_MAX_LENGTH} 字元`),

  /** 描述 */
  description: z
    .string()
    .max(DESCRIPTION_MAX_LENGTH, `描述不能超過 ${DESCRIPTION_MAX_LENGTH} 字元`)
    .optional(),

  /** 有效起始日 */
  validFrom: z.string().datetime('無效的日期時間格式').optional(),

  /** 有效結束日 */
  validUntil: z.string().datetime('無效的日期時間格式').optional(),

  /** 是否啟用 */
  isActive: z.boolean().default(true),
});

/**
 * 導入 Reference Numbers Schema
 */
export const importReferenceNumbersSchema = z.object({
  /** 匯出版本（可選，用於向後兼容） */
  exportVersion: z.string().optional(),

  /** 導入項目列表 */
  items: z
    .array(importItemSchema)
    .min(1, '至少需要一筆資料')
    .max(IMPORT_MAX_ITEMS, `一次最多導入 ${IMPORT_MAX_ITEMS} 筆`),

  /** 導入選項 */
  options: z
    .object({
      /** 覆蓋已存在的記錄（預設 false） */
      overwriteExisting: z.boolean().default(false),
      /** 跳過無效記錄（預設 false，false 時整批失敗） */
      skipInvalid: z.boolean().default(false),
    })
    .default({ overwriteExisting: false, skipInvalid: false }),
});

/** 導入 Reference Numbers 輸入類型 */
export type ImportReferenceNumbersInput = z.infer<typeof importReferenceNumbersSchema>;

// ============================================================================
// Export Reference Numbers Query Schema (Story 20.4)
// ============================================================================

/**
 * 導出 Reference Numbers 查詢 Schema
 */
export const exportReferenceNumbersQuerySchema = z.object({
  /** 篩選年份 */
  year: z
    .string()
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int())
    .optional(),

  /** 篩選地區 ID */
  regionId: z.string().uuid().optional(),

  /** 篩選類型 */
  type: referenceNumberTypeSchema.optional(),

  /** 篩選狀態 */
  status: referenceNumberStatusSchema.optional(),

  /** 篩選文件子類型（CHANGE-086） */
  documentSubType: referenceNumberSubTypeSchema.optional(),

  /** 篩選啟用狀態 */
  isActive: z
    .string()
    .transform((val) => val === 'true')
    .optional(),
});

/** 導出 Reference Numbers 查詢類型 */
export type ExportReferenceNumbersQuery = z.infer<typeof exportReferenceNumbersQuerySchema>;

// ============================================================================
// Validate Reference Numbers Schema (Story 20.4)
// ============================================================================

/** 驗證批次最大數量 */
const VALIDATE_MAX_ITEMS = 100;

/**
 * 驗證 Reference Numbers Schema
 */
export const validateReferenceNumbersSchema = z.object({
  /** 待驗證號碼列表 */
  numbers: z
    .array(
      z.object({
        /** 號碼值 */
        value: z.string().min(1, '號碼不能為空'),
        /** 類型（可選篩選） */
        type: referenceNumberTypeSchema.optional(),
      })
    )
    .min(1, '至少需要一筆號碼')
    .max(VALIDATE_MAX_ITEMS, `一次最多驗證 ${VALIDATE_MAX_ITEMS} 筆`),

  /** 驗證選項 */
  options: z
    .object({
      /** 篩選年份 */
      year: z.number().int().optional(),
      /** 篩選地區 ID */
      regionId: z.string().uuid().optional(),
    })
    .optional(),
});

/** 驗證 Reference Numbers 輸入類型 */
export type ValidateReferenceNumbersInput = z.infer<typeof validateReferenceNumbersSchema>;
