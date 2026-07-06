/**
 * @fileoverview Company 相關類型定義 (REFACTOR-001)
 * @description
 *   定義 Company Profile 功能所需的所有 TypeScript 類型，
 *   包含列表項目、詳情頁面、統計資料、查詢參數、分頁資訊等。
 *
 *   設計說明：
 *   - REFACTOR-001: Forwarder → Company 模型重構
 *   - 支援多種公司類型（Forwarder, Exporter, Carrier, Customs Broker 等）
 *   - Story 5.5 新增 CompanyStatus enum 和生命週期管理
 *   - Story 5-2 新增詳情頁面相關類型（統計、規則摘要、近期文件）
 *
 * @module src/types/company
 * @author Development Team
 * @since REFACTOR-001 (Forwarder → Company)
 * @lastModified 2025-12-22
 *
 * @features
 *   - REFACTOR-001: Company 模型支援多種公司類型
 *   - Story 5.1: 列表頁面類型（CompanyListItem, CompaniesQueryParams）
 *   - Story 5.2: 詳情頁面類型（CompanyDetailView, CompanyStats, RulesSummary）
 *   - Story 5.5: 新增/停用 Company（CompanyStatus, CreateCompany, UpdateCompany）
 *
 * @dependencies
 *   - prisma/schema.prisma - Company 模型定義
 *
 * @related
 *   - src/services/company.service.ts - Company 業務邏輯
 *   - src/app/api/companies/route.ts - API 端點
 *   - src/hooks/use-companies.ts - React Query Hook
 */

import { z } from 'zod'

// ============================================================
// REFACTOR-001: Company Type Enum（公司類型）
// ============================================================

/**
 * 公司類型（對應 Prisma CompanyType enum）
 * @description REFACTOR-001 - 支援多種公司類型
 *   - FORWARDER: 貨運代理商
 *   - EXPORTER: 出口商
 *   - CARRIER: 承運人
 *   - CUSTOMS_BROKER: 報關行
 *   - OTHER: 其他
 *   - UNKNOWN: 未分類
 */
export type CompanyType = 'FORWARDER' | 'EXPORTER' | 'CARRIER' | 'CUSTOMS_BROKER' | 'OTHER' | 'UNKNOWN'

/**
 * 公司類型標籤配置
 * @description REFACTOR-001 - 六種類型的顯示配置
 */
export const COMPANY_TYPE_CONFIG: Record<
  CompanyType,
  { label: string; description: string; className: string }
> = {
  FORWARDER: {
    label: '貨運代理商',
    description: 'Freight Forwarder',
    className: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  },
  EXPORTER: {
    label: '出口商',
    description: 'Exporter',
    className: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  },
  CARRIER: {
    label: '承運人',
    description: 'Carrier',
    className: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  },
  CUSTOMS_BROKER: {
    label: '報關行',
    description: 'Customs Broker',
    className: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  },
  OTHER: {
    label: '其他',
    description: 'Other',
    className: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
  },
  UNKNOWN: {
    label: '未分類',
    description: 'Unknown',
    className: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  },
} as const

// ============================================================
// REFACTOR-001: Company Source Enum（公司來源）
// ============================================================

/**
 * 公司建立來源（對應 Prisma CompanySource enum）
 * @description REFACTOR-001 - 追蹤公司如何被建立
 *   - MANUAL: 手動建立
 *   - AUTO_CREATED: 自動建立（Just-in-Time）
 *   - IMPORTED: 批量匯入
 */
export type CompanySource = 'MANUAL' | 'AUTO_CREATED' | 'IMPORTED'

/**
 * 公司來源標籤配置
 */
export const COMPANY_SOURCE_CONFIG: Record<
  CompanySource,
  { label: string; description: string; className: string }
> = {
  MANUAL: {
    label: '手動建立',
    description: '由管理員手動建立',
    className: 'bg-blue-100 text-blue-800',
  },
  AUTO_CREATED: {
    label: '自動建立',
    description: '系統自動識別並建立',
    className: 'bg-green-100 text-green-800',
  },
  IMPORTED: {
    label: '批量匯入',
    description: '從外部資料匯入',
    className: 'bg-purple-100 text-purple-800',
  },
} as const

// ============================================================
// Company Status Enum（公司狀態）
// ============================================================

