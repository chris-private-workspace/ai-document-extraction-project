'use client';

/**
 * @fileoverview 實例數據行表格組件
 * @description
 *   顯示模版實例的數據行列表，支援：
 *   - 動態列生成（根據 DataTemplate.fields）
 *   - 錯誤高亮
 *   - 篩選和分頁
 *   - 批量操作
 *
 * @module src/components/features/template-instance/InstanceRowsTable
 * @since Epic 19 - Story 19.5
 * @lastModified 2026-01-22
 */

import * as React from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Search, AlertCircle, Eye, Edit, Trash2, MoreHorizontal, RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import { RowEditDialog } from './RowEditDialog';
import { RowDetailDrawer } from './RowDetailDrawer';
import { BulkActionsMenu } from './BulkActionsMenu';
import { getRowStatusConfig } from './status-config';
import { useTemplateInstanceRows } from '@/hooks/use-template-instances';
import { useFieldLabel } from '@/hooks/use-field-label';
import { formatShortDate } from '@/lib/i18n-date';
import { formatNumber } from '@/lib/i18n-number';
import { formatCurrency } from '@/lib/i18n-currency';
import type { Locale } from '@/i18n/config';
import type { DataTemplateField } from '@/types/data-template';
import type { TemplateInstanceRow, TemplateInstanceRowStatus } from '@/types/template-instance';

// ============================================================================
// Types
// ============================================================================

interface InstanceRowsTableProps {
  instanceId: string;
  templateFields: DataTemplateField[];
  className?: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * 格式化欄位值
 */
function formatFieldValue(
  value: unknown,
  dataType: DataTemplateField['dataType'],
  locale: Locale
): string {
  if (value === undefined || value === null || value === '') {
    return '-';
  }

  switch (dataType) {
    case 'number':
      return formatNumber(Number(value), locale);
    case 'currency':
      return formatCurrency(Number(value), 'USD', locale);
    case 'date':
      return formatShortDate(new Date(String(value)), locale);
    case 'boolean':
      return value ? '✓' : '✗';
    case 'array':
      return Array.isArray(value) ? value.join(', ') : String(value);
    default:
      return String(value);
  }
}

// ============================================================================
// Sub Components
// ============================================================================

function TableSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <Skeleton className="h-9 w-[200px]" />
        <Skeleton className="h-9 w-[140px]" />
      </div>
      <Skeleton className="h-[400px] w-full rounded-lg" />
    </div>
  );
}

