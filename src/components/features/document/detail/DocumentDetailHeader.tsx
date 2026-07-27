'use client'

/**
 * @fileoverview 文件詳情頁面頭部組件
 * @description
 *   顯示文件詳情頁面的頭部區塊：
 *   - 返回按鈕
 *   - 文件名稱
 *   - 處理狀態徽章
 *   - 操作按鈕群組
 *
 * @module src/components/features/document/detail/DocumentDetailHeader
 * @author Development Team
 * @since Epic 13 - Story 13-8 (Document Detail Page)
 * @lastModified 2026-02-07
 */

import * as React from 'react'
import { useTranslations } from 'next-intl'
import { Link, useRouter } from '@/i18n/routing'
import { Button } from '@/components/ui/button'
import { ProcessingStatus } from '@/components/features/document/ProcessingStatus'
import { RetryButton } from '@/components/features/document/RetryButton'
import {
  ArrowLeft,
  Download,
  Trash2,
  RefreshCw,
  FileText,
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/hooks/use-toast'
import { canRetryStatus, type DocumentStatusKey } from '@/lib/document-status'

// ============================================================
// Types
// ============================================================

interface DocumentData {
  id: string
  fileName: string
  status: DocumentStatusKey | string
  blobUrl?: string | null
}

interface DocumentDetailHeaderProps {
  /** 文件數據 */
  document: DocumentData
  /** 刷新回調 */
  onRefresh?: () => void
}

// ============================================================
// Component
// ============================================================

/**
 * 文件詳情頁面頭部
 *
 * @description
 *   顯示文件名稱、狀態和操作按鈕
 */
export function DocumentDetailHeader({
  document,
  onRefresh,
}: DocumentDetailHeaderProps) {
  const t = useTranslations('documents')
  const tc = useTranslations('common')
  const router = useRouter()
  const { toast } = useToast()
  const [isDeleting, setIsDeleting] = React.useState(false)

  // 可重試的狀態
  // FIX-117: 改用 document-status.ts 的共用判斷，與列表頁 DocumentListTable 一致。
  //          原本硬編碼 ['OCR_FAILED', 'FAILED'] 漏掉 REF_MATCH_FAILED，
  //          導致該狀態的文件在列表頁有重試按鈕、進到詳情頁卻沒有。
  const isRetryable = canRetryStatus(document.status)

  // 處理下載
  const handleDownload = React.useCallback(async () => {
    if (!document.blobUrl) {
      toast({
        title: tc('errors.title'),
        description: t('detail.errors.noFile'),
        variant: 'destructive',
      })
      return
    }

    try {
      // 創建下載連結
      const link = window.document.createElement('a')
      link.href = document.blobUrl
      link.download = document.fileName
      link.click()
    } catch {
      toast({
        title: tc('errors.title'),
        description: t('detail.errors.downloadFailed'),
        variant: 'destructive',
      })
    }
  }, [document.blobUrl, document.fileName, t, tc, toast])

  // 處理刪除
  const handleDelete = React.useCallback(async () => {
    setIsDeleting(true)
    try {
      const response = await fetch(`/api/documents/${document.id}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error('Delete failed')
      }

      toast({
        title: t('detail.deleteSuccess'),
        description: t('detail.deleteSuccessDescription'),
      })

      router.push('/documents')
    } catch {
      toast({
        title: tc('errors.title'),
        description: t('detail.errors.deleteFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsDeleting(false)
    }
  }, [document.id, router, t, tc, toast])

  return (
    <div className="flex items-center justify-between">
      {/* Left: Back button + Title */}
      <div className="flex items-center gap-4">
        <Link href="/documents">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>

        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100">
            <FileText className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{document.fileName}</h1>
            <div className="flex items-center gap-2 mt-1">
              <ProcessingStatus status={document.status} size="sm" />
            </div>
          </div>
        </div>
      </div>

      {/* Right: Action buttons */}
      <div className="flex items-center gap-2">
        {/* Refresh */}
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCw className="h-4 w-4 mr-2" />
          {tc('actions.refresh')}
        </Button>

        {/* Retry */}
        {isRetryable && (
          <RetryButton
            documentId={document.id}
            onRetry={onRefresh}
            size="sm"
          />
        )}

        {/* Download */}
        <Button
          variant="outline"
          size="sm"
          onClick={handleDownload}
          disabled={!document.blobUrl}
        >
          <Download className="h-4 w-4 mr-2" />
          {t('actions.download')}
        </Button>

        {/* Delete */}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" className="text-red-600 hover:text-red-700">
              <Trash2 className="h-4 w-4 mr-2" />
              {t('actions.delete')}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('detail.deleteConfirmTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('detail.deleteConfirmDescription', { fileName: document.fileName })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{tc('actions.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                disabled={isDeleting}
                className="bg-red-600 hover:bg-red-700"
              >
                {isDeleting ? tc('actions.deleting') : t('actions.delete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}