/**
 * 公司狀態（對應 Prisma CompanyStatus enum）
 * @description
 *   - ACTIVE: 啟用中 - 可處理文件
 *   - INACTIVE: 已停用 - 暫停所有處理
 *   - PENDING: 待設定 - 新建立，尚未配置規則
 *   - MERGED: 已合併 - 合併到其他公司
 */
export type CompanyStatus = 'ACTIVE' | 'INACTIVE' | 'PENDING' | 'MERGED'

/**
 * 公司狀態標籤配置
 */
export const COMPANY_STATUS_CONFIG: Record<
  CompanyStatus,
  { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive'; className: string; description: string }
> = {
  ACTIVE: {
    label: '啟用',
    variant: 'default',
    className: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    description: '可正常處理文件',
  },
  INACTIVE: {
    label: '停用',
    variant: 'secondary',
    className: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
    description: '暫停所有處理',
  },
  PENDING: {
    label: '待設定',
    variant: 'outline',
    className: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
    description: '尚未配置規則',
  },
  MERGED: {
    label: '已合併',
    variant: 'destructive',
    className: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
    description: '已合併到其他公司',
  },
} as const

// ============================================================
// 向後兼容類型別名 (Forwarder → Company)
// ============================================================

/**
 * @deprecated 使用 CompanyStatus 替代
 */
export type ForwarderStatus = CompanyStatus

/**
 * @deprecated 使用 COMPANY_STATUS_CONFIG 替代
 */
export const FORWARDER_STATUS_CONFIG = COMPANY_STATUS_CONFIG

// ============================================================
// 列表項目類型
// ============================================================

/**
 * Company 列表項目
 * @description 用於列表頁面顯示的 Company 資料
 */
export interface CompanyListItem {
  /** Company ID */
  id: string
  /** Company 名稱 */
  name: string
  /** Company 代碼 */
  code: string | null
  /** 顯示名稱 */
  displayName: string
  /** REFACTOR-001: 公司類型 */
  type: CompanyType
  /** REFACTOR-001: 公司來源 */
  source: CompanySource
  /** Company 狀態 */
  status: CompanyStatus
  /** 是否啟用（向後兼容，從 status 計算） */
  isActive: boolean
  /** 優先級 */
  priority: number
  /** 關聯的映射規則數量 */
  ruleCount: number
  /** 最後更新時間 */
  updatedAt: Date | string
  /** 建立時間 */
  createdAt: Date | string
  /** Logo URL */
  logoUrl?: string | null
  /** 描述 */
  description?: string | null
  /** 聯絡電子郵件 */
  contactEmail?: string | null
  /** 預設信心度 (0-1) */
  defaultConfidence?: number
  /** REFACTOR-001: 名稱變體（用於模糊匹配） */
  nameVariants?: string[]
  /** REFACTOR-001: 合併到的公司 ID */
  mergedIntoId?: string | null
}

/**
 * @deprecated 使用 CompanyListItem 替代
 */
export type ForwarderListItem = CompanyListItem

/**
 * Company 詳細資訊（用於詳情頁/編輯）
 */
export interface CompanyDetail extends CompanyListItem {
  /** 識別模式 */
  identificationPatterns: CompanyIdentificationPattern[]
  /** 關聯的文件數量 */
  documentCount?: number
  /** 合併到的公司資訊 (REFACTOR-001) */
  mergedIntoCompany?: {
    id: string
    name: string
    displayName: string | null
  } | null
  /** 從多少公司合併過來的數量 (REFACTOR-001) */
  mergedFromCount?: number
  /** 首次出現的文件 ID (REFACTOR-001) */
  firstSeenDocumentId?: string | null
}

/**
 * @deprecated 使用 CompanyDetail 替代
 */
export type ForwarderDetail = CompanyDetail

/**
 * Company 識別模式
 */
export interface CompanyIdentificationPattern {
  /** 模式類型 */
  type: 'keyword' | 'regex' | 'domain'
  /** 模式值 */
  value: string
  /** 優先級 */
  priority?: number
}

/**
 * @deprecated 使用 CompanyIdentificationPattern 替代
 */
export type ForwarderIdentificationPattern = CompanyIdentificationPattern

// ============================================================
// 詳情頁面相關類型
// ============================================================

/**
 * 映射規則狀態（對應 Prisma RuleStatus enum）
 */
export type RuleStatus = 'DRAFT' | 'PENDING_REVIEW' | 'ACTIVE' | 'DEPRECATED'

/**
 * 規則狀態配置
 */
export const RULE_STATUS_CONFIG = {
  DRAFT: {
    label: '草稿',
    variant: 'outline' as const,
    className: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
  },
  PENDING_REVIEW: {
    label: '待審核',
    variant: 'secondary' as const,
    className: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  },
  ACTIVE: {
    label: '啟用',
    variant: 'default' as const,
    className: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  },
  DEPRECATED: {
    label: '已棄用',
    variant: 'destructive' as const,
    className: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  },
} as const

/**
 * 規則狀態數量統計
 */
export interface RuleStatusCounts {
  active: number
  draft: number
  pendingReview: number
  deprecated: number
}

/**
 * 規則摘要資訊
 */
export interface RulesSummary {
  total: number
  byStatus: RuleStatusCounts
}

/**
 * 每日趨勢資料點
 */
export interface DailyTrendData {
  date: string
  count: number
  successCount: number
}

/**
 * Company 統計資料
 */
export interface CompanyStats {
  totalDocuments: number
  processedLast30Days: number
  successRate: number
  avgConfidence: number
  dailyTrend: DailyTrendData[]
}

/**
 * @deprecated 使用 CompanyStats 替代
 */
export type ForwarderStats = CompanyStats

/**
 * 文件處理狀態
 */
export type DocumentProcessingStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'NEEDS_REVIEW'

/**
 * 文件處理狀態配置
 */
export const DOCUMENT_PROCESSING_STATUS_CONFIG: Record<
  DocumentProcessingStatus,
  { label: string; variant: string; className: string }
> = {
  PENDING: { label: '待處理', variant: 'outline', className: 'bg-gray-100 text-gray-800' },
  PROCESSING: { label: '處理中', variant: 'secondary', className: 'bg-blue-100 text-blue-800' },
  COMPLETED: { label: '已完成', variant: 'default', className: 'bg-green-100 text-green-800' },
  FAILED: { label: '失敗', variant: 'destructive', className: 'bg-red-100 text-red-800' },
  NEEDS_REVIEW: { label: '待審核', variant: 'secondary', className: 'bg-yellow-100 text-yellow-800' },
}

/**
 * 將 Prisma DocumentStatus 映射到顯示用狀態
 */
export function mapDocumentStatus(prismaStatus: string): DocumentProcessingStatus {
  const statusMap: Record<string, DocumentProcessingStatus> = {
    UPLOADING: 'PENDING',
    UPLOADED: 'PENDING',
    OCR_PROCESSING: 'PROCESSING',
    OCR_COMPLETED: 'PROCESSING',
    OCR_FAILED: 'FAILED',
    MAPPING_PROCESSING: 'PROCESSING',
    MAPPING_COMPLETED: 'PROCESSING',
    PENDING_REVIEW: 'NEEDS_REVIEW',
    IN_REVIEW: 'NEEDS_REVIEW',
    APPROVED: 'COMPLETED',
    ESCALATED: 'NEEDS_REVIEW',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
  }
  return statusMap[prismaStatus] ?? 'PENDING'
}

/**
 * 近期文件項目
 */
export interface RecentDocumentItem {
  id: string
  fileName: string
  status: DocumentProcessingStatus
  confidence: number | null
  processedAt: Date | string | null
  createdAt: Date | string
}

/**
 * Company 詳情檢視（含統計資料）
 */
export interface CompanyDetailView extends CompanyDetail {
  rulesSummary: RulesSummary
  stats: CompanyStats
  recentDocuments: RecentDocumentItem[]
}

/**
 * @deprecated 使用 CompanyDetailView 替代
 */
export type ForwarderDetailView = CompanyDetailView

/**
 * 規則列表項目
 */
export interface RuleListItem {
  id: string
  fieldName: string
  status: RuleStatus
  version: number
  confidence: number
  matchCount: number
  lastMatchedAt: Date | string | null
  updatedAt: Date | string
}

/**
 * 規則查詢參數
 */
export interface RulesQueryParams {
  status?: RuleStatus
  search?: string
  page?: number
  limit?: number
  sortBy?: 'fieldName' | 'status' | 'confidence' | 'matchCount' | 'updatedAt'
  sortOrder?: SortOrder
}

/**
 * 規則列表 API 回應
 */
export interface RulesResponse {
  data: RuleListItem[]
  pagination: PaginationInfo
}

// ============================================================
// 分頁與查詢
// ============================================================

/**
 * 分頁資訊
 */
export interface PaginationInfo {
  page: number
  limit: number
  total: number
  totalPages: number
}

/**
 * 排序方向
 */
export type SortOrder = 'asc' | 'desc'

/**
 * Company 可排序欄位
 */
export type CompanySortField = 'name' | 'code' | 'updatedAt' | 'createdAt' | 'priority' | 'ruleCount' | 'type'

/**
 * @deprecated 使用 CompanySortField 替代
 */
export type ForwarderSortField = CompanySortField

/**
 * Company 查詢參數
 */
export interface CompaniesQueryParams {
  search?: string
  isActive?: boolean
  type?: CompanyType
  source?: CompanySource
  status?: CompanyStatus
  page?: number
  limit?: number
  sortBy?: CompanySortField
  sortOrder?: SortOrder
}

/**
 * @deprecated 使用 CompaniesQueryParams 替代
 */
export type ForwardersQueryParams = CompaniesQueryParams

/**
 * Company 列表 API 回應
 */
export interface CompaniesResponse {
  data: CompanyListItem[]
  pagination: PaginationInfo
}

/**
 * @deprecated 使用 CompaniesResponse 替代
 */
export type ForwardersResponse = CompaniesResponse

// ============================================================
// Zod Schemas（運行時驗證）
// ============================================================

/**
 * 查詢參數驗證 Schema
 */
export const CompaniesQuerySchema = z.object({
  search: z.string().optional(),
  isActive: z
    .string()
    .optional()
    .transform((val) => {
      if (val === 'true') return true
      if (val === 'false') return false
      return undefined
    }),
  type: z.enum(['FORWARDER', 'EXPORTER', 'CARRIER', 'CUSTOMS_BROKER', 'OTHER', 'UNKNOWN']).optional(),
  source: z.enum(['MANUAL', 'AUTO_CREATED', 'IMPORTED']).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'PENDING', 'MERGED']).optional(),
  page: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 1))
    .pipe(z.number().int().positive()),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 10))
    .pipe(z.number().int().min(1).max(100)),
  sortBy: z.enum(['name', 'code', 'updatedAt', 'createdAt', 'priority', 'ruleCount', 'type']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
})

