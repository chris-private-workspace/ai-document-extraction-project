'use client';

/**
 * @fileoverview Outlook 配置表單元件
 * @description
 *   提供 Outlook 連線配置的建立和編輯表單。
 *   包含連線測試功能和表單驗證。
 *
 * @module src/components/features/outlook/OutlookConfigForm
 * @author Development Team
 * @since Epic 9 - Story 9.4 (Outlook 連線設定)
 * @lastModified 2025-12-20
 *
 * @features
 *   - 新增/編輯 Outlook 配置
 *   - 即時連線測試
 *   - Zod 表單驗證
 *   - 城市選擇
 *   - Mailbox 和 Folder 設定
 */

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, TestTube, CheckCircle2, XCircle, Mail, Folder } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';

import type {
  OutlookConfigApiResponse,
  OutlookConnectionTestResult,
  TestConnectionInput,
} from '@/types/outlook-config.types';

// ============================================================
// Types
// ============================================================

interface City {
  id: string;
  name: string;
  code: string;
}

interface OutlookConfigFormProps {
  config?: OutlookConfigApiResponse;
  cities: City[];
  onSubmit: (data: OutlookConfigFormData) => Promise<void>;
  onCancel: () => void;
  onTestConnection?: (data: TestConnectionInput) => Promise<OutlookConnectionTestResult>;
}

// ============================================================
// Validation Schema
// ============================================================

const formSchema = z.object({
  name: z.string().min(1, '名稱不能為空').max(100, '名稱不能超過 100 字元'),
  description: z.string().max(500, '說明不能超過 500 字元').optional(),
  tenantId: z.string().uuid('Tenant ID 格式不正確'),
  clientId: z.string().uuid('Client ID 格式不正確'),
  clientSecret: z.string().min(1, 'Client Secret 不能為空').optional(),
  mailboxAddress: z.string().email('請輸入有效的電子郵件地址'),
  mailFolders: z.string().optional(),
  cityId: z.string().optional().nullable(),
  isGlobal: z.boolean().optional(),
  maxAttachmentSizeMb: z.coerce.number().min(1).max(100).optional(),
  allowedExtensions: z.string().optional(),
});

type OutlookConfigFormData = z.infer<typeof formSchema>;

// ============================================================
// Component
// ============================================================

/**
 * Outlook 配置表單
 */
