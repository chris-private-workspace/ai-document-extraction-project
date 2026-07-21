/**
 * @fileoverview 公司自動建立服務（Just-in-Time）
 * @description
 *   負責在 AI 處理過程中自動建立公司 Profile：
 *   - 從提取結果識別公司名稱
 *   - 調用匹配服務檢查是否存在
 *   - 自動建立新公司 Profile
 *   - 記錄公司來源和首次出現文件
 *
 * @module src/services/company-auto-create
 * @since Epic 0 - Story 0.3
 * @lastModified 2025-12-23
 *
 * @features
 *   - JIT 公司 Profile 建立
 *   - 自動匹配現有公司
 *   - 來源追蹤（AUTO_CREATED）
 *   - 首次出現文件記錄
 *
 * @dependencies
 *   - Prisma Client - 數據庫操作
 *   - company-matcher.service - 公司匹配服務
 *
 * @related
 *   - src/services/company-matcher.service.ts - 匹配服務
 *   - src/services/batch-processor.service.ts - 批量處理服務
 */

import { prisma } from '@/lib/prisma'
import { CompanyStatus, CompanySource, CompanyType, Company } from '@prisma/client'
// FIX-125: 合併時一併轉移「公司處理知識」類關聯
import {
  transferCompanyKnowledge,
  logMergeTransferSkips,
} from './company-merge-transfer.service'
import {
  findMatchingCompany,
  findPossibleDuplicates,
  clearMatcherCache,
  type CompanyMatchResult,
  type PossibleDuplicate,
} from './company-matcher.service'

// ============================================================
// Types
// ============================================================

/**
 * 公司識別結果
 */
export interface CompanyIdentificationResult {
  /** 是否為新公司 */
  isNewCompany: boolean
  /** 公司 ID */
  companyId: string
  /** 公司名稱 */
  companyName: string
  /** 匹配結果（如果是現有公司） */
  matchResult?: CompanyMatchResult
  /** 可能的重複建議（如果是新公司） */
  possibleDuplicates?: PossibleDuplicate[]
  /** 新建立的公司（如果是新公司） */
  createdCompany?: Company
}

/**
 * 提取結果中的公司資訊
 */
export interface ExtractedCompanyInfo {
  /** 公司名稱（必須） */
  name: string
  /** 公司代碼（可選） */
  code?: string
  /** 聯繫郵箱（可選） */
  contactEmail?: string
  /** 其他元數據 */
  metadata?: Record<string, unknown>
}

/**
 * 自動建立配置
 */
export interface AutoCreateConfig {
  /** 建立者 ID（系統用戶） */
  createdById: string
  /** 首次出現的文件 ID */
  firstSeenDocumentId?: string
  /** 是否自動查找重複建議 */
  findDuplicateSuggestions?: boolean
  /** 預設公司類型 */
  defaultType?: CompanyType
}

// ============================================================
// Constants
// ============================================================

/**
 * 系統用戶 ID（用於自動建立）
 *
 * @description
 *   此 ID 用於 JIT（Just-in-Time）自動建立公司時的 createdById 欄位。
 *   必須對應到資料庫中已存在的用戶 ID，否則會觸發 FK 約束錯誤：
 *   `Foreign key constraint violated on the constraint: companies_created_by_id_fkey`
 *
 *   行為（FIX-054 後）：
 *   - 全新環境：預設 `'system-user-1'`（由 prisma/seed.ts 建立的系統用戶固定 ID）
 *   - 既有環境：可透過 `SYSTEM_USER_ID` env 覆蓋為現有 systemUser UUID，避免資料遷移
 *
 * @since FIX-002 - 修復公司自動建立 FK 約束問題
 * @lastModified FIX-054 - 改為可覆蓋常量，命名由 'dev-user-1' 改為 'system-user-1'
 */
export const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID ?? 'system-user-1'

// ============================================================
// Core Functions
// ============================================================