/**
 * @deprecated 使用 CompaniesQuerySchema 替代
 */
export const ForwardersQuerySchema = CompaniesQuerySchema

/**
 * 驗證後的查詢參數類型
 */
export type ValidatedCompaniesQuery = z.infer<typeof CompaniesQuerySchema>

/**
 * @deprecated 使用 ValidatedCompaniesQuery 替代
 */
export type ValidatedForwardersQuery = ValidatedCompaniesQuery

/**
 * 規則狀態驗證 Schema
 */
export const RuleStatusSchema = z.enum(['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'DEPRECATED'])

/**
 * 規則查詢參數驗證 Schema
 */
export const RulesQuerySchema = z.object({
  status: RuleStatusSchema.optional(),
  search: z.string().optional(),
  page: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 1))
    .pipe(z.number().int().positive()),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 10))
    .pipe(z.number().int().min(1).max(100)),
  sortBy: z.enum(['fieldName', 'status', 'confidence', 'matchCount', 'updatedAt']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
})

/**
 * 驗證後的規則查詢參數類型
 */
export type ValidatedRulesQuery = z.infer<typeof RulesQuerySchema>

/**
 * Company ID 參數驗證 Schema
 */
export const CompanyIdSchema = z.object({
  id: z.string().uuid(),
})

