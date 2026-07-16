/**
 * @fileoverview Company 服務層
 * @description
 *   提供 Company Profile 相關的業務邏輯，包含查詢、創建、更新等功能。
 *   Company 可以是貨運代理商、出口商、承運人等多種類型的公司。
 *
 *   REFACTOR-001: 從 Forwarder 模型重構為更通用的 Company 模型
 *   - 支援多種公司類型 (FORWARDER, EXPORTER, CARRIER, CUSTOMS_BROKER, OTHER, UNKNOWN)
 *   - 新增公司來源追蹤 (MANUAL, AUTO_CREATED, IMPORTED)
 *   - 新增名稱變體支援（用於模糊匹配）
 *   - 新增合併功能（mergedIntoId）
 *
 *   主要功能：
 *   - Company 列表查詢（分頁、搜尋、篩選、排序）
 *   - Company 詳情查詢（含統計、規則摘要、近期文件）
 *   - Company CRUD 操作
 *   - 規則數量統計
 *   - 規則列表查詢
 *   - Company 停用/啟用
 *
 * @module src/services/company.service
 * @author Development Team
 * @since REFACTOR-001: Forwarder → Company
 * @lastModified 2025-12-22
 *
 * @features
 *   - 列表查詢功能（getCompanies, getCompanyById）
 *   - 詳情檢視功能（getCompanyDetailView, getCompanyRules, getCompanyStatsById）
 *   - CRUD 操作（createCompany, updateCompany）
 *   - 生命週期管理（deactivateCompany, activateCompany）
 *   - 公司類型篩選
 *   - 名稱變體匹配
 *
 * @dependencies
 *   - @prisma/client - Prisma ORM 客戶端
 *   - @/lib/prisma - Prisma 單例實例
 *   - @/types/company - Company 類型定義
 *
 * @related
 *   - src/app/api/companies/route.ts - 列表/創建 API 端點
 *   - src/app/api/companies/[id]/route.ts - 詳情/更新 API 端點
 *   - src/types/company.ts - 類型定義
 *   - prisma/schema.prisma - 資料庫模型
 */

import { prisma } from '@/lib/prisma'
import type {
  Prisma,
  RuleStatus as PrismaRuleStatus,
  CompanyStatus as PrismaCompanyStatus,
  CompanyType as PrismaCompanyType,
  CompanySource as PrismaCompanySource,
} from '@prisma/client'
import type {
  CompanyListItem,
  CompaniesResponse,
  CompanyDetail,
  CompanyDetailView,
  CompanyIdentificationPattern,
  ValidatedCompaniesQuery,
  ValidatedRulesQuery,
  CompanySortField,
  SortOrder,
  RulesSummary,
  RuleStatusCounts,
  CompanyStats as CompanyStatsData,
  DailyTrendData,
  RecentDocumentItem,
  RuleListItem,
  RulesResponse,
  RuleStatus,
  CompanyStatus,
  CompanyType,
  CompanySource,
  CreateCompanyFormData,
  UpdateCompanyFormData,
} from '@/types/company'
import { mapDocumentStatus, getIsActiveFromStatus } from '@/types/company'

// ============================================================
// 類型定義
// ============================================================

/**
 * Company 列表查詢參數
 */
export interface GetCompaniesParams {
  /** 搜尋關鍵字（name, code） */
  search?: string
  /** 狀態篩選 */
  status?: CompanyStatus
  /** 公司類型篩選 (REFACTOR-001) */
  type?: CompanyType
  /** 公司來源篩選 (REFACTOR-001) */
  source?: CompanySource
  /** 頁碼（從 1 開始）*/
  page?: number
  /** 每頁數量 */
  limit?: number
  /** 排序欄位 */
  sortBy?: CompanySortField
  /** 排序方向 */
  sortOrder?: SortOrder
}

/**
 * 排序欄位對應
 * ruleCount 需要特殊處理（計算欄位）
 */
const SORT_FIELD_MAP: Record<CompanySortField, string> = {
  name: 'name',
  code: 'code',
  updatedAt: 'updatedAt',
  createdAt: 'createdAt',
  priority: 'priority',
  ruleCount: '_count.mappingRules', // 特殊處理
  type: 'type', // REFACTOR-001
}

// ============================================================
// Company 列表查詢
// ============================================================

/**
 * 獲取 Company 列表（分頁、搜尋、篩選、排序）
 *
 * @description
 *   查詢 Company 列表，支援：
 *   - 關鍵字搜尋（name, code, displayName, nameVariants）
 *   - 狀態篩選（status）
 *   - 類型篩選（type）- REFACTOR-001
 *   - 來源篩選（source）- REFACTOR-001
 *   - 分頁
 *   - 多欄位排序
 *   - 包含規則數量統計
 *
 * @param params - 查詢參數
 * @returns Company 列表和分頁資訊
 *
 * @example
 *   const result = await getCompanies({
 *     search: 'DHL',
 *     status: 'ACTIVE',
 *     type: 'FORWARDER',
 *     page: 1,
 *     limit: 10,
 *     sortBy: 'updatedAt',
 *     sortOrder: 'desc',
 *   })
 */
