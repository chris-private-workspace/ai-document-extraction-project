/**
 * @fileoverview 模版欄位映射列表組件
 * @description
 *   顯示 TemplateFieldMapping 配置列表，支援篩選、搜索和分頁
 *
 * @module src/components/features/template-field-mapping
 * @since Epic 19 - Story 19.4
 * @lastModified 2026-06-22 (CHANGE-087 Phase 2: 遷移共用 DataTable)
 */

'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/routing';
import { Plus, Search, Edit, Copy, Trash2, RefreshCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DataTable,
  type DataTableColumn,
} from '@/components/features/common/DataTable';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { toast } from 'sonner';

import {
  useTemplateFieldMappings,
  useDeleteTemplateFieldMapping,
} from '@/hooks/use-template-field-mappings';
import type {
  TemplateFieldMappingSummary,
  TemplateFieldMappingScope,
} from '@/types/template-field-mapping';
import { SCOPE_OPTIONS } from '@/types/template-field-mapping';

// ============================================================================
// Types
// ============================================================================

interface TemplateFieldMappingListProps {
  className?: string;
}

interface ListFilters {
  scope: TemplateFieldMappingScope | 'ALL';
  search: string;
  page: number;
  limit: number;
}

// ============================================================================
// Sub Components
// ============================================================================

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex gap-4">
        <Skeleton className="h-10 w-[200px]" />
        <Skeleton className="h-10 w-[200px]" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    </div>
  );
}

function EmptyState({ onCreateClick }: { onCreateClick: () => void }) {
  const t = useTranslations('templateFieldMapping');

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <p className="text-lg font-medium text-muted-foreground">
        {t('list.emptyTitle')}
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        {t('list.emptyDescription')}
      </p>
      <Button onClick={onCreateClick} className="mt-4">
        <Plus className="mr-2 h-4 w-4" />
        {t('actions.create')}
      </Button>
    </div>
  );
}

function ScopeBadge({ scope }: { scope: TemplateFieldMappingScope }) {
  const t = useTranslations('templateFieldMapping');

  const variants: Record<TemplateFieldMappingScope, 'default' | 'secondary' | 'outline'> = {
    GLOBAL: 'default',
    COMPANY: 'secondary',
    FORMAT: 'outline',
  };

  return (
    <Badge variant={variants[scope]}>
      {t(`scope.${scope.toLowerCase()}`)}
    </Badge>
  );
}

