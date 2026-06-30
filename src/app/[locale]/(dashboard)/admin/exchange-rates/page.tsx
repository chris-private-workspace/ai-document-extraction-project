'use client'

/**
 * @fileoverview Exchange Rate 管理列表頁面
 * @description
 *   Exchange Rate 的管理介面入口：
 *   - 支援篩選（年份、來源貨幣、目標貨幣、狀態、來源類型）
 *   - 支援排序（貨幣、匯率、年份）
 *   - 篩選條件同步到 URL 參數
 *   - 提供新增、導入、導出功能按鈕
 *
 * @module src/app/[locale]/(dashboard)/admin/exchange-rates
 * @since Epic 21 - Story 21.6 (Management Page - List & Filter)
 * @lastModified 2026-02-06
 */

import * as React from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus, Upload, Download, RefreshCw, Coins } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Link, useRouter, usePathname } from '@/i18n/routing'
import {
  ExchangeRateList,
  ExchangeRateFilters,
  type ExchangeRateFilterValues,
} from '@/components/features/exchange-rate'
import {
  useExchangeRates,
  type ExchangeRateQueryParams,
} from '@/hooks/use-exchange-rates'

// ============================================================
// Helper Functions
// ============================================================

/**
 * 從 URL search params 解析篩選條件
 */
function parseFiltersFromParams(
  searchParams: URLSearchParams
): ExchangeRateQueryParams {
  return {
    page: Number(searchParams.get('page')) || 1,
    limit: Number(searchParams.get('limit')) || 20,
    year: searchParams.get('year') ? Number(searchParams.get('year')) : undefined,
    fromCurrency: searchParams.get('fromCurrency') || undefined,
    toCurrency: searchParams.get('toCurrency') || undefined,
    isActive:
      searchParams.get('isActive') === 'true'
        ? true
        : searchParams.get('isActive') === 'false'
          ? false
          : undefined,
    source:
      (searchParams.get('source') as ExchangeRateQueryParams['source']) ||
      undefined,
    sortBy:
      (searchParams.get('sortBy') as ExchangeRateQueryParams['sortBy']) ||
      'createdAt',
    sortOrder: (searchParams.get('sortOrder') as 'asc' | 'desc') || 'desc',
  }
}

// ============================================================
// Page Component
// ============================================================

export default function ExchangeRatesPage() {
  const t = useTranslations('exchangeRate')
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  // --- 從 URL 解析篩選條件 ---
  const filters = React.useMemo(
    () => parseFiltersFromParams(searchParams),
    [searchParams]
  )

  // --- 查詢資料 ---
  const { data, isLoading, refetch } = useExchangeRates(filters)

  const items = data?.items ?? []
  const pagination = data?.pagination

  // --- 篩選器值（不含分頁/排序） ---
  const filterValues: ExchangeRateFilterValues = React.useMemo(
    () => ({
      year: filters.year,
      fromCurrency: filters.fromCurrency,
      toCurrency: filters.toCurrency,
      isActive: filters.isActive,
      source: filters.source,
    }),
    [
      filters.year,
      filters.fromCurrency,
      filters.toCurrency,
      filters.isActive,
      filters.source,
    ]
  )

  // --- 更新 URL 參數 ---
  const updateFilters = React.useCallback(
    (newFilters: Partial<ExchangeRateQueryParams>) => {
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

  const handleFiltersChange = React.useCallback(
    (newFilters: Partial<ExchangeRateFilterValues> & { page?: number }) => {
      updateFilters(newFilters)
    },
    [updateFilters]
  )

  // --- Render ---

  return (
    <div className="container mx-auto py-6 space-y-6">
      {/* 頁面標題 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Coins className="h-6 w-6" />
            {t('title')}
          </h1>
          <p className="text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleRefresh} variant="outline" size="sm">
            <RefreshCw className="h-4 w-4 mr-2" />
            {t('actions.refresh')}
          </Button>
          <Button variant="outline" size="sm">
            <Upload className="h-4 w-4 mr-2" />
            {t('actions.import')}
          </Button>
          <Button variant="outline" size="sm">
            <Download className="h-4 w-4 mr-2" />
            {t('actions.export')}
          </Button>
          <Button asChild>
            <Link href="/admin/exchange-rates/new">
              <Plus className="h-4 w-4 mr-2" />
              {t('actions.add')}
            </Link>
          </Button>
        </div>
      </div>

      {/* 篩選器 */}
      <Card>
        <CardContent className="pt-6">
          <ExchangeRateFilters
            filters={filterValues}
            onFiltersChange={handleFiltersChange}
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
      <ExchangeRateList
        data={items}
        pagination={pagination}
        isLoading={isLoading}
        currentSortBy={filters.sortBy}
        currentSortOrder={filters.sortOrder}
        onPageChange={(page) => updateFilters({ page })}
        onSortChange={(sortBy, sortOrder) =>
          updateFilters({
            sortBy: sortBy as ExchangeRateQueryParams['sortBy'],
            sortOrder,
          })
        }
      />
    </div>
  )
}
