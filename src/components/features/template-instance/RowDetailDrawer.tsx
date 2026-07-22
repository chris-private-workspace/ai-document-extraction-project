'use client';

/**
 * @fileoverview 行詳情抽屜組件
 * @description
 *   顯示數據行的完整詳情，包括：
 *   - 基本資訊（rowKey, rowIndex, status）
 *   - 來源文件列表
 *   - 所有欄位值
 *   - 驗證錯誤
 *
 * @module src/components/features/template-instance/RowDetailDrawer
 * @since Epic 19 - Story 19.5
 * @lastModified 2026-01-22
 */

import * as React from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link } from '@/i18n/routing';
import { ExternalLink, AlertCircle, AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useFieldLabel } from '@/hooks/use-field-label';
import { getRowStatusConfig } from './status-config';
import { formatShortDate, formatDateTime } from '@/lib/i18n-date';
import { formatNumber } from '@/lib/i18n-number';
import { formatCurrency } from '@/lib/i18n-currency';
import type { Locale } from '@/i18n/config';
import type { DataTemplateField } from '@/types/data-template';
import type { TemplateInstanceRow } from '@/types/template-instance';

// ============================================================================
// Types
// ============================================================================

interface RowDetailDrawerProps {
  row: TemplateInstanceRow;
  templateFields: DataTemplateField[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * 格式化欄位值用於顯示
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
// Component
// ============================================================================

/**
 * 行詳情抽屜組件
 */
export function RowDetailDrawer({
  row,
  templateFields,
  open,
  onOpenChange,
}: RowDetailDrawerProps) {
  const t = useTranslations('templateInstance');
  const locale = useLocale();

  const getFieldLabel = useFieldLabel();
  const statusConfig = getRowStatusConfig(row.status);
  const errors = row.validationErrors ?? {};
  const hasErrors = Object.keys(errors).length > 0;
  // FIX-128: 轉換診斷（targetField → 引用了不存在的來源 key 清單）
  const diagnostics = row.transformDiagnostics ?? {};
  const hasDiagnostics = Object.keys(diagnostics).length > 0;
  // CHANGE-106: 來源文件在本行產生後被重新處理 → 本行是舊快照
  const staleSources = row.staleSources ?? [];
  const isStale = staleSources.length > 0;

  // Sorted fields
  const sortedFields = React.useMemo(() => {
    return [...templateFields].sort((a, b) => a.order - b.order);
  }, [templateFields]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>{t('rowDetail.title')}</DialogTitle>
          <DialogDescription>
            {t('rows.columns.rowKey')}: {row.rowKey}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="h-[calc(90vh-160px)] mt-6">
          <div className="space-y-6 pr-4">
            {/* CHANGE-106: 來源已更新警示（本行欄位值為舊快照） */}
            {isStale && (
              <Alert className="border-amber-500/50 text-amber-700 dark:text-amber-500 [&>svg]:text-amber-600">
                <RefreshCw className="h-4 w-4" />
                <AlertDescription>
                  <p className="text-sm mb-2 font-medium">{t('rowDetail.staleSources.title')}</p>
                  <p className="text-sm mb-2">{t('rowDetail.staleSources.description')}</p>
                  <ul className="list-disc pl-4 space-y-1 text-sm">
                    {staleSources.map((doc) => (
                      <li key={doc.id}>
                        {doc.fileName} —{' '}
                        {t('rowDetail.staleSources.processedAt', {
                          date: formatDateTime(new Date(doc.processedAt), locale as Locale),
                        })}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {/* Basic Info */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{t('rowDetail.rowKey')}</span>
                <span className="font-medium">{row.rowKey}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{t('rowDetail.rowIndex')}</span>
                <span className="font-mono">{row.rowIndex + 1}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{t('rowDetail.status')}</span>
                <Badge variant={statusConfig.badgeVariant}>
                  <span className="mr-1">{statusConfig.icon}</span>
                  {t(`rowStatus.${row.status}`)}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{t('rowDetail.createdAt')}</span>
                <span className="text-sm">{formatDateTime(new Date(row.createdAt), locale as Locale)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{t('rowDetail.updatedAt')}</span>
                <span className="text-sm">{formatDateTime(new Date(row.updatedAt), locale as Locale)}</span>
              </div>
            </div>

            <Separator />

            {/* Source Documents（CHANGE-091 1.6: 顯示檔名，退化時顯示 id） */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium">{t('rowDetail.sourceDocuments')}</h4>
              {(row.sourceDocuments && row.sourceDocuments.length > 0) ||
              row.sourceDocumentIds.length > 0 ? (
                <ul className="space-y-2">
                  {(
                    row.sourceDocuments ??
                    row.sourceDocumentIds.map((id) => ({ id, fileName: id }))
                  ).map((doc) => (
                    <li key={doc.id}>
                      <Button variant="link" size="sm" asChild className="h-auto p-0">
                        <Link href={`/documents/${doc.id}`}>
                          <ExternalLink className="mr-1 h-3 w-3" />
                          {doc.fileName}
                        </Link>
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t('rowDetail.noSourceDocuments')}</p>
              )}
            </div>

            <Separator />

            {/* Validation Errors */}
            {hasErrors && (
              <>
                <div className="space-y-3">
                  <h4 className="text-sm font-medium">{t('rowDetail.validationErrors')}</h4>
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      <ul className="list-disc pl-4 space-y-1 text-sm">
                        {Object.entries(errors).map(([fieldName, error]) => {
                          const field = templateFields.find((f) => f.name === fieldName);
                          return (
                            <li key={fieldName}>
                              <strong>{field ? getFieldLabel(field) : fieldName}:</strong> {error}
                            </li>
                          );
                        })}
                      </ul>
                    </AlertDescription>
                  </Alert>
                </div>
                <Separator />
              </>
            )}

            {!hasErrors && row.status === 'VALID' && (
              <>
                <Alert>
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  <AlertDescription className="text-green-600">
                    {t('rowDetail.noErrors')}
                  </AlertDescription>
                </Alert>
                <Separator />
              </>
            )}

            {/* Transform Diagnostics（FIX-128：公式引用了不存在的來源 key） */}
            {hasDiagnostics && (
              <>
                <div className="space-y-3">
                  <h4 className="text-sm font-medium">
                    {t('rowDetail.transformDiagnostics.title')}
                  </h4>
                  <Alert className="border-amber-500/50 text-amber-700 dark:text-amber-500 [&>svg]:text-amber-600">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                      <p className="text-sm mb-2">
                        {t('rowDetail.transformDiagnostics.description')}
                      </p>
                      <ul className="list-disc pl-4 space-y-1 text-sm">
                        {Object.entries(diagnostics).map(([targetField, keys]) => {
                          const field = templateFields.find((f) => f.name === targetField);
                          return (
                            <li key={targetField}>
                              <strong>{field ? getFieldLabel(field) : targetField}:</strong>{' '}
                              {t('rowDetail.transformDiagnostics.unknownKeys', {
                                keys: keys.join(', '),
                              })}
                            </li>
                          );
                        })}
                      </ul>
                    </AlertDescription>
                  </Alert>
                </div>
                <Separator />
              </>
            )}

            {/* Field Values */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium">{t('rowDetail.fieldValues')}</h4>
              <div className="space-y-3">
                {sortedFields.map((field) => {
                  const value = row.fieldValues[field.name];
                  const fieldError = errors[field.name];

                  return (
                    <div
                      key={field.name}
                      className={`flex items-start justify-between gap-4 p-2 rounded ${
                        fieldError ? 'bg-red-50' : ''
                      }`}
                    >
                      <div>
                        <span className="text-sm text-muted-foreground">{getFieldLabel(field)}</span>
                        {fieldError && (
                          <p className="text-xs text-red-500 mt-0.5">{fieldError}</p>
                        )}
                      </div>
                      <span
                        className={`text-sm font-medium text-right ${
                          fieldError ? 'text-red-600' : ''
                        }`}
                      >
                        {formatFieldValue(value, field.dataType, locale as Locale)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
