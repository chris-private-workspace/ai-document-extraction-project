/**
 * @fileoverview next-intl Server-side 請求配置
 * @description
 *   配置 next-intl 的 Server-side 翻譯載入邏輯。
 *   支援多個命名空間的翻譯檔案合併載入。
 *
 * @module src/i18n/request
 * @author Development Team
 * @since Epic 17 - Story 17.1 (i18n Infrastructure Setup)
 * @lastModified 2026-01-17
 *
 * @features
 *   - 動態載入語言翻譯檔案
 *   - 支援多命名空間載入
 *   - 無效語言自動 fallback 到預設語言
 *   - 錯誤處理和訊息回退
 *
 * @dependencies
 *   - next-intl/server - Server-side i18n 工具
 *
 * @related
 *   - src/i18n/config.ts - 語言配置常數
 *   - messages/ - 翻譯檔案目錄
 */

import { getRequestConfig } from 'next-intl/server'
import { defaultLocale, isValidLocale } from './config'

/**
 * 定義所有命名空間
 * 這些命名空間對應 messages/{locale}/ 目錄下的 JSON 檔案
 */
const namespaces = [
  'common',
  'navigation',
  'dialogs',
  'auth',
  'validation',
  'errors',
  'dashboard',
  'global',
  'escalation',
  'review',
  'documents',
  'rules',
  'companies',
  'reports',
  'admin',
  'historicalData',
  'termAnalysis',
  'documentPreview',
  'fieldMappingConfig',
  'promptConfig',
  'dataTemplates',
  'formats',
  'templateFieldMapping',
  'templateInstance',
  'templateMatchingTest',
  'standardFields',
  'referenceNumber',
  'confidence',
  'exchangeRate',
  'region',
  'pipelineConfig',
  'fieldDefinitionSet',
  'profile',
  'systemSettings',
] as const

export type Namespace = (typeof namespaces)[number]

export default getRequestConfig(async ({ requestLocale }) => {
  // 從請求中取得 locale
  let locale = await requestLocale

  // 驗證 locale 是否有效，無效則使用預設語言
  if (!locale || !isValidLocale(locale)) {
    locale = defaultLocale
  }

  // 載入所有命名空間的翻譯檔案
  const messagesPromises = namespaces.map(async (ns) => {
    try {
      const mod = await import(`../../messages/${locale}/${ns}.json`)
      return { [ns]: mod.default }
    } catch {
      // 如果找不到檔案，嘗試從預設語言載入
      try {
        const fallbackModule = await import(
          `../../messages/${defaultLocale}/${ns}.json`
        )
        return { [ns]: fallbackModule.default }
      } catch {
        // 如果預設語言也找不到，返回空物件
        console.warn(
          `[i18n] Missing translation file for namespace: ${ns} (locale: ${locale})`
        )
        return { [ns]: {} }
      }
    }
  })

  const messagesArray = await Promise.all(messagesPromises)
  const messages = messagesArray.reduce(
    (acc, curr) => ({ ...acc, ...curr }),
    {}
  )

  return {
    locale,
    messages,
    // 時區設定
    timeZone: 'Asia/Taipei',
    // 錯誤處理
    onError: (error) => {
      console.error('[i18n] Translation error:', error)
    },
    getMessageFallback: ({ namespace, key }) => {
      return `[Missing: ${namespace}.${key}]`
    },
  }
})
