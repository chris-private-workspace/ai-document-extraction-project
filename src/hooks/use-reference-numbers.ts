'use client'

/**
 * @fileoverview Reference Number 查詢與操作 Hooks
 * @description
 *   提供客戶端 Reference Number CRUD 操作功能。
 *   使用 React Query 進行資料緩存和狀態管理。
 *
 *   主要功能：
 *   - useReferenceNumbers: 列表查詢（支援分頁、篩選、排序）
 *   - useReferenceNumber: 單一記錄查詢
 *   - useCreateReferenceNumber: 建立新記錄
 *   - useUpdateReferenceNumber: 更新記錄
 *   - useDeleteReferenceNumber: 刪除記錄（軟刪除）
 *   - useImportReferenceNumbers: 批次導入
 *   - useExportReferenceNumbers: 批次導出
 *   - useValidateReferenceNumbers: 批次驗證
 *
 * @module src/hooks/use-reference-numbers
 * @since Epic 20 - Story 20.3
 * @lastModified 2026-02-05 (Story 20.4: Import/Export/Validate hooks)
 *
 * @dependencies
 *   - @tanstack/react-query - 資料查詢和緩存
 *
 * @related
 *   - src/lib/validations/reference-number.schema.ts - 驗證 Schema
 *   - src/app/api/v1/reference-numbers/ - API 端點
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

// ============================================================
// 類型定義
// ============================================================

/**
 * Reference Number 列表項目
 */
export interface ReferenceNumber {
  id: string
  code: string
  number: string
  type: string
  status: string
  documentSubType: string | null
  year: number
  regionId: string
  regionCode: string
  regionName: string
  description: string | null
  validFrom: string | null
  validUntil: string | null
  matchCount: number
  lastMatchedAt: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/**
 * Reference Number 詳情（含 createdById）
 */
export interface ReferenceNumberDetail extends ReferenceNumber {
  createdById: string
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
 * Reference Number 列表 API 響應
 */
interface ReferenceNumberListResponse {
  success: boolean
  data?: ReferenceNumber[]
  meta?: {
    pagination: PaginationInfo
  }
  type?: string
  title?: string
  status?: number
  detail?: string
}

/**
 * Reference Number 單一 API 響應
 */
interface ReferenceNumberResponse {
  success: boolean
  data?: ReferenceNumberDetail
  type?: string
  title?: string
  status?: number
  detail?: string
}

/**
 * 刪除/操作 API 響應
 */
interface OperationResponse {
  success: boolean
  type?: string
  title?: string
  status?: number
  detail?: string
}

/**
 * Reference Number 查詢參數
 */
export interface ReferenceNumberQueryParams {
  page?: number
  limit?: number
  year?: number
  regionId?: string
  type?: string
  status?: string
  documentSubType?: string
  isActive?: boolean
  search?: string
  sortBy?: 'number' | 'year' | 'createdAt' | 'updatedAt' | 'matchCount'
  sortOrder?: 'asc' | 'desc'
}

/**
 * 建立 Reference Number 輸入
 */
export interface CreateReferenceNumberInput {
  code?: string
  number: string
  type: string
  year: number
  regionId: string
  documentSubType?: string | null
  description?: string | null
  validFrom?: string | null
  validUntil?: string | null
}

/**
 * 更新 Reference Number 輸入
 */
export interface UpdateReferenceNumberInput {
  number?: string
  type?: string
  status?: string
  documentSubType?: string | null
  year?: number
  regionId?: string
  description?: string | null
  validFrom?: string | null
  validUntil?: string | null
  isActive?: boolean
}

// ============================================================
// Constants
// ============================================================

/** Query Key 前綴 */
const QUERY_KEY = 'reference-numbers'

// ============================================================
// API 函數
// ============================================================

/**
 * 從 API 獲取 Reference Number 列表
 */
async function fetchReferenceNumbers(
  params: ReferenceNumberQueryParams
): Promise<{ items: ReferenceNumber[]; pagination: PaginationInfo }> {
  const url = new URL('/api/v1/reference-numbers', window.location.origin)

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  })

  const response = await fetch(url.toString())
  const json: ReferenceNumberListResponse = await response.json()