export async function getCompanies(
  params: GetCompaniesParams = {}
): Promise<CompaniesResponse> {
  const {
    search,
    status,
    type,
    source,
    page = 1,
    limit = 10,
    sortBy = 'updatedAt',
    sortOrder = 'desc',
  } = params

  // 構建 where 條件
  const where: Prisma.CompanyWhereInput = {
    // 排除已合併的公司
    mergedIntoId: null,
    // 搜尋條件（name, code, displayName, nameVariants）
    ...(search && {
      OR: [
        { name: { contains: search, mode: 'insensitive' as const } },
        { code: { contains: search, mode: 'insensitive' as const } },
        { displayName: { contains: search, mode: 'insensitive' as const } },
        { nameVariants: { has: search } }, // REFACTOR-001: 搜尋名稱變體
      ],
    }),
    // 狀態篩選
    ...(status && { status: status as PrismaCompanyStatus }),
    // 類型篩選 (REFACTOR-001)
    ...(type && { type: type as PrismaCompanyType }),
    // 來源篩選 (REFACTOR-001)
    ...(source && { source: source as PrismaCompanySource }),
  }

  // 構建排序條件 - 使用明確的 switch 避免 Prisma 動態 key 問題
  let orderBy: Prisma.CompanyOrderByWithRelationInput | Prisma.CompanyOrderByWithRelationInput[]

  switch (sortBy) {
    case 'ruleCount':
      // ruleCount 需要按關聯數量排序
      orderBy = {
        mappingRules: {
          _count: sortOrder,
        },
      }
      break
    case 'name':
      orderBy = { name: sortOrder }
      break
    case 'code':
      orderBy = { code: sortOrder }
      break
    case 'createdAt':
      orderBy = { createdAt: sortOrder }
      break
    case 'priority':
      orderBy = { priority: sortOrder }
      break
    case 'type':
      orderBy = { type: sortOrder }
      break
    case 'updatedAt':
    default:
      orderBy = { updatedAt: sortOrder }
  }

  // 執行並行查詢（資料 + 總數）
  const [companiesRaw, total] = await prisma.$transaction([
    prisma.company.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy,
      include: {
        _count: {
          select: {
            mappingRules: true,
          },
        },
      },
    }),
    prisma.company.count({ where }),
  ])

  // 轉換為 CompanyListItem 格式
  const data: CompanyListItem[] = companiesRaw.map((c) => ({
    id: c.id,
    name: c.name,
    code: c.code,
    displayName: c.displayName,
    status: c.status as CompanyStatus,
    isActive: getIsActiveFromStatus(c.status as CompanyStatus),
    // REFACTOR-001: 新增欄位
    type: c.type as CompanyType,
    source: c.source as CompanySource,
    nameVariants: c.nameVariants,
    mergedIntoId: c.mergedIntoId,
    priority: c.priority,
    ruleCount: c._count.mappingRules,
    updatedAt: c.updatedAt,
    createdAt: c.createdAt,
    logoUrl: c.logoUrl,
    description: c.description,
    contactEmail: c.contactEmail,
    defaultConfidence: c.defaultConfidence,
  }))

  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  }
}

/**
 * 從已驗證的查詢參數獲取 Company 列表
 *
 * @description
 *   包裝 getCompanies，接受 Zod 驗證後的查詢參數
 *
 * @param query - 已驗證的查詢參數
 * @returns Company 列表和分頁資訊
 */
export async function getCompaniesFromQuery(
  query: ValidatedCompaniesQuery
): Promise<CompaniesResponse> {
  return getCompanies({
    search: query.search,
    status: query.status,
    type: query.type,
    source: query.source,
    page: query.page,
    limit: query.limit,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
  })
}

// ============================================================
// Company 詳情查詢
// ============================================================

/**
 * 根據 ID 獲取 Company 詳情
 *
 * @description
 *   獲取單個 Company 的完整資訊，包含：
 *   - 基本資料
 *   - 識別模式
 *   - 規則數量
 *   - 文件數量
 *   - 合併資訊 (REFACTOR-001)
 *
 * @param id - Company ID
 * @returns Company 詳情或 null
 */
export async function getCompanyById(id: string): Promise<CompanyDetail | null> {
  const company = await prisma.company.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          mappingRules: true,
          documents: true,
          mergedFrom: true, // REFACTOR-001: 被合併的公司數量
        },
      },
      mergedInto: { // REFACTOR-001: 如果被合併，顯示合併目標
        select: {
          id: true,
          name: true,
          displayName: true,
        },
      },
    },
  })

  if (!company) {
    return null
  }

  // 解析識別模式 JSON（Prisma 返回 JsonValue 類型，需要類型斷言）
  const identificationPatterns = Array.isArray(company.identificationPatterns)
    ? (company.identificationPatterns as unknown as CompanyIdentificationPattern[])
    : []

  return {
    id: company.id,
    name: company.name,
    code: company.code,
    displayName: company.displayName,
    status: company.status as CompanyStatus,
    isActive: getIsActiveFromStatus(company.status as CompanyStatus),
    // REFACTOR-001: 新增欄位
    type: company.type as CompanyType,
    source: company.source as CompanySource,
    nameVariants: company.nameVariants,
    mergedIntoId: company.mergedIntoId,
    mergedIntoCompany: company.mergedInto,
    mergedFromCount: company._count.mergedFrom,
    priority: company.priority,
    ruleCount: company._count.mappingRules,
    documentCount: company._count.documents,
    identificationPatterns,
    updatedAt: company.updatedAt,
    createdAt: company.createdAt,
    logoUrl: company.logoUrl,
    description: company.description,
    contactEmail: company.contactEmail,
    defaultConfidence: company.defaultConfidence,
    firstSeenDocumentId: company.firstSeenDocumentId,
  }
}

/**
 * 根據 Code 獲取 Company
 *
 * @param code - Company 代碼
 * @returns Company 或 null
 */
export async function getCompanyByCode(code: string): Promise<CompanyListItem | null> {
  const company = await prisma.company.findUnique({
    where: { code },
    include: {
      _count: {
        select: {
          mappingRules: true,
        },
      },
    },
  })

  if (!company) {
    return null
  }

  return {
    id: company.id,
    name: company.name,
    code: company.code,
    displayName: company.displayName,
    status: company.status as CompanyStatus,
    isActive: getIsActiveFromStatus(company.status as CompanyStatus),
    type: company.type as CompanyType,
    source: company.source as CompanySource,
    nameVariants: company.nameVariants,
    mergedIntoId: company.mergedIntoId,
    priority: company.priority,
    ruleCount: company._count.mappingRules,
    updatedAt: company.updatedAt,
    createdAt: company.createdAt,
    logoUrl: company.logoUrl,
    description: company.description,
    contactEmail: company.contactEmail,
    defaultConfidence: company.defaultConfidence,
  }
}

/**
 * 根據名稱模糊匹配獲取 Company (REFACTOR-001)
 *
 * @description
 *   用於 Just-in-Time Company Profile 建立時的名稱匹配
 *   搜尋順序：完全匹配 name → 包含在 nameVariants → 模糊搜尋
 *
 * @param name - 公司名稱
 * @returns Company 或 null
 */
export async function getCompanyByName(name: string): Promise<CompanyListItem | null> {
  // 1. 嘗試完全匹配
  let company = await prisma.company.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      mergedIntoId: null, // 排除已合併的公司
    },
    include: {
      _count: { select: { mappingRules: true } },
    },
  })

  // 2. 如果沒找到，搜尋 nameVariants
  if (!company) {
    company = await prisma.company.findFirst({
      where: {
        nameVariants: { has: name },
        mergedIntoId: null,
      },
      include: {
        _count: { select: { mappingRules: true } },
      },
    })
  }

  // 3. 如果還是沒找到，嘗試模糊搜尋
  if (!company) {
    company = await prisma.company.findFirst({
      where: {
        name: { contains: name, mode: 'insensitive' },
        mergedIntoId: null,
      },
      include: {
        _count: { select: { mappingRules: true } },
      },
    })
  }

  if (!company) {
    return null
  }

  return {
    id: company.id,
    name: company.name,
    code: company.code,
    displayName: company.displayName,
    status: company.status as CompanyStatus,
    isActive: getIsActiveFromStatus(company.status as CompanyStatus),
    type: company.type as CompanyType,
    source: company.source as CompanySource,
    nameVariants: company.nameVariants,
    mergedIntoId: company.mergedIntoId,
    priority: company.priority,
    ruleCount: company._count.mappingRules,
    updatedAt: company.updatedAt,
    createdAt: company.createdAt,
    logoUrl: company.logoUrl,
    description: company.description,
    contactEmail: company.contactEmail,
    defaultConfidence: company.defaultConfidence,
  }
}

