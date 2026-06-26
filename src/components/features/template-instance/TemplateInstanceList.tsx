'use client';

/**
 * @fileoverview 模版實例列表組件
 * @description
 *   顯示模版實例列表，整合篩選、搜尋和分頁功能
 *
 * @module src/components/features/template-instance/TemplateInstanceList
 * @since Epic 19 - Story 19.5
 * @lastModified 2026-01-22
 */

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { FileStack, RefreshCw, AlertCircle } from 'lucide-react';
import { TemplateInstanceCard } from './TemplateInstanceCard';
import { TemplateInstanceTable } from './TemplateInstanceTable';
import { TemplateInstanceFilters, type TemplateInstanceFiltersState } from './TemplateInstanceFilters';
import { CreateInstanceDialog } from './CreateInstanceDialog';
import { ViewToggle } from '@/components/features/common/ViewToggle';
import { useTemplateInstances, useDeleteTemplateInstance } from '@/hooks/use-template-instances';
import { useViewMode } from '@/hooks/use-view-mode';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
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
import { toast } from 'sonner';

// ============================================================================
// Types
// ============================================================================

interface TemplateInstanceListProps {
  className?: string;
}

// ============================================================================
// Sub Components
// ============================================================================

function ListSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <Skeleton className="h-9 w-[200px]" />
        <Skeleton className="h-9 w-[160px]" />
        <Skeleton className="h-9 w-[180px]" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[180px] rounded-lg" />
        ))}
      </div>
    </div>
  );
}

function ListEmpty({
  onSuccess,
  t,
}: {
  onSuccess?: () => void;
  t: (key: string) => string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="rounded-full bg-muted p-4 mb-4">
        <FileStack className="h-8 w-8 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-medium mb-2">{t('list.emptyTitle')}</h3>
      <p className="text-sm text-muted-foreground max-w-md mb-4">
        {t('list.emptyDescription')}
      </p>
      <CreateInstanceDialog onSuccess={onSuccess} triggerVariant="default" />
    </div>
  );
}

function ListError({
  error,
  onRetry,
  t,
}: {
  error: Error;
  onRetry: () => void;
  t: (key: string) => string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="rounded-full bg-destructive/10 p-4 mb-4">
        <AlertCircle className="h-8 w-8 text-destructive" />
      </div>
      <h3 className="text-lg font-medium mb-2">{t('list.errorTitle')}</h3>
      <p className="text-sm text-muted-foreground mb-4 max-w-md">
        {error.message || t('list.errorDescription')}
      </p>
      <Button variant="outline" onClick={onRetry}>
        <RefreshCw className="mr-2 h-4 w-4" />
        {t('list.retry')}
      </Button>
    </div>
  );
}

function ListNoResults({
  onReset,
  t,
}: {
  onReset: () => void;
  t: (key: string) => string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="rounded-full bg-muted p-4 mb-4">
        <FileStack className="h-8 w-8 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-medium mb-2">{t('list.noResultsTitle')}</h3>
      <p className="text-sm text-muted-foreground mb-4">{t('list.noResultsDescription')}</p>
      <Button variant="outline" onClick={onReset}>
        {t('list.clearFilters')}
      </Button>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * 模版實例列表組件
 */
export function TemplateInstanceList({ className }: TemplateInstanceListProps) {
  const t = useTranslations('templateInstance');
  const tCommon = useTranslations('common');

  // --- State ---
  const [filters, setFilters] = React.useState<TemplateInstanceFiltersState>({
    status: null,
    dataTemplateId: null,
    search: '',
  });
  const [page, setPage] = React.useState(1);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const [viewMode, setViewMode] = useViewMode('templateInstances.viewMode');

  // --- Data fetching ---
  const {
    data,
    isLoading,
    error,
    refetch,
  } = useTemplateInstances({
    status: filters.status ?? undefined,
    dataTemplateId: filters.dataTemplateId ?? undefined,
    search: filters.search || undefined,
    page,
    limit: 12,
  });

  const deleteMutation = useDeleteTemplateInstance();

  const instances = data?.instances ?? [];
  const pagination = data?.pagination;

  // --- Handlers ---
  const handleFiltersChange = React.useCallback((newFilters: TemplateInstanceFiltersState) => {
    setFilters(newFilters);
    setPage(1); // Reset to first page when filters change
  }, []);

  const handleReset = React.useCallback(() => {
    setFilters({
      status: null,
      dataTemplateId: null,
      search: '',
    });
    setPage(1);
  }, []);

  const handleDelete = React.useCallback((id: string) => {
    setDeleteId(id);
  }, []);

  const confirmDelete = React.useCallback(() => {
    if (!deleteId) return;

    deleteMutation.mutate(deleteId, {
      onSuccess: () => {
        toast.success(t('toast.deleteSuccess'));
        setDeleteId(null);
      },
      onError: (error) => {
        toast.error(t('toast.deleteError'), {
          description: error.message,
        });
      },
    });
  }, [deleteId, deleteMutation, t]);

  // --- Loading state ---
  if (isLoading) {
    return <ListSkeleton />;
  }

  // --- Error state ---
  if (error) {
    return <ListError error={error} onRetry={refetch} t={t} />;
  }

  // --- Check if filters are active ---
  const hasFilters =
    filters.status !== null || filters.dataTemplateId !== null || filters.search !== '';

  // --- Empty state (no instances at all) ---
  if (!instances.length && !hasFilters) {
    return <ListEmpty onSuccess={() => refetch()} t={t} />;
  }

  // --- No results with filters ---
  if (!instances.length && hasFilters) {
    return (
      <div className={className}>
        <TemplateInstanceFilters value={filters} onChange={handleFiltersChange} className="mb-4" />
        <ListNoResults onReset={handleReset} t={t} />
      </div>
    );
  }

  // --- Normal display ---
  return (
    <div className={className}>
      {/* Filters */}
      <TemplateInstanceFilters value={filters} onChange={handleFiltersChange} className="mb-4" />

      {/* Stats, View Toggle and Create button */}
      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {t('list.totalInstances', { count: pagination?.total ?? 0 })}
        </span>
        <div className="flex items-center gap-2">
          <ViewToggle value={viewMode} onChange={setViewMode} />
          <CreateInstanceDialog onSuccess={() => refetch()} triggerVariant="outline" />
        </div>
      </div>

      {/* Instance list */}
      {viewMode === 'list' ? (
        <TemplateInstanceTable
          instances={instances}
          onDelete={handleDelete}
          page={page}
          pageSize={12}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {instances.map((instance) => (
            <TemplateInstanceCard
              key={instance.id}
              instance={instance}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 && (
        <div className="mt-6 flex justify-center">
          <Pagination
            currentPage={page}
            totalPages={pagination.totalPages}
            onPageChange={setPage}
          />
        </div>
      )}

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tCommon('dialog.confirmDelete')}</AlertDialogTitle>
            <AlertDialogDescription>{tCommon('dialog.deleteWarning')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? tCommon('actions.deleting') : tCommon('actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