  if (!response.ok || !json.success) {
    throw new Error(json.detail || 'Failed to fetch reference numbers')
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
 * 從 API 獲取單一 Reference Number
 */
async function fetchReferenceNumber(id: string): Promise<ReferenceNumberDetail> {
  const response = await fetch(`/api/v1/reference-numbers/${id}`)
  const json: ReferenceNumberResponse = await response.json()

  if (!response.ok || !json.success || !json.data) {
    throw new Error(json.detail || 'Failed to fetch reference number')
  }

  return json.data
}

/**
 * 建立新 Reference Number
 */
async function createReferenceNumber(
  input: CreateReferenceNumberInput
): Promise<ReferenceNumberDetail> {
  const response = await fetch('/api/v1/reference-numbers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })

  const json: ReferenceNumberResponse = await response.json()

  if (!response.ok || !json.success || !json.data) {
    throw new Error(json.detail || 'Failed to create reference number')
  }

  return json.data
}

/**
 * 更新 Reference Number
 */
async function updateReferenceNumber(
  id: string,
  input: UpdateReferenceNumberInput
): Promise<ReferenceNumberDetail> {
  const response = await fetch(`/api/v1/reference-numbers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })

  const json: ReferenceNumberResponse = await response.json()

  if (!response.ok || !json.success || !json.data) {
    throw new Error(json.detail || 'Failed to update reference number')
  }

  return json.data
}

/**
 * 刪除 Reference Number（軟刪除）
 */
async function deleteReferenceNumberApi(id: string): Promise<void> {
  const response = await fetch(`/api/v1/reference-numbers/${id}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    const json: OperationResponse = await response.json()
    throw new Error(json.detail || 'Failed to delete reference number')
  }
}

// ============================================================
// Hooks
// ============================================================

/**
 * Reference Number 列表查詢 Hook
 *
 * @param params - 查詢參數
 * @returns React Query 查詢結果
 *
 * @example
 *   const { data, isLoading } = useReferenceNumbers({ year: 2026 })
 *   const items = data?.items ?? []
 *   const pagination = data?.pagination
 */
export function useReferenceNumbers(params: ReferenceNumberQueryParams = {}) {
  return useQuery({
    queryKey: [QUERY_KEY, params],
    queryFn: () => fetchReferenceNumbers(params),
    staleTime: 5 * 60 * 1000, // 5 分鐘
    gcTime: 30 * 60 * 1000, // 30 分鐘
  })
}

/**
 * 單一 Reference Number 查詢 Hook
 *
 * @param id - Reference Number ID
 * @returns React Query 查詢結果
 *
 * @example
 *   const { data: item, isLoading } = useReferenceNumber('xxx-id')
 */
export function useReferenceNumber(id: string) {
  return useQuery({
    queryKey: [QUERY_KEY, id],
    queryFn: () => fetchReferenceNumber(id),
    enabled: !!id,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })
}

/**
 * 建立 Reference Number Mutation Hook
 *
 * @returns React Query mutation 結果
 *
 * @example
 *   const { mutate: create, isPending } = useCreateReferenceNumber()
 *   create({ number: 'SH-001', type: 'SHIPMENT', year: 2026, regionId: 'xxx' })
 */
export function useCreateReferenceNumber() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: createReferenceNumber,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
    },
  })
}

/**
 * 更新 Reference Number Mutation Hook
 *
 * @returns React Query mutation 結果
 *
 * @example
 *   const { mutate: update, isPending } = useUpdateReferenceNumber()
 *   update({ id: 'xxx', input: { number: 'SH-002' } })
 */
export function useUpdateReferenceNumber() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateReferenceNumberInput }) =>
      updateReferenceNumber(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
    },
  })
}

/**
 * 刪除 Reference Number Mutation Hook
 *
 * @returns React Query mutation 結果
 *
 * @example
 *   const { mutate: remove, isPending } = useDeleteReferenceNumber()
 *   remove('xxx-id')
 */
export function useDeleteReferenceNumber() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: deleteReferenceNumberApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
    },
  })
}

// ============================================================
// Import/Export/Validate 類型定義 (Story 20.4)
// ============================================================

/**
 * 導入結果
 */
export interface ImportReferenceNumbersResult {
  imported: number
  updated: number
  skipped: number
  errors: Array<{ index: number; error: string }>
  /** SI-4：跳過/失敗的原因明細（相容擴充，後端可能未回傳） */
  skippedDetails?: Array<{ index: number; reason: string; message: string }>
}

/**
 * 導入 API 響應
 */
interface ImportReferenceNumbersResponse {
  success: boolean
  data?: ImportReferenceNumbersResult
  type?: string
  title?: string
  status?: number
  detail?: string
}

/**
 * 導出項目
 */
export interface ExportReferenceNumberItem {
  code: string
  number: string
  type: string
  status: string
  documentSubType: string | null
  year: number
  regionCode: string
  description: string | null
  validFrom: string | null
  validUntil: string | null
  matchCount: number
  isActive: boolean
}

/**
 * 導出結果
 */
export interface ExportReferenceNumbersResult {
  exportVersion: string
  exportedAt: string
  totalCount: number
  items: ExportReferenceNumberItem[]
}

