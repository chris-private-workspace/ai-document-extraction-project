'use client';

/**
 * @fileoverview 卡片 / 列表檢視切換按鈕組（共用）
 * @description
 *   受控的檢視模式切換元件，提供「卡片」與「列表」兩個圖示按鈕。
 *   與 use-view-mode Hook 搭配使用，列表頁工具列共用。
 *
 * @module src/components/features/common/ViewToggle
 * @since CHANGE-093
 * @lastModified 2026-06-26
 */

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { LayoutGrid, List } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ViewMode } from '@/hooks/use-view-mode';

// ============================================================
// Types
// ============================================================

interface ViewToggleProps {
  /** 當前檢視模式 */
  value: ViewMode;
  /** 切換回調 */
  onChange: (mode: ViewMode) => void;
  /** 額外 className */
  className?: string;
}

// ============================================================
// Component
// ============================================================

/**
 * @component ViewToggle
 * @description 卡片 / 列表檢視切換（受控）
 */
export function ViewToggle({ value, onChange, className }: ViewToggleProps) {
  const t = useTranslations('common');

  return (
    <div className={cn('inline-flex items-center rounded-md border p-0.5', className)}>
      <Button
        type="button"
        variant={value === 'card' ? 'secondary' : 'ghost'}
        size="icon"
        className="h-8 w-8"
        aria-label={t('viewToggle.card')}
        aria-pressed={value === 'card'}
        onClick={() => onChange('card')}
      >
        <LayoutGrid className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant={value === 'list' ? 'secondary' : 'ghost'}
        size="icon"
        className="h-8 w-8"
        aria-label={t('viewToggle.list')}
        aria-pressed={value === 'list'}
        onClick={() => onChange('list')}
      >
        <List className="h-4 w-4" />
      </Button>
    </div>
  );
}