/**
 * 識別或建立公司
 *
 * @description
 *   Just-in-Time 公司識別邏輯：
 *   1. 嘗試匹配現有公司
 *   2. 如果匹配成功（>90%），返回現有公司
 *   3. 如果匹配失敗，自動建立新公司 Profile
 *
 * @param companyInfo - 提取的公司資訊
 * @param config - 建立配置
 * @returns 公司識別結果
 *
 * @example
 * ```typescript
 * const result = await identifyOrCreateCompany(
 *   { name: 'ABC Logistics Ltd.' },
 *   { createdById: 'system', firstSeenDocumentId: 'doc-123' }
 * )
 *
 * if (result.isNewCompany) {
 *   console.log('Created new company:', result.companyName)
 * } else {
 *   console.log('Matched existing company:', result.companyName)
 * }
 * ```
 */
export async function identifyOrCreateCompany(
  companyInfo: ExtractedCompanyInfo,
  config: AutoCreateConfig
): Promise<CompanyIdentificationResult> {
  const {
    createdById,
    firstSeenDocumentId,
    findDuplicateSuggestions = true,
    defaultType = CompanyType.UNKNOWN,
  } = config

  // 步驟 1：嘗試匹配現有公司
  const matchResult = await findMatchingCompany(companyInfo.name)

  // 步驟 2：如果匹配成功，返回現有公司
  if (matchResult.matched && matchResult.companyId) {
    return {
      isNewCompany: false,
      companyId: matchResult.companyId,
      companyName: matchResult.companyName!,
      matchResult,
    }
  }

  // 步驟 3：建立新公司 Profile
  const newCompany = await prisma.company.create({
    data: {
      name: companyInfo.name,
      code: companyInfo.code,
      displayName: companyInfo.name,
      type: defaultType,
      status: CompanyStatus.PENDING,
      source: CompanySource.AUTO_CREATED,
      nameVariants: [],
      firstSeenDocumentId: firstSeenDocumentId,
      contactEmail: companyInfo.contactEmail,
      createdById: createdById,
    },
  })

  // 清除快取以包含新公司
  clearMatcherCache()

  // 步驟 4：查找可能的重複建議
  let possibleDuplicates: PossibleDuplicate[] = []
  if (findDuplicateSuggestions) {
    possibleDuplicates = await findPossibleDuplicates(companyInfo.name)
  }

  return {
    isNewCompany: true,
    companyId: newCompany.id,
    companyName: newCompany.name,
    possibleDuplicates,
    createdCompany: newCompany,
  }
}

/**
 * 批量識別或建立公司
 *
 * @description
 *   批量處理多個公司名稱的識別和建立。
 *   優化數據庫操作，減少查詢次數。
 *
 * @param companies - 公司資訊列表
 * @param config - 建立配置
 * @returns 識別結果映射（公司名稱 → 結果）
 */
export async function batchIdentifyOrCreateCompanies(
  companies: ExtractedCompanyInfo[],
  config: AutoCreateConfig
): Promise<Map<string, CompanyIdentificationResult>> {
  const results = new Map<string, CompanyIdentificationResult>()

  for (const companyInfo of companies) {
    const result = await identifyOrCreateCompany(companyInfo, config)
    results.set(companyInfo.name, result)
  }

  return results
}

/**
 * 從發票提取結果中識別公司
 *
 * @description
 *   解析 AI 提取結果，識別其中的公司名稱，
 *   並執行 JIT 公司建立流程。
 *
 * @param extractionResult - AI 提取結果
 * @param config - 建立配置
 * @returns 識別到的公司列表
 *
 * @example
 * ```typescript
 * const extractionResult = {
 *   invoiceData: {
 *     vendor: 'ABC Logistics Ltd.',
 *     shipper: 'XYZ Trading Co.',
 *   }
 * }
 *
 * const companies = await identifyCompaniesFromExtraction(
 *   extractionResult,
 *   { createdById: 'system', firstSeenDocumentId: 'doc-123' }
 * )
 * ```
 */
export async function identifyCompaniesFromExtraction(
  extractionResult: Record<string, unknown>,
  config: AutoCreateConfig
): Promise<CompanyIdentificationResult[]> {
  const results: CompanyIdentificationResult[] = []

  // 從提取結果中識別公司名稱
  const companyNames = extractCompanyNamesFromResult(extractionResult)

  for (const name of companyNames) {
    if (name && name.trim()) {
      const result = await identifyOrCreateCompany(
        { name: name.trim() },
        config
      )
      results.push(result)
    }
  }

  return results
}

