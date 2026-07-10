'use client'

/**
 * @fileoverview LLM Provider 管理 Hooks（Epic 23 - Story 23.2）
 * @description
 *   後台多 LLM provider CRUD 的客戶端 React Query hooks，消費 `/api/v1/llm-providers`。
 *
 *   主要功能：
 *   - useLlmProviders: 列表查詢（憑證遮罩，list 不含末 4 碼預覽）
 *   - useLlmProvider: 單一查詢（含 apiKeyPreview 末 4 碼）
 *   - useCreateLlmProvider / useUpdateLlmProvider / useDeleteLlmProvider: CRUD（限 globalAdmin）
 *   - useTestLlmProviderConnection: 連線測試（限 globalAdmin）
 *
 *   ⚠️ 憑證安全：回傳形狀**永不**含明文/密文，僅 `hasApiKey` + 末 4 碼 `apiKeyPreview`。
 *
 * @module src/hooks/use-llm-providers
 * @since Epic 23 - Story 23.2
 * @lastModified 2026-07-10
 *
 * @dependencies
 *   - @tanstack/react-query - 資料查詢和緩存
 *
 * @related
 *   - src/services/llm-provider.service.ts - 服務層（加密/遮罩/審計）
 *   - src/app/api/v1/llm-providers/ - API 端點
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

// ============================================================
// Types
// ============================================================

/** LLM Provider 類型（對齊 Prisma enum `LlmProviderType`；本地定義避免客戶端引入 Prisma Client） */
export const LLM_PROVIDER_TYPES = [
  'AZURE_OPENAI',
  'OPENAI',
  'ANTHROPIC',
  'GOOGLE_GEMINI',
  'XAI_GROK',
  'OPENAI_COMPATIBLE',
] as const

export type LlmProviderType = (typeof LLM_PROVIDER_TYPES)[number]

/** 遮罩後的 provider（對外回傳唯一形狀；永不含明文/密文） */
export interface LlmProviderMasked {
  id: string
  name: string
  providerType: LlmProviderType
  baseUrl: string | null
  apiVersion: string | null
  isEnabled: boolean
  isDefault: boolean
  allowSensitiveData: boolean
  keyVersion: number
  extraConfig: unknown
  /** 是否已設定 API key（不洩漏內容） */
  hasApiKey: boolean
  /** 末 4 碼預覽（`••••1234`）；僅單筆查詢提供，list 為 null */
  apiKeyPreview: string | null
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

/** 建立 provider 輸入（apiKey 明文；服務層加密後落庫） */
export interface CreateLlmProviderInput {
  name: string
  providerType: LlmProviderType
  baseUrl?: string
  apiVersion?: string
  apiKey?: string
  isEnabled?: boolean
  isDefault?: boolean
  allowSensitiveData?: boolean
  extraConfig?: Record<string, unknown>
}

/** 更新 provider 輸入（皆可選；apiKey 省略則保留既有憑證） */
export interface UpdateLlmProviderInput {
  name?: string
  providerType?: LlmProviderType
  baseUrl?: string | null
  apiVersion?: string | null
  apiKey?: string
  isEnabled?: boolean
  isDefault?: boolean
  allowSensitiveData?: boolean
  extraConfig?: Record<string, unknown> | null
}

/** 連線測試結果 */
export interface TestConnectionResult {
  success: boolean
  supported: boolean
  message: string
  statusCode?: number
}

// ============================================================
// Constants
// ============================================================

/** Query Key 前綴 */
const QUERY_KEY = 'llm-providers'

// ============================================================
// API 函數
// ============================================================

/** 從 RFC 7807 回應擷取 detail 訊息 */
async function extractErrorDetail(response: Response, fallback: string): Promise<string> {
  const json = (await response.json().catch(() => null)) as { detail?: string } | null
  return json?.detail || fallback
}

async function fetchLlmProviders(): Promise<LlmProviderMasked[]> {
  const response = await fetch('/api/v1/llm-providers')
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, 'Failed to fetch providers'))
  }
  const json = await response.json()
  return json.data
}

async function fetchLlmProvider(id: string): Promise<LlmProviderMasked> {
  const response = await fetch(`/api/v1/llm-providers/${id}`)
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, 'Failed to fetch provider'))
  }
  const json = await response.json()
  return json.data
}

async function createLlmProviderApi(
  input: CreateLlmProviderInput
): Promise<LlmProviderMasked> {
  const response = await fetch('/api/v1/llm-providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, 'Failed to create provider'))
  }
  const json = await response.json()
  return json.data
}

async function updateLlmProviderApi(
  id: string,
  input: UpdateLlmProviderInput
): Promise<LlmProviderMasked> {
  const response = await fetch(`/api/v1/llm-providers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, 'Failed to update provider'))
  }
  const json = await response.json()
  return json.data
}

async function deleteLlmProviderApi(id: string): Promise<void> {
  const response = await fetch(`/api/v1/llm-providers/${id}`, { method: 'DELETE' })
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, 'Failed to delete provider'))
  }
}

async function testLlmProviderConnectionApi(id: string): Promise<TestConnectionResult> {
  const response = await fetch(`/api/v1/llm-providers/${id}/test`, { method: 'POST' })
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, 'Failed to test connection'))
  }
  const json = await response.json()
  return json.data
}

// ============================================================
// Query Hooks
// ============================================================

/**
 * LLM Provider 列表查詢 Hook（遮罩；登入即可）
 */
export function useLlmProviders() {
  return useQuery({
    queryKey: [QUERY_KEY],
    queryFn: fetchLlmProviders,
    staleTime: 30 * 1000,
  })
}

/**
 * 單一 LLM Provider 查詢 Hook（含末 4 碼預覽；供編輯預填）
 *
 * @param id - Provider ID（falsy 時停用查詢）
 */
export function useLlmProvider(id: string | null) {
  return useQuery({
    queryKey: [QUERY_KEY, id],
    queryFn: () => fetchLlmProvider(id as string),
    enabled: !!id,
    staleTime: 30 * 1000,
  })
}

// ============================================================
// Mutation Hooks
// ============================================================

/** 建立 LLM Provider Mutation Hook（限 globalAdmin） */
export function useCreateLlmProvider() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createLlmProviderApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
    },
  })
}

/** 更新 LLM Provider Mutation Hook（限 globalAdmin） */
export function useUpdateLlmProvider() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateLlmProviderInput }) =>
      updateLlmProviderApi(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
    },
  })
}

/** 刪除 LLM Provider Mutation Hook（限 globalAdmin） */
export function useDeleteLlmProvider() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: deleteLlmProviderApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
    },
  })
}

/** 連線測試 Mutation Hook（限 globalAdmin；不改資料，僅回傳測試結果） */
export function useTestLlmProviderConnection() {
  return useMutation({
    mutationFn: testLlmProviderConnectionApi,
  })
}
