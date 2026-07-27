/**
 * @fileoverview LLM Provider 模型管理頁面（Server Component）
 * @description
 *   某 provider 底下的模型管理頁：globalAdmin 可新增/編輯/停用/刪除模型。
 *   `isEnabled` 決定該模型是否出現在 model-settings 的環節指派下拉。
 *   透過伺服器端翻譯取得頁面標題，渲染客戶端 LlmProviderModelsClient 組件。
 *
 * @module src/app/[locale]/(dashboard)/admin/llm-providers/[id]/models/page
 * @since Epic 23 - Story 23.2
 * @lastModified 2026-07-10
 *
 * @related
 *   - ./client.tsx - 客戶端主組件
 *   - src/hooks/use-llm-models.ts - 模型 CRUD Hooks
 *   - src/app/api/v1/llm-providers/[id]/models/ - 模型子資源 API
 */

import { LlmProviderModelsClient } from './client'

interface PageParams {
  params: Promise<{ id: string }>
}

/**
 * @page LlmProviderModelsPage
 * @description LLM Provider 模型管理頁面（Server Component）
 */
export default async function LlmProviderModelsPage({ params }: PageParams) {
  const { id } = await params

  return (
    <div className="space-y-6">
      <LlmProviderModelsClient providerId={id} />
    </div>
  )
}
