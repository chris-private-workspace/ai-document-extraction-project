'use client';

/**
 * @fileoverview 數據模版列表（表格檢視）
 * @description
 *   以共用 DataTable 呈現數據模版清單，作為卡片網格的替代檢視。
 *   欄位與操作邏輯與 DataTemplateCard 一致（範圍徽章、系統/停用標示、編輯/刪除）。
 *
 * @module src/components/features/data-template/DataTemplateTable
 * @since CHANGE-093
 * @lastModified 2026-06-26
 */

import * as React from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { MoreHorizontal, Pencil, Trash2, Globe, Building2, Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DataTable, type DataTableColumn } from '@/components/features/common/DataTable';
import { formatShortDate } from '@/lib/i18n-date';
import type { DataTemplateSummary } from '@/types/data-template';
import type { Locale } from '@/i18n/config';

// ============================================================
// Types
// ============================================================

export interface DataTemplateTableProps {
  /** 模版列表 */
  templates: DataTemplateSummary[];
  /** 編輯回調 */
  onEdit?: (id: string) => void;
  /** 刪除回調 */
  onDelete?: (id: string, name: string) => void;
}

// ============================================================
// Component
// ============================================================

/**
 * @component DataTemplateTable
 * @description 數據模版清單的表格檢視
 */
export function DataTemplateTable({ templates, onEdit, onDelete }: DataTemplateTableProps) {
  const t = useTranslations('dataTemplates');
  const locale = useLocale() as Locale;

  const columns = React.useMemo<DataTableColumn<DataTemplateSummary>[]>(
    () => [
      {
        id: 'name',
        header: t('table.columns.name'),
        cell: (row) => (
          <div className="flex items-center gap-2">
            <span className="font-medium">{row.name}</span>
            {row.scope === 'GLOBAL' ? (
              <Badge variant="secondary" className="gap-1">
                <Globe className="h-3 w-3" />
                {t('card.global')}
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1">
                <Building2 className="h-3 w-3" />
                {row.companyName || t('card.company')}
              </Badge>
            )}
            {row.isSystem && (
              <Badge variant="default" className="gap-1">
                <Lock className="h-3 w-3" />
                {t('card.system')}
              </Badge>
            )}
          </div>
        ),
      },
      {
        id: 'description',
        header: t('table.columns.description'),
        cell: (row) => (
          <span className="text-sm text-muted-foreground line-clamp-1">
            {row.description || '--'}
          </span>
        ),
      },
      {
        id: 'fieldCount',
        header: t('table.columns.fieldCount'),
        headerClassName: 'text-right',
        cellClassName: 'text-right tabular-nums',
        cell: (row) => row.fieldCount,
      },
      {
        id: 'usageCount',
        header: t('table.columns.usageCount'),
        headerClassName: 'text-right',
        cellClassName: 'text-right tabular-nums',
        cell: (row) => row.usageCount,
      },
      {
        id: 'status',
        header: t('table.columns.status'),
        cell: (row) =>
          row.isActive ? (
            <Badge variant="outline">{t('filters.active')}</Badge>
          ) : (
            <Badge variant="destructive">{t('card.inactive')}</Badge>
          ),
      },
      {
        id: 'updatedAt',
        header: t('table.columns.updatedAt'),
        cellClassName: 'text-sm text-muted-foreground whitespace-nowrap',
        cell: (row) => formatShortDate(row.updatedAt, locale),
      },
      {
        id: 'actions',
        header: <span className="sr-only">{t('table.columns.actions')}</span>,
        headerClassName: 'w-[60px]',
        cell: (row) => {
          const canDelete = !row.isSystem && row.usageCount === 0;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onEdit?.(row.id)}>
                  <Pencil className="h-4 w-4 mr-2" />
                  {row.isSystem ? t('card.viewDetails') : t('card.edit')}
                </DropdownMenuItem>
                {canDelete && (
                  <DropdownMenuItem
                    onClick={() => onDelete?.(row.id, row.name)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    {t('card.delete')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [t, locale, onEdit, onDelete]
  );

  return <DataTable data={templates} columns={columns} getRowId={(row) => row.id} />;
}
