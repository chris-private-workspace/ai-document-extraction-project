'use client'

/**
 * @fileoverview 文件列表表格組件（國際化版本）
 * @description
 *   顯示文件列表的表格，包含：
 *   - No. 序號欄（CHANGE-087 共用 DataTable，跨頁連續）
 *   - 文件名稱、狀態、處理路徑
 *   - 上傳時間（絕對時間）、處理時間（開始/結束/耗時）
 *   - 信心度、上傳者
 *   - 操作按鈕（查看、重試）
 *   - 完整國際化支援
 *
 * @module src/components/features/document/DocumentListTable
 * @author Development Team
 * @since Epic 2 - Story 2.7 (Processing Status Tracking & Display)
 * @lastModified 2026-06-21 (CHANGE-087 Phase 1: 遷移為共用 DataTable + No. 序號欄)
 *
 * @features
 *   - 共用 DataTable 封裝（序號欄 + 欄位定義驅動）
 *   - 狀態徽章顯示
 *   - 錯誤訊息顯示
 *   - 重試按鈕（僅失敗狀態）
 *   - i18n 國際化支援
 *
 * @dependencies
 *   - next-intl - 國際化
 *   - @/components/features/common/DataTable - 共用表格封裝（序號欄）
 *   - @/components/ui/button - Button 組件
 *   - @/lib/i18n-date - 日期格式化（絕對時間）
 *   - @/components/features/confidence - 信心度徽章
 *   - lucide-react - 圖標
 *
 * @related
 *   - src/hooks/use-documents.ts - Documents Hook
 *   - src/app/[locale]/(dashboard)/documents/page.tsx - 文件列表頁面
 *   - messages/{locale}/documents.json - 翻譯檔案
 */

import * as React from 'react'
import Link from 'next/link'
import { useTranslations, useLocale } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DataTable,
  type DataTableColumn,
} from '@/components/features/common/DataTable'
import { ProcessingStatus } from './ProcessingStatus'
import { RetryButton } from './RetryButton'
import { getStatusConfig } from '@/lib/document-status'
import { formatDateTime } from '@/lib/i18n-date'
import { ConfidenceBadge } from '@/components/features/confidence/ConfidenceBadge'
import { Eye, FileText } from 'lucide-react'
import type { DocumentListItem } from '@/hooks/use-documents'
import type { Locale } from '@/i18n/config'

// ============================================================
// Types
// ============================================================

export interface DocumentListTableProps {
  /** 文件列表 */
  documents: DocumentListItem[]
  /** 是否載入中 */
  isLoading?: boolean
  /** 已選擇的文件 ID 集合 */
  selectedIds?: Set<string>
  /** 選擇變更回調 */
  onSelectionChange?: (ids: Set<string>) => void
  /** CHANGE-087: 當前頁碼（1-based），用於序號欄跨頁連續 */
  page?: number
  /** CHANGE-087: 每頁筆數，用於序號欄跨頁連續 */
  pageSize?: number
}

// ============================================================
// Constants
// ============================================================

/**
 * 處理路徑顯示映射 key（用於翻譯查找）
 */
const processingPathKeys: Record<string, string> = {
  AUTO_APPROVE: 'autoApprove',
  QUICK_REVIEW: 'quickReview',
  FULL_REVIEW: 'fullReview',
  MANUAL_REQUIRED: 'manualRequired',
}

// ============================================================
// Component
// ============================================================

/**
 * 文件列表表格組件
 *
 * @description
 *   顯示文件列表，包含狀態追蹤和操作功能
 *
 * @example
 * ```tsx
 * <DocumentListTable
 *   documents={documents}
 *   isLoading={isLoading}
 *   page={page}
 *   pageSize={pageSize}
 * />
 * ```
 */