// ============================================================
// Company 統計
// ============================================================

/**
 * Company 統計資訊
 */
export interface CompanyStats {
  /** 總數 */
  total: number
  /** 各狀態數量 */
  byStatus: Record<CompanyStatus, number>
  /** 各類型數量 (REFACTOR-001) */
  byType: Record<CompanyType, number>
  /** 各來源數量 (REFACTOR-001) */
  bySource: Record<CompanySource, number>
  /** 有規則的 Company 數 */
  withRules: number
  /** 已合併的公司數 */
  merged: number
}

/**
 * 獲取 Company 統計資訊
 *
 * @returns 統計資訊
 */
export async function getCompanyStats(): Promise<CompanyStats> {
  const [
    total,
    byStatusRaw,
    byTypeRaw,
    bySourceRaw,
    withRules,
    merged,
  ] = await prisma.$transaction([
    prisma.company.count(),
    prisma.company.groupBy({
      by: ['status'],
      _count: { id: true },
      orderBy: {},
    }),
    prisma.company.groupBy({
      by: ['type'],
      _count: { id: true },
      orderBy: {},
    }),
    prisma.company.groupBy({
      by: ['source'],
      _count: { id: true },
      orderBy: {},
    }),
    prisma.company.count({
      where: { mappingRules: { some: {} } },
    }),
    prisma.company.count({
      where: { mergedIntoId: { not: null } },
    }),
  ])

  // 初始化計數
  const byStatus: Record<CompanyStatus, number> = {
    ACTIVE: 0,
    INACTIVE: 0,
    PENDING: 0,
    MERGED: 0,
  }

  const byType: Record<CompanyType, number> = {
    FORWARDER: 0,
    EXPORTER: 0,
    CARRIER: 0,
    CUSTOMS_BROKER: 0,
    OTHER: 0,
    UNKNOWN: 0,
  }

  const bySource: Record<CompanySource, number> = {
    MANUAL: 0,
    AUTO_CREATED: 0,
    IMPORTED: 0,
  }

  // 填充狀態計數
  for (const item of byStatusRaw) {
    byStatus[item.status as CompanyStatus] = (item._count as { id?: number })?.id ?? 0
  }

  // 填充類型計數
  for (const item of byTypeRaw) {
    byType[item.type as CompanyType] = (item._count as { id?: number })?.id ?? 0
  }

  // 填充來源計數
  for (const item of bySourceRaw) {
    bySource[item.source as CompanySource] = (item._count as { id?: number })?.id ?? 0
  }

  return {
    total,
    byStatus,
    byType,
    bySource,
    withRules,
    merged,
  }
}

// ============================================================
// Company 檢查
// ============================================================

/**
 * 檢查 Company 是否存在
 *
 * @param id - Company ID
 * @returns 是否存在
 */
export async function companyExists(id: string): Promise<boolean> {
  const count = await prisma.company.count({
    where: { id },
  })
  return count > 0
}

/**
 * 檢查 Company 代碼是否已存在
 *
 * @param code - Company 代碼
 * @param excludeId - 排除的 ID（用於更新時檢查）
 * @returns 是否已存在
 */
export async function companyCodeExists(
  code: string,
  excludeId?: string
): Promise<boolean> {
  const count = await prisma.company.count({
    where: {
      code,
      ...(excludeId && { NOT: { id: excludeId } }),
    },
  })
  return count > 0
}

/**
 * 檢查 Company 名稱是否已存在
 *
 * @param name - Company 名稱
 * @param excludeId - 排除的 ID（用於更新時檢查）
 * @returns 是否已存在
 */
export async function companyNameExists(
  name: string,
  excludeId?: string
): Promise<boolean> {
  const count = await prisma.company.count({
    where: {
      name,
      ...(excludeId && { NOT: { id: excludeId } }),
    },
  })
  return count > 0
}

// ============================================================
// Company 選項（用於下拉選單）
// ============================================================

/**
 * Company 選項項目
 */
export interface CompanyOption {
  value: string
  label: string
  code: string | null
  type: CompanyType
}

/**
 * 獲取所有啟用的 Company 選項
 *
 * @description
 *   用於表單下拉選單，只返回啟用的 Company
 *
 * @param type - 可選的類型篩選
 * @returns Company 選項列表
 */
export async function getActiveCompanyOptions(type?: CompanyType): Promise<CompanyOption[]> {
  const companies = await prisma.company.findMany({
    where: {
      status: 'ACTIVE',
      mergedIntoId: null,
      ...(type && { type: type as PrismaCompanyType }),
    },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      code: true,
      displayName: true,
      type: true,
    },
  })

  return companies.map((c) => ({
    value: c.id,
    label: c.displayName || c.name,
    code: c.code,
    type: c.type as CompanyType,
  }))
}

/**
 * 獲取所有 Company 選項（包含停用）
 *
 * @param type - 可選的類型篩選
 * @returns Company 選項列表
 */
export async function getAllCompanyOptions(type?: CompanyType): Promise<CompanyOption[]> {
  const companies = await prisma.company.findMany({
    where: {
      mergedIntoId: null, // 排除已合併
      ...(type && { type: type as PrismaCompanyType }),
    },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      code: true,
      displayName: true,
      type: true,
    },
  })

  return companies.map((c) => ({
    value: c.id,
    label: c.displayName || c.name,
    code: c.code,
    type: c.type as CompanyType,
  }))
}

// ============================================================
// Company 詳情檢視
// ============================================================

/**
 * 獲取規則摘要統計
 *
 * @description
 *   統計 Company 的規則數量，按狀態分組
 *
 * @param companyId - Company ID
 * @returns 規則摘要
 */
