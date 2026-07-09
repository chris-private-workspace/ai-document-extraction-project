'use client'

/**
 * @fileoverview LLM 模型選擇配置 Hooks
 * @description
 *   提供客戶端 LLM 模型選擇管理功能，使用 React Query 進行資料緩存和狀態管理。
 *
 *   主要功能：
 *   - useModelConfigs: 讀取可選模型白名單 + 目前 Stage 1-3 模型選擇
 *   - useUpdateModelConfigs: 更新 Stage 1-3 模型選擇（限 globalAdmin）
 *
 *   對應後端 API：
 *   - GET  /api/v1/model-configs
 *   - PUT  /api/v1/model-configs
 *
 * @module src/hooks/use-model-configs
 * @since CHANGE-099 - LLM 模型選擇管理
 * @lastModified 2026-07-09
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
  defaultImageDetail: 'auto' | 'low' | 'high'
  supportsJsonSchema: boolean
}

/** 可選模型（白名單項目） */
export interface LlmModel {
  key: string
  label: string
  capability: LlmModelCapability
}

/** Stage 1-3 的模型選擇（各為 models[].key） */
export interface StageModelSelection {
  stage1: string
  stage2: string
  stage3: string
}

/** GET /api/v1/model-configs 回傳的 data 內容 */
export interface ModelConfigsData {
  models: LlmModel[]
  selection: StageModelSelection
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
 *   讀取可選模型白名單與目前各 Stage 的模型選擇。
 *
 * @returns React Query 查詢結果（data: { models, selection }）
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
 * 更新 LLM 模型選擇 Mutation Hook
 *
 * @description
 *   更新 Stage 1-3 的模型選擇（限 globalAdmin）。
 *   成功後自動刷新模型配置查詢。
 *
 * @returns React Query Mutation 結果
 */
export function useUpdateModelConfigs() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (
      input: StageModelSelection
    ): Promise<StageModelSelection> => {
      const res = await fetch('/api/v1/model-configs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })

      if (!res.ok) {
        const errorJson = await res.json().catch(() => null)
        throw new Error(errorJson?.detail || 'Failed to update model configs')
      }

      const json = await res.json()
      return json.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: modelConfigsQueryKeys.all })
    },
  })
}