export function DocumentListTable({
  documents,
  isLoading,
  selectedIds,
  onSelectionChange,
  page,
  pageSize,
}: DocumentListTableProps) {
  const t = useTranslations('documents')
  const locale = useLocale() as Locale

  // --- Selection Helpers ---
  const hasSelection = selectedIds !== undefined && onSelectionChange !== undefined
  const allSelected = hasSelection && documents.length > 0 && documents.every((d) => selectedIds.has(d.id))
  const someSelected = hasSelection && documents.some((d) => selectedIds.has(d.id)) && !allSelected

  const handleSelectAll = React.useCallback(() => {
    if (!onSelectionChange) return
    if (allSelected) {
      onSelectionChange(new Set())
    } else {
      onSelectionChange(new Set(documents.map((d) => d.id)))
    }
  }, [allSelected, documents, onSelectionChange])

  const handleSelectOne = React.useCallback((id: string, checked: boolean) => {
    if (!onSelectionChange || !selectedIds) return
    const next = new Set(selectedIds)
    if (checked) {
      next.add(id)
    } else {
      next.delete(id)
    }
    onSelectionChange(next)
  }, [selectedIds, onSelectionChange])

  // --- Column 定義 ---
  const columns = React.useMemo<DataTableColumn<DocumentListItem>[]>(() => {
    const cols: DataTableColumn<DocumentListItem>[] = []

    // 選擇欄（條件顯示）
    if (hasSelection) {
      cols.push({
        id: 'select',
        headerClassName: 'w-[40px]',
        header: (
          <Checkbox
            checked={allSelected ? true : someSelected ? 'indeterminate' : false}
            onCheckedChange={handleSelectAll}
            aria-label={t('table.columns.select')}
          />
        ),
        cell: (doc) => (
          <Checkbox
            checked={selectedIds?.has(doc.id) ?? false}
            onCheckedChange={(checked) => handleSelectOne(doc.id, !!checked)}
            aria-label={`${t('table.columns.select')} ${doc.fileName}`}
          />
        ),
      })
    }

    // 文件名稱
    cols.push({
      id: 'filename',
      header: t('table.columns.filename'),
      cellClassName: 'font-medium',
      cell: (doc) => (
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-gray-400 flex-shrink-0" />
          <span className="break-all" title={doc.fileName}>
            {doc.fileName}
          </span>
        </div>
      ),
    })

    // CHANGE-092: 公司（識別出的公司名稱，未識別時顯示 --）
    cols.push({
      id: 'company',
      header: t('table.columns.company'),
      cellClassName: 'text-sm',
      cell: (doc) =>
        doc.company ? (
          doc.company.name
        ) : (
          <span className="text-gray-400">--</span>
        ),
    })

    // 狀態
    cols.push({
      id: 'status',
      header: t('table.columns.status'),
      cell: (doc) => {
        const statusConfig = getStatusConfig(doc.status)
        return (
          <>
            <ProcessingStatus status={doc.status} />
            {statusConfig.isError && doc.uploader && (
              <p
                className="text-xs text-red-500 mt-1 truncate max-w-[150px]"
                title={t('table.processingError')}
              >
                {t('table.processingFailed')}
              </p>
            )}
          </>
        )
      },
    })

    // 處理路徑
    cols.push({
      id: 'processingPath',
      header: t('table.columns.processingPath'),
      cell: (doc) =>
        doc.processingPath ? (
          <span className="text-sm">
            {t(`processingPath.${processingPathKeys[doc.processingPath]}`) ||
              doc.processingPath}
          </span>
        ) : (
          <span className="text-gray-400">--</span>
        ),
    })

    // 上傳時間（絕對時間）
    cols.push({
      id: 'uploadTime',
      header: t('table.columns.uploadTime'),
      cellClassName: 'text-gray-500 text-sm whitespace-nowrap',
      cell: (doc) => formatDateTime(doc.createdAt, locale),
    })

    // 處理時間（開始 / 結束 / 耗時）
    cols.push({
      id: 'processingTime',
      header: t('table.columns.processingTime'),
      cellClassName: 'text-gray-500 text-xs',
      cell: (doc) =>
        doc.processingStartedAt ||
        doc.processingEndedAt ||
        doc.processingDuration != null ? (
          <div className="space-y-0.5 whitespace-nowrap">
            <div>
              {t('table.processing.started')}:{' '}
              {doc.processingStartedAt
                ? formatDateTime(doc.processingStartedAt, locale)
                : '--'}
            </div>
            <div>
              {t('table.processing.ended')}:{' '}
              {doc.processingEndedAt
                ? formatDateTime(doc.processingEndedAt, locale)
                : '--'}
            </div>
            <div>
              {t('table.processing.duration')}:{' '}
              {doc.processingDuration != null
                ? t('table.processing.durationValue', {
                    seconds: (doc.processingDuration / 1000).toFixed(1),
                  })
                : '--'}
            </div>
          </div>
        ) : (
          <span className="text-gray-400">--</span>
        ),
    })

    // 信心度
    cols.push({
      id: 'confidence',
      header: t('table.columns.confidence'),
      cell: (doc) =>
        doc.extractionResult?.averageConfidence != null ? (
          <ConfidenceBadge
            score={doc.extractionResult.averageConfidence}
            showScore
            size="sm"
            locale={locale.startsWith('zh') ? 'zh' : 'en'}
          />
        ) : (
          <span className="text-gray-400">--</span>
        ),
    })

    // 上傳者
    cols.push({
      id: 'uploader',
      header: t('table.columns.uploader'),
      cellClassName: 'text-sm',
      cell: (doc) => doc.uploader.name || doc.uploader.email,
    })

    // 操作
    cols.push({
      id: 'actions',
      header: t('table.columns.actions'),
      headerClassName: 'text-right',
      cellClassName: 'text-right',
      cell: (doc) => {
        const statusConfig = getStatusConfig(doc.status)
        return (
          <div className="flex items-center justify-end gap-2">
            {statusConfig.canRetry && <RetryButton documentId={doc.id} />}
            <Link href={`/documents/${doc.id}`}>
              <Button variant="ghost" size="sm">
                <Eye className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        )
      },
    })

    return cols
  }, [
    hasSelection,
    allSelected,
    someSelected,
    handleSelectAll,
    handleSelectOne,
    selectedIds,
    t,
    locale,
  ])

  // 載入中狀態
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-pulse text-gray-500">{t('table.loading')}</div>
      </div>
    )
  }

  // 空狀態
  if (documents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-gray-500">
        <FileText className="h-12 w-12 mb-4 opacity-50" />
        <p>{t('table.noDocuments')}</p>
      </div>
    )
  }

  return (
    <DataTable
      data={documents}
      columns={columns}
      getRowId={(doc) => doc.id}
      page={page}
      pageSize={pageSize}
      rowProps={(doc) => ({
        className: selectedIds?.has(doc.id) ? 'bg-muted' : undefined,
      })}
    />
  )
}