async function getRulesSummary(companyId: string): Promise<RulesSummary> {
  const rules = await prisma.mappingRule.groupBy({
    by: ['status'],
    where: { companyId },
    _count: {
      id: true,
    },
  })

  const byStatus: RuleStatusCounts = {
    active: 0,
    draft: 0,
    pendingReview: 0,
    deprecated: 0,
  }

  let total = 0
  for (const rule of rules) {
    const count = rule._count.id
    total += count
    switch (rule.status) {
      case 'ACTIVE':
        byStatus.active = count
        break
      case 'DRAFT':
        byStatus.draft = count
        break
      case 'PENDING_REVIEW':
        byStatus.pendingReview = count
        break
      case 'DEPRECATED':
        byStatus.deprecated = count
        break
    }
  }

  return { total, byStatus }
}

/**
 * 獲取每日趨勢資料
 *
 * @description
 *   計算過去 30 天每天的文件處理數量和成功數量
 *
 * @param companyId - Company ID
 * @returns 每日趨勢資料陣列
 */
async function getDailyTrend(companyId: string): Promise<DailyTrendData[]> {
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  thirtyDaysAgo.setHours(0, 0, 0, 0)

  // 獲取過去 30 天的文件
  const documents = await prisma.document.findMany({
    where: {
      companyId,
      createdAt: {
        gte: thirtyDaysAgo,
      },
    },
    select: {
      createdAt: true,
      status: true,
    },
  })

  // 建立日期到資料的映射
  const trendMap = new Map<string, { count: number; successCount: number }>()

  // 初始化過去 30 天的資料
  for (let i = 0; i < 30; i++) {
    const date = new Date()
    date.setDate(date.getDate() - i)
    const dateStr = date.toISOString().split('T')[0]
    trendMap.set(dateStr, { count: 0, successCount: 0 })
  }

  // 統計每天的數量
  for (const doc of documents) {
    const dateStr = doc.createdAt.toISOString().split('T')[0]
    const existing = trendMap.get(dateStr)
    if (existing) {
      existing.count++
      if (doc.status === 'COMPLETED') {
        existing.successCount++
      }
    }
  }

  // 轉換為陣列並按日期排序
  const trend: DailyTrendData[] = []
  for (const [date, data] of trendMap) {
    trend.push({
      date,
      count: data.count,
      successCount: data.successCount,
    })
  }

  // 按日期升序排序
  trend.sort((a, b) => a.date.localeCompare(b.date))

  return trend
}

/**
 * 獲取 Company 統計資料
 *
 * @description
 *   計算 Company 的處理統計，包含：
 *   - 總文件數
 *   - 過去 30 天處理數
 *   - 成功率
 *   - 平均信心度
 *   - 每日趨勢
 *
 * @param companyId - Company ID
 * @returns 統計資料
 */
export async function getCompanyStatsById(companyId: string): Promise<CompanyStatsData> {
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  // 並行執行多個查詢
  const [totalDocuments, last30Days, completedCount, avgConfidenceResult, dailyTrend] =
    await Promise.all([
      // 總文件數
      prisma.document.count({
        where: { companyId },
      }),
      // 過去 30 天處理數
      prisma.document.count({
        where: {
          companyId,
          createdAt: { gte: thirtyDaysAgo },
        },
      }),
      // 成功完成數（用於計算成功率）
      prisma.document.count({
        where: {
          companyId,
          status: 'COMPLETED',
        },
      }),
      // 平均信心度（從 ExtractionResult）
      prisma.extractionResult.aggregate({
        where: {
          document: {
            companyId,
          },
        },
        _avg: {
          averageConfidence: true,
        },
      }),
      // 每日趨勢
      getDailyTrend(companyId),
    ])

  // 計算成功率
  const successRate = totalDocuments > 0 ? Math.round((completedCount / totalDocuments) * 100) : 0

  // 平均信心度（0-100 範圍）
  const avgConfidence = avgConfidenceResult._avg?.averageConfidence
    ? Math.round(avgConfidenceResult._avg.averageConfidence)
    : 0

  return {
    totalDocuments,
    processedLast30Days: last30Days,
    successRate,
    avgConfidence,
    dailyTrend,
  }
}

/**
 * 獲取近期文件
 *
 * @description
 *   獲取 Company 最近處理的文件列表
 *
 * @param companyId - Company ID
 * @param limit - 限制數量（預設 10）
 * @returns 近期文件列表
 */
export async function getCompanyRecentDocuments(
  companyId: string,
  limit: number = 10
): Promise<RecentDocumentItem[]> {
  const documents = await prisma.document.findMany({
    where: { companyId },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      fileName: true,
      status: true,
      updatedAt: true,
      createdAt: true,
      extractionResult: {
        select: {
          averageConfidence: true,
        },
      },
    },
  })

  return documents.map((doc) => ({
    id: doc.id,
    fileName: doc.fileName,
    status: mapDocumentStatus(doc.status),
    confidence: doc.extractionResult?.averageConfidence ?? null,
    processedAt: doc.updatedAt,
    createdAt: doc.createdAt,
  }))
}

/**
 * 獲取 Company 詳情檢視（含統計資料）
 *
 * @description
 *   獲取 Company 的完整詳情，包含：
 *   - 基本資料
 *   - 識別模式
 *   - 規則摘要（按狀態分組）
 *   - 處理統計（成功率、平均信心度、趨勢）
 *   - 近期文件列表
 *
 * @param id - Company ID
 * @returns 完整的詳情檢視資料或 null
 *
 * @example
 *   const detail = await getCompanyDetailView('cuid123')
 *   if (detail) {
 *     console.log(detail.stats.successRate)
 *     console.log(detail.rulesSummary.byStatus.active)
 *   }
 */
export async function getCompanyDetailView(id: string): Promise<CompanyDetailView | null> {
  // 首先獲取基本詳情
  const detail = await getCompanyById(id)
  if (!detail) {
    return null
  }

  // 並行獲取其他資料
  const [rulesSummary, stats, recentDocuments] = await Promise.all([
    getRulesSummary(id),
    getCompanyStatsById(id),
    getCompanyRecentDocuments(id, 10),
  ])

  return {
    ...detail,
    rulesSummary,
    stats,
    recentDocuments,
  }
}

// ============================================================
// Company 規則列表
// ============================================================

/**
 * 規則列表查詢參數
 */
export interface GetCompanyRulesParams {
  /** Company ID */
  companyId: string
  /** 狀態篩選 */
  status?: RuleStatus
  /** 搜尋欄位名稱 */
  search?: string
  /** 頁碼（從 1 開始）*/
  page?: number
  /** 每頁數量 */
  limit?: number
  /** 排序欄位 */
  sortBy?: 'fieldName' | 'status' | 'confidence' | 'matchCount' | 'updatedAt'
  /** 排序方向 */
  sortOrder?: SortOrder
}

