/**
 * @fileoverview 數據模版表單組件（國際化版本）
 * @description
 *   提供數據模版的創建和編輯功能
 *   - i18n 國際化支援 (Epic 17)
 *
 * @module src/components/features/data-template/DataTemplateForm
 * @since Epic 16 - Story 16.7
 * @lastModified 2026-01-20
 *
 * @features
 *   - 創建/編輯模式
 *   - 表單驗證
 *   - 欄位編輯器整合
 *   - 公司選擇（COMPANY 範圍時）
 */

'use client';

import * as React from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { Loader2, Save, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DataTemplateFieldEditor } from './DataTemplateFieldEditor';
import {
  createDataTemplateSchema,
  updateDataTemplateSchema,
} from '@/validations/data-template';
import type {
  DataTemplate,
  DataTemplateField,
  DataTemplateScope,
  LineItemMode,
} from '@/types/data-template';
import { DEFAULT_LINE_ITEM_MODE } from '@/types/data-template';

// ============================================================================
// Types
// ============================================================================

export interface DataTemplateFormProps {
  /** 編輯模式時的初始資料 */
  initialData?: DataTemplate;
  /** 是否為編輯模式 */
  isEditMode?: boolean;
  /** 是否唯讀（系統模版） */
  readOnly?: boolean;
  /** 是否提交中 */
  isSubmitting?: boolean;
  /** 提交回調 */
  onSubmit: (data: FormValues) => void | Promise<void>;
  /** 取消回調 */
  onCancel: () => void;
  /** 公司選項（COMPANY 範圍時使用） */
  companies?: Array<{ id: string; name: string }>;
}

interface FormValues {
  name: string;
  description?: string | null;
  scope: 'GLOBAL' | 'COMPANY';
  companyId?: string | null;
  fields: DataTemplateField[];
  lineItemMode?: LineItemMode;
  isActive?: boolean;
}

/**
 * 可選的分列模式
 *
 * @description
 *   `EXPAND`（1 筆費用 = 1 列）雖已納入型別與資料庫值域，但展開邏輯尚未實作
 *   （見 CHANGE-113 §階段二範圍），因此不列入選單 —— 避免使用者選了卻沒有作用。
 */
const LINE_ITEM_MODE_CHOICES: LineItemMode[] = ['PIVOT', 'GROUP'];

// ============================================================================
// Component
// ============================================================================