/**
 * @deprecated 使用 CompanyIdSchema 替代
 */
export const ForwarderIdSchema = CompanyIdSchema

// ============================================================
// 表格相關
// ============================================================

/**
 * 表格欄位配置
 */
export interface CompanyTableColumn {
  id: CompanySortField | 'status' | 'actions'
  label: string
  sortable: boolean
  width?: string
  align?: 'left' | 'center' | 'right'
}

/**
 * @deprecated 使用 CompanyTableColumn 替代
 */
export type ForwarderTableColumn = CompanyTableColumn

/**
 * 預設表格欄位配置
 */
export const DEFAULT_COMPANY_COLUMNS: CompanyTableColumn[] = [
  { id: 'name', label: '名稱', sortable: true, width: '200px' },
  { id: 'code', label: '代碼', sortable: true, width: '120px' },
  { id: 'type', label: '類型', sortable: true, width: '120px', align: 'center' },
  { id: 'status', label: '狀態', sortable: false, width: '100px', align: 'center' },
  { id: 'ruleCount', label: '規則數', sortable: true, width: '100px', align: 'center' },
  { id: 'priority', label: '優先級', sortable: true, width: '100px', align: 'center' },
  { id: 'updatedAt', label: '最後更新', sortable: true, width: '180px' },
  { id: 'actions', label: '操作', sortable: false, width: '100px', align: 'center' },
]

