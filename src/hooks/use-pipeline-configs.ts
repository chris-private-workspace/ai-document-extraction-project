'use client'

/**
 * @fileoverview Pipeline Config 查詢與操作 Hooks
 * @description
 *   提供客戶端 Pipeline Config CRUD 操作功能。
 *   使用 React Query 進行資料緩存和狀態管理。
 *
 *   主要功能：
 *   - usePipelineConfigs: 列表查詢（支援分頁、篩選、排序）
 *   - usePipelineConfig: 單一記錄查詢
 *   - useCreatePipelineConfig: 建立新記錄
 *   - useUpdatePipelineConfig: 更新記錄
 *   - useDeletePipelineConfig: 刪除記錄
 *
 * @module src/hooks/use-pipeline-configs
 * @since CHANGE-032 - Pipeline Reference Number Matching & FX Conversion
 * @lastModified 2026-02-08
 *
 * @dependencies
 *   - @tanstack/react-query - 資料查詢和緩存
 *
 * @related
 *   - src/lib/validations/pipeline-config.schema.ts - 驗證 Schema
 *   - src/app/api/v1/pipeline-configs/ - API 端點
 *   - src/services/pipeline-config.service.ts - 服務層
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

// ============================================================
// 類型定義
// ============================================================

/**
 * Pipeline Config 列表項目
 */
export interface PipelineConfigItem {
  id: string
  scope: 'GLOBAL' | 'REGION' | 'COMPANY' | 'FORMAT'
  regionId: string | null
  companyId: string | null
  documentFormatId: string | null
  refMatchEnabled: boolean
  refMatchTypes: string[] | null
  refMatchMaxResults: number
  fxConversionEnabled: boolean
  fxTargetCurrency: string | null
  fxConvertLineItems: boolean
  fxConvertExtraCharges: boolean
  fxRoundingPrecision: number
  fxFallbackBehavior: string
  fxSourceCurrencies: string[] | null
  isActive: boolean
  description: string | null
  createdAt: string
  updatedAt: string
  region?: { id: string; name: string } | null
  company?: { id: string; name: string } | null
  documentFormat?: {
    id: string
    name: string | null
    company?: { id: string; name: string } | null
  } | null
}

/**
 * 分頁資訊
 */
interface PaginationInfo {
  page: number
  limit: number
  total: number
  totalPages: number
}

/**
 * Pipeline Config 列表 API 響應
 */
interface PipelineConfigListResponse {
  success: boolean
  data?: PipelineConfigItem[]
  meta?: {
    pagination: PaginationInfo
  }
  type?: string
  title?: string
  status?: number
  detail?: string
}

/**
 * Pipeline Config 單一 API 響應
 */
interface PipelineConfigResponse {
  success: boolean
  data?: PipelineConfigItem
  type?: string
  title?: string
  status?: number
  detail?: string
}

/**
 * Pipeline Config 查詢參數
 */
export interface PipelineConfigQueryParams {
  page?: number
  limit?: number
  scope?: 'GLOBAL' | 'REGION' | 'COMPANY' | 'FORMAT'
  isActive?: boolean
  sortBy?: 'createdAt' | 'updatedAt' | 'scope'
  sortOrder?: 'asc' | 'desc'
}

/**
 * 建立 Pipeline Config 輸入
 */
export interface CreatePipelineConfigInput {
  scope: 'GLOBAL' | 'REGION' | 'COMPANY' | 'FORMAT'
  regionId?: string | null
  companyId?: string | null
  documentFormatId?: string | null
  refMatchEnabled?: boolean
  refMatchTypes?: string[]
  refMatchMaxResults?: number
  fxConversionEnabled?: boolean
  fxTargetCurrency?: string | null
  fxConvertLineItems?: boolean
  fxConvertExtraCharges?: boolean
  fxRoundingPrecision?: number
  fxFallbackBehavior?: string
  fxSourceCurrencies?: string[] | null
  isActive?: boolean
  description?: string | null
}

/**
 * 更新 Pipeline Config 輸入
 */
