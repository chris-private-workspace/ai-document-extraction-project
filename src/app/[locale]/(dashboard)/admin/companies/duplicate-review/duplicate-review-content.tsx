'use client'

/**
 * @fileoverview 疑似重複公司審核內容組件
 * @description
 *   CHANGE-103 Phase 2（組件 4）客戶端組件，提供疑似重複公司的人工審核互動：
 *   - 佇列表格（PENDING 公司 + 疑似重複目標 + 文件數）
 *   - 確認為新公司（PENDING → ACTIVE）
 *   - 併入疑似目標（破壞性合併，需二次確認）
 *
 * @module src/app/(dashboard)/admin/companies/duplicate-review/duplicate-review-content
 * @since CHANGE-103 Phase 2（組件 4）
 * @lastModified 2026-07-16
 *
 * @dependencies
 *   - @/hooks/use-duplicate-review - 資料獲取與審核動作
 */

import * as React from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { toast } from 'sonner'
import {
  Building2,
  AlertTriangle,
  CheckCircle,
  RefreshCw,
  Loader2,
} from 'lucide-react'
import {
  useDuplicateReviewQueue,
  useConfirmCompanyAsNew,
  useConfirmCompanyMerge,
  type DuplicateReviewCompany,
} from '@/hooks/use-duplicate-review'
import type { Locale } from '@/i18n/config'
import { DuplicateReviewRow } from './duplicate-review-row'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

// ============================================================
// Types
// ============================================================

interface DuplicateReviewContentProps {
  canManage: boolean
}

// ============================================================
// Component
// ============================================================

export function DuplicateReviewContent({
  canManage,
}: DuplicateReviewContentProps) {
  const t = useTranslations('companies')
  const locale = useLocale() as Locale

  // --- State ---
  const [mergeCandidate, setMergeCandidate] =
    React.useState<DuplicateReviewCompany | null>(null)

  // --- Hooks ---
  const { data, isLoading, isFetching, error, refetch } =
    useDuplicateReviewQueue()
  const confirmNew = useConfirmCompanyAsNew()
  const confirmMerge = useConfirmCompanyMerge()

  const companies = React.useMemo(
    () => data?.data?.companies ?? [],
    [data?.data?.companies]
  )
  const isMutating = confirmNew.isPending || confirmMerge.isPending

  // --- Handlers ---
  const handleConfirmNew = React.useCallback(
    async (id: string) => {
      try {
        await confirmNew.mutateAsync(id)
        toast.success(t('duplicateReview.toast.confirmNewSuccess'))
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : t('duplicateReview.toast.confirmNewError')
        )
      }
    },
    [confirmNew, t]
  )

  const handleConfirmMerge = React.useCallback(async () => {
    if (!mergeCandidate) return
    try {
      await confirmMerge.mutateAsync(mergeCandidate.id)
      toast.success(t('duplicateReview.toast.confirmMergeSuccess'))
      setMergeCandidate(null)
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t('duplicateReview.toast.confirmMergeError')
      )
    }
  }, [mergeCandidate, confirmMerge, t])

  // --- Error State ---
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          {t('duplicateReview.loadError', { error: error.message })}
        </AlertDescription>
      </Alert>
    )
  }

  const colSpan = canManage ? 4 : 3

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Building2 className="h-6 w-6" />
            {t('duplicateReview.title')}
          </h1>
          <p className="text-muted-foreground">
            {t('duplicateReview.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {!isLoading && (
            <Badge variant="secondary">
              {t('duplicateReview.pendingCount', { count: companies.length })}
            </Badge>
          )}
          <Button
            variant="outline"
            size="icon"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label={t('duplicateReview.refresh')}
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {t('duplicateReview.table.columns.pendingCompany')}
              </TableHead>
              <TableHead>
                {t('duplicateReview.table.columns.documentCount')}
              </TableHead>
              <TableHead>
                {t('duplicateReview.table.columns.suspectedDuplicate')}
              </TableHead>
              {canManage && (
                <TableHead className="text-right">
                  {t('duplicateReview.table.columns.actions')}
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                  <span className="ml-2 text-muted-foreground">
                    {t('duplicateReview.loading')}
                  </span>
                </TableCell>
              </TableRow>
            ) : companies.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-center py-10">
                  <CheckCircle className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                  <p className="font-medium">{t('duplicateReview.empty.title')}</p>
                  <p className="text-sm text-muted-foreground">
                    {t('duplicateReview.empty.description')}
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              companies.map((company) => (
                <DuplicateReviewRow
                  key={company.id}
                  company={company}
                  canManage={canManage}
                  locale={locale}
                  disabled={isMutating}
                  onConfirmNew={handleConfirmNew}
                  onRequestMerge={setMergeCandidate}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Merge Confirmation Dialog */}
      <AlertDialog
        open={mergeCandidate !== null}
        onOpenChange={(open) => {
          if (!open) setMergeCandidate(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('duplicateReview.mergeDialog.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('duplicateReview.mergeDialog.description', {
                source: mergeCandidate?.displayName ?? '',
                target: mergeCandidate?.suspectedDuplicateOf?.displayName ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="text-sm font-medium text-destructive">
            {t('duplicateReview.mergeDialog.warning')}
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirmMerge.isPending}>
              {t('duplicateReview.mergeDialog.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleConfirmMerge()
              }}
              disabled={confirmMerge.isPending}
            >
              {confirmMerge.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {t('duplicateReview.mergeDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
