'use client'

/**
 * @fileoverview Document List React Query Hook
 * @description
 *   提供文件列表的 React Query 封裝：
 *   - 自動分頁查詢
 *   - 動態輪詢（處理中 5s，閒置 30s）
 *   - 重試功能
 *   - 樂觀更新
 *
 * @module src/hooks/use-documents
 * @author Development Team
 * @since Epic 2 - Story 2.7 (Processing Status Tracking & Display)
 * @lastModified 2025-12-18
 *
 * @features
 *   - 動態 refetch interval
 *   - 整合重試 mutation
 *   - 類型安全的 API 響應
 *
 * @dependencies
 *   - @tanstack/react-query - React Query
 *   - @/lib/document-status - 狀態配置
 *
 * @related
 *   - src/app/api/documents/route.ts - Documents API
 *   - src/app/[locale]/(dashboard)/documents/page.tsx - 文件列表頁面
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { hasProcessingDocuments } from '@/lib/document-status'
import type { DocumentStatus } from '@prisma/client'

// ============================================================
// Types
// ============================================================

/**
 * useDocuments 查詢參數
 */
export interface UseDocumentsParams {
  /** 頁碼 */
  page?: number
  /** 每頁數量 */
  pageSize?: number
  /** 狀態篩選 */
  status?: string
  /** 搜尋關鍵字 */
  search?: string
}

/**
 * 文件列表項目
 */
export interface DocumentListItem {
  id: string
  fileName: string
  fileType: string
  fileSize: number
  status: DocumentStatus
  processingPath: string | null
  // CHANGE-084: 處理時間（JSON 序列化後日期為 ISO 字串；耗時為毫秒）
  processingStartedAt: string | null
  processingEndedAt: string | null
  processingDuration: number | null
  cityCode: string | null
  createdAt: string
  updatedAt: string
  uploader: {
    id: string
    name: string | null
    email: string
  }
  // CHANGE-092: 識別出的公司（Stage 1 公司識別結果；未識別時為 null）
  company: {
    id: string
    name: string
  } | null
  // CHANGE-084: 信心度（來自 1:1 關聯 extraction_results，0–100；無提取結果時為 null）
  extractionResult: {
    averageConfidence: number
  } | null
}

/**
 * 文件列表響應
 */
export interface DocumentsResponse {
  success: boolean
  data: DocumentListItem[]
  meta: {
    total: number
    page: number
    pageSize: number
    totalPages: number
  }
  stats: {
    byStatus: Record<string, number>
    processing: number
    completed: number
    failed: number
    total: number
  }
}

// ============================================================
// Query Keys
// ============================================================

export const documentsQueryKeys = {
  all: ['documents'] as const,
  list: (params: UseDocumentsParams) => ['documents', 'list', params] as const,
  detail: (id: string) => ['documents', 'detail', id] as const,
}

// ============================================================
// Hook
// ============================================================

/**
 * 文件列表 React Query Hook
 *
 * @description
 *   提供文件列表查詢功能，包含：
 *   - 自動輪詢（處理中時 5s，否則 30s）
 *   - 重試 mutation
 *   - 錯誤處理
 *
 * @param params - 查詢參數
 * @returns Query 結果和重試功能
 *
 * @example
 * ```tsx
 * const { data, isLoading, retry, isRetrying } = useDocuments({
 *   page: 1,
 *   pageSize: 20,
 *   status: 'PENDING_REVIEW',
 * })
 * ```
 */
export function useDocuments(params: UseDocumentsParams = {}) {
  const queryClient = useQueryClient()

  // 文件列表查詢
  const query = useQuery<DocumentsResponse>({
    queryKey: documentsQueryKeys.list(params),
    queryFn: async () => {
      const searchParams = new URLSearchParams()

      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== '') {
          searchParams.set(key, String(value))
        }
      })

      const response = await fetch(`/api/documents?${searchParams}`)

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to fetch documents')
      }

      return response.json()
    },
    // 動態 refetch interval
    refetchInterval: (query) => {
      const data = query.state.data
      if (!data?.data) return 30000 // 30s default

      const statuses = data.data.map((doc) => doc.status)
      return hasProcessingDocuments(statuses) ? 5000 : 30000
    },
    staleTime: 2000,
  })

  // 重試 mutation
  const retryMutation = useMutation({
    mutationFn: async (documentId: string) => {
      const response = await fetch(`/api/documents/${documentId}/retry`, {
        method: 'POST',
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Retry failed')
      }

      return response.json()
    },
    onSuccess: () => {
      // 重新獲取列表
      queryClient.invalidateQueries({
        queryKey: documentsQueryKeys.all,
      })
    },
  })

  return {
    ...query,
    retry: retryMutation.mutate,
    retryAsync: retryMutation.mutateAsync,
    isRetrying: retryMutation.isPending,
    retryError: retryMutation.error,
  }
}
