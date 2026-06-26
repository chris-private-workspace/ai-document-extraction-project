/**
 * @fileoverview 數據模版管理列表頁（國際化版本）
 * @description
 *   數據模版的管理介面入口：
 *   - 顯示所有模版（網格列表）
 *   - 支援篩選（範圍、狀態、類型、搜尋）
 *   - 提供新增、編輯、刪除功能
 *   - i18n 國際化支援 (Epic 17)
 *
 * @module src/app/(dashboard)/admin/data-templates
 * @since Epic 16 - Story 16.7
 * @lastModified 2026-01-20
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus, RefreshCw, AlertCircle, FileCode } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { useToast } from '@/hooks/use-toast';
import {
  DataTemplateList,
  DataTemplateFilters,
} from '@/components/features/data-template';
import { ViewToggle } from '@/components/features/common/ViewToggle';
import {
  useDataTemplates,
  useDeleteDataTemplate,
} from '@/hooks/use-data-templates';
import { useViewMode } from '@/hooks/use-view-mode';
import type { DataTemplateFilters as Filters } from '@/types/data-template';

// ============================================================================
// Page Component
// ============================================================================

export default function DataTemplatesPage() {
  const router = useRouter();
  const { toast } = useToast();
  const t = useTranslations('dataTemplates');

  // --- State ---
  const [filters, setFilters] = React.useState<Filters>({});
  const [page, setPage] = React.useState(1);
  const [viewMode, setViewMode] = useViewMode('dataTemplates.viewMode');
  const [deleteTarget, setDeleteTarget] = React.useState<{
    id: string;
    name: string;
  } | null>(null);

  // --- Queries ---
  const {
    data: templatesData,
    isLoading,
    error,
    refetch,
  } = useDataTemplates(filters, page, 20);

  const deleteMutation = useDeleteDataTemplate();

  // --- Derived State ---
  const templates = templatesData?.templates ?? [];
  const totalCount = templatesData?.pagination?.total ?? 0;

  // --- Handlers ---

  const handleCreateNew = React.useCallback(() => {
    router.push('/admin/data-templates/new');
  }, [router]);

  const handleEdit = React.useCallback(
    (id: string) => {
      router.push(`/admin/data-templates/${id}`);
    },
    [router]
  );

  const handleDeleteRequest = React.useCallback(
    (id: string, name: string) => {
      setDeleteTarget({ id, name });
    },
    []
  );

  const handleDeleteConfirm = React.useCallback(async () => {
    if (!deleteTarget) return;

    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      toast({
        title: t('toast.deleteSuccess'),
        description: t('toast.deleteSuccessDesc', { name: deleteTarget.name }),
      });
      setDeleteTarget(null);
    } catch (err) {
      toast({
        variant: 'destructive',
        title: t('toast.deleteFailed'),
        description: err instanceof Error ? err.message : t('page.unknownError'),
      });
    }
  }, [deleteTarget, deleteMutation, toast, t]);

  const handleRefresh = React.useCallback(() => {
    refetch();
  }, [refetch]);

  const handleFiltersChange = React.useCallback((newFilters: Filters) => {
    setFilters(newFilters);
    setPage(1);
  }, []);

  // --- Render ---
  return (
    <div className="container mx-auto py-6 space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FileCode className="h-6 w-6" />
            {t('page.title')}
          </h1>
          <p className="text-muted-foreground">
            {t('page.description')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleRefresh} variant="outline">
            <RefreshCw className="h-4 w-4 mr-2" />
            {t('page.refresh')}
          </Button>
          <Button onClick={handleCreateNew}>
            <Plus className="h-4 w-4 mr-2" />
            {t('page.create')}
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-lg">{t('page.filters')}</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTemplateFilters
            filters={filters}
            onFiltersChange={handleFiltersChange}
          />
        </CardContent>
      </Card>

      {/* Error Alert */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {t('page.loadError')}
            {error instanceof Error ? error.message : t('page.unknownError')}
          </AlertDescription>
        </Alert>
      )}

      {/* Summary + View Toggle */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          {t('page.templateCount', { count: totalCount })}
        </div>
        <ViewToggle value={viewMode} onChange={setViewMode} />
      </div>

      {/* Template List */}
      <DataTemplateList
        templates={templates}
        isLoading={isLoading}
        error={error ?? undefined}
        onEdit={handleEdit}
        onDelete={handleDeleteRequest}
        viewMode={viewMode}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deleteDialog.description', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('deleteDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? t('deleteDialog.deleting') : t('deleteDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
