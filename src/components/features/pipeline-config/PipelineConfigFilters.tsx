'use client'

/**
 * @fileoverview Pipeline Config 篩選器組件
 * @description
 *   提供 Pipeline Config 列表的篩選功能：
 *   - Scope 選擇（GLOBAL/REGION/COMPANY）
 *   - 啟用狀態
 *   - 清除所有篩選
 *
 * @module src/components/features/pipeline-config/PipelineConfigFilters
 * @since CHANGE-032 - Pipeline Reference Number Matching & FX Conversion
 * @lastModified 2026-02-08
 *
 * @dependencies
 *   - next-intl - 國際化
 *   - @/components/ui/select - 下拉選擇
 *   - @/components/ui/button - 按鈕
 */

import * as React from 'react'
import { useTranslations } from 'next-intl'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// ============================================================
// Types
// ============================================================

export interface PipelineConfigFilterValues {
  scope?: 'GLOBAL' | 'REGION' | 'COMPANY' | 'FORMAT'
  isActive?: boolean
}

interface PipelineConfigFiltersProps {
  filters: PipelineConfigFilterValues
  onFiltersChange: (
    filters: Partial<PipelineConfigFilterValues> & { page?: number }
  ) => void
}

// ============================================================
// Constants
// ============================================================

const SCOPE_OPTIONS = ['GLOBAL', 'REGION', 'COMPANY', 'FORMAT'] as const
const ALL_VALUE = '__all__'

// ============================================================
// Component
// ============================================================

/**
 * Pipeline Config 篩選器
 */
export function PipelineConfigFilters({
  filters,
  onFiltersChange,
}: PipelineConfigFiltersProps) {
  const t = useTranslations('pipelineConfig')

  const handleClear = React.useCallback(() => {
    onFiltersChange({
      scope: undefined,
      isActive: undefined,
      page: 1,
    })
  }, [onFiltersChange])

  const hasActiveFilters =
    !!filters.scope || filters.isActive !== undefined

  return (
    <div className="flex flex-wrap items-end gap-4">
      {/* Scope */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t('filters.scope')}</label>
        <Select
          value={filters.scope ?? ALL_VALUE}
          onValueChange={(value) =>
            onFiltersChange({
              scope:
                value === ALL_VALUE
                  ? undefined
                  : (value as PipelineConfigFilterValues['scope']),
              page: 1,
            })
          }
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder={t('filters.all')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>{t('filters.all')}</SelectItem>
            {SCOPE_OPTIONS.map((scope) => (
              <SelectItem key={scope} value={scope}>
                {t(`scope.${scope}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* 狀態 */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t('filters.status')}</label>
        <Select
          value={
            filters.isActive === undefined
              ? ALL_VALUE
              : filters.isActive.toString()
          }
          onValueChange={(value) =>
            onFiltersChange({
              isActive: value === ALL_VALUE ? undefined : value === 'true',
              page: 1,
            })
          }
        >
          <SelectTrigger className="w-[120px]">
            <SelectValue placeholder={t('filters.all')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>{t('filters.all')}</SelectItem>
            <SelectItem value="true">{t('filters.active')}</SelectItem>
            <SelectItem value="false">{t('filters.inactive')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* 清除按鈕 */}
      {hasActiveFilters && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium invisible">Action</label>
          <Button variant="ghost" size="sm" onClick={handleClear}>
            <X className="h-4 w-4 mr-1" />
            {t('filters.clear')}
          </Button>
        </div>
      )}
    </div>
  )
}