/**
 * 獲取 Company 的規則列表（分頁）
 *
 * @description
 *   獲取指定 Company 的映射規則列表，支援：
 *   - 狀態篩選
 *   - 欄位名稱搜尋
 *   - 分頁
 *   - 排序
 *
 * @param params - 查詢參數
 * @returns 規則列表和分頁資訊
 *
 * @example
 *   const result = await getCompanyRules({
 *     companyId: 'cuid123',
 *     status: 'ACTIVE',
 *     page: 1,
 *     limit: 10,
 *   })
 */
export async function getCompanyRules(params: GetCompanyRulesParams): Promise<RulesResponse> {
  const {
    companyId,
    status,
    search,
    page = 1,
    limit = 10,
    sortBy = 'updatedAt',
    sortOrder = 'desc',
  } = params

  // 構建 where 條件
  const where: Prisma.MappingRuleWhereInput = {
    companyId,
    ...(status && { status: status as PrismaRuleStatus }),
    ...(search && {
      fieldName: { contains: search, mode: 'insensitive' as const },
    }),
  }

  // 構建排序條件
  const orderBy: Prisma.MappingRuleOrderByWithRelationInput = {
    [sortBy]: sortOrder,
  }

  // 執行並行查詢
  const [rulesRaw, total] = await prisma.$transaction([
    prisma.mappingRule.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy,
      select: {
        id: true,
        fieldName: true,
        status: true,
        version: true,
        confidence: true,
        updatedAt: true,
        _count: {
          select: {
            applications: true,
          },
        },
      },
    }),
    prisma.mappingRule.count({ where }),
  ])

  // 轉換為 RuleListItem 格式
  const data: RuleListItem[] = rulesRaw.map((rule) => ({
    id: rule.id,
    fieldName: rule.fieldName,
    status: rule.status as RuleStatus,
    version: rule.version,
    confidence: Math.round(rule.confidence * 100),
    matchCount: rule._count.applications,
    lastMatchedAt: null,
    updatedAt: rule.updatedAt,
  }))

  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  }
}

/**
 * 從已驗證的查詢參數獲取規則列表
 *
 * @param companyId - Company ID
 * @param query - 已驗證的查詢參數
 * @returns 規則列表和分頁資訊
 */
export async function getCompanyRulesFromQuery(
  companyId: string,
  query: ValidatedRulesQuery
): Promise<RulesResponse> {
  return getCompanyRules({
    companyId,
    status: query.status as RuleStatus | undefined,
    search: query.search,
    page: query.page,
    limit: query.limit,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
  })
}

// ============================================================
// Company CRUD 操作
// ============================================================

/**
 * 創建 Company 輸入參數
 */
export interface CreateCompanyInput {
  /** 名稱 */
  name: string
  /** 代碼（可選，REFACTOR-001） */
  code?: string | null
  /** 描述 */
  description?: string | null
  /** 聯絡電子郵件 */
  contactEmail?: string | null
  /** 預設信心度 */
  defaultConfidence?: number
  /** Logo URL（上傳後的 URL） */
  logoUrl?: string | null
  /** 公司類型 (REFACTOR-001) */
  type?: CompanyType
  /** 公司來源 (REFACTOR-001) */
  source?: CompanySource
  /** 名稱變體 (REFACTOR-001) */
  nameVariants?: string[]
  /** 首次出現的文件 ID (REFACTOR-001) */
  firstSeenDocumentId?: string | null
  /** 創建者 ID */
  createdById: string
}

/**
 * 創建新的 Company
 *
 * @description
 *   創建新的 Company Profile
 *   - 初始狀態為 PENDING（手動創建）或可指定
 *   - displayName 預設等於 name
 *   - 支援自動創建來源 (REFACTOR-001)
 *
 * @param input - 創建參數
 * @returns 創建的 Company ID 和狀態
 */
export async function createCompany(input: CreateCompanyInput): Promise<{
  id: string
  name: string
  code: string | null
  status: CompanyStatus
  type: CompanyType
  source: CompanySource
}> {
  const company = await prisma.company.create({
    data: {
      name: input.name,
      code: input.code ?? null,
      displayName: input.name,
      description: input.description,
      contactEmail: input.contactEmail,
      defaultConfidence: input.defaultConfidence ?? 0.8,
      logoUrl: input.logoUrl,
      type: (input.type ?? 'UNKNOWN') as PrismaCompanyType,
      source: (input.source ?? 'MANUAL') as PrismaCompanySource,
      status: 'PENDING' as PrismaCompanyStatus,
      nameVariants: input.nameVariants ?? [],
      firstSeenDocumentId: input.firstSeenDocumentId,
      createdById: input.createdById,
      identificationPatterns: [],
    },
    select: {
      id: true,
      name: true,
      code: true,
      status: true,
      type: true,
      source: true,
    },
  })

  return {
    id: company.id,
    name: company.name,
    code: company.code,
    status: company.status as CompanyStatus,
    type: company.type as CompanyType,
    source: company.source as CompanySource,
  }
}

/**
 * Just-in-Time Company Profile 創建 (REFACTOR-001)
 *
 * @description
 *   當處理文件時發現新公司時自動創建 Profile
 *   - 來源標記為 AUTO_CREATED
 *   - 類型標記為 UNKNOWN（待後續確認）
 *   - 狀態為 PENDING
 *   - 記錄首次出現的文件
 *
 * @param input - 創建參數
 * @returns 創建的 Company
 */
export async function createCompanyJIT(input: {
  name: string
  firstSeenDocumentId: string
  createdById: string
  nameVariants?: string[]
}): Promise<{
  id: string
  name: string
  status: CompanyStatus
  type: CompanyType
  source: CompanySource
}> {
  return createCompany({
    name: input.name,
    nameVariants: input.nameVariants ?? [input.name],
    firstSeenDocumentId: input.firstSeenDocumentId,
    type: 'UNKNOWN',
    source: 'AUTO_CREATED',
    createdById: input.createdById,
  })
}

/**
 * 更新 Company 輸入參數
 */
export interface UpdateCompanyInput {
  /** 名稱 */
  name?: string
  /** 公司代碼（CHANGE-095：僅允許對空 code 補填一次，已有值不可修改） */
  code?: string | null
  /** 描述 */
  description?: string | null
  /** 聯絡電子郵件 */
  contactEmail?: string | null
  /** 預設信心度 */
  defaultConfidence?: number
  /** Logo URL（上傳後的 URL） */
  logoUrl?: string | null
  /** 公司類型 (REFACTOR-001) */
  type?: CompanyType
  /** 名稱變體 (REFACTOR-001) */
  nameVariants?: string[]
}

