'use client'

/**
 * @fileoverview 公司合併對話框組件（國際化版本）
 * @description
 *   提供公司合併功能的對話框介面。
 *   - 完整國際化支援
 *
 * @module src/components/features/companies/CompanyMergeDialog
 * @since Epic 0 - Story 0.3
 * @lastModified 2026-01-17
 *
 * @features
 *   - 主/副公司選擇
 *   - 合併預覽
 *   - 確認執行
 *   - 完整國際化支援
 *
 * @dependencies
 *   - next-intl - 國際化
 *   - @/components/ui/dialog - 對話框組件
 *   - @/hooks/use-pending-companies - 合併 API
 *
 * @related
 *   - src/app/api/admin/companies/merge/route.ts - 合併 API
 */

import * as React from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useMergeCompanies } from '@/hooks/use-pending-companies'
import { MergeSkippedReportAlert } from './MergeSkippedReportAlert'
import type { MergeTransferSkip } from '@/services/company-merge-transfer.service'
import { Loader2, GitMerge, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'

// ============================================================
// Types
// ============================================================

/**
 * 合併對話框所需的最小公司形狀（FIX-131）
 *
 * @description
 *   原本綁死 `PendingCompany[]`，只適用 PENDING 審核清單。放寬為此最小型別後，
 *   詳情頁「合併兩間 ACTIVE 公司」可用「當前公司 + 選中公司」組成兩筆傳入。
 *   `PendingCompany` 結構相容此型別，既有審核頁呼叫端不需改動。
 */
export interface MergeableCompany {
  id: string
  name: string
  /** 文件/出現次數（選填——來自公司列表 API 的候選公司不含此欄位） */
  documentCount?: number
}

interface CompanyMergeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  companies: MergeableCompany[]
  onSuccess?: () => void
}

// ============================================================
// Component
// ============================================================

/**
 * 公司合併對話框
 *
 * @description
 *   提供介面讓用戶選擇主公司和副公司進行合併。
 *   合併後，副公司的名稱變體會轉移到主公司，
 *   副公司狀態會變更為 MERGED。
 *
 * @param props - 組件屬性
 * @returns 公司合併對話框
 */
export function CompanyMergeDialog({
  open,
  onOpenChange,
  companies,
  onSuccess,
}: CompanyMergeDialogProps) {
  const t = useTranslations('companies')
  const [primaryId, setPrimaryId] = React.useState<string>('')
  // FIX-129: 合併結果快照（skipped 非空時顯示結果視圖而非自動關閉）。
  // 用快照而非即時 prop —— onSuccess 刷新列表後 companies 會變，不能再依賴它。
  const [mergeOutcome, setMergeOutcome] = React.useState<{
    skipped: MergeTransferSkip[]
    mergedCount: number
  } | null>(null)
  const mergeMutation = useMergeCompanies()

  // 對話框「開啟瞬間」重置結果視圖（不能依賴 companies —— 合併成功後
  // 列表刷新會改變 companies 引用，若在此 reset 會把結果視圖清掉）
  const prevOpenRef = React.useRef(false)
  React.useEffect(() => {
    if (open && !prevOpenRef.current) {
      setMergeOutcome(null)
    }
    prevOpenRef.current = open
  }, [open])

  // 重置選擇當對話框打開
  React.useEffect(() => {
    if (open && companies.length > 0) {
      setPrimaryId(companies[0].id)
    }
  }, [open, companies])

  // 計算副公司列表
  const secondaryCompanies = React.useMemo(
    () => companies.filter((c) => c.id !== primaryId),
    [companies, primaryId]
  )

  // 處理合併
  const handleMerge = async () => {
    if (!primaryId || secondaryCompanies.length === 0) {
      toast.error(t('merge.selectError'))
      return
    }

    try {
      const result = await mergeMutation.mutateAsync({
        primaryId,
        secondaryIds: secondaryCompanies.map((c) => c.id),
      })
      toast.success(t('merge.success', { count: secondaryCompanies.length }))

      // FIX-129: 有設定因唯一鍵衝突未轉移 → 留在對話框顯示明細，不自動關閉
      const skipped = result.knowledgeTransfer?.skipped ?? []
      if (skipped.length > 0) {
        toast.warning(t('merge.skipped.toast', { count: skipped.length }))
        setMergeOutcome({ skipped, mergedCount: secondaryCompanies.length })
      } else {
        onOpenChange(false)
      }
      onSuccess?.()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('merge.error')
      )
    }
  }

  // FIX-129: 合併完成但有設定未轉移 → 顯示結果視圖（明細 + 手動關閉）
  if (mergeOutcome !== null) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitMerge className="h-5 w-5" />
              {t('merge.skipped.resultTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('merge.success', { count: mergeOutcome.mergedCount })}
            </DialogDescription>
          </DialogHeader>
          <MergeSkippedReportAlert skipped={mergeOutcome.skipped} />
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('merge.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  if (companies.length < 2) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('merge.title')}</DialogTitle>
            <DialogDescription>
              {t('merge.needTwoCompanies')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('merge.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="h-5 w-5" />
            {t('merge.title')}
          </DialogTitle>
          <DialogDescription>
            {t('merge.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* 主公司選擇 */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('merge.selectPrimary')}</Label>
            <RadioGroup value={primaryId} onValueChange={setPrimaryId}>
              {companies.map((company) => (
                <div
                  key={company.id}
                  className="flex items-center space-x-3 rounded-lg border p-3 hover:bg-accent"
                >
                  <RadioGroupItem value={company.id} id={company.id} />
                  <Label
                    htmlFor={company.id}
                    className="flex-1 cursor-pointer"
                  >
                    <div className="font-medium">{company.name}</div>
                    {company.documentCount !== undefined && (
                      <div className="text-xs text-muted-foreground">
                        {t('merge.documentCount', { count: company.documentCount })}
                      </div>
                    )}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          {/* 合併預覽 */}
          {primaryId && secondaryCompanies.length > 0 && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <div className="space-y-1">
                  <p>{t('merge.previewTitle')}</p>
                  <ul className="list-inside list-disc text-sm">
                    {secondaryCompanies.map((company) => (
                      <li key={company.id}>{company.name}</li>
                    ))}
                  </ul>
                  <p className="text-xs mt-2">
                    {t('merge.previewDescription')}
                  </p>
                </div>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mergeMutation.isPending}
          >
            {t('actions.cancel')}
          </Button>
          <Button
            onClick={handleMerge}
            disabled={
              mergeMutation.isPending ||
              !primaryId ||
              secondaryCompanies.length === 0
            }
          >
            {mergeMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('merge.merging')}
              </>
            ) : (
              <>
                <GitMerge className="mr-2 h-4 w-4" />
                {t('merge.confirmMerge')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
