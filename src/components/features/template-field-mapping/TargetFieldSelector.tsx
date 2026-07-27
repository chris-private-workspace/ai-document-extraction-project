/**
 * @fileoverview 目標欄位選擇器組件
 * @description
 *   用於選擇模版欄位作為映射的目標欄位
 *   從 DataTemplate 的欄位定義中載入
 *
 * @module src/components/features/template-field-mapping
 * @since Epic 19 - Story 19.4
 * @lastModified 2026-01-22
 */

'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronsUpDown, Search, AlertCircle } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';

// ============================================================================
// Types
// ============================================================================

/**
 * 模版欄位定義
 */
export interface TemplateField {
  name: string;
  label: string;
  type: string;
  isRequired: boolean;
}

interface TargetFieldSelectorProps {
  value: string;
  onChange: (value: string) => void;
  templateFields: TemplateField[];
  usedFields?: string[];
  disabled?: boolean;
  isLoading?: boolean;
  className?: string;
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * @component TargetFieldSelector
 * @description 模版欄位選擇器，用於選擇映射的目標欄位
 */
export function TargetFieldSelector({
  value,
  onChange,
  templateFields,
  usedFields = [],
  disabled = false,
  isLoading = false,
  className,
}: TargetFieldSelectorProps) {
  const t = useTranslations('templateFieldMapping');
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');

  // Filter fields by search
  const filteredFields = React.useMemo(() => {
    if (!search) {
      return templateFields;
    }

    const lowerSearch = search.toLowerCase();
    return templateFields.filter(
      (field) =>
        field.name.toLowerCase().includes(lowerSearch) ||
        field.label.toLowerCase().includes(lowerSearch)
    );
  }, [templateFields, search]);

  // Get selected field info
  const selectedField = React.useMemo(
    () => templateFields.find((f) => f.name === value),
    [templateFields, value]
  );

  // CHANGE-107: A non-empty value that matches no template field is surfaced
  // instead of silently falling back to the placeholder. This happens when a
  // copied rule keeps a targetField from the source configuration's template
  // and the user then picks a different data template — the stale value would
  // otherwise be invisible here while still being submitted.
  const hasInvalidValue = !!value && !selectedField;

  const handleSelect = React.useCallback(
    (fieldName: string) => {
      onChange(fieldName);
      setOpen(false);
      setSearch('');
    },
    [onChange]
  );

  if (isLoading) {
    return <Skeleton className="h-10 w-full" />;
  }

  if (templateFields.length === 0) {
    return (
      <div className={cn('flex items-center gap-2 text-muted-foreground', className)}>
        <AlertCircle className="h-4 w-4" />
        <span className="text-sm">{t('targetField.noTemplate')}</span>
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'w-full justify-between',
            hasInvalidValue && 'border-destructive text-destructive',
            className
          )}
        >
          {selectedField ? (
            <span className="truncate">
              {selectedField.label || selectedField.name}
            </span>
          ) : hasInvalidValue ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span className="truncate">{value}</span>
              <Badge variant="destructive" className="shrink-0 text-[10px] px-1 py-0">
                {t('targetField.invalidValue')}
              </Badge>
            </span>
          ) : (
            <span className="text-muted-foreground">
              {t('targetField.placeholder')}
            </span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[400px] p-0" align="start">
        <div className="border-b p-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t('targetField.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
        <ScrollArea className="h-[300px]">
          <div className="p-2 space-y-1">
            {filteredFields.map((field) => {
              const isUsed = usedFields.includes(field.name);
              const isSelected = value === field.name;

              return (
                <button
                  key={field.name}
                  type="button"
                  onClick={() => handleSelect(field.name)}
                  disabled={isUsed && !isSelected}
                  className={cn(
                    'flex w-full items-center justify-between rounded-md px-2 py-2 text-sm transition-colors',
                    'hover:bg-accent hover:text-accent-foreground',
                    isSelected && 'bg-accent text-accent-foreground',
                    isUsed && !isSelected && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  <div className="flex flex-col items-start">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">
                        {field.label || field.name}
                      </span>
                      {field.isRequired && (
                        <Badge variant="destructive" className="text-[10px] px-1 py-0">
                          {t('targetField.required')}
                        </Badge>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {field.name} ({field.type})
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {isUsed && !isSelected && (
                      <Badge variant="secondary" className="text-xs">
                        {t('targetField.alreadyMapped')}
                      </Badge>
                    )}
                    {isSelected && <Check className="h-4 w-4" />}
                  </div>
                </button>
              );
            })}
            {filteredFields.length === 0 && (
              <div className="py-6 text-center text-sm text-muted-foreground">
                {t('targetField.noResults')}
              </div>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

/**
 * @component TargetFieldDisplay
 * @description 顯示已選擇的目標欄位（唯讀）
 */
export function TargetFieldDisplay({
  value,
  templateFields,
}: {
  value: string;
  templateFields: TemplateField[];
}) {
  const field = React.useMemo(
    () => templateFields.find((f) => f.name === value),
    [templateFields, value]
  );

  if (!field) {
    return <span className="text-muted-foreground">{value}</span>;
  }

  return (
    <div className="flex flex-col">
      <span className="font-medium">{field.label || field.name}</span>
      <span className="text-xs text-muted-foreground">
        {field.name} ({field.type})
      </span>
    </div>
  );
}