export interface UpdatePipelineConfigInput {
  refMatchEnabled?: boolean
  refMatchTypes?: string[]
  refMatchMaxResults?: number
  fxConversionEnabled?: boolean
  fxTargetCurrency?: string | null
  fxConvertLineItems?: boolean
  fxConvertExtraCharges?: boolean
  fxRoundingPrecision?: number
  fxFallbackBehavior?: string
  fxSourceCurrencies?: string[] | null
  isActive?: boolean
  description?: string | null
}

// ============================================================
// Constants
// ============================================================

/** Query Key 前綴 */
const QUERY_KEY = 'pipeline-configs'

// ============================================================
// API 函數
// ============================================================

/**
 * 從 API 獲取 Pipeline Config 列表
 */
async function fetchPipelineConfigs(
  params: PipelineConfigQueryParams
): Promise<{ items: PipelineConfigItem[]; pagination: PaginationInfo }> {
  const url = new URL('/api/v1/pipeline-configs', window.location.origin)

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  })

  const response = await fetch(url.toString())
  const json: PipelineConfigListResponse = await response.json()

  if (!response.ok || !json.success) {
    throw new Error(json.detail || 'Failed to fetch pipeline configs')
  }

  return {
    items: json.data ?? [],
    pagination: json.meta?.pagination ?? {
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
    },
  }
}

/**
 * 從 API 獲取單一 Pipeline Config
 */
async function fetchPipelineConfig(id: string): Promise<PipelineConfigItem> {
  const response = await fetch(`/api/v1/pipeline-configs/${id}`)
  const json: PipelineConfigResponse = await response.json()

  if (!response.ok || !json.success || !json.data) {
    throw new Error(json.detail || 'Failed to fetch pipeline config')
  }

  return json.data
}

/**
 * 建立新 Pipeline Config
 */
async function createPipelineConfigApi(
  input: CreatePipelineConfigInput
): Promise<PipelineConfigItem> {
  const response = await fetch('/api/v1/pipeline-configs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })

  const json: PipelineConfigResponse = await response.json()

  if (!response.ok || !json.success || !json.data) {
    throw new Error(json.detail || 'Failed to create pipeline config')
  }

  return json.data
}

/**
 * 更新 Pipeline Config
 */
async function updatePipelineConfigApi(
  id: string,
  input: UpdatePipelineConfigInput
): Promise<PipelineConfigItem> {
  const response = await fetch(`/api/v1/pipeline-configs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })

  const json: PipelineConfigResponse = await response.json()

  if (!response.ok || !json.success || !json.data) {
    throw new Error(json.detail || 'Failed to update pipeline config')
  }

  return json.data
}

/**
 * 刪除 Pipeline Config
 */
async function deletePipelineConfigApi(id: string): Promise<void> {
  const response = await fetch(`/api/v1/pipeline-configs/${id}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    const json = await response.json().catch(() => ({}))
    throw new Error(
      (json as { detail?: string }).detail || 'Failed to delete pipeline config'
    )
  }
}

// ============================================================
// Hooks
// ============================================================

/**
 * Pipeline Config 列表查詢 Hook
 *
 * @param params - 查詢參數（分頁、篩選、排序）
 * @returns React Query 查詢結果
 */
export function usePipelineConfigs(params: PipelineConfigQueryParams = {}) {
  return useQuery({
    queryKey: [QUERY_KEY, params],
    queryFn: () => fetchPipelineConfigs(params),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })
}

/**
 * 單一 Pipeline Config 查詢 Hook
 *
 * @param id - Pipeline Config ID
 * @returns React Query 查詢結果
 */
export function usePipelineConfig(id: string) {
  return useQuery({
    queryKey: [QUERY_KEY, id],
    queryFn: () => fetchPipelineConfig(id),
    enabled: !!id,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })
}

/**
 * 建立 Pipeline Config Mutation Hook
 */
export function useCreatePipelineConfig() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: createPipelineConfigApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
    },
  })
}

/**
 * 更新 Pipeline Config Mutation Hook
 */
export function useUpdatePipelineConfig() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdatePipelineConfigInput }) =>
      updatePipelineConfigApi(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
    },
  })
}

/**
 * 刪除 Pipeline Config Mutation Hook
 */
export function useDeletePipelineConfig() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: deletePipelineConfigApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
    },
  })
}