export function DataTemplateForm({
  initialData,
  isEditMode = false,
  readOnly = false,
  isSubmitting = false,
  onSubmit,
  onCancel,
  companies = [],
}: DataTemplateFormProps) {
  const t = useTranslations('dataTemplates');

  // --- Scope Options (i18n) ---
  const scopeOptions: Array<{ value: DataTemplateScope; label: string }> = [
    { value: 'GLOBAL', label: t('scopes.GLOBAL') },
    { value: 'COMPANY', label: t('scopes.COMPANY') },
  ];

  // --- Form Setup ---
  const schema = isEditMode ? updateDataTemplateSchema : createDataTemplateSchema;

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } = useForm<FormValues>({
    resolver: zodResolver(schema) as any,
    defaultValues: {
      name: initialData?.name ?? '',
      description: initialData?.description ?? '',
      scope: initialData?.scope ?? 'GLOBAL',
      companyId: initialData?.companyId ?? undefined,
      lineItemMode: initialData?.lineItemMode ?? DEFAULT_LINE_ITEM_MODE,
      fields: initialData?.fields ?? [
        { name: 'field_1', label: t('fieldEditor.defaultFieldLabel', { number: 1 }), dataType: 'string', isRequired: false, order: 1 },
      ],
    },
  });

  const scope = watch('scope');
  const fields = watch('fields');
  const lineItemMode = watch('lineItemMode') ?? DEFAULT_LINE_ITEM_MODE;

  // --- Handlers ---

  const handleFieldsChange = React.useCallback(
    (newFields: DataTemplateField[]) => {
      setValue('fields', newFields, { shouldValidate: true });
    },
    [setValue]
  );

  // --- Render ---
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* 基本資訊 */}
      <Card>
        <CardHeader>
          <CardTitle>{t('form.basicInfo')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 模版名稱 */}
          <div className="space-y-2">
            <Label htmlFor="name">{t('form.templateNameRequired')}</Label>
            <Input
              id="name"
              {...register('name')}
              placeholder={t('form.templateNamePlaceholder')}
              disabled={readOnly}
              className={readOnly ? 'bg-muted' : ''}
            />
            {errors.name && (
              <p className="text-sm text-destructive">{errors.name.message}</p>
            )}
          </div>

          {/* 模版說明 */}
          <div className="space-y-2">
            <Label htmlFor="description">{t('form.description')}</Label>
            <Textarea
              id="description"
              {...register('description')}
              placeholder={t('form.descriptionPlaceholder')}
              rows={3}
              disabled={readOnly}
              className={readOnly ? 'bg-muted' : ''}
            />
            {errors.description && (
              <p className="text-sm text-destructive">
                {errors.description.message}
              </p>
            )}
          </div>

          {/* 範圍設定 */}
          <div className="grid gap-4 sm:grid-cols-2">
            {/* 配置範圍 */}
            <div className="space-y-2">
              <Label>{t('form.scopeRequired')}</Label>
              <Controller
                name="scope"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={readOnly || isEditMode}
                  >
                    <SelectTrigger
                      className={(readOnly || isEditMode) ? 'bg-muted' : ''}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {scopeOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.scope && (
                <p className="text-sm text-destructive">{errors.scope.message}</p>
              )}
            </div>

            {/* 公司選擇（COMPANY 範圍時） */}
            {scope === 'COMPANY' && (
              <div className="space-y-2">
                <Label>{t('form.companyRequired')}</Label>
                <Controller
                  name="companyId"
                  control={control}
                  render={({ field }) => (
                    <Select
                      value={field.value ?? undefined}
                      onValueChange={field.onChange}
                      disabled={readOnly || isEditMode}
                    >
                      <SelectTrigger
                        className={(readOnly || isEditMode) ? 'bg-muted' : ''}
                      >
                        <SelectValue placeholder={t('form.companyPlaceholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {companies.map((company) => (
                          <SelectItem key={company.id} value={company.id}>
                            {company.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.companyId && (
                  <p className="text-sm text-destructive">
                    {errors.companyId.message}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* 行項目分列模式（CHANGE-113） */}
          <div className="space-y-2">
            <Label>{t('form.lineItemMode')}</Label>
            <Controller
              name="lineItemMode"
              control={control}
              render={({ field }) => (
                <Select
                  value={field.value ?? DEFAULT_LINE_ITEM_MODE}
                  onValueChange={field.onChange}
                  disabled={readOnly}
                >
                  <SelectTrigger className={readOnly ? 'bg-muted' : ''}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LINE_ITEM_MODE_CHOICES.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {t(`lineItemModes.${mode}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <p className="text-sm text-muted-foreground">
              {t(`lineItemModeHints.${lineItemMode}`)}
            </p>
            {errors.lineItemMode && (
              <p className="text-sm text-destructive">
                {errors.lineItemMode.message}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 欄位定義 */}
      <Card>
        <CardHeader>
          <CardTitle>{t('form.fieldDefinitions')}</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTemplateFieldEditor
            fields={fields}
            onChange={handleFieldsChange}
            readOnly={readOnly}
            error={
              errors.fields?.message ||
              (errors.fields as { root?: { message?: string } })?.root?.message
            }
          />
        </CardContent>
      </Card>

      {/* 操作按鈕 */}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('form.back')}
        </Button>
        {!readOnly && (
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('form.saving')}
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                {isEditMode ? t('form.updateTemplate') : t('form.createTemplate')}
              </>
            )}
          </Button>
        )}
      </div>
    </form>
  );
}
