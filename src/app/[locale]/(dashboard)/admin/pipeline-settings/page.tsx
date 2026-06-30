'use client'

/**
 * @fileoverview Pipeline Settings 管理列表頁面
 * @description
 *   Pipeline Config 的管理介面入口：
 *   - 支援篩選（scope、啟用狀態）
 *   - 支援排序
 *   - 篩選條件同步到 URL 參數
 *   - 提供新增功能按鈕
 *
 * @module src/app/[locale]/(dashboard)/admin/pipeline-settings
 * @since CHANGE-032 - Pipeline Reference Number Matching & FX Conversion
 * @lastModified 2026-02-08
 */

import * as React from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus, RefreshCw, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Link, useRouter, usePathname } from '@/i18n/routing'
import {
  PipelineConfigList,
  PipelineConfigFilters,
  type PipelineConfigFilterValues,
} from '@/components/features/pipeline-config'
import {
  usePipelineConfigs,
  type PipelineConfigQueryParams,
} from '@/hooks/use-pipeline-configs'

// ============================================================
// Helper Functions
// ============================================================

/**
 * 從 URL search params 解析篩選條件
 */
function parseFiltersFromParams(
  searchParams: URLSearchParams
): PipelineConfigQueryParams {
  return {
    page: Number(searchParams.get('page')) || 1,
    limit: Number(searchParams.get('limit')) || 20,
    scope:
      (searchParams.get('scope') as PipelineConfigQueryParams['scope']) ||
      undefined,
    isActive:
      searchParams.get('isActive') === 'true'
        ? true
        : searchParams.get('isActive') === 'false'
          ? false
          : undefined,
    sortBy:
      (searchParams.get('sortBy') as PipelineConfigQueryParams['sortBy']) ||
      'createdAt',
    sortOrder: (searchParams.get('sortOrder') as 'asc' | 'desc') || 'desc',
  }
}

// ============================================================
// Page Component
// ============================================================

export default function PipelineSettingsPage() {
  const t = useTranslations('pipelineConfig')
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  // --- 從 URL 解析篩選條件 ---
  const filters = React.useMemo(
    () => parseFiltersFromParams(searchParams),
    [searchParams]
  )

  // --- 查詢資料 ---
  const { data, isLoading, refetch } = usePipelineConfigs(filters)

  const items = data?.items ?? []
  const pagination = data?.pagination

  // --- 篩選器值（不含分頁/排序） ---
  const filterValues: PipelineConfigFilterValues = React.useMemo(
    () => ({
      scope: filters.scope,
      isActive: filters.isActive,
    }),
    [filters.scope, filters.isActive]
  )

  // --- 更新 URL 參數 ---
  const updateFilters = React.useCallback(
    (newFilters: Partial<PipelineConfigQueryParams>) => {
      const params = new URLSearchParams(searchParams.toString())

      Object.entries(newFilters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && String(value) !== '') {
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
    (newFilters: Partial<PipelineConfigFilterValues> & { page?: number }) => {
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
            <Settings2 className="h-6 w-6" />
            {t('title')}
          </h1>
          <p className="text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleRefresh} variant="outline" size="sm">
            <RefreshCw className="h-4 w-4 mr-2" />
            {t('actions.refresh')}
          </Button>
          <Button asChild>
            <Link href="/admin/pipeline-settings/new">
              <Plus className="h-4 w-4 mr-2" />
              {t('actions.add')}
            </Link>
          </Button>
        </div>
      </div>

      {/* 篩選器 */}
      <Card>
        <CardContent className="pt-6">
          <PipelineConfigFilters
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
      <PipelineConfigList
        data={items}
        pagination={pagination}
        isLoading={isLoading}
        currentSortBy={filters.sortBy}
        currentSortOrder={filters.sortOrder}
        onPageChange={(page) => updateFilters({ page })}
        onSortChange={(sortBy, sortOrder) =>
          updateFilters({
            sortBy: sortBy as PipelineConfigQueryParams['sortBy'],
            sortOrder,
          })
        }
      />
    </div>
  )
}
