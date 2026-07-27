'use client'

/**
 * @fileoverview 公司合併「未轉移設定」明細警示組件
 * @description
 *   FIX-129：公司合併時，處理知識類關聯（格式 / 欄位定義集 / 模板映射等）若與
 *   目標公司撞唯一鍵會被跳過（FIX-125 的守門設計）。本組件將合併回應中的
 *   skipped 明細顯示給使用者 —— 哪一類、哪一筆、為何跳過 —— 讓「需人工處理」
 *   不再只存在於伺服器 log。
 *
 * @module src/components/features/companies/MergeSkippedReportAlert
 * @since FIX-129
 * @lastModified 2026-07-22
 *
 * @related
 *   - src/services/company-merge-transfer.service.ts - skipped 報告來源
 *   - src/components/features/companies/CompanyMergeDialog.tsx - 合併對話框內顯示
 *   - src/app/[locale]/(dashboard)/admin/companies/duplicate-review/ - 審核頁顯示
 */

import { useTranslations } from 'next-intl'
import { AlertTriangle } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import type { MergeTransferSkip } from '@/services/company-merge-transfer.service'

// ============================================================
// Types
// ============================================================

interface MergeSkippedReportAlertProps {
  /** 合併回應中的 skipped 明細（空陣列時不渲染） */
  skipped: MergeTransferSkip[]
}

// ============================================================
// Component
// ============================================================

/**
 * @component MergeSkippedReportAlert
 * @description 琥珀色警示：列出合併時因唯一鍵衝突而未轉移的設定明細
 */
export function MergeSkippedReportAlert({
  skipped,
}: MergeSkippedReportAlertProps) {
  const t = useTranslations('companies')

  if (skipped.length === 0) return null

  const relationLabel = (relation: string): string => {
    const key = `merge.skipped.relations.${relation}`
    return t.has(key) ? t(key) : relation
  }

  return (
    <Alert className="border-amber-500/50 text-amber-900 dark:text-amber-200 [&>svg]:text-amber-600">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>
        {t('merge.skipped.title', { count: skipped.length })}
      </AlertTitle>
      <AlertDescription>
        <p className="mb-2">{t('merge.skipped.description')}</p>
        <ul className="list-inside list-disc space-y-1 text-sm">
          {skipped.map((skip) => (
            <li key={`${skip.relation}-${skip.recordId}`}>
              <span className="font-medium">
                {relationLabel(skip.relation)}
              </span>
              {'「'}
              {skip.label}
              {'」'}
              <span className="text-muted-foreground"> — {skip.reason}</span>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}