/**
 * @deprecated 使用 DEFAULT_COMPANY_COLUMNS 替代
 */
export const DEFAULT_FORWARDER_COLUMNS = DEFAULT_COMPANY_COLUMNS

// ============================================================
// 篩選器相關
// ============================================================

/**
 * 篩選器狀態
 */
export interface CompanyFiltersState {
  search: string
  status: 'all' | 'active' | 'inactive' | 'pending' | 'merged'
  type: CompanyType | 'all'
}

/**
 * @deprecated 使用 CompanyFiltersState 替代
 */
export type ForwarderFiltersState = CompanyFiltersState

/**
 * 預設篩選器狀態
 */
export const DEFAULT_COMPANY_FILTERS: CompanyFiltersState = {
  search: '',
  status: 'all',
  type: 'all',
}

/**
 * @deprecated 使用 DEFAULT_COMPANY_FILTERS 替代
 */
export const DEFAULT_FORWARDER_FILTERS = DEFAULT_COMPANY_FILTERS

/**
 * 狀態篩選選項
 */
export const COMPANY_STATUS_OPTIONS = [
  { value: 'all', label: '全部狀態' },
  { value: 'active', label: '啟用' },
  { value: 'inactive', label: '停用' },
  { value: 'pending', label: '待設定' },
  { value: 'merged', label: '已合併' },
] as const

/**
 * @deprecated 使用 COMPANY_STATUS_OPTIONS 替代
 */
export const FORWARDER_STATUS_OPTIONS = COMPANY_STATUS_OPTIONS

/**
 * 類型篩選選項
 */
export const COMPANY_TYPE_OPTIONS = [
  { value: 'all', label: '全部類型' },
  { value: 'FORWARDER', label: '貨運代理商' },
  { value: 'EXPORTER', label: '出口商' },
  { value: 'CARRIER', label: '承運人' },
  { value: 'CUSTOMS_BROKER', label: '報關行' },
  { value: 'OTHER', label: '其他' },
  { value: 'UNKNOWN', label: '未分類' },
] as const

// ============================================================
// 新增/編輯 Company 表單相關
// ============================================================

/**
 * 創建 Company 表單驗證 Schema
 */
export const CreateCompanySchema = z.object({
  name: z.string().min(1, '名稱為必填').max(100, '名稱最多 100 個字符'),
  code: z
    .string()
    .min(2, '代碼至少 2 個字符')
    .max(20, '代碼最多 20 個字符')
    .regex(/^[A-Z0-9_]+$/, '代碼只能包含大寫字母、數字和底線')
    .transform((v) => v.toUpperCase())
    .optional()
    .nullable(),
  type: z.enum(['FORWARDER', 'EXPORTER', 'CARRIER', 'CUSTOMS_BROKER', 'OTHER', 'UNKNOWN']).default('UNKNOWN'),
  description: z.string().max(500, '描述最多 500 個字符').optional().nullable(),
  contactEmail: z.string().email('請輸入有效的電子郵件').optional().nullable().or(z.literal('')),
  defaultConfidence: z.number().min(0).max(1),
  nameVariants: z.array(z.string()).optional(),
})

/**
 * @deprecated 使用 CreateCompanySchema 替代
 */
export const CreateForwarderSchema = CreateCompanySchema

/**
 * 創建 Company 表單資料類型
 */
export type CreateCompanyFormData = z.infer<typeof CreateCompanySchema>

/**
 * @deprecated 使用 CreateCompanyFormData 替代
 */
export type CreateForwarderFormData = CreateCompanyFormData

/**
 * 創建 Company API 請求資料（含 Logo）
 */
export interface CreateCompanyRequest extends CreateCompanyFormData {
  logo?: File | null
}

/**
 * @deprecated 使用 CreateCompanyRequest 替代
 */
export type CreateForwarderRequest = CreateCompanyRequest