/**
 * 更新 Company
 *
 * @description
 *   更新 Company Profile 基本資訊
 *   - CHANGE-095: 僅允許對「空 code」補填一次；已有 code 不可修改
 *   - 不允許直接修改 status（使用 deactivate/activate）
 *
 * @param id - Company ID
 * @param input - 更新參數
 * @returns 更新後的 Company 資料
 */
export async function updateCompany(
  id: string,
  input: UpdateCompanyInput
): Promise<{
  id: string
  name: string
  code: string | null
  description: string | null
  logoUrl: string | null
  contactEmail: string | null
  defaultConfidence: number
  status: CompanyStatus
  type: CompanyType
}> {
  // 構建更新資料，只包含有值的欄位
  const updateData: Prisma.CompanyUpdateInput = {}

  // CHANGE-095: code 補填處理（「只補空值」政策的後端防線）
  if (input.code) {
    const current = await prisma.company.findUnique({
      where: { id },
      select: { code: true },
    })

    if (current?.code) {
      // 已有 code：只有「維持原值」允許（no-op），改成別的值一律拒絕
      if (current.code !== input.code) {
        throw new Error('Company code cannot be modified once set')
      }
    } else {
      // 空 code 補填：唯一性檢查（排除自身）後寫入
      const existing = await prisma.company.findUnique({
        where: { code: input.code },
      })
      if (existing && existing.id !== id) {
        throw new Error(`Company with code '${input.code}' already exists`)
      }
      updateData.code = input.code
    }
  }

  if (input.name !== undefined) {
    updateData.name = input.name
    updateData.displayName = input.name
  }
  if (input.description !== undefined) {
    updateData.description = input.description
  }
  if (input.contactEmail !== undefined) {
    updateData.contactEmail = input.contactEmail
  }
  if (input.defaultConfidence !== undefined) {
    updateData.defaultConfidence = input.defaultConfidence
  }
  if (input.logoUrl !== undefined) {
    updateData.logoUrl = input.logoUrl
  }
  if (input.type !== undefined) {
    updateData.type = input.type as PrismaCompanyType
  }
  if (input.nameVariants !== undefined) {
    updateData.nameVariants = input.nameVariants
  }

  const company = await prisma.company.update({
    where: { id },
    data: updateData,
    select: {
      id: true,
      name: true,
      code: true,
      description: true,
      logoUrl: true,
      contactEmail: true,
      defaultConfidence: true,
      status: true,
      type: true,
    },
  })

  return {
    ...company,
    status: company.status as CompanyStatus,
    type: company.type as CompanyType,
  }
}

/**
 * 停用 Company
 *
 * @description
 *   停用 Company Profile
 *   - 將狀態改為 INACTIVE
 *   - 可選擇同時停用所有 ACTIVE 規則（改為 DEPRECATED）
 *   - 記錄停用原因
 *
 * @param id - Company ID
 * @param options - 停用選項
 * @returns 停用結果
 */
export async function deactivateCompany(
  id: string,
  options: {
    reason?: string
    deactivateRules?: boolean
  } = {}
): Promise<{
  id: string
  name: string
  status: CompanyStatus
  rulesAffected: number
}> {
  const { deactivateRules = true } = options

  // 使用事務確保一致性
  const result = await prisma.$transaction(async (tx) => {
    // 1. 更新 Company 狀態
    const company = await tx.company.update({
      where: { id },
      data: {
        status: 'INACTIVE' as PrismaCompanyStatus,
      },
      select: {
        id: true,
        name: true,
        status: true,
      },
    })

    let rulesAffected = 0

    // 2. 如果需要，停用所有 ACTIVE 規則
    if (deactivateRules) {
      const updateResult = await tx.mappingRule.updateMany({
        where: {
          companyId: id,
          status: 'ACTIVE',
        },
        data: {
          status: 'DEPRECATED',
        },
      })
      rulesAffected = updateResult.count
    }

    return {
      id: company.id,
      name: company.name,
      status: company.status as CompanyStatus,
      rulesAffected,
    }
  })

  return result
}

/**
 * 啟用 Company
 *
 * @description
 *   啟用 Company Profile
 *   - 將狀態改為 ACTIVE
 *   - 可選擇重新啟用之前的 DEPRECATED 規則（改為 ACTIVE）
 *
 * @param id - Company ID
 * @param options - 啟用選項
 * @returns 啟用結果
 */
export async function activateCompany(
  id: string,
  options: {
    reactivateRules?: boolean
  } = {}
): Promise<{
  id: string
  name: string
  status: CompanyStatus
  rulesAffected: number
}> {
  const { reactivateRules = false } = options

  // 使用事務確保一致性
  const result = await prisma.$transaction(async (tx) => {
    // 1. 更新 Company 狀態
    const company = await tx.company.update({
      where: { id },
      data: {
        status: 'ACTIVE' as PrismaCompanyStatus,
      },
      select: {
        id: true,
        name: true,
        status: true,
      },
    })

    let rulesAffected = 0

    // 2. 如果需要，重新啟用 DEPRECATED 規則
    if (reactivateRules) {
      const updateResult = await tx.mappingRule.updateMany({
        where: {
          companyId: id,
          status: 'DEPRECATED',
        },
        data: {
          status: 'ACTIVE',
        },
      })
      rulesAffected = updateResult.count
    }

    return {
      id: company.id,
      name: company.name,
      status: company.status as CompanyStatus,
      rulesAffected,
    }
  })

  return result
}

/**
 * 合併公司 (REFACTOR-001)
 *
 * @description
 *   將來源公司合併到目標公司
 *   - 來源公司狀態改為 MERGED
 *   - 所有關聯的文件、提取結果、規則轉移到目標公司（extractionResults 為 FIX-112 補齊）
 *   - 來源公司的名稱變體加入目標公司
 *
 * @param sourceId - 來源公司 ID
 * @param targetId - 目標公司 ID
 * @returns 合併結果（含各類關聯轉移數量）
 */
