'use client';

/**
 * @fileoverview 模版實例列表（表格檢視）
 * @description
 *   以共用 DataTable 呈現模版實例清單，作為卡片網格的替代檢視。
 *   欄位與操作邏輯與 TemplateInstanceCard 一致（狀態徽章、行數統計、查看 / 刪除）。
 *
 * @module src/components/features/template-instance/TemplateInstanceTable
 * @since CHANGE-093
 * @lastModified 2026-06-26
 */

import * as React from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link } from '@/i18n/routing';
import { Eye, Trash2, MoreHorizontal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DataTable, type DataTableColumn } from '@/components/features/common/DataTable';
import { getInstanceStatusConfig } from './status-config';
import { formatRelativeTime } from '@/lib/i18n-date';
import type { Locale } from '@/i18n/config';
import type { TemplateInstanceSummary } from '@/types/template-instance';

// ============================================================
// Types
// ============================================================

export interface TemplateInstanceTableProps {
  /** 實例列表 */
  instances: TemplateInstanceSummary[];
  /** 刪除回調 */
  onDelete?: (id: string) => void;
  /** 當前頁碼（1-based，供序號跨頁連續） */
  page?: number;
  /** 每頁筆數（供序號跨頁連續） */
  pageSize?: number;
}

// ============================================================
// Component
// ============================================================

/**
 * @component TemplateInstanceTable
 * @description 模版實例清單的表格檢視
 */
export function TemplateInstanceTable({
  instances,
  onDelete,
  page,
  pageSize,
}: TemplateInstanceTableProps) {
  const t = useTranslations('templateInstance');
  const locale = useLocale() as Locale;

  const columns = React.useMemo<DataTableColumn<TemplateInstanceSummary>[]>(
    () => [
      {
        id: 'name',
        header: t('table.columns.name'),
        cell: (row) => <span className="font-medium">{row.name}</span>,
      },
      {
        id: 'template',
        header: t('table.columns.template'),
        cell: (row) => (
          <span className="text-sm text-muted-foreground">{row.dataTemplateName}</span>
        ),
      },
      {
        id: 'status',
        header: t('table.columns.status'),
        cell: (row) => {
          const cfg = getInstanceStatusConfig(row.status);
          return (
            <Badge variant={cfg.badgeVariant}>
              <span className="mr-1">{cfg.icon}</span>
              {t(`status.${row.status}`)}
            </Badge>
          );
        },
      },
      {
        id: 'rows',
        header: t('table.columns.rows'),
        cell: (row) => (
          <div className="flex items-center gap-2 text-sm whitespace-nowrap">
            <span className="text-muted-foreground">{t('card.rows', { count: row.rowCount })}</span>
            {row.validRowCount > 0 && (
              <span className="text-green-600">
                {t('card.validRows', { count: row.validRowCount })}
              </span>
            )}
            {row.errorRowCount > 0 && (
              <span className="text-red-500">
                {t('card.errorRows', { count: row.errorRowCount })}
              </span>
            )}
          </div>
        ),
      },
      {
        id: 'updatedAt',
        header: t('table.columns.updatedAt'),
        cellClassName: 'text-sm text-muted-foreground whitespace-nowrap',
        cell: (row) =>
          row.exportedAt
            ? t('card.exportedAt', {
                date: formatRelativeTime(new Date(row.exportedAt), locale),
              })
            : t('card.updatedAt', {
                date: formatRelativeTime(new Date(row.updatedAt), locale),
              }),
      },
      {
        id: 'actions',
        header: <span className="sr-only">{t('table.columns.actions')}</span>,
        headerClassName: 'w-[140px]',
        cell: (row) => (
          <div className="flex items-center justify-end gap-1">
            <Button variant="outline" size="sm" asChild>
              <Link href={`/template-instances/${row.id}`}>
                <Eye className="mr-1 h-4 w-4" />
                {t('card.viewDetails')}
              </Link>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">{t('table.columns.actions')}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link href={`/template-instances/${row.id}`}>
                    <Eye className="mr-2 h-4 w-4" />
                    {t('card.viewDetails')}
                  </Link>
                </DropdownMenuItem>
                {row.status === 'DRAFT' && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => onDelete?.(row.id)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {t('rowActions.delete')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [t, locale, onDelete]
  );

  return (
    <DataTable
      data={instances}
      columns={columns}
      getRowId={(row) => row.id}
      page={page}
      pageSize={pageSize}
    />
  );
}