function StatusBadge({ isActive }: { isActive: boolean }) {
  const t = useTranslations('templateFieldMapping');

  return (
    <Badge variant={isActive ? 'default' : 'destructive'}>
      {isActive ? t('status.active') : t('status.inactive')}
    </Badge>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * @component TemplateFieldMappingList
 * @description 模版欄位映射配置列表
 */
export function TemplateFieldMappingList({ className }: TemplateFieldMappingListProps) {
  const t = useTranslations('templateFieldMapping');
  const router = useRouter();

  // State
  const [filters, setFilters] = React.useState<ListFilters>({
    scope: 'ALL',
    search: '',
    page: 1,
    limit: 20,
  });
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const [searchInput, setSearchInput] = React.useState('');

  // Hooks
  const { mappings, total, totalPages, isLoading, isError, error, refetch } =
    useTemplateFieldMappings({
      scope: filters.scope === 'ALL' ? undefined : filters.scope,
      search: filters.search || undefined,
      page: filters.page,
      limit: filters.limit,
    });

  const { deleteMapping, isDeleting } = useDeleteTemplateFieldMapping();

  // Handlers
  const handleSearch = React.useCallback(() => {
    setFilters((prev) => ({
      ...prev,
      search: searchInput,
      page: 1,
    }));
  }, [searchInput]);

  const handleScopeChange = React.useCallback((value: string) => {
    setFilters((prev) => ({
      ...prev,
      scope: value as ListFilters['scope'],
      page: 1,
    }));
  }, []);

  const handlePageChange = React.useCallback((newPage: number) => {
    setFilters((prev) => ({
      ...prev,
      page: newPage,
    }));
  }, []);

  const handleDelete = React.useCallback(async () => {
    if (!deleteId) return;

    try {
      await deleteMapping(deleteId);
      toast.success(t('toast.deleted.title'));
      setDeleteId(null);
    } catch (err) {
      toast.error(t('toast.deleteError.title'), {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [deleteId, deleteMapping, t]);

  const handleCreateClick = React.useCallback(() => {
    router.push('/admin/template-field-mappings/new');
  }, [router]);

  const handleEditClick = React.useCallback(
    (id: string) => {
      router.push(`/admin/template-field-mappings/${id}`);
    },
    [router]
  );

  // CHANGE-107: copy opens the create form pre-filled from this record. The
  // four identity fields are cleared there, so the user must retarget before
  // saving — an identical copy would violate unique_template_mapping.
  const handleCopyClick = React.useCallback(
    (id: string) => {
      router.push(`/admin/template-field-mappings/new?copyFrom=${id}`);
    },
    [router]
  );

  // --- Column 定義 ---
  const columns = React.useMemo<DataTableColumn<TemplateFieldMappingSummary>[]>(
    () => [
      {
        id: 'name',
        header: t('table.name'),
        cell: (mapping) => (
          <Link
            href={`/admin/template-field-mappings/${mapping.id}`}
            className="font-medium hover:underline"
          >
            {mapping.name}
          </Link>
        ),
      },
      {
        id: 'template',
        header: t('table.template'),
        cellClassName: 'text-muted-foreground',
        cell: (mapping) => mapping.dataTemplateName,
      },
      {
        id: 'scope',
        header: t('table.scope'),
        cell: (mapping) => <ScopeBadge scope={mapping.scope} />,
      },
      {
        id: 'target',
        header: t('table.target'),
        cellClassName: 'text-muted-foreground',
        cell: (mapping) => {
          if (mapping.scope === 'COMPANY' && mapping.companyName) {
            return mapping.companyName;
          }
          if (mapping.scope === 'FORMAT' && mapping.documentFormatName) {
            return mapping.documentFormatName;
          }
          return '-';
        },
      },
      {
        id: 'ruleCount',
        header: t('table.ruleCount'),
        headerClassName: 'text-center',
        cellClassName: 'text-center',
        cell: (mapping) => mapping.ruleCount,
      },
      {
        id: 'priority',
        header: t('table.priority'),
        headerClassName: 'text-center',
        cellClassName: 'text-center',
        cell: (mapping) => mapping.priority,
      },
      {
        id: 'status',
        header: t('table.status'),
        headerClassName: 'text-center',
        cellClassName: 'text-center',
        cell: (mapping) => <StatusBadge isActive={mapping.isActive} />,
      },
      {
        id: 'actions',
        header: t('table.actions'),
        headerClassName: 'text-right',
        cellClassName: 'text-right',
        cell: (mapping) => (
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleEditClick(mapping.id)}
            >
              <Edit className="h-4 w-4" />
              <span className="sr-only">{t('actions.edit')}</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleCopyClick(mapping.id)}
            >
              <Copy className="h-4 w-4" />
              <span className="sr-only">{t('actions.copy')}</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDeleteId(mapping.id)}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
              <span className="sr-only">{t('actions.delete')}</span>
            </Button>
          </div>
        ),
      },
    ],
    [t, handleEditClick, handleCopyClick]
  );

  // Render
  if (isLoading) {
    return <LoadingSkeleton />;
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-destructive">{t('list.error')}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {error?.message || t('list.unknownError')}
        </p>
        <Button onClick={() => refetch()} variant="outline" className="mt-4">
          <RefreshCcw className="mr-2 h-4 w-4" />
          {t('actions.retry')}
        </Button>
      </div>
    );
  }

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>{t('list.title')}</CardTitle>
            <CardDescription>
              {t('list.total', { count: total })}
            </CardDescription>
          </div>
          <Button onClick={handleCreateClick}>
            <Plus className="mr-2 h-4 w-4" />
            {t('actions.create')}
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {/* Filters */}
        <div className="mb-6 flex flex-wrap items-center gap-4">
          <div className="flex flex-1 items-center gap-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={t('filters.searchPlaceholder')}
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="pl-10"
              />
            </div>
            <Button variant="secondary" onClick={handleSearch}>
              {t('filters.search')}
            </Button>
          </div>

          <Select value={filters.scope} onValueChange={handleScopeChange}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder={t('filters.scope')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('filters.allScopes')}</SelectItem>
              {SCOPE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(`scope.${option.value.toLowerCase()}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        {mappings.length === 0 ? (
          <EmptyState onCreateClick={handleCreateClick} />
        ) : (
          <>
            <div className="rounded-md border">
              <DataTable
                data={mappings}
                columns={columns}
                getRowId={(mapping) => mapping.id}
                page={filters.page}
                pageSize={filters.limit}
              />
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {t('pagination.showing', {
                    start: (filters.page - 1) * filters.limit + 1,
                    end: Math.min(filters.page * filters.limit, total),
                    total,
                  })}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePageChange(filters.page - 1)}
                    disabled={filters.page === 1}
                  >
                    {t('pagination.previous')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePageChange(filters.page + 1)}
                    disabled={filters.page >= totalPages}
                  >
                    {t('pagination.next')}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deleteDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('deleteDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? t('deleteDialog.deleting') : t('deleteDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
