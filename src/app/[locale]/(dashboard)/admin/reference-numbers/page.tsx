/**
 * @fileoverview Reference Number 管理列表頁面
 * @description
 *   Reference Number 的管理介面入口：
 *   - 支援篩選（年份、地區、類型、狀態、搜尋）
 *   - 支援排序（號碼、年份、匹配次數、更新時間）
 *   - 篩選條件同步到 URL 參數
 *   - 提供新增、導入、導出功能按鈕
 *
 * @module src/app/(dashboard)/admin/reference-numbers
 * @since Epic 20 - Story 20.5 (Management Page - List & Filter)
 * @lastModified 2026-02-05 (Story 20.6: Import/Export integration)
 */

'use client'

import * as React from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus, Upload, RefreshCw, Hash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Link, useRouter, usePathname } from '@/i18n/routing'
import {
  ReferenceNumberList,
  ReferenceNumberFilters,
  ReferenceNumberImportDialog,
  ReferenceNumberExportButton,
} from '@/components/features/reference-number'
import { useReferenceNumbers } from '@/hooks/use-reference-numbers'
import type { ReferenceNumberQueryParams } from '@/hooks/use-reference-numbers'

// ============================================================
// Helper Functions
// ============================================================

/**
 * 從 URL search params 解析篩選條件
 */
function parseFiltersFromParams(
  searchParams: URLSearchParams
): ReferenceNumberQueryParams {
  return {
    page: Number(searchParams.get('page')) || 1,
    limit: Number(searchParams.get('limit')) || 20,
    year: searchParams.get('year') ? Number(searchParams.get('year')) : undefined,
    regionId: searchParams.get('regionId') || undefined,
    type: searchParams.get('type') || undefined,
    status: searchParams.get('status') || undefined,
    documentSubType: searchParams.get('documentSubType') || undefined,
    search: searchParams.get('search') || undefined,
    sortBy: (searchParams.get('sortBy') as ReferenceNumberQueryParams['sortBy']) || 'createdAt',
    sortOrder: (searchParams.get('sortOrder') as 'asc' | 'desc') || 'desc',
  }
}

// ============================================================
// Page Component
// ============================================================

export default function ReferenceNumbersPage() {
  const t = useTranslations('referenceNumber')
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const [importOpen, setImportOpen] = React.useState(false)

  // --- 從 URL 解析篩選條件 ---
  const filters = React.useMemo(
    () => parseFiltersFromParams(searchParams),
    [searchParams]
  )

  // --- 查詢資料 ---
  const { data, isLoading, refetch } = useReferenceNumbers(filters)

  const items = data?.items ?? []
  const pagination = data?.pagination

  // --- 導出篩選參數（不含分頁/排序） ---
  const exportFilters = React.useMemo(
    () => ({
      year: filters.year,
      regionId: filters.regionId,
      type: filters.type,
      status: filters.status,
      documentSubType: filters.documentSubType,
    }),
    [filters.year, filters.regionId, filters.type, filters.status, filters.documentSubType]
  )

  // --- 更新 URL 參數 ---
  const updateFilters = React.useCallback(
    (newFilters: Partial<ReferenceNumberQueryParams>) => {
      const params = new URLSearchParams(searchParams.toString())

      Object.entries(newFilters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
          params.set(key, String(value))
        } else {
          params.delete(key)
        }
      })

      router.push(`${pathname}?${params.toString()}`)
    },
    [searchParams, router, pathname]
  )

  // --- Handlers ---

  const handleRefresh = React.useCallback(() => {
    refetch()
  }, [refetch])

  const handleImportSuccess = React.useCallback(() => {
    refetch()
  }, [refetch])

  // --- Render ---

  return (
    <div className="container mx-auto py-6 space-y-6">
      {/* 頁面標題 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Hash className="h-6 w-6" />
            {t('title')}
          </h1>
          <p className="text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleRefresh} variant="outline" size="sm">
            <RefreshCw className="h-4 w-4 mr-2" />
            {t('actions.refresh')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setImportOpen(true)}
          >
            <Upload className="h-4 w-4 mr-2" />
            {t('actions.import')}
          </Button>
          <ReferenceNumberExportButton filters={exportFilters} />
          <Button asChild>
            <Link href="/admin/reference-numbers/new">
              <Plus className="h-4 w-4 mr-2" />
              {t('actions.add')}
            </Link>
          </Button>
        </div>
      </div>

      {/* 篩選器 */}
      <Card>
        <CardContent className="pt-6">
          <ReferenceNumberFilters
            filters={filters}
            onFiltersChange={updateFilters}
          />
        </CardContent>
      </Card>

      {/* 統計摘要 */}
      {pagination && (
        <div className="text-sm text-muted-foreground">
          {t('summary.total', { count: pagination.total })}
        </div>
      )}

      {/* 列表 */}
      <ReferenceNumberList
        data={items}
        pagination={pagination}
        isLoading={isLoading}
        currentSortBy={filters.sortBy}
        currentSortOrder={filters.sortOrder}
        onPageChange={(page) => updateFilters({ page })}
        onSortChange={(sortBy, sortOrder) =>
          updateFilters({
            sortBy: sortBy as ReferenceNumberQueryParams['sortBy'],
            sortOrder,
          })
        }
      />

      {/* 導入對話框 */}
      <ReferenceNumberImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onSuccess={handleImportSuccess}
      />
    </div>
  )
}
