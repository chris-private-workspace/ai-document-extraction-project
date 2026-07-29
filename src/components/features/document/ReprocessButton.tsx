'use client'

/**
 * @fileoverview 重新處理按鈕組件
 * @description
 *   提供「已處理成功但需以新設定重跑」的入口：
 *   - 適用於欄位定義集 / Prompt / 映射設定變更後，既有文件需要套用新設定的情境
 *   - 與 RetryButton 互斥：失敗狀態走「重試」，成功狀態走「重新處理」
 *   - 帶確認對話框 —— 此操作會**取代**既有提取結果並產生 AI 費用，
 *     與 RetryButton（對失敗文件重試，本來就沒有結果可失去）的風險不同
 *
 * @module src/components/features/document/ReprocessButton
 * @since FIX-144 - 已完成文件無重新處理入口
 * @lastModified 2026-07-29
 *
 * @features
 *   - 確認對話框（顯示檔名 + 取代既有結果的警告）
 *   - 載入狀態顯示
 *   - Toast 通知
 *   - i18n 國際化支援
 *
 * @dependencies
 *   - next-intl - 國際化
 *   - lucide-react - 圖標
 *   - sonner - Toast 通知
 *   - @/components/ui/alert-dialog - 確認對話框
 *   - @/hooks/use-documents - Documents Hook（與重試共用 retry mutation）
 *
 * @related
 *   - src/lib/document-status.ts - canReprocessStatus 判斷可用狀態
 *   - src/components/features/document/RetryButton.tsx - 失敗重試（語意不同）
 *   - src/services/document.service.ts - retryProcessing 後端實作
 *   - messages/{locale}/documents.json - 翻譯檔案
 */

import * as React from 'react'
import { useTranslations } from 'next-intl'
import { RotateCcw, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
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
import { useDocuments } from '@/hooks/use-documents'

// ============================================================
// Types
// ============================================================

export interface ReprocessButtonProps {
  /** 文件 ID */
  documentId: string
  /** 檔案名稱（顯示於確認對話框） */
  fileName: string
  /** 重新處理已觸發後的回調 */
  onReprocess?: () => void
  /** 按鈕尺寸 */
  size?: 'sm' | 'default'
  /** 自定義 className */
  className?: string
}

// ============================================================
// Component
// ============================================================

/**
 * 重新處理按鈕組件
 *
 * @description
 *   點擊後跳出確認對話框，確認才觸發重新處理：
 *   1. 顯示載入狀態
 *   2. 調用 retry API（後端 retryProcessing 同時支援失敗重試與成功重跑）
 *   3. 顯示成功/失敗提示
 *
 * @example
 * ```tsx
 * {canReprocessStatus(document.status) && (
 *   <ReprocessButton
 *     documentId={document.id}
 *     fileName={document.fileName}
 *     onReprocess={onRefresh}
 *   />
 * )}
 * ```
 */
export function ReprocessButton({
  documentId,
  fileName,
  onReprocess,
  size = 'sm',
  className,
}: ReprocessButtonProps) {
  const t = useTranslations('documents')
  const tc = useTranslations('common')
  const { retry, isRetrying } = useDocuments()

  const handleReprocess = () => {
    retry(documentId, {
      onSuccess: () => {
        toast.success(t('reprocess.success'))
        onReprocess?.()
      },
      onError: (error) => {
        toast.error(t('reprocess.failed', { message: error.message }))
      },
    })
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size={size}
          disabled={isRetrying}
          className={className}
        >
          {isRetrying ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <RotateCcw className="h-4 w-4 mr-2" />
          )}
          {t('reprocess.button')}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('reprocess.confirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('reprocess.confirmDescription', { fileName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tc('actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={handleReprocess} disabled={isRetrying}>
            {t('reprocess.button')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
