'use client'

/**
 * @fileoverview LLM 模型管理 Hooks（Epic 23 - Story 23.2）
 * @description
 *   某 provider 底下模型（`LlmModel`）的客戶端 React Query CRUD hooks，
 *   消費 `/api/v1/llm-providers/:id/models` 與 `/:modelId` 子資源。
 *
 *   主要功能：
 *   - useProviderModels: 列出某 provider 的模型（登入即可）
 *   - useCreateLlmModel / useUpdateLlmModel / useDeleteLlmModel: CRUD（限 globalAdmin）
 *
 *   模型無憑證，回傳直接帶完整欄位（capability / pricing / isEnabled）。
 *   `isEnabled` 決定該模型是否出現在 model-settings 的指派下拉。
 *
 * @module src/hooks/use-llm-models
 * @since Epic 23 - Story 23.2
 * @lastModified 2026-07-10
 *
 * @dependencies
 *   - @tanstack/react-query - 資料查詢和緩存
 *
 * @related
 *   - src/services/llm-provider.service.ts - 服務層（listModels/createModel/updateModel/deleteModel）
 *   - src/hooks/use-llm-providers.ts - Provider CRUD hooks（同域）
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

// ============================================================
// Types
// ============================================================

/** 模型能力（對齊 llm-provider.schema.ts `modelCapabilitySchema`；catchall 保留 seed 額外欄位） */
export interface ModelCapability {
  maxTokens: number
  supportsTemperature: boolean
  temperature?: number
  defaultImageDetail?: 'auto' | 'low' | 'high'
  supportsJsonSchema: boolean
  supportsVision: boolean
  [key: string]: unknown
}

/** 模型計價（跨 provider；皆可選） */
export interface ModelPricing {
  inputPer1k?: number
  outputPer1k?: number
  currency?: string
}

/** 模型對外形狀（無憑證） */
export interface LlmModelPublic {
  id: string
  providerId: string
  modelKey: string
  label: string
  capability: ModelCapability
  pricing: ModelPricing | null
  isEnabled: boolean
  createdAt: string
  updatedAt: string
}

/** 建立模型輸入 */
export interface CreateLlmModelInput {
  modelKey: string
  label: string
  capability: ModelCapability
  pricing?: ModelPricing
  isEnabled?: boolean
}

/** 更新模型輸入（皆可選；capability 整欄替換、pricing 傳 null 清空） */
export interface UpdateLlmModelInput {
  modelKey?: string
  label?: string
  capability?: ModelCapability
  pricing?: ModelPricing | null
  isEnabled?: boolean
}

// ============================================================
// Constants
// ============================================================

/** Query Key 前綴 */
const QUERY_KEY = 'llm-provider-models'

// ============================================================
// API 函數
// ============================================================

/** 從 RFC 7807 回應擷取 detail 訊息 */
async function extractErrorDetail(response: Response, fallback: string): Promise<string> {
  const json = (await response.json().catch(() => null)) as { detail?: string } | null
  return json?.detail || fallback
}

async function fetchProviderModels(providerId: string): Promise<LlmModelPublic[]> {
  const response = await fetch(`/api/v1/llm-providers/${providerId}/models`)
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, 'Failed to fetch models'))
  }
  const json = await response.json()
  return json.data
}

async function createModelApi(
  providerId: string,
  input: CreateLlmModelInput,
): Promise<LlmModelPublic> {
  const response = await fetch(`/api/v1/llm-providers/${providerId}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, 'Failed to create model'))
  }
  const json = await response.json()
  return json.data
}

async function updateModelApi(
  providerId: string,
  modelId: string,
  input: UpdateLlmModelInput,
): Promise<LlmModelPublic> {
  const response = await fetch(
    `/api/v1/llm-providers/${providerId}/models/${modelId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  )
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, 'Failed to update model'))
  }
  const json = await response.json()
  return json.data
}

async function deleteModelApi(providerId: string, modelId: string): Promise<void> {
  const response = await fetch(
    `/api/v1/llm-providers/${providerId}/models/${modelId}`,
    { method: 'DELETE' },
  )
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, 'Failed to delete model'))
  }
}

// ============================================================
// Query Hooks
// ============================================================

/**
 * 某 provider 的模型列表查詢 Hook（登入即可）
 *
 * @param providerId - Provider ID（falsy 時停用查詢）
 */
export function useProviderModels(providerId: string | null) {
  return useQuery({
    queryKey: [QUERY_KEY, providerId],
    queryFn: () => fetchProviderModels(providerId as string),
    enabled: !!providerId,
    staleTime: 30 * 1000,
  })
}

// ============================================================
// Mutation Hooks
// ============================================================

/** 建立模型 Mutation Hook（限 globalAdmin） */
export function useCreateLlmModel(providerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateLlmModelInput) => createModelApi(providerId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY, providerId] })
    },
  })
}

/** 更新模型 Mutation Hook（限 globalAdmin） */
export function useUpdateLlmModel(providerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ modelId, input }: { modelId: string; input: UpdateLlmModelInput }) =>
      updateModelApi(providerId, modelId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY, providerId] })
    },
  })
}

/** 刪除模型 Mutation Hook（限 globalAdmin） */
export function useDeleteLlmModel(providerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (modelId: string) => deleteModelApi(providerId, modelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY, providerId] })
    },
  })
}