/**
 * 從提取結果中解析公司名稱
 *
 * @description
 *   檢查提取結果中常見的公司名稱欄位：
 *   - vendor / supplier / seller
 *   - shipper / consignor
 *   - consignee / receiver
 *   - forwarder / agent
 *   - carrier
 *
 * @param result - 提取結果對象
 * @returns 識別到的公司名稱列表
 */
function extractCompanyNamesFromResult(
  result: Record<string, unknown>
): string[] {
  const companyNames: string[] = []

  // 定義可能包含公司名稱的欄位
  const companyFields = [
    // 賣方/供應商
    'vendor',
    'vendor_name',
    'vendorName',
    'supplier',
    'supplier_name',
    'supplierName',
    'seller',
    'seller_name',
    'sellerName',
    // 發貨人
    'shipper',
    'shipper_name',
    'shipperName',
    'consignor',
    'consignor_name',
    'consignorName',
    // 收貨人
    'consignee',
    'consignee_name',
    'consigneeName',
    'receiver',
    'receiver_name',
    'receiverName',
    // 貨運代理
    'forwarder',
    'forwarder_name',
    'forwarderName',
    'agent',
    'agent_name',
    'agentName',
    'freight_forwarder',
    'freightForwarder',
    // 承運人
    'carrier',
    'carrier_name',
    'carrierName',
    // 通用
    'company',
    'company_name',
    'companyName',
  ]

  // 遞歸搜尋提取結果
  function searchObject(obj: Record<string, unknown>, prefix = ''): void {
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key
      const lowerKey = key.toLowerCase()

      // 檢查是否為公司名稱欄位
      if (companyFields.some((field) => lowerKey === field.toLowerCase())) {
        if (typeof value === 'string' && value.trim()) {
          companyNames.push(value.trim())
        }
      }

      // 遞歸搜尋嵌套對象
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        searchObject(value as Record<string, unknown>, fullKey)
      }

      // 搜尋數組中的對象
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object') {
            searchObject(item as Record<string, unknown>, fullKey)
          }
        }
      }
    }
  }

  searchObject(result)

  // 去重
  return [...new Set(companyNames)]
}

// ============================================================
// Company Management Functions
// ============================================================

/**
 * 更新公司類型
 *
 * @param companyId - 公司 ID
 * @param type - 新類型
 * @returns 更新後的公司
 */
export async function updateCompanyType(
  companyId: string,
  type: CompanyType
): Promise<Company> {
  const company = await prisma.company.update({
    where: { id: companyId },
    data: {
      type,
      status: CompanyStatus.ACTIVE, // 設定類型後自動啟用
    },
  })

  clearMatcherCache()
  return company
}

/**
 * 添加名稱變體
 *
 * @param companyId - 公司 ID
 * @param variant - 名稱變體
 * @returns 更新後的公司
 */
export async function addNameVariant(
  companyId: string,
  variant: string
): Promise<Company> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { nameVariants: true },
  })

  if (!company) {
    throw new Error(`Company not found: ${companyId}`)
  }

  // 避免重複添加
  if (company.nameVariants.includes(variant)) {
    return prisma.company.findUnique({
      where: { id: companyId },
    }) as Promise<Company>
  }

  const updated = await prisma.company.update({
    where: { id: companyId },
    data: {
      nameVariants: [...company.nameVariants, variant],
    },
  })

  clearMatcherCache()
  return updated
}

/**
 * 合併公司（JIT 自動建立專用）
 *
 * @description
 *   將副公司合併到主公司：
 *   1. 將副公司的名稱變體添加到主公司
 *   2. 將副公司的名稱作為變體添加到主公司
 *   3. 將副公司的文件、提取結果、映射規則轉移到主公司（FIX-112 補齊）
 *   4. 將副公司狀態設為 MERGED
 *   5. 記錄合併關係
 *
 *   NOTE: 此函數為 admin 合併 UI（POST /api/admin/companies/merge）的實際後端。
 *   FIX-112 前僅更新 nameVariants + MERGED，未轉移副公司關聯資料，導致合併後
 *   documents / extraction_results / mapping_rules 全部孤兒化（COMPANY 級 template
 *   映射因 companyId 不相等而失效）。現與 company.service.ts 的
 *   mergeCompanies / confirmCompanyMerge 行為一致。
 *
 * @param primaryId - 主公司 ID（保留）
 * @param secondaryIds - 副公司 ID 列表（將被合併）
 * @returns 合併後的主公司
 */