/**
 * 更新 Company 表單驗證 Schema
 */
export const UpdateCompanySchema = z.object({
  name: z.string().min(1, '名稱為必填').max(100, '名稱最多 100 個字符').optional(),
  // CHANGE-095: 允許補填 code（僅對空 code 補填一次，由服務層強制「只補空值」政策）
  code: z
    .string()
    .min(2, '代碼至少 2 個字符')
    .max(20, '代碼最多 20 個字符')
    .regex(/^[A-Z0-9_]+$/, '代碼只能包含大寫字母、數字和底線')
    .transform((v) => v.toUpperCase())
    .optional()
    .nullable(),
  type: z.enum(['FORWARDER', 'EXPORTER', 'CARRIER', 'CUSTOMS_BROKER', 'OTHER', 'UNKNOWN']).optional(),
  description: z.string().max(500, '描述最多 500 個字符').optional().nullable(),
  contactEmail: z.string().email('請輸入有效的電子郵件').optional().nullable().or(z.literal('')),
  defaultConfidence: z.number().min(0).max(1).optional(),
  nameVariants: z.array(z.string()).optional(),
})

/**
 * @deprecated 使用 UpdateCompanySchema 替代
 */
export const UpdateForwarderSchema = UpdateCompanySchema

/**
 * 更新 Company 表單資料類型
 */
export type UpdateCompanyFormData = z.infer<typeof UpdateCompanySchema>

/**
 * @deprecated 使用 UpdateCompanyFormData 替代
 */
export type UpdateForwarderFormData = UpdateCompanyFormData

/**
 * 更新 Company API 請求資料（含 Logo）
 */
export interface UpdateCompanyRequest extends UpdateCompanyFormData {
  logo?: File | null
  removeLogo?: boolean
}

/**
 * @deprecated 使用 UpdateCompanyRequest 替代
 */
export type UpdateForwarderRequest = UpdateCompanyRequest

/**
 * 停用 Company Schema
 */
export const DeactivateCompanySchema = z.object({
  reason: z.string().max(500, '原因最多 500 個字符').optional(),
  deactivateRules: z.boolean().default(true),
})

/**
 * @deprecated 使用 DeactivateCompanySchema 替代
 */
export const DeactivateForwarderSchema = DeactivateCompanySchema

/**
 * 停用 Company 請求資料類型
 */
export type DeactivateCompanyRequest = z.infer<typeof DeactivateCompanySchema>

/**
 * @deprecated 使用 DeactivateCompanyRequest 替代
 */
export type DeactivateForwarderRequest = DeactivateCompanyRequest

/**
 * 啟用 Company Schema
 */
export const ActivateCompanySchema = z.object({
  reactivateRules: z.boolean().default(false),
})

/**
 * @deprecated 使用 ActivateCompanySchema 替代
 */
export const ActivateForwarderSchema = ActivateCompanySchema

/**
 * 啟用 Company 請求資料類型
 */
export type ActivateCompanyRequest = z.infer<typeof ActivateCompanySchema>

/**
 * @deprecated 使用 ActivateCompanyRequest 替代
 */
export type ActivateForwarderRequest = ActivateCompanyRequest

/**
 * 檢查代碼唯一性請求 Schema
 */
export const CheckCodeSchema = z.object({
  code: z
    .string()
    .min(2, '代碼至少 2 個字符')
    .max(20, '代碼最多 20 個字符')
    .regex(/^[A-Z0-9_]+$/, '代碼只能包含大寫字母、數字和底線'),
  excludeId: z.string().uuid().optional(),
})

/**
 * 檢查代碼唯一性回應
 */
export interface CheckCodeResponse {
  available: boolean
  message?: string
}

/**
 * Company 創建成功回應
 */
export interface CreateCompanyResponse {
  success: true
  data: {
    id: string
    name: string
    code: string | null
    type: CompanyType
    status: CompanyStatus
    message: string
  }
}

/**
 * @deprecated 使用 CreateCompanyResponse 替代
 */
export type CreateForwarderResponse = CreateCompanyResponse

/**
 * Company 更新成功回應
 */
export interface UpdateCompanyResponse {
  success: true
  data: {
    id: string
    name: string
    code: string | null
    type: CompanyType
    description: string | null
    logoUrl: string | null
    contactEmail: string | null
    defaultConfidence: number
    status: CompanyStatus
    message: string
  }
}

