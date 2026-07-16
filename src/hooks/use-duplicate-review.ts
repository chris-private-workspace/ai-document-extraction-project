/**
 * @fileoverview PENDING 疑似重複公司審核 Hook
 * @description
 *   CHANGE-103 Phase 2（組件 4）：封裝灰帶 PENDING 疑似重複公司審核佇列的
 *   查詢與審核動作（確認為新公司 / 併入疑似目標）。
 *   消費 `/api/companies/pending` 系列端點（RFC 7807 top-level 錯誤格式）。
 *
 * @module src/hooks/use-duplicate-review
 * @since CHANGE-103 Phase 2（組件 4）
 * @lastModified 2026-07-16
 *
 * @related
 *   - src/app/api/companies/pending/route.ts - 審核佇列
 *   - src/app/api/companies/pending/[id]/confirm-new/route.ts - 確認為新公司
 *   - src/app/api/companies/pending/[id]/confirm-merge/route.ts - 併入疑似目標
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

// ============================================================
// Types
// ============================================================

/** 疑似重複的目標公司（灰帶命中的既有公司） */
export interface SuspectedDuplicateTarget {
  id: string
  name: string
  displayName: string
  documentCount: number
}

/** PENDING 審核佇列項目 */
export interface DuplicateReviewCompany {
  id: string
  name: string
  displayName: string
  /** 首次出現時間（ISO 字串） */
  firstSeenAt: string
  documentCount: number
  suspectedDuplicateOf: SuspectedDuplicateTarget | null
}

interface DuplicateReviewResponse {
  success: boolean
  data: {
    companies: DuplicateReviewCompany[]
    total: number
  }
}

const QUERY_KEY = ['duplicate-review-companies'] as const

// ============================================================
// API Functions
// ============================================================

/**
 * 從 RFC 7807 錯誤回應解析 detail，找不到則用 fallback 訊息拋出。
 */
async function throwFromResponse(
  response: Response,
  fallback: string
): Promise<never> {
  let detail = fallback
  try {
    const body: unknown = await response.json()
    if (
      body &&
      typeof body === 'object' &&
      'detail' in body &&
      typeof (body as { detail: unknown }).detail === 'string'
    ) {
      detail = (body as { detail: string }).detail
    }
  } catch {
    // 回應無 JSON body：沿用 fallback
  }
  throw new Error(detail)
}

async function fetchDuplicateReviewQueue(): Promise<DuplicateReviewResponse> {
  const response = await fetch('/api/companies/pending')
  if (!response.ok) {
    return throwFromResponse(response, 'Failed to load review queue')
  }
  return response.json()
}

async function confirmCompanyAsNew(id: string): Promise<void> {
  const response = await fetch(`/api/companies/pending/${id}/confirm-new`, {
    method: 'POST',
  })
  if (!response.ok) {
    await throwFromResponse(response, 'Failed to confirm as new company')
  }
}

async function confirmCompanyMerge(id: string): Promise<void> {
  const response = await fetch(`/api/companies/pending/${id}/confirm-merge`, {
    method: 'POST',
  })
  if (!response.ok) {
    await throwFromResponse(response, 'Failed to merge company')
  }
}

// ============================================================
// Hooks
// ============================================================

/**
 * 待審核 PENDING 疑似重複公司佇列查詢 Hook。
 *
 * @returns 審核佇列查詢結果
 */
export function useDuplicateReviewQueue() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchDuplicateReviewQueue,
    staleTime: 30 * 1000,
  })
}

/**
 * 確認 PENDING 公司為「全新公司」Mutation Hook（PENDING → ACTIVE）。
 *
 * @returns 確認為新公司的 mutation
 */
export function useConfirmCompanyAsNew() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => confirmCompanyAsNew(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })
}

/**
 * 確認 PENDING 公司併入疑似目標 Mutation Hook（破壞性合併）。
 *
 * @returns 併入疑似目標的 mutation
 */
export function useConfirmCompanyMerge() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => confirmCompanyMerge(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })
}