export async function mergeCompanies(
  sourceId: string,
  targetId: string
): Promise<{
  sourceId: string
  targetId: string
  documentsTransferred: number
  extractionResultsTransferred: number
  rulesTransferred: number
}> {
  const result = await prisma.$transaction(async (tx) => {
    // 1. 獲取來源公司資訊
    const source = await tx.company.findUnique({
      where: { id: sourceId },
      select: { name: true, nameVariants: true },
    })

    if (!source) {
      throw new Error(`Source company not found: ${sourceId}`)
    }

    // 2. 更新目標公司的名稱變體
    const target = await tx.company.findUnique({
      where: { id: targetId },
      select: { nameVariants: true },
    })

    if (!target) {
      throw new Error(`Target company not found: ${targetId}`)
    }

    const combinedVariants = [
      ...new Set([
        ...target.nameVariants,
        source.name,
        ...source.nameVariants,
      ]),
    ]

    await tx.company.update({
      where: { id: targetId },
      data: { nameVariants: combinedVariants },
    })

    // 3. 轉移文件
    const documentsResult = await tx.document.updateMany({
      where: { companyId: sourceId },
      data: { companyId: targetId },
    })

    // 4. 轉移提取結果（FIX-112：補既有缺口——原本只轉移 documents + mappingRules，
    //    未處理 extractionResults，導致合併後 COMPANY 級 template 映射因 companyId
    //    不相等而失效。與 confirmCompanyMerge 一致。）
    const extractionResultsResult = await tx.extractionResult.updateMany({
      where: { companyId: sourceId },
      data: { companyId: targetId },
    })

    // 5. 轉移規則
    const rulesResult = await tx.mappingRule.updateMany({
      where: { companyId: sourceId },
      data: { companyId: targetId },
    })

    // 6. 更新來源公司狀態
    await tx.company.update({
      where: { id: sourceId },
      data: {
        status: 'MERGED' as PrismaCompanyStatus,
        mergedIntoId: targetId,
      },
    })

    return {
      sourceId,
      targetId,
      documentsTransferred: documentsResult.count,
      extractionResultsTransferred: extractionResultsResult.count,
      rulesTransferred: rulesResult.count,
    }
  })

  return result
}

/**
 * 獲取 Company 的 ACTIVE 規則數量
 *
 * @param companyId - Company ID
 * @returns ACTIVE 規則數量
 */
export async function getActiveRulesCount(companyId: string): Promise<number> {
  return prisma.mappingRule.count({
    where: {
      companyId,
      status: 'ACTIVE',
    },
  })
}

/**
 * 獲取 Company 的 DEPRECATED 規則數量
 *
 * @param companyId - Company ID
 * @returns DEPRECATED 規則數量
 */
export async function getDeprecatedRulesCount(companyId: string): Promise<number> {
  return prisma.mappingRule.count({
    where: {
      companyId,
      status: 'DEPRECATED',
    },
  })
}

/**
 * 獲取 Company 原始資料（用於編輯）
 *
 * @param id - Company ID
 * @returns Company 原始資料或 null
 */
export async function getCompanyForEdit(id: string): Promise<{
  id: string
  name: string
  code: string | null
  description: string | null
  logoUrl: string | null
  contactEmail: string | null
  defaultConfidence: number
  status: CompanyStatus
  type: CompanyType
  nameVariants: string[]
} | null> {
  const company = await prisma.company.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      code: true,
      description: true,
      logoUrl: true,
      contactEmail: true,
      defaultConfidence: true,
      status: true,
      type: true,
      nameVariants: true,
    },
  })

  if (!company) {
    return null
  }

  return {
    ...company,
    status: company.status as CompanyStatus,
    type: company.type as CompanyType,
  }
}

// ============================================================
// CHANGE-103 Phase 2（組件 4）：PENDING 疑似重複公司人工審核
// ============================================================

/**
 * PENDING 審核佇列項目
 *
 * @description
 *   灰帶 JIT 建立的 PENDING 公司，附帶其疑似重複的目標公司資訊，
 *   供公司管理頁的人工審核佇列使用。
 */
export interface PendingReviewCompanyItem {
  /** PENDING 公司 ID */
  id: string
  /** PENDING 公司名稱（canonical name） */
  name: string
  /** PENDING 公司顯示名稱 */
  displayName: string
  /** 建立時間（首次出現時間） */
  createdAt: Date
  /** 該 PENDING 公司目前綁定的文件數 */
  documentCount: number
  /** 疑似重複的目標公司（灰帶命中的既有公司） */
  suspectedDuplicateOf: {
    id: string
    name: string
    displayName: string
    /** 目標公司目前綁定的文件數 */
    documentCount: number
  } | null
}

/**
 * 取得所有待審核的 PENDING 疑似重複公司
 *
 * @description
 *   列出所有 status=PENDING 且 suspectedDuplicateOfId 非空的公司（灰帶 JIT 產物），
 *   附帶各自的文件數，以及疑似重複目標公司的基本資訊 + 文件數，供人工審核佇列使用。
 *   以 createdAt 升序排列，讓最早出現者優先審核。
 *
 * @returns 待審核公司列表（不分頁；PENDING 疑似重複量預期不大）
 */
