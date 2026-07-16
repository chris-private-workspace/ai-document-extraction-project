'use client'

/**
 * @fileoverview 疑似重複公司審核 — 單列組件
 * @description
 *   CHANGE-103 Phase 2（組件 4）：佇列表格的單一 PENDING 公司列，顯示公司資訊、
 *   疑似重複目標與審核動作按鈕。由 duplicate-review-content.tsx 使用。
 *
 * @module src/app/(dashboard)/admin/companies/duplicate-review/duplicate-review-row
 * @since CHANGE-103 Phase 2（組件 4）
 * @lastModified 2026-07-16
 */

import { useTranslations } from 'next-intl'
import { ArrowRight, CheckCircle, GitMerge } from 'lucide-react'
import type { DuplicateReviewCompany } from '@/hooks/use-duplicate-review'
import type { Locale } from '@/i18n/config'
import { formatDateTime } from '@/lib/i18n-date'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { TableCell, TableRow } from '@/components/ui/table'

// ============================================================
// Types
// ============================================================

interface DuplicateReviewRowProps {
  company: DuplicateReviewCompany
  canManage: boolean
  locale: Locale
  disabled: boolean
  onConfirmNew: (id: string) => void
  onRequestMerge: (company: DuplicateReviewCompany) => void
}

// ============================================================
// Component
// ============================================================

/**
 * @component DuplicateReviewRow
 * @description 疑似重複審核佇列的單列
 */
export function DuplicateReviewRow({
  company,
  canManage,
  locale,
  disabled,
  onConfirmNew,
  onRequestMerge,
}: DuplicateReviewRowProps) {
  const t = useTranslations('companies')
  const target = company.suspectedDuplicateOf

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{company.name}</div>
        {company.displayName !== company.name && (
          <div className="text-xs text-muted-foreground">
            {t('duplicateReview.table.displayName', {
              name: company.displayName,
            })}
          </div>
        )}
        <div className="text-xs text-muted-foreground">
          {t('duplicateReview.table.firstSeen', {
            date: formatDateTime(new Date(company.firstSeenAt), locale),
          })}
        </div>
      </TableCell>
      <TableCell>
        <Badge variant="secondary">
          {t('duplicateReview.table.documentsUnit', {
            count: company.documentCount,
          })}
        </Badge>
      </TableCell>
      <TableCell>
        {target ? (
          <div className="flex items-center gap-2">
            <ArrowRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <div>
              <div className="font-medium">{target.name}</div>
              <div className="text-xs text-muted-foreground">
                {t('duplicateReview.table.documentsUnit', {
                  count: target.documentCount,
                })}
              </div>
            </div>
          </div>
        ) : (
          <span className="text-muted-foreground text-sm">
            {t('duplicateReview.table.noTarget')}
          </span>
        )}
      </TableCell>
      {canManage && (
        <TableCell>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => onConfirmNew(company.id)}
            >
              <CheckCircle className="mr-2 h-4 w-4" />
              {t('duplicateReview.actions.confirmNew')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled || !target}
              onClick={() => onRequestMerge(company)}
            >
              <GitMerge className="mr-2 h-4 w-4" />
              {t('duplicateReview.actions.confirmMerge')}
            </Button>
          </div>
        </TableCell>
      )}
    </TableRow>
  )
}
