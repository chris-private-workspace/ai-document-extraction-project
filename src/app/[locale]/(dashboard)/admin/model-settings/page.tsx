/**
 * @fileoverview LLM 模型設定頁面 (Server Component)
 * @description
 *   LLM 模型選擇後台管理頁：讓 globalAdmin 為文件處理 Stage 1-3 各選一個 LLM 模型。
 *   透過伺服器端翻譯取得頁面標題，並渲染客戶端 ModelSettingsClient 組件。
 *
 * @module src/app/[locale]/(dashboard)/admin/model-settings/page
 * @since CHANGE-099 - LLM 模型選擇管理
 * @lastModified 2026-07-09
 *
 * @related
 *   - src/app/[locale]/(dashboard)/admin/model-settings/client.tsx - 客戶端主組件
 *   - src/hooks/use-model-configs.ts - 模型配置查詢/更新 Hooks
 *   - src/app/api/v1/model-configs/route.ts - 模型配置 API
 */

import { getTranslations } from 'next-intl/server'
import { ModelSettingsClient } from './client'

// ============================================================
// Page Component
// ============================================================

/**
 * @page ModelSettingsPage
 * @description LLM 模型設定頁面（Server Component）
 */
export default async function ModelSettingsPage() {
  const t = await getTranslations('systemSettings')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          {t('modelSettings.pageTitle')}
        </h1>
        <p className="text-muted-foreground">
          {t('modelSettings.pageDescription')}
        </p>
      </div>
      <ModelSettingsClient />
    </div>
  )
}
