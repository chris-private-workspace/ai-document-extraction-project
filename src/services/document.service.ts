/**
 * @fileoverview Document 服務層
 * @description
 *   提供文件（Document）相關的業務邏輯：
 *   - 文件列表查詢（分頁、篩選、排序）
 *   - 單個文件查詢
 *   - 文件刪除（含 Azure Blob）
 *   - 文件狀態更新
 *
 * @module src/services/document.service
 * @author Development Team
 * @since Epic 2 - Story 2.1 (File Upload Interface & Validation)
 * @lastModified 2025-12-18
 *
 * @features
 *   - 分頁文件列表
 *   - 多條件篩選
 *   - 文件刪除（DB + Azure Blob）
 *   - 狀態管理
 *   - 處理重試（Story 2.7）
 *   - 處理統計（Story 2.7）
 *
 * @dependencies
 *   - @prisma/client - Prisma ORM
 *   - @/lib/azure/storage - Azure Blob Storage
 *
 * @related
 *   - src/app/api/documents - Document API 端點
 *   - src/lib/azure/storage.ts - Azure 存儲服務
 *   - prisma/schema.prisma - Document 模型
 */

import { prisma } from '@/lib/prisma'
import { deleteFile } from '@/lib/azure'
import { downloadBlob } from '@/lib/azure-blob'
import { Prisma } from '@prisma/client'
import type { DocumentStatus } from '@prisma/client'
import { getUnifiedDocumentProcessor } from '@/services/unified-processor'
import {
  persistProcessingResult,
  markDocumentProcessingFailed,
} from '@/services/processing-result-persistence.service'
import { autoTemplateMatchingService } from '@/services/auto-template-matching.service'
import type { ProcessFileInput } from '@/types/unified-processor'
import { intersectCityCodes, type SessionCityUser } from '@/lib/auth/city-scope'

// ===========================================
// Types
// ===========================================

/**
 * 獲取文件列表參數
 */
export interface GetDocumentsParams {
  /** 頁碼（從 1 開始）*/
  page: number
  /** 每頁數量 */
  pageSize: number
  /** 文件狀態篩選 */
  status?: DocumentStatus
  /** 搜尋關鍵字（文件名或 ID）*/
  search?: string
  /** 城市代碼篩選 */
  cityCode?: string
  /** 上傳者 ID 篩選 */
  uploadedBy?: string
  /** 排序欄位 */
  sortBy?: 'createdAt' | 'fileName' | 'status' | 'fileSize'
  /** 排序方向 */
  sortOrder?: 'asc' | 'desc'
  /** 授權城市範圍（非全域使用者限制可見城市，CHANGE-079）*/
  cityScope?: SessionCityUser
}

/**
 * 文件列表結果
 */
export interface DocumentListResult {
  /** 文件列表 */
  data: DocumentSummary[]
  /** 分頁資訊 */
  meta: {
    total: number
    page: number
    pageSize: number
    totalPages: number
  }
}

/**
 * 文件摘要（列表用）
 */
export interface DocumentSummary {
  id: string
  fileName: string
  fileType: string
  fileSize: number
  status: DocumentStatus
  processingPath: string | null
  // CHANGE-084: 處理時間（開始 / 結束 / 耗時毫秒）
  processingStartedAt: Date | null
  processingEndedAt: Date | null
  processingDuration: number | null
  cityCode: string | null
  createdAt: Date
  updatedAt: Date
  uploader: {
    id: string
    name: string | null
    email: string
  }
  // CHANGE-084: 信心度（來自 1:1 關聯 extraction_results，0–100；無提取結果時為 null）
  extractionResult: {
    averageConfidence: number
  } | null
}

/**
 * 文件詳情
 */
export interface DocumentDetail {
  id: string
  fileName: string
  fileType: string
  fileExtension: string
  fileSize: number
  filePath: string
  blobName: string
  status: DocumentStatus
  errorMessage: string | null
  processingPath: string | null
  routingDecision: Prisma.JsonValue | null
  cityCode: string | null
  createdAt: Date
  updatedAt: Date
  uploader: {
    id: string
    name: string | null
    email: string
  }
}

// ===========================================
// Functions
// ===========================================