/**
 * @deprecated 使用 UpdateCompanyResponse 替代
 */
export type UpdateForwarderResponse = UpdateCompanyResponse

/**
 * Company 狀態變更回應
 */
export interface CompanyStatusChangeResponse {
  success: true
  data: {
    id: string
    name: string
    status: CompanyStatus
    rulesAffected?: number
    message: string
  }
}

/**
 * @deprecated 使用 CompanyStatusChangeResponse 替代
 */
export type ForwarderStatusChangeResponse = CompanyStatusChangeResponse

/**
 * Logo 上傳限制
 */
export const LOGO_UPLOAD_CONFIG = {
  maxSize: 5 * 1024 * 1024,
  acceptedTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'],
  acceptedTypesLabel: 'PNG, JPG, WebP, GIF, SVG',
  recommendedSize: { width: 200, height: 200 },
} as const

/**
 * Company 表單欄位標籤配置
 */
export const COMPANY_FORM_LABELS = {
  name: {
    label: '公司名稱',
    placeholder: '例如：DHL Express',
    description: '用於顯示的完整名稱',
  },
  code: {
    label: '公司代碼',
    placeholder: '例如：DHL_EXPRESS',
    description: '唯一識別碼（大寫字母、數字、底線）',
  },
  type: {
    label: '公司類型',
    description: '選擇公司的業務類型',
  },
  description: {
    label: '描述',
    placeholder: '輸入公司的描述...',
    description: '選填，最多 500 個字符',
  },
  contactEmail: {
    label: '聯絡電子郵件',
    placeholder: 'contact@example.com',
    description: '選填，用於接收通知',
  },
  defaultConfidence: {
    label: '預設信心度',
    description: '新規則的預設信心度閾值',
  },
  logo: {
    label: 'Logo 圖片',
    description: '選填，建議 200x200 像素',
  },
  nameVariants: {
    label: '名稱變體',
    placeholder: '輸入名稱變體...',
    description: '用於模糊匹配的其他名稱',
  },
} as const

/**
 * @deprecated 使用 COMPANY_FORM_LABELS 替代
 */
export const FORWARDER_FORM_LABELS = COMPANY_FORM_LABELS

/**
 * 停用/啟用對話框文案
 */
export const COMPANY_ACTION_DIALOGS = {
  deactivate: {
    title: '停用公司',
    description: '停用後將暫停此公司的所有文件處理。確定要繼續嗎？',
    confirmText: '確認停用',
    cancelText: '取消',
    reasonLabel: '停用原因',
    reasonPlaceholder: '選填，輸入停用原因...',
    deactivateRulesLabel: '同時停用所有相關規則',
    warningMessage: '此公司有 {ruleCount} 條啟用中的規則',
  },
  activate: {
    title: '啟用公司',
    description: '啟用後此公司將恢復文件處理功能。確定要繼續嗎？',
    confirmText: '確認啟用',
    cancelText: '取消',
    reactivateRulesLabel: '同時重新啟用之前的規則',
    infoMessage: '此公司有 {ruleCount} 條可恢復的規則',
  },
} as const

/**
 * @deprecated 使用 COMPANY_ACTION_DIALOGS 替代
 */
export const FORWARDER_ACTION_DIALOGS = COMPANY_ACTION_DIALOGS

// ============================================================
// 向後兼容函數
// ============================================================

/**
 * Forwarder 顯示狀態
 * @deprecated 使用 CompanyStatus 替代
 */
export type ForwarderDisplayStatus = 'active' | 'inactive'

/**
 * 將 isActive 轉換為顯示狀態
 * @deprecated 使用 CompanyStatus 替代
 */
export function getForwarderDisplayStatus(isActive: boolean): ForwarderDisplayStatus {
  return isActive ? 'active' : 'inactive'
}

/**
 * 將 CompanyStatus 轉換為 isActive boolean
 */
export function getIsActiveFromStatus(status: CompanyStatus): boolean {
  return status === 'ACTIVE'
}

/**
 * 舊版狀態標籤配置
 * @deprecated 使用 COMPANY_STATUS_CONFIG 替代
 */
export const LEGACY_FORWARDER_STATUS_CONFIG = {
  active: {
    label: '啟用',
    variant: 'default' as const,
    className: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  },
  inactive: {
    label: '停用',
    variant: 'secondary' as const,
    className: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
  },
} as const