export async function listPendingReviewCompanies(): Promise<PendingReviewCompanyItem[]> {
  const companies = await prisma.company.findMany({
    where: {
      status: 'PENDING' as PrismaCompanyStatus,
      suspectedDuplicateOfId: { not: null },
    },
    select: {
      id: true,
      name: true,
      displayName: true,
      createdAt: true,
      _count: { select: { documents: true } },
      suspectedDuplicateOf: {
        select: {
          id: true,
          name: true,
          displayName: true,
          _count: { select: { documents: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  return companies.map((company) => ({
    id: company.id,
    name: company.name,
    displayName: company.displayName,
    createdAt: company.createdAt,
    documentCount: company._count.documents,
    suspectedDuplicateOf: company.suspectedDuplicateOf
      ? {
          id: company.suspectedDuplicateOf.id,
          name: company.suspectedDuplicateOf.name,
          displayName: company.suspectedDuplicateOf.displayName,
          documentCount: company.suspectedDuplicateOf._count.documents,
        }
      : null,
  }))
}

/**
 * 確認 PENDING 公司為「全新公司」
 *
 * @description
 *   人工審核判定該 PENDING 公司並非既有公司的變體 → 升為 ACTIVE 並清除疑似重複標記，
 *   使其得以進入 loadKnownCompanies 的 ACTIVE 候選。
 *
 * @param companyId - 待確認的 PENDING 公司 ID
 * @returns 更新後的公司（id / name / status）
 * @throws Error 若公司不存在（訊息含 "not found"）
 * @throws Error 若公司非 PENDING 狀態（訊息含 "not in PENDING status"）
 */
export async function confirmCompanyAsNew(companyId: string): Promise<{
  id: string
  name: string
  status: CompanyStatus
}> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, status: true },
  })

  if (!company) {
    throw new Error(`Company not found: ${companyId}`)
  }

  if (company.status !== 'PENDING') {
    throw new Error(
      `Company ${companyId} is not in PENDING status (current: ${company.status}); cannot confirm as new`
    )
  }

  const updated = await prisma.company.update({
    where: { id: companyId },
    data: {
      status: 'ACTIVE' as PrismaCompanyStatus,
      suspectedDuplicateOfId: null,
    },
    select: { id: true, name: true, status: true },
  })

  return {
    id: updated.id,
    name: updated.name,
    status: updated.status as CompanyStatus,
  }
}

/**
 * 確認 PENDING 公司為「既有公司變體」並併入疑似目標
 *
 * @description
 *   人工審核判定該 PENDING 公司是其 suspectedDuplicateOfId 目標公司的變體 → 執行完整合併。
 *   於單一 transaction 內原子性完成：
 *   1. 合併 nameVariants（來源 name + 變體 append 到目標，去重不覆蓋）
 *   2. 轉移 documents（company_id → 目標）
 *   3. 轉移 extractionResults（company_id → 目標）— **補既有 `mergeCompanies` 未轉移提取結果的缺口**
 *   4. 轉移 mappingRules（company_id → 目標）
 *   5. 來源公司設為 MERGED + mergedIntoId=目標 + 清除疑似重複標記
 *
 * @param companyId - 待併入的 PENDING 公司 ID
 * @returns 合併結果（轉移數量統計）
 * @throws Error 若公司不存在（訊息含 "not found"）
 * @throws Error 若公司非 PENDING 狀態（訊息含 "not in PENDING status"）
 * @throws Error 若公司無 suspectedDuplicateOfId（訊息含 "no suspectedDuplicateOfId"）
 */
export async function confirmCompanyMerge(companyId: string): Promise<{
  sourceId: string
  targetId: string
  documentsTransferred: number
  extractionResultsTransferred: number
  rulesTransferred: number
}> {
  return prisma.$transaction(async (tx) => {
    // 1. 讀取來源公司並驗證：必須 PENDING 且有疑似重複目標
    const source = await tx.company.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        name: true,
        nameVariants: true,
        status: true,
        suspectedDuplicateOfId: true,
      },
    })

    if (!source) {
      throw new Error(`Company not found: ${companyId}`)
    }

    if (source.status !== 'PENDING') {
      throw new Error(
        `Company ${companyId} is not in PENDING status (current: ${source.status}); cannot confirm merge`
      )
    }

    if (!source.suspectedDuplicateOfId) {
      throw new Error(
        `Company ${companyId} has no suspectedDuplicateOfId; nothing to merge into`
      )
    }

    const targetId = source.suspectedDuplicateOfId

    // 2. 讀取目標公司
    const target = await tx.company.findUnique({
      where: { id: targetId },
      select: { id: true, nameVariants: true },
    })

    if (!target) {
      throw new Error(`Suspected duplicate target company not found: ${targetId}`)
    }

    // 3. 合併 nameVariants（去重、append 不覆蓋）
    const combinedVariants = [
      ...new Set([...target.nameVariants, source.name, ...source.nameVariants]),
    ]

    await tx.company.update({
      where: { id: targetId },
      data: { nameVariants: combinedVariants },
    })

    // 4. 轉移文件
    const documentsResult = await tx.document.updateMany({
      where: { companyId: source.id },
      data: { companyId: targetId },
    })

    // 5. 轉移提取結果（補既有 mergeCompanies 缺口：其僅轉移 documents + mappingRules，未處理 extractionResults）
    const extractionResultsResult = await tx.extractionResult.updateMany({
      where: { companyId: source.id },
      data: { companyId: targetId },
    })

    // 6. 轉移映射規則
    const rulesResult = await tx.mappingRule.updateMany({
      where: { companyId: source.id },
      data: { companyId: targetId },
    })

    // 7. 來源公司設為 MERGED + 記錄合併目標 + 清除疑似重複標記
    await tx.company.update({
      where: { id: source.id },
      data: {
        status: 'MERGED' as PrismaCompanyStatus,
        mergedIntoId: targetId,
        suspectedDuplicateOfId: null,
      },
    })

    return {
      sourceId: source.id,
      targetId,
      documentsTransferred: documentsResult.count,
      extractionResultsTransferred: extractionResultsResult.count,
      rulesTransferred: rulesResult.count,
    }
  })
}

// ============================================================
// 向後相容別名 (DEPRECATED)
// ============================================================

// 這些函數是為了向後相容而保留的，請使用新的 Company 版本

/** @deprecated Use getCompanies instead */
export const getForwarders = getCompanies
/** @deprecated Use getCompaniesFromQuery instead */
export const getForwardersFromQuery = getCompaniesFromQuery
/** @deprecated Use getCompanyById instead */
export const getForwarderById = getCompanyById
/** @deprecated Use getCompanyByCode instead */
export const getForwarderByCode = getCompanyByCode
/** @deprecated Use getCompanyStats instead */
export const getForwarderStats = getCompanyStats
/** @deprecated Use companyExists instead */
export const forwarderExists = companyExists
/** @deprecated Use companyCodeExists instead */
export const forwarderCodeExists = companyCodeExists
/** @deprecated Use companyNameExists instead */
export const forwarderNameExists = companyNameExists
/** @deprecated Use getActiveCompanyOptions instead */
export const getActiveForwarderOptions = getActiveCompanyOptions
/** @deprecated Use getAllCompanyOptions instead */
export const getAllForwarderOptions = getAllCompanyOptions
/** @deprecated Use getCompanyStatsById instead */
export const getForwarderStatsById = getCompanyStatsById
/** @deprecated Use getCompanyRecentDocuments instead */
export const getForwarderRecentDocuments = getCompanyRecentDocuments
/** @deprecated Use getCompanyDetailView instead */
export const getForwarderDetailView = getCompanyDetailView
/** @deprecated Use getCompanyRules instead */
export const getForwarderRules = getCompanyRules
/** @deprecated Use getCompanyRulesFromQuery instead */
export const getForwarderRulesFromQuery = getCompanyRulesFromQuery
/** @deprecated Use createCompany instead */
export const createForwarder = createCompany
/** @deprecated Use updateCompany instead */
export const updateForwarder = updateCompany
/** @deprecated Use deactivateCompany instead */
export const deactivateForwarder = deactivateCompany
/** @deprecated Use activateCompany instead */
export const activateForwarder = activateCompany
/** @deprecated Use getCompanyForEdit instead */
export const getForwarderForEdit = getCompanyForEdit

// 類型別名
/** @deprecated Use GetCompaniesParams instead */
export type GetForwardersParams = GetCompaniesParams
/** @deprecated Use GetCompanyRulesParams instead */
export type GetForwarderRulesParams = GetCompanyRulesParams
/** @deprecated Use CreateCompanyInput instead */
export type CreateForwarderInput = CreateCompanyInput
/** @deprecated Use UpdateCompanyInput instead */
export type UpdateForwarderInput = UpdateCompanyInput
/** @deprecated Use CompanyOption instead */
export type ForwarderOption = CompanyOption