/**
 * 獲取分頁文件列表
 *
 * @description 根據條件查詢文件列表，支援分頁、篩選、排序
 * @param params - 查詢參數
 * @returns 文件列表和分頁資訊
 *
 * @example
 * ```typescript
 * const result = await getDocuments({
 *   page: 1,
 *   pageSize: 20,
 *   status: 'UPLOADED',
 *   sortBy: 'createdAt',
 *   sortOrder: 'desc',
 * })
 * ```
 */
export async function getDocuments(
  params: GetDocumentsParams
): Promise<DocumentListResult> {
  const {
    page = 1,
    pageSize = 20,
    status,
    search,
    cityCode,
    uploadedBy,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    cityScope,
  } = params

  // CHANGE-079（城市 IDOR）：套用授權城市範圍（與客戶端 cityCode 篩選取交集）
  // - cityScope 提供時：非全域使用者限定授權城市；空交集回 __NONE__ 確保無結果
  // - 未提供 cityScope 時：維持原本的 cityCode 單值篩選（向後相容）
  let cityWhere: Prisma.DocumentWhereInput = {}
  if (cityScope) {
    const allowed = intersectCityCodes(
      cityCode ? [cityCode] : undefined,
      cityScope.cityCodes,
      cityScope.isGlobalAdmin
    )
    if (allowed.length > 0) {
      cityWhere = { cityCode: { in: allowed } }
    }
  } else if (cityCode) {
    cityWhere = { cityCode }
  }

  // 構建查詢條件
  const where: Prisma.DocumentWhereInput = {
    ...(status && { status }),
    ...cityWhere,
    ...(uploadedBy && { uploadedBy }),
    ...(search && {
      OR: [
        { fileName: { contains: search, mode: 'insensitive' } },
        { id: { contains: search } },
      ],
    }),
  }

  // 並行執行查詢和計數
  const [data, total] = await prisma.$transaction([
    prisma.document.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { [sortBy]: sortOrder },
      select: {
        id: true,
        fileName: true,
        fileType: true,
        fileSize: true,
        status: true,
        processingPath: true,
        // CHANGE-084: 列表顯示處理時間（開始 / 結束 / 耗時）
        processingStartedAt: true,
        processingEndedAt: true,
        processingDuration: true,
        cityCode: true,
        createdAt: true,
        updatedAt: true,
        uploader: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        // CHANGE-084: 列表顯示信心度（權威來源為 1:1 關聯 extraction_results.average_confidence，0–100）
        extractionResult: {
          select: {
            averageConfidence: true,
          },
        },
      },
    }),
    prisma.document.count({ where }),
  ])

  return {
    data: data as DocumentSummary[],
    meta: {
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    },
  }
}

/**
 * 根據 ID 獲取文件詳情
 *
 * @description 獲取單個文件的完整資訊
 * @param id - 文件 ID
 * @returns 文件詳情或 null
 *
 * @example
 * ```typescript
 * const document = await getDocumentById('xxx-xxx-xxx')
 * if (!document) {
 *   throw new Error('Document not found')
 * }
 * ```
 */