function EmptyState({ t }: { t: (key: string) => string }) {
  return (
    <TableRow>
      <TableCell colSpan={100} className="h-32 text-center">
        <p className="text-muted-foreground">{t('rows.empty.title')}</p>
        <p className="text-sm text-muted-foreground">{t('rows.empty.description')}</p>
      </TableCell>
    </TableRow>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * 實例數據行表格組件
 */
export function InstanceRowsTable({
  instanceId,
  templateFields,
  className,
}: InstanceRowsTableProps) {
  const t = useTranslations('templateInstance');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const getFieldLabel = useFieldLabel();

  // --- State ---
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<TemplateInstanceRowStatus | null>(null);
  const [page, setPage] = React.useState(1);
  const [selectedRows, setSelectedRows] = React.useState<Set<string>>(new Set());
  const [editingRowId, setEditingRowId] = React.useState<string | null>(null);
  const [viewingRowId, setViewingRowId] = React.useState<string | null>(null);

  // --- Data fetching ---
  const { data, isLoading, refetch } = useTemplateInstanceRows(instanceId, {
    status: statusFilter ?? undefined,
    search: search || undefined,
    page,
    limit: 20,
  });

  const rows = data?.rows ?? [];
  const pagination = data?.pagination;

  // Visible template fields (sorted by order)
  const sortedFields = React.useMemo(() => {
    return [...templateFields].sort((a, b) => a.order - b.order);
  }, [templateFields]);

  // --- Handlers ---
  const handleSelectAll = React.useCallback(
    (checked: boolean) => {
      if (checked) {
        setSelectedRows(new Set(rows.map((r) => r.id)));
      } else {
        setSelectedRows(new Set());
      }
    },
    [rows]
  );

  const handleSelectRow = React.useCallback((rowId: string, checked: boolean) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(rowId);
      } else {
        next.delete(rowId);
      }
      return next;
    });
  }, []);

  const handleBulkActionComplete = React.useCallback(() => {
    setSelectedRows(new Set());
    refetch();
  }, [refetch]);

  // Find editing/viewing row
  const editingRow = React.useMemo(() => {
    return rows.find((r) => r.id === editingRowId) ?? null;
  }, [rows, editingRowId]);

  const viewingRow = React.useMemo(() => {
    return rows.find((r) => r.id === viewingRowId) ?? null;
  }, [rows, viewingRowId]);

  // --- Loading state ---
  if (isLoading) {
    return <TableSkeleton />;
  }

  const isAllSelected = rows.length > 0 && selectedRows.size === rows.length;
  const isSomeSelected = selectedRows.size > 0;

  return (
    <div className={`space-y-4 ${className ?? ''}`}>
      {/* Filters and Bulk Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative w-[200px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('rows.filters.searchPlaceholder')}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="pl-8"
            />
          </div>

          {/* Status filter */}
          <Select
            value={statusFilter ?? '__all__'}
            onValueChange={(v) => {
              setStatusFilter(v === '__all__' ? null : (v as TemplateInstanceRowStatus));
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder={t('rows.filters.allStatuses')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t('rows.filters.allStatuses')}</SelectItem>
              <SelectItem value="VALID">{t('rowStatus.VALID')}</SelectItem>
              <SelectItem value="INVALID">{t('rows.filters.onlyErrors')}</SelectItem>
              <SelectItem value="PENDING">{t('rowStatus.PENDING')}</SelectItem>
              <SelectItem value="SKIPPED">{t('rowStatus.SKIPPED')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Bulk actions */}
        {isSomeSelected && (
          <BulkActionsMenu
            instanceId={instanceId}
            selectedIds={Array.from(selectedRows)}
            onComplete={handleBulkActionComplete}
          />
        )}
      </div>

      {/* Table */}
      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {/* Checkbox column */}
              <TableHead className="w-[40px]">
                <Checkbox
                  checked={isAllSelected}
                  onCheckedChange={handleSelectAll}
                  aria-label="Select all"
                />
              </TableHead>
              {/* Fixed columns */}
              <TableHead className="w-[60px]">{t('rows.columns.index')}</TableHead>
              <TableHead className="w-[120px]">{t('rows.columns.rowKey')}</TableHead>
              {/* Dynamic columns from template fields */}
              {sortedFields.map((field) => (
                <TableHead key={field.name} className="min-w-[120px] whitespace-nowrap">
                  {getFieldLabel(field)}
                </TableHead>
              ))}
              {/* CHANGE-091 1.6: 來源文件欄 */}
              <TableHead className="min-w-[140px]">{t('rows.columns.sourceDocuments')}</TableHead>
              {/* Status column */}
              <TableHead className="w-[100px]">{t('rows.columns.status')}</TableHead>
              {/* Actions column */}
              <TableHead className="w-[80px]">{t('rows.columns.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <EmptyState t={t} />
            ) : (
              rows.map((row) => {
                const statusConfig = getRowStatusConfig(row.status);
                const errors = row.validationErrors ?? {};
                const hasErrors = Object.keys(errors).length > 0;

                return (
                  <TableRow
                    key={row.id}
                    className={hasErrors ? 'bg-red-50 hover:bg-red-100' : ''}
                  >
                    {/* Checkbox */}
                    <TableCell>
                      <Checkbox
                        checked={selectedRows.has(row.id)}
                        onCheckedChange={(checked) =>
                          handleSelectRow(row.id, checked as boolean)
                        }
                        aria-label={`Select row ${row.rowKey}`}
                      />
                    </TableCell>
                    {/* Index */}
                    <TableCell className="font-mono text-sm">{row.rowIndex + 1}</TableCell>
                    {/* Row Key */}
                    <TableCell className="font-medium">{row.rowKey}</TableCell>
                    {/* Dynamic field values */}
                    {sortedFields.map((field) => {
                      const value = row.fieldValues[field.name];
                      const fieldError = errors[field.name];

                      return (
                        <TableCell key={field.name}>
                          <div className="flex items-center gap-1">
                            <span className={fieldError ? 'text-red-600' : ''}>
                              {formatFieldValue(value, field.dataType, locale as Locale)}
                            </span>
                            {fieldError && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger>
                                    <AlertCircle className="h-4 w-4 text-red-500" />
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>{fieldError}</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                          </div>
                        </TableCell>
                      );
                    })}
                    {/* CHANGE-091 1.6: 來源文件 */}
                    <TableCell>
                      <div className="flex max-w-[200px] flex-col gap-0.5">
                        {/* CHANGE-106: 來源文件在本行產生後被重新處理 → 舊快照標記 */}
                        {row.staleSources && row.staleSources.length > 0 && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge
                                  variant="outline"
                                  className="w-fit border-amber-500/60 bg-amber-50 text-amber-700"
                                >
                                  <RefreshCw className="mr-1 h-3 w-3" />
                                  {t('rows.staleBadge')}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>{t('rows.staleTooltip', { count: row.staleSources.length })}</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                        {row.sourceDocuments && row.sourceDocuments.length > 0 ? (
                          row.sourceDocuments.map((doc) => (
                            <a
                              key={doc.id}
                              href={`/documents/${doc.id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="truncate text-xs text-primary hover:underline"
                              title={doc.fileName}
                            >
                              {doc.fileName}
                            </a>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </div>
                    </TableCell>
                    {/* Status */}
                    <TableCell>
                      <Badge variant={statusConfig.badgeVariant}>
                        <span className="mr-1">{statusConfig.icon}</span>
                        {t(`rowStatus.${row.status}`)}
                      </Badge>
                    </TableCell>
                    {/* Actions */}
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                            <span className="sr-only">Actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setViewingRowId(row.id)}>
                            <Eye className="mr-2 h-4 w-4" />
                            {t('rowActions.view')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setEditingRowId(row.id)}>
                            <Edit className="mr-2 h-4 w-4" />
                            {t('rowActions.edit')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive focus:text-destructive">
                            <Trash2 className="mr-2 h-4 w-4" />
                            {t('rowActions.delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination info */}
      {pagination && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {t('rows.showing', {
              start: (pagination.page - 1) * pagination.limit + 1,
              end: Math.min(pagination.page * pagination.limit, pagination.total),
              total: pagination.total,
            })}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
            >
              {tCommon('pagination.previous')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pagination.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              {tCommon('pagination.next')}
            </Button>
          </div>
        </div>
      )}

      {/* Edit Dialog */}
      {editingRow && (
        <RowEditDialog
          instanceId={instanceId}
          row={editingRow}
          templateFields={templateFields}
          open={!!editingRowId}
          onOpenChange={(open) => !open && setEditingRowId(null)}
          onSuccess={() => {
            setEditingRowId(null);
            refetch();
          }}
        />
      )}

      {/* Detail Drawer */}
      {viewingRow && (
        <RowDetailDrawer
          row={viewingRow}
          templateFields={templateFields}
          open={!!viewingRowId}
          onOpenChange={(open) => !open && setViewingRowId(null)}
        />
      )}
    </div>
  );
}
