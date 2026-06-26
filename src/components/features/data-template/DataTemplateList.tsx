/**
 * @fileoverview 數據模版列表組件（國際化版本）
 * @description
 *   顯示數據模版的網格列表，支援載入狀態和空狀態
 *   - i18n 國際化支援 (Epic 17)
 *
 * @module src/components/features/data-template/DataTemplateList
 * @since Epic 16 - Story 16.7
 * @lastModified 2026-01-20
 */

'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { FileCode } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTemplateCard } from './DataTemplateCard';
import { DataTemplateTable } from './DataTemplateTable';
import type { DataTemplateSummary } from '@/types/data-template';
import type { ViewMode } from '@/hooks/use-view-mode';

// ============================================================================
// Types
// ============================================================================

export interface DataTemplateListProps {
  /** 模版列表 */
  templates: DataTemplateSummary[];
  /** 是否載入中 */
  isLoading?: boolean;
  /** 錯誤 */
  error?: Error;
  /** 編輯回調 */
  onEdit?: (id: string) => void;
  /** 刪除回調 */
  onDelete?: (id: string, name: string) => void;
  /** 檢視模式（卡片 / 列表，預設卡片） */
  viewMode?: ViewMode;
}

// ============================================================================
// Component
// ============================================================================

export function DataTemplateList({
  templates,
  isLoading,
  error,
  onEdit,
  onDelete,
  viewMode = 'card',
}: DataTemplateListProps) {
  const t = useTranslations('dataTemplates');

  // --- Loading State ---
  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[180px] w-full" />
        ))}
      </div>
    );
  }

  // --- Error State ---
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <FileCode className="h-12 w-12 text-destructive mb-4" />
        <h3 className="text-lg font-medium text-destructive">{t('list.loadFailed')}</h3>
        <p className="text-sm text-muted-foreground mt-1">
          {error.message || t('list.loadFailedDesc')}
        </p>
      </div>
    );
  }

  // --- Empty State ---
  if (templates.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <FileCode className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-medium">{t('list.empty')}</h3>
        <p className="text-sm text-muted-foreground mt-1">
          {t('list.emptyDesc')}
        </p>
      </div>
    );
  }

  // --- Template List (List View) ---
  if (viewMode === 'list') {
    return (
      <DataTemplateTable templates={templates} onEdit={onEdit} onDelete={onDelete} />
    );
  }

  // --- Template List (Card View) ---
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {templates.map((template) => (
        <DataTemplateCard
          key={template.id}
          template={template}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