export function OutlookConfigForm({
  config,
  cities,
  onSubmit,
  onCancel,
  onTestConnection,
}: OutlookConfigFormProps) {
  const t = useTranslations('integrations');
  const tc = useTranslations('common');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [isTesting, setIsTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<OutlookConnectionTestResult | null>(null);

  const isEditing = !!config;

  const form = useForm<OutlookConfigFormData>({
    resolver: zodResolver(formSchema) as Resolver<OutlookConfigFormData>,
    defaultValues: {
      name: config?.name ?? '',
      description: config?.description ?? '',
      tenantId: config?.tenantId ?? '',
      clientId: config?.clientId ?? '',
      clientSecret: '',
      mailboxAddress: config?.mailboxAddress ?? '',
      mailFolders: config?.mailFolders?.join(', ') ?? 'inbox',
      cityId: config?.cityId ?? null,
      isGlobal: config?.isGlobal ?? false,
      maxAttachmentSizeMb: config?.maxAttachmentSizeMb ?? 30,
      allowedExtensions: config?.allowedExtensions?.join(', ') ?? 'pdf, jpg, jpeg, png, tiff',
    },
  });

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = form;

  const isGlobal = watch('isGlobal');

  const handleFormSubmit = async (data: OutlookConfigFormData) => {
    setIsSubmitting(true);
    try {
      await onSubmit(data);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTestConnection = async () => {
    if (!onTestConnection) return;

    const values = watch();
    if (!values.tenantId || !values.clientId || !values.mailboxAddress) {
      setTestResult({
        success: false,
        error: t('outlook.form.test.missingFields'),
      });
      return;
    }

    // 編輯模式下若未輸入新密鑰，則需要提示
    if (!isEditing && !values.clientSecret) {
      setTestResult({
        success: false,
        error: t('outlook.form.test.missingSecret'),
      });
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    try {
      const result = await onTestConnection({
        tenantId: values.tenantId,
        clientId: values.clientId,
        clientSecret: values.clientSecret ?? '',
        mailboxAddress: values.mailboxAddress,
      });
      setTestResult(result);
    } catch {
      setTestResult({
        success: false,
        error: t('outlook.form.test.failed'),
      });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-6">
      {/* 基本資訊 */}
      <Card>
        <CardHeader>
          <CardTitle>{t('outlook.form.basicInfo.title')}</CardTitle>
          <CardDescription>{t('outlook.form.basicInfo.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">{t('outlook.form.name.label')}</Label>
            <Input
              id="name"
              {...register('name')}
              placeholder={t('outlook.form.name.placeholder')}
            />
            {errors.name && (
              <p className="text-sm text-red-500">{errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">{t('outlook.form.description.label')}</Label>
            <Textarea
              id="description"
              {...register('description')}
              placeholder={t('outlook.form.description.placeholder')}
              rows={3}
            />
            {errors.description && (
              <p className="text-sm text-red-500">{errors.description.message}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Azure AD 設定 */}
      <Card>
        <CardHeader>
          <CardTitle>{t('outlook.form.azureAd.title')}</CardTitle>
          <CardDescription>{t('outlook.form.azureAd.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tenantId">{t('outlook.form.tenantId.label')}</Label>
            <Input
              id="tenantId"
              {...register('tenantId')}
              placeholder={t('outlook.form.tenantId.placeholder')}
            />
            {errors.tenantId && (
              <p className="text-sm text-red-500">{errors.tenantId.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="clientId">{t('outlook.form.clientId.label')}</Label>
            <Input
              id="clientId"
              {...register('clientId')}
              placeholder={t('outlook.form.clientId.placeholder')}
            />
            {errors.clientId && (
              <p className="text-sm text-red-500">{errors.clientId.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="clientSecret">
              {t('outlook.form.clientSecret.label')}
              {isEditing && (
                <span className="text-muted-foreground ml-2">
                  {t('outlook.form.clientSecret.editHint')}
                </span>
              )}
            </Label>
            <Input
              id="clientSecret"
              type="password"
              autoComplete="new-password"
              {...register('clientSecret')}
              placeholder={
                isEditing
                  ? t('outlook.form.clientSecret.placeholderEdit')
                  : t('outlook.form.clientSecret.placeholderCreate')
              }
            />
            {errors.clientSecret && (
              <p className="text-sm text-red-500">{errors.clientSecret.message}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Outlook 信箱設定 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            {t('outlook.form.mailbox.title')}
          </CardTitle>
          <CardDescription>{t('outlook.form.mailbox.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="mailboxAddress">{t('outlook.form.mailboxAddress.label')}</Label>
            <Input
              id="mailboxAddress"
              type="email"
              {...register('mailboxAddress')}
              placeholder={t('outlook.form.mailboxAddress.placeholder')}
            />
            {errors.mailboxAddress && (
              <p className="text-sm text-red-500">{errors.mailboxAddress.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="mailFolders" className="flex items-center gap-2">
              <Folder className="h-4 w-4" />
              {t('outlook.form.mailFolders.label')}
            </Label>
            <Input
              id="mailFolders"
              {...register('mailFolders')}
              placeholder={t('outlook.form.mailFolders.placeholder')}
            />
            <p className="text-sm text-muted-foreground">
              {t('outlook.form.mailFolders.hint')}
            </p>
          </div>

          {/* 連線測試 */}
          {onTestConnection && (
            <div className="pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={handleTestConnection}
                disabled={isTesting}
              >
                {isTesting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('outlook.form.test.testing')}
                  </>
                ) : (
                  <>
                    <TestTube className="mr-2 h-4 w-4" />
                    {t('outlook.form.test.button')}
                  </>
                )}
              </Button>

              {testResult && (
                <Alert
                  className="mt-4"
                  variant={testResult.success ? 'default' : 'destructive'}
                >
                  {testResult.success ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <XCircle className="h-4 w-4" />
                  )}
                  <AlertDescription>
                    {testResult.success ? (
                      <div className="space-y-1">
                        <p>{t('outlook.form.test.success')}</p>
                        {testResult.details?.mailboxInfo && (
                          <p className="text-sm text-muted-foreground">
                            {t('outlook.form.test.mailbox', {
                              name: testResult.details.mailboxInfo.displayName,
                            })}
                          </p>
                        )}
                        {testResult.details?.recentMailCount !== undefined && (
                          <p className="text-sm text-muted-foreground">
                            {t('outlook.form.test.recentMailCount', {
                              count: testResult.details.recentMailCount,
                            })}
                          </p>
                        )}
                      </div>
                    ) : (
                      <p>{testResult.error}</p>
                    )}
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 處理設定 */}
      <Card>
        <CardHeader>
          <CardTitle>{t('outlook.form.processing.title')}</CardTitle>
          <CardDescription>{t('outlook.form.processing.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="maxAttachmentSizeMb">{t('outlook.form.maxAttachmentSizeMb.label')}</Label>
            <Input
              id="maxAttachmentSizeMb"
              type="number"
              {...register('maxAttachmentSizeMb')}
              min={1}
              max={100}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="allowedExtensions">{t('outlook.form.allowedExtensions.label')}</Label>
            <Input
              id="allowedExtensions"
              {...register('allowedExtensions')}
              placeholder={t('outlook.form.allowedExtensions.placeholder')}
            />
            <p className="text-sm text-muted-foreground">{t('outlook.form.allowedExtensions.hint')}</p>
          </div>
        </CardContent>
      </Card>

      {/* 城市關聯 */}
      <Card>
        <CardHeader>
          <CardTitle>{t('outlook.form.city.title')}</CardTitle>
          <CardDescription>{t('outlook.form.city.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center space-x-2">
            <Switch
              id="isGlobal"
              checked={isGlobal}
              onCheckedChange={(checked) => {
                setValue('isGlobal', checked);
                if (checked) {
                  setValue('cityId', null);
                }
              }}
              disabled={isEditing}
            />
            <Label htmlFor="isGlobal">{t('outlook.form.city.isGlobalLabel')}</Label>
          </div>

          {!isGlobal && (
            <div className="space-y-2">
              <Label htmlFor="cityId">{t('outlook.form.city.selectCityLabel')}</Label>
              <Select
                value={watch('cityId') ?? undefined}
                onValueChange={(value) => setValue('cityId', value)}
                disabled={isEditing}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('outlook.form.city.selectCityPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {cities.map((city) => (
                    <SelectItem key={city.id} value={city.id}>
                      {city.name} ({city.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 操作按鈕 */}
      <div className="flex justify-end space-x-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          {tc('actions.cancel')}
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('outlook.form.submit.saving')}
            </>
          ) : isEditing ? (
            t('outlook.form.submit.update')
          ) : (
            t('outlook.form.submit.create')
          )}
        </Button>
      </div>
    </form>
  );
}

export type { OutlookConfigFormData };