export async function autoMergeCompanies(
  primaryId: string,
  secondaryIds: string[]
): Promise<Company> {
  // 獲取主公司
  const primaryCompany = await prisma.company.findUnique({
    where: { id: primaryId },
    select: { nameVariants: true },
  })

  if (!primaryCompany) {
    throw new Error(`Primary company not found: ${primaryId}`)
  }

  // 獲取所有副公司
  const secondaryCompanies = await prisma.company.findMany({
    where: { id: { in: secondaryIds } },
    select: { id: true, name: true, nameVariants: true },
  })

  // 收集所有名稱變體
  const allVariants = new Set(primaryCompany.nameVariants)

  for (const secondary of secondaryCompanies) {
    // 添加副公司的主名稱作為變體
    allVariants.add(secondary.name)
    // 添加副公司的所有變體
    for (const variant of secondary.nameVariants) {
      allVariants.add(variant)
    }
  }

  // 使用事務執行合併
  const result = await prisma.$transaction(async (tx) => {
    // 更新主公司
    const updatedPrimary = await tx.company.update({
      where: { id: primaryId },
      data: {
        nameVariants: Array.from(allVariants),
      },
    })

    // FIX-112：轉移副公司的關聯資料到主公司（原本缺失，導致合併後孤兒化）。
    // 與 company.service.ts 的 confirmCompanyMerge 一致。
    await tx.document.updateMany({
      where: { companyId: { in: secondaryIds } },
      data: { companyId: primaryId },
    })
    await tx.extractionResult.updateMany({
      where: { companyId: { in: secondaryIds } },
      data: { companyId: primaryId },
    })
    await tx.mappingRule.updateMany({
      where: { companyId: { in: secondaryIds } },
      data: { companyId: primaryId },
    })

    // FIX-125：document_formats / field_definition_sets 等原本「刻意不轉」，理由是
    // 「副公司設 MERGED 後 inert」。該假設對 documents 成立，對公司處理知識不成立 ——
    // 存活公司仍會收到同樣版面的文件，辨識所需的定義留在原地等同遺失
    // （Azure DEV 實證：CEVA 8 個格式散落 8 間公司，FIX-115 因此完全無效）。
    const knowledgeTransfer = await transferCompanyKnowledge(tx, secondaryIds, primaryId)

    // 更新所有副公司
    await tx.company.updateMany({
      where: { id: { in: secondaryIds } },
      data: {
        status: CompanyStatus.MERGED,
        mergedIntoId: primaryId,
      },
    })

    logMergeTransferSkips(
      knowledgeTransfer,
      `autoMergeCompanies [${secondaryIds.join(', ')}] → ${primaryId}`
    )

    return updatedPrimary
  })

  clearMatcherCache()
  return result
}

/**
 * 獲取待審核的公司列表
 *
 * @param options - 查詢選項
 * @returns 待審核公司列表
 */
export async function getPendingCompanies(
  options: {
    page?: number
    limit?: number
    includeDocumentCount?: boolean
  } = {}
): Promise<{
  companies: (Company & { documentCount?: number; possibleDuplicates?: PossibleDuplicate[] })[]
  total: number
  page: number
  totalPages: number
}> {
  const { page = 1, limit = 20, includeDocumentCount = true } = options

  const [companies, total] = await Promise.all([
    prisma.company.findMany({
      where: { status: CompanyStatus.PENDING },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.company.count({
      where: { status: CompanyStatus.PENDING },
    }),
  ])

  // 擴展每個公司的資訊
  const enrichedCompanies = await Promise.all(
    companies.map(async (company) => {
      const result: Company & { documentCount?: number; possibleDuplicates?: PossibleDuplicate[] } = { ...company }

      // 獲取文件數量（待實現：需要 Document 與 Company 的關聯）
      if (includeDocumentCount) {
        // TODO: 實現文件計數
        result.documentCount = 0
      }

      // 獲取可能的重複建議
      result.possibleDuplicates = await findPossibleDuplicates(company.name)

      return result
    })
  )

  return {
    companies: enrichedCompanies,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  }
}
