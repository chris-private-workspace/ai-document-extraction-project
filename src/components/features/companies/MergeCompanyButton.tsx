'use client'

/**
 * @fileoverview 公司詳情頁合併入口（FIX-131）
 * @description
 *   在公司詳情頁提供「合併公司」入口，補上既有 UI 的缺口——原本合併只暴露給
 *   PENDING 待審清單，導致兩間 ACTIVE 公司無法透過任何頁面合併。
 *
 *   流程：按鈕 → 公司搜尋選擇器（查啟用中公司、排除自己）→ 選中後開
 *   CompanyMergeDialog，以「當前公司 + 選中公司」兩筆進入既有合併流程
 *   （沿用 useMergeCompanies + 唯一鍵撞鍵報告 MergeSkippedReportAlert）。
 *
 * @module src/components/features/companies/MergeCompanyButton
 * @since FIX-131
 * @lastModified 2026-07-22
 *
 * @dependencies
 *   - next-intl - 國際化
 *   - @tanstack/react-query - 公司搜尋（不走 use-companies 的 URL 同步）
 *   - ./CompanyMergeDialog - 合併對話框
 */

import * as React from 'react'
import { useTranslations } from 'next-intl'
import { useQuery } from '@tanstack/react-query'
import { GitMerge, Search, Loader2, Building2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useDebounce } from '@/hooks/use-debounce'
import { CompanyMergeDialog, type MergeableCompany } from './CompanyMergeDialog'

// ============================================================
// Types
// ============================================================

interface MergeCompanyButtonProps {
  /** 當前檢視的公司（詳情頁主體，預設為合併後存活方） */
  currentCompany: MergeableCompany
  /** 合併成功後的回呼（通常用於重新載入詳情） */
  onMerged?: () => void
}

/** 公司搜尋結果的最小形狀（取自 /api/companies 列表項） */
interface CompanySearchItem {
  id: string
  name: string
  displayName: string
  code: string | null
}

interface CompaniesSearchResponse {
  success: boolean
  data: CompanySearchItem[]
}

// ============================================================
// Constants
// ============================================================

const SEARCH_DEBOUNCE_MS = 300
const SEARCH_LIMIT = 10

// ============================================================
// Component
// ============================================================

/**
 * 公司詳情頁「合併公司」入口按鈕
 *
 * @param props - 組件屬性
 */
export function MergeCompanyButton({
  currentCompany,
  onMerged,
}: MergeCompanyButtonProps) {
  const t = useTranslations('companies')

  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [mergeOpen, setMergeOpen] = React.useState(false)
  const [selected, setSelected] = React.useState<MergeableCompany | null>(null)
  const [search, setSearch] = React.useState('')
  const debouncedSearch = useDebounce(search, SEARCH_DEBOUNCE_MS)

  // 公司搜尋（只查啟用中公司，排除當前公司自己）
  const { data, isLoading, isError } = useQuery<CompaniesSearchResponse>({
    queryKey: ['company-merge-picker', debouncedSearch],
    queryFn: async () => {
      const params = new URLSearchParams()
      params.set('status', 'ACTIVE')
      params.set('limit', String(SEARCH_LIMIT))
      if (debouncedSearch) params.set('search', debouncedSearch)

      const response = await fetch(`/api/companies?${params}`)
      if (!response.ok) {
        const error = await response.json().catch(() => null)
        throw new Error(error?.error?.detail || t('merge.fromDetail.loadError'))
      }
      return response.json()
    },
    enabled: pickerOpen,
    staleTime: 60 * 1000,
  })

  const results = React.useMemo(
    () => (data?.data ?? []).filter((c) => c.id !== currentCompany.id),
    [data?.data, currentCompany.id]
  )

  // 開啟選擇器時重置搜尋字串
  const handleOpenPicker = React.useCallback(() => {
    setSearch('')
    setPickerOpen(true)
  }, [])

  // 選中候選公司 → 關選擇器、開合併對話框
  const handlePick = React.useCallback((company: CompanySearchItem) => {
    setSelected({ id: company.id, name: company.name })
    setPickerOpen(false)
    setMergeOpen(true)
  }, [])

  const mergeCompanies: MergeableCompany[] = React.useMemo(
    () => (selected ? [currentCompany, selected] : []),
    [currentCompany, selected]
  )

  return (
    <>
      <Button variant="outline" size="sm" onClick={handleOpenPicker}>
        <GitMerge className="mr-2 h-4 w-4" />
        {t('merge.fromDetail.button')}
      </Button>

      {/* 公司搜尋選擇器 */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitMerge className="h-5 w-5" />
              {t('merge.fromDetail.pickerTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('merge.fromDetail.pickerDescription', {
                name: currentCompany.name,
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('merge.fromDetail.searchPlaceholder')}
                className="pl-9"
                autoFocus
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t('merge.fromDetail.searchHint')}
            </p>

            <ScrollArea className="h-64 rounded-md border">
              {isLoading ? (
                <div className="flex items-center justify-center py-10 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span className="ml-2 text-sm">
                    {t('merge.fromDetail.searching')}
                  </span>
                </div>
              ) : isError ? (
                <div className="py-10 text-center text-sm text-destructive">
                  {t('merge.fromDetail.loadError')}
                </div>
              ) : results.length === 0 ? (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  {t('merge.fromDetail.noResults')}
                </div>
              ) : (
                <div className="divide-y">
                  {results.map((company) => (
                    <button
                      key={company.id}
                      type="button"
                      onClick={() => handlePick(company)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent"
                    >
                      <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">
                          {company.displayName || company.name}
                        </div>
                        {company.code && (
                          <div className="truncate font-mono text-xs text-muted-foreground">
                            {company.code}
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>

      {/* 合併確認對話框（沿用既有流程 + 撞鍵報告） */}
      <CompanyMergeDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        companies={mergeCompanies}
        onSuccess={onMerged}
      />
    </>
  )
}
