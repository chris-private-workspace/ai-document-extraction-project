/**
 * @fileoverview 公式編輯器組件
 * @description
 *   用於編輯 FORMULA 類型轉換的公式
 *   支援變數佔位符 {field_name} 和基本運算
 *
 * @module src/components/features/template-field-mapping
 * @since Epic 19 - Story 19.4
 * @lastModified 2026-01-22
 */

'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Plus, AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

import {
  getCommonStandardFields,
} from '@/constants/standard-fields';
// FIX-128: 動態合成欄位（li_* / _ref_*）豁免未知 key 判定
import { isSyntheticSourceKey } from '@/lib/template-mapping-source-keys';

// ============================================================================
// Types
// ============================================================================

interface FormulaEditorProps {
  value: string;
  onChange: (value: string) => void;
  availableFields?: string[];
  disabled?: boolean;
  error?: string;
  className?: string;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * 驗證公式語法
 */
function validateFormula(formula: string): { valid: boolean; error?: string } {
  if (!formula.trim()) {
    return { valid: false, error: '公式不能為空' };
  }

  // 檢查括號匹配
  let parenCount = 0;
  for (const char of formula) {
    if (char === '(') parenCount++;
    if (char === ')') parenCount--;
    if (parenCount < 0) {
      return { valid: false, error: '括號不匹配' };
    }
  }
  if (parenCount !== 0) {
    return { valid: false, error: '括號不匹配' };
  }

  // 檢查變數佔位符格式
  const varPattern = /\{([^}]+)\}/g;
  const vars = formula.match(varPattern);
  if (vars) {
    for (const v of vars) {
      const varName = v.slice(1, -1);
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varName)) {
        return { valid: false, error: `無效的變數名稱: ${varName}` };
      }
    }
  }

  // 檢查是否包含無效字符
  const cleanFormula = formula.replace(varPattern, '0'); // 替換變數為數字
  if (!/^[0-9\s\+\-\*\/\.\(\)]+$/.test(cleanFormula)) {
    return { valid: false, error: '公式包含無效字符' };
  }

  return { valid: true };
}

/**
 * 提取公式中的變數
 */
function extractVariables(formula: string): string[] {
  const varPattern = /\{([^}]+)\}/g;
  const matches = formula.match(varPattern);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(1, -1)))];
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * @component FormulaEditor
 * @description 公式編輯器
 */
export function FormulaEditor({
  value,
  onChange,
  availableFields,
  disabled = false,
  error: externalError,
  className,
}: FormulaEditorProps) {
  const t = useTranslations('templateFieldMapping');
  const [showFieldPicker, setShowFieldPicker] = React.useState(false);

  // Validation
  const validation = React.useMemo(() => validateFormula(value), [value]);
  const usedVariables = React.useMemo(() => extractVariables(value), [value]);

  // FIX-128: 標示不在已知欄位清單中的變數（拼錯 → 執行時被靜默視為 0）。
  // 無清單可對照時不判定（避免誤報）；li_* / _ref_* 為動態合成欄位一律豁免。
  const unknownVariables = React.useMemo(() => {
    if (!availableFields || availableFields.length === 0) return [];
    const known = new Set(availableFields);
    return usedVariables.filter((v) => !known.has(v) && !isSyntheticSourceKey(v));
  }, [usedVariables, availableFields]);

  // Common fields for quick insert
  const commonFields = React.useMemo(() => {
    if (availableFields) {
      return availableFields.slice(0, 10);
    }
    return getCommonStandardFields()
      .filter((f) => f.dataType === 'currency' || f.dataType === 'number')
      .map((f) => f.name)
      .slice(0, 10);
  }, [availableFields]);

  // Insert field at cursor position
  const handleInsertField = React.useCallback(
    (fieldName: string) => {
      onChange(`${value}{${fieldName}}`);
      setShowFieldPicker(false);
    },
    [value, onChange]
  );

  const displayError = externalError || (!validation.valid ? validation.error : undefined);

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium">{t('formula.label')}</Label>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-muted-foreground cursor-help">(?)</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="text-sm">
                {t('formula.help')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('formula.example')}: {'{sea_freight} + {terminal_handling}'}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <div className="relative">
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="{field_a} + {field_b} * 1.1"
          className={cn(
            'font-mono text-sm min-h-[80px]',
            displayError && 'border-destructive'
          )}
        />

        {/* Field Picker Button */}
        <Popover open={showFieldPicker} onOpenChange={setShowFieldPicker}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="absolute right-2 top-2"
              disabled={disabled}
            >
              <Plus className="h-3 w-3 mr-1" />
              {t('formula.insertField')}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[250px] p-2" align="end">
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {t('formula.quickInsert')}
              </p>
              <div className="flex flex-wrap gap-1">
                {commonFields.map((field) => (
                  <Button
                    key={field}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handleInsertField(field)}
                  >
                    {field}
                  </Button>
                ))}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {/* Validation Status */}
      <div className="flex items-center gap-2">
        {displayError ? (
          <>
            <AlertCircle className="h-4 w-4 text-destructive" />
            <span className="text-sm text-destructive">{displayError}</span>
          </>
        ) : value && validation.valid ? (
          <>
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <span className="text-sm text-green-600">
              {t('formula.valid')}
            </span>
          </>
        ) : null}
      </div>

      {/* Used Variables */}
      {usedVariables.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t('formula.usedVariables')}:
          </span>
          {usedVariables.map((v) => {
            const isUnknown = unknownVariables.includes(v);
            return (
              <Badge
                key={v}
                variant={isUnknown ? 'outline' : 'secondary'}
                className={cn(
                  'text-xs',
                  isUnknown && 'border-amber-500 text-amber-600 dark:text-amber-500'
                )}
              >
                {v}
              </Badge>
            );
          })}
        </div>
      )}

      {/* Unknown Variables Warning（FIX-128） */}
      {unknownVariables.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 p-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
          <p className="text-xs text-amber-700 dark:text-amber-500">
            {t('formula.unknownVariablesWarning', {
              variables: unknownVariables.join(', '),
            })}
          </p>
        </div>
      )}

      {/* Operator Reference */}
      <div className="rounded-md bg-muted/50 p-2">
        <p className="text-xs text-muted-foreground mb-1">
          {t('formula.operators')}:
        </p>
        <div className="flex flex-wrap gap-2 text-xs">
          <code className="px-1 bg-muted rounded">+</code>
          <code className="px-1 bg-muted rounded">-</code>
          <code className="px-1 bg-muted rounded">*</code>
          <code className="px-1 bg-muted rounded">/</code>
          <code className="px-1 bg-muted rounded">( )</code>
        </div>
      </div>
    </div>
  );
}
