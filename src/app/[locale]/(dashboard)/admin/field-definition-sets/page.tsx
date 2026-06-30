'use client';

/**
 * @fileoverview FieldDefinitionSet 管理列表頁面
 * @description
 *   FieldDefinitionSet 的管理介面入口：
 *   - 支援篩選（scope、status、search）
 *   - 支援排序（name、fieldsCount）
 *   - 篩選條件同步到 URL 參數
 *   - 提供新增按鈕
 *
 * @module src/app/[locale]/(dashboard)/admin/field-definition-sets
 * @since CHANGE-042 Phase 3
 * @lastModified 2026-02-23
 */

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus, RefreshCw, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Link, useRouter, usePathname } from '@/i18n/routing';
import {
  FieldDefinitionSetList,
  FieldDefinitionSetFilters,
} from '@/components/features/field-definition-set';
import {
  useFieldDefinitionSets,
  type FieldDefinitionSetFilters as FilterValues,
} from '@/hooks/use-field-definition-sets';

// ============================================================
// Helper
// ============================================================

function parseFiltersFromParams(
  searchParams: URLSearchParams
): FilterValues {
  return {
    page: Number(searchParams.get('page')) || 1,
    limit: Number(searchParams.get('limit')) || 20,
    scope: searchParams.get('scope') || undefined,
    isActive:
      searchParams.get('isActive') === 'true'
        ? true
        : searchParams.get('isActive') === 'false'
          ? false
          : undefined,
    search: searchParams.get('search') || undefined,
    sortBy: searchParams.get('sortBy') || 'createdAt',
    sortOrder:
      (searchParams.get('sortOrder') as 'asc' | 'desc') || 'desc',
  };
}

// ============================================================
// Page
// ============================================================

export default function FieldDefinitionSetsPage() {
  const t = useTranslations('fieldDefinitionSet');
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filters = React.useMemo(
    () => parseFiltersFromParams(searchParams),
    [searchParams]
  );

  const { data, isLoading, refetch } = useFieldDefinitionSets(filters);

  const items = data?.items ?? [];
  const pagination = data?.pagination;

  const filterValues: FilterValues = React.useMemo(
    () => ({
      scope: filters.scope,
      isActive: filters.isActive,
      search: filters.search,
    }),
    [filters.scope, filters.isActive, filters.search]
  );

  const updateFilters = React.useCallback(
    (newFilters: Partial<FilterValues>) => {
      const params = new URLSearchParams(searchParams.toString());

      Object.entries(newFilters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
          params.set(key, String(value));
        } else {
          params.delete(key);
        }
      });

      router.push(`${pathname}?${params.toString()}`);
    },
    [searchParams, router, pathname]
  );

  return (
    <div className="container mx-auto py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Layers className="h-6 w-6" />
            {t('title')}
          </h1>
          <p className="text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => refetch()}
            variant="outline"
            size="sm"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button asChild>
            <Link href="/admin/field-definition-sets/new">
              <Plus className="h-4 w-4 mr-2" />
              {t('actions.add')}
            </Link>
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <FieldDefinitionSetFilters
            filters={filterValues}
            onFiltersChange={(f) => updateFilters(f)}
          />
        </CardContent>
      </Card>

      {/* List */}
      <FieldDefinitionSetList
        data={items}
        pagination={pagination}
        isLoading={isLoading}
        currentSortBy={filters.sortBy}
        currentSortOrder={filters.sortOrder}
        onPageChange={(page) => updateFilters({ page })}
        onSortChange={(sortBy, sortOrder) =>
          updateFilters({ sortBy, sortOrder })
        }
      />
    </div>
  );
}