/**
 * 導出 API 響應
 */
interface ExportReferenceNumbersResponse {
  success: boolean
  data?: ExportReferenceNumbersResult
  type?: string
  title?: string
  status?: number
  detail?: string
}

/**
 * 驗證匹配項目
 */
export interface ValidateReferenceNumberMatch {
  id: string
  number: string
  type: string
  year: number
  regionCode: string
  status: string
}

/**
 * 驗證結果
 */
export interface ValidateReferenceNumbersResult {
  results: Array<{
    value: string
    found: boolean
    matches: ValidateReferenceNumberMatch[]
  }>
  summary: {
    total: number
    found: number
    notFound: number
  }
}

/**
 * 驗證 API 響應
 */
interface ValidateReferenceNumbersResponse {
  success: boolean
  data?: ValidateReferenceNumbersResult
  type?: string
  title?: string
  status?: number
  detail?: string
}

/**
 * 導入輸入參數
 */
export interface ImportReferenceNumbersInput {
  exportVersion?: string
  items: Array<{
    code?: string
    number: string
    type: string
    year: number
    regionCode: string
    documentSubType?: string
    description?: string
    validFrom?: string
    validUntil?: string
    isActive?: boolean
  }>
  options?: {
    overwriteExisting?: boolean
    skipInvalid?: boolean
  }
}

/**
 * 導出查詢參數
 */
export interface ExportReferenceNumbersParams {
  year?: number
  regionId?: string
  type?: string
  status?: string
  documentSubType?: string
  isActive?: boolean
}

/**
 * 驗證輸入參數
 */
export interface ValidateReferenceNumbersInput {
  numbers: Array<{
    value: string
    type?: string
  }>
  options?: {
    year?: number
    regionId?: string
  }
}

// ============================================================
// Import/Export/Validate API 函數 (Story 20.4)
// ============================================================

/**
 * 批次導入 Reference Numbers
 */
async function importReferenceNumbersApi(
  input: ImportReferenceNumbersInput
): Promise<ImportReferenceNumbersResult> {
  const response = await fetch('/api/v1/reference-numbers/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })

  const json: ImportReferenceNumbersResponse = await response.json()

  if (!response.ok || !json.success || !json.data) {
    throw new Error(json.detail || 'Failed to import reference numbers')
  }

  return json.data
}

/**
 * 批次導出 Reference Numbers
 */
async function exportReferenceNumbersApi(
  params: ExportReferenceNumbersParams = {}
): Promise<ExportReferenceNumbersResult> {
  const url = new URL('/api/v1/reference-numbers/export', window.location.origin)

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value))
    }
  })

  const response = await fetch(url.toString())
  const json: ExportReferenceNumbersResponse = await response.json()

  if (!response.ok || !json.success || !json.data) {
    throw new Error(json.detail || 'Failed to export reference numbers')
  }

  return json.data
}

/**
 * 批次驗證 Reference Numbers
 */
async function validateReferenceNumbersApi(
  input: ValidateReferenceNumbersInput
): Promise<ValidateReferenceNumbersResult> {
  const response = await fetch('/api/v1/reference-numbers/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })

  const json: ValidateReferenceNumbersResponse = await response.json()

  if (!response.ok || !json.success || !json.data) {
    throw new Error(json.detail || 'Failed to validate reference numbers')
  }

  return json.data
}

// ============================================================
// Import/Export/Validate Hooks (Story 20.4)
// ============================================================

/**
 * 批次導入 Reference Numbers Mutation Hook
 *
 * @returns React Query mutation 結果
 *
 * @example
 *   const { mutate: importRefNums, isPending } = useImportReferenceNumbers()
 *   importRefNums({ items: [...], options: { overwriteExisting: true } })
 */
export function useImportReferenceNumbers() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: importReferenceNumbersApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
    },
  })
}

/**
 * 批次導出 Reference Numbers Mutation Hook
 *
 * @returns React Query mutation 結果
 *
 * @example
 *   const { mutate: exportRefNums, isPending } = useExportReferenceNumbers()
 *   exportRefNums({ year: 2026 })
 */
export function useExportReferenceNumbers() {
  return useMutation({
    mutationFn: exportReferenceNumbersApi,
  })
}

/**
 * 批次驗證 Reference Numbers Mutation Hook
 *
 * @returns React Query mutation 結果
 *
 * @example
 *   const { mutate: validate, isPending } = useValidateReferenceNumbers()
 *   validate({ numbers: [{ value: 'SH-001' }] })
 */
export function useValidateReferenceNumbers() {
  return useMutation({
    mutationFn: validateReferenceNumbersApi,
  })
}
