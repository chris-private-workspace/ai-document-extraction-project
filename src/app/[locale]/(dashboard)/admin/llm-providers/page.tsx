/**
 * @fileoverview LLM Provider 管理頁面（Server Component）
 * @description
 *   後台多 LLM provider 管理頁：globalAdmin 可新增/編輯/刪除 provider（含加密憑證）並測試連線。
 *   透過伺服器端翻譯取得頁面標題，渲染客戶端 LlmProvidersClient 組件。
 *
 * @module src/app/[locale]/(dashboard)/admin/llm-providers/page
 * @since Epic 23 - Story 23.2
 * @lastModified 2026-07-10
 *
 * @related
 *   - src/app/[locale]/(dashboard)/admin/llm-providers/client.tsx - 客戶端主組件
 *   - src/hooks/use-llm-providers.ts - Provider CRUD Hooks
 *   - src/app/api/v1/llm-providers/ - Provider 管理 API
 */

import { getTranslations } from 'next-intl/server'
import { LlmProvidersClient } from './client'

/**
 * @page LlmProvidersPage
 * @description LLM Provider 管理頁面（Server Component）
 */
export default async function LlmProvidersPage() {
  const t = await getTranslations('llmProviders')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t('pageTitle')}</h1>
        <p className="text-muted-foreground">{t('pageDescription')}</p>
      </div>
      <LlmProvidersClient />
    </div>
  )
}