export async function getDocumentById(
  id: string
): Promise<DocumentDetail | null> {
  const document = await prisma.document.findUnique({
    where: { id },
    select: {
      id: true,
      fileName: true,
      fileType: true,
      fileExtension: true,
      fileSize: true,
      filePath: true,
      blobName: true,
      status: true,
      errorMessage: true,
      processingPath: true,
      routingDecision: true,
      cityCode: true,
      createdAt: true,
      updatedAt: true,
      uploader: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  })

  return document as DocumentDetail | null
}

/**
 * 刪除文件
 *
 * @description 刪除文件記錄和對應的 Azure Blob
 * @param id - 文件 ID
 * @throws {Error} 如果文件不存在或刪除失敗
 *
 * @example
 * ```typescript
 * await deleteDocument('xxx-xxx-xxx')
 * ```
 */
export async function deleteDocument(id: string): Promise<void> {
  // 獲取 blob 名稱
  const document = await prisma.document.findUnique({
    where: { id },
    select: { blobName: true },
  })

  if (!document) {
    throw new Error(`Document with ID ${id} not found`)
  }

  // 刪除 Azure Blob
  if (document.blobName) {
    try {
      await deleteFile(document.blobName)
    } catch (error) {
      console.error(`Failed to delete blob ${document.blobName}:`, error)
      // 繼續刪除資料庫記錄
    }
  }

  // 刪除資料庫記錄
  await prisma.document.delete({
    where: { id },
  })
}

/**
 * 更新文件狀態
 *
 * @description 更新文件的處理狀態，可選設置錯誤訊息
 * @param id - 文件 ID
 * @param status - 新狀態
 * @param errorMessage - 錯誤訊息（可選）
 *
 * @example
 * ```typescript
 * // 標記為 OCR 處理中
 * await updateDocumentStatus('xxx', 'OCR_PROCESSING')
 *
 * // 標記為失敗
 * await updateDocumentStatus('xxx', 'FAILED', 'OCR extraction failed')
 * ```
 */
export async function updateDocumentStatus(
  id: string,
  status: DocumentStatus,
  errorMessage?: string
): Promise<void> {
  await prisma.document.update({
    where: { id },
    data: {
      status,
      errorMessage: errorMessage ?? null,
      updatedAt: new Date(),
    },
  })
}

/**
 * 批量更新文件狀態
 *
 * @description 批量更新多個文件的狀態
 * @param ids - 文件 ID 列表
 * @param status - 新狀態
 *
 * @example
 * ```typescript
 * await batchUpdateDocumentStatus(['id1', 'id2'], 'OCR_PROCESSING')
 * ```
 */
export async function batchUpdateDocumentStatus(
  ids: string[],
  status: DocumentStatus
): Promise<void> {
  await prisma.document.updateMany({
    where: { id: { in: ids } },
    data: {
      status,
      updatedAt: new Date(),
    },
  })
}

/**
 * 獲取文件統計資訊
 *
 * @description 獲取各狀態的文件數量統計
 * @param cityCode - 城市代碼篩選（可選）
 * @returns 各狀態的文件數量
 *
 * @example
 * ```typescript
 * const stats = await getDocumentStats('TPE')
 * console.log(stats.UPLOADED) // 已上傳數量
 * ```
 */
export async function getDocumentStats(
  cityCode?: string
): Promise<Record<DocumentStatus, number>> {
  const where: Prisma.DocumentWhereInput = cityCode ? { cityCode } : {}

  const stats = await prisma.document.groupBy({
    by: ['status'],
    where,
    _count: { status: true },
  })

  // 初始化所有狀態為 0
  const result: Record<string, number> = {
    UPLOADING: 0,
    UPLOADED: 0,
    OCR_PROCESSING: 0,
    OCR_COMPLETED: 0,
    OCR_FAILED: 0,
    MAPPING_PROCESSING: 0,
    MAPPING_COMPLETED: 0,
    PENDING_REVIEW: 0,
    IN_REVIEW: 0,
    COMPLETED: 0,
    FAILED: 0,
  }

  // 填入實際數量
  stats.forEach((stat) => {
    result[stat.status] = stat._count.status
  })

  return result as Record<DocumentStatus, number>
}

// ===========================================
// Story 2.7 - Processing Status Tracking
// ===========================================

/**
 * 處理統計結果（增強版）
 */
export interface ProcessingStatsResult {
  /** 按狀態分組的數量 */
  byStatus: Record<string, number>
  /** 處理中數量 */
  processing: number
  /** 已完成數量 */
  completed: number
  /** 失敗數量 */
  failed: number
  /** 總數 */
  total: number
}

/**
 * 獲取處理統計資訊（增強版）
 *
 * @description 獲取詳細的處理統計，包括按狀態分組和彙總數據
 * @param cityCode - 城市代碼篩選（可選）
 * @returns 處理統計結果
 *
 * @example
 * ```typescript
 * const stats = await getProcessingStatsEnhanced()
 * console.log(stats.processing) // 處理中數量
 * console.log(stats.byStatus.OCR_PROCESSING) // OCR 處理中數量
 * ```
 */
export async function getProcessingStatsEnhanced(
  cityCode?: string
): Promise<ProcessingStatsResult> {
  const where: Prisma.DocumentWhereInput = cityCode ? { cityCode } : {}

  const statuses = await prisma.document.groupBy({
    by: ['status'],
    where,
    _count: true,
  })

  const byStatus: Record<string, number> = {}
  let processing = 0
  let completed = 0
  let failed = 0
  let total = 0

  const processingStatuses = [
    'UPLOADING',
    'OCR_PROCESSING',
    'MAPPING_PROCESSING',
    'IN_REVIEW',
  ]
  const completedStatuses = [
    'OCR_COMPLETED',
    'MAPPING_COMPLETED',
    'PENDING_REVIEW',
    'COMPLETED',
    'APPROVED',
  ]
  const failedStatuses = ['OCR_FAILED', 'REF_MATCH_FAILED', 'FAILED']

  for (const item of statuses) {
    byStatus[item.status] = item._count
    total += item._count

    if (processingStatuses.includes(item.status)) {
      processing += item._count
    } else if (completedStatuses.includes(item.status)) {
      completed += item._count
    } else if (failedStatuses.includes(item.status)) {
      failed += item._count
    }
  }

  return { byStatus, processing, completed, failed, total }
}

/**
 * 重試文件處理（統一管線）
 *
 * @description
 *   重置文件狀態並觸發統一 11 步處理管線（Epic 15）。
 *   取代舊版 extractDocument() OCR-only 流程。
 *   處理以非阻塞方式執行，API 立即回應。
 *
 * @param documentId - 文件 ID
 * @throws {Error} 文件不存在或狀態不可重試
 *
 * @since CHANGE-017 - Retry 整合統一處理管線
 *
 * @example
 * ```typescript
 * await retryProcessing('xxx-xxx-xxx')
 * ```
 */
export async function retryProcessing(documentId: string): Promise<void> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
  })

  if (!document) {
    throw new Error('Document not found')
  }

  /** 允許重試的 Document 狀態（對齊 /process 端點 + FAILED） */
  const retryableStatuses: DocumentStatus[] = [
    'OCR_FAILED',
    'REF_MATCH_FAILED',
    'FAILED',
    'UPLOADED',
    'OCR_COMPLETED',
    'MAPPING_COMPLETED',
  ]

  if (!retryableStatuses.includes(document.status)) {
    throw new Error(`Cannot retry document with status: ${document.status}`)
  }

  // 1. 重置文件狀態（清除舊數據）
  await prisma.$transaction([
    prisma.document.update({
      where: { id: documentId },
      data: {
        status: 'OCR_PROCESSING',
        processingPath: null,
        routingDecision: Prisma.JsonNull,
        errorMessage: null,
        processingStartedAt: new Date(),
      },
    }),
    prisma.processingQueue.deleteMany({
      where: { documentId },
    }),
    prisma.extractionResult.deleteMany({
      where: { documentId },
    }),
  ])

  // 2. 非阻塞觸發統一處理管線
  ;(async () => {
    try {
      // 2a. 下載文件
      const fileBuffer = await downloadBlob(document.blobName)

      // 2b. 建構輸入
      const input: ProcessFileInput = {
        fileId: document.id,
        fileName: document.fileName,
        fileBuffer,
        mimeType: document.fileType,
        userId: document.uploadedBy ?? 'system',
      }

      // 2c. 執行統一處理
      const processor = getUnifiedDocumentProcessor()
      const result = await processor.processFile(input)

      // 2d. 持久化結果
      await persistProcessingResult({
        documentId: document.id,
        result,
        userId: document.uploadedBy ?? 'system',
      })

      // 2e. 觸發自動模版匹配（Fire-and-Forget）
      if (result.success && result.companyId) {
        autoTemplateMatchingService.autoMatch(document.id).catch((err) => {
          console.error(`[Retry] Auto-match error for ${document.id}:`, err)
        })
      }

      console.log(`[Retry] Processing completed for ${document.id}`)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      console.error(`[Retry] Processing failed for ${document.id}:`, msg)
      await markDocumentProcessingFailed(documentId, msg).catch(() => {})
    }
  })()
}

/**
 * 獲取文件詳情（含關聯資料）
 *
 * @description 獲取文件完整詳情，包括上傳者、Forwarder、OCR 結果等
 * @param id - 文件 ID
 * @returns 文件詳情或 null
 */
export async function getDocumentWithRelations(id: string) {
  return prisma.document.findUnique({
    where: { id },
    // REFACTOR-001: forwarder → company
    include: {
      uploader: {
        select: { id: true, name: true, email: true },
      },
      company: {
        select: { id: true, name: true, code: true },
      },
      ocrResult: true,
      processingQueue: true,
    },
  })
}
