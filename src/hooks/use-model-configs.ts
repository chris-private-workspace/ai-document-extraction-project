'use client'

/**
 * @fileoverview LLM 模型指派 Hooks
 * @description
 *   提供客戶端 LLM 模型指派管理功能，使用 React Query 進行資料緩存和狀態管理。
 *
 *   主要功能：
 *   - useModelConfigs: 讀取可選模型 + 各處理環節目前的模型指派
 *   - useUpdateModelConfigs: 更新環節模型指派（限 globalAdmin，支援部分更新）
 *
 *   Story 23.4 起指派範圍由 extraction Stage 1-3 擴大到全部 9 個 LLM 呼叫環節；
 *   環節目錄見 `@/lib/constants/llm-stages`。
 *
 *   對應後端 API：
 *   - GET  /api/v1/model-configs
 *   - PUT  /api/v1/model-configs
 *
 * @module src/hooks/use-model-configs
 * @since CHANGE-099 - LLM 模型選擇管理
 * @lastModified 2026-07-27
 *
 * @dependencies
 *   - @tanstack/react-query - 資料查詢和緩存
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

// ============================================================
// Types
// ============================================================

/** 模型能力描述（對應後端 capability 欄位） */
export interface LlmModelCapability {
  maxTokens: number
  supportsTemperature: boolean
  temperature?: number
  defaultImageDetail?: 'auto' | 'low' | 'high'
  supportsJsonSchema: boolean
  supportsVision?: boolean
}

/**
 * 可選模型（Epic 23 step 3b：來自已啟用 provider 的已啟用模型）。
 * `id` = `LlmModel.id`（選擇值）；`providerType` 供核心環節非 Azure 警示判斷。
 */
export interface LlmModel {
  id: string
  modelKey: string
  label: string
  capability: LlmModelCapability
  providerId: string
  providerName: string
  providerType: string
}

/**
 * 各處理環節的模型指派（Story 23.4）：`stageKey` → `models[].id`。
 * 環節目錄（顯示順序 / i18n key / 是否核心提取）見 `@/lib/constants/llm-stages`。
 */
export type StageAssignments = Record<string, string>

/** GET /api/v1/model-configs 回傳的 data 內容 */
export interface ModelConfigsData {
  models: LlmModel[]
  assignments: StageAssignments
  /**
   * gateway 主開關（`FEATURE_LLM_GATEWAY_ENABLED`）目前是否開啟。
   * 關閉時 `requiresGateway` 的環節指派**不會生效**，UI 需顯示提示。
   */
  gatewayEnabled: boolean
}

// ============================================================
// Query Keys
// ============================================================

/** LLM 模型配置查詢鍵 */
export const modelConfigsQueryKeys = {
  all: ['model-configs'] as const,
}

// ============================================================
// Query Hooks
// ============================================================

/**
 * LLM 模型配置查詢 Hook
 *
 * @description
 *   讀取可選模型與各處理環節目前的模型指派。
 *
 * @returns React Query 查詢結果（data: { models, assignments }）
 */
export function useModelConfigs() {
  return useQuery({
    queryKey: modelConfigsQueryKeys.all,
    queryFn: async (): Promise<ModelConfigsData> => {
      const res = await fetch('/api/v1/model-configs')
      if (!res.ok) {
        const errorJson = await res.json().catch(() => null)
        throw new Error(errorJson?.detail || 'Failed to fetch model configs')
      }
      const json = await res.json()
      return json.data
    },
    staleTime: 30 * 1000, // 30 秒
  })
}

// ============================================================
// Mutation Hooks
// ============================================================

/**
 * 更新 LLM 模型指派 Mutation Hook
 *
 * @description
 *   更新各處理環節的模型指派（限 globalAdmin），只需帶有異動的環節。
 *   成功後自動刷新模型配置查詢。
 *
 * @returns React Query Mutation 結果
 */
export function useUpdateModelConfigs() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: StageAssignments): Promise<StageAssignments> => {
      const res = await fetch('/api/v1/model-configs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments: input }),
      })

      if (!res.ok) {
        const errorJson = await res.json().catch(() => null)
        throw new Error(errorJson?.detail || 'Failed to update model configs')
      }

      const json = await res.json()
      return json.data.assignments
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: modelConfigsQueryKeys.all })
    },
  })
}
