'use client';

/**
 * @fileoverview SharePoint 配置表單元件
 * @description
 *   提供 SharePoint 連線配置的建立和編輯表單。
 *   包含連線測試功能和表單驗證。
 *
 * @module src/components/features/sharepoint/SharePointConfigForm
 * @author Development Team
 * @since Epic 9 - Story 9.2 (SharePoint 連線配置)
 * @lastModified 2025-12-20
 *
 * @features
 *   - 新增/編輯 SharePoint 配置
 *   - 即時連線測試
 *   - Zod 表單驗證
 *   - 城市選擇
 */

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, TestTube, CheckCircle2, XCircle } from 'lucide-react';

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

import type { SharePointConfigResponse, ConnectionTestResult } from '@/types/sharepoint';

// ============================================================
// Types
// ============================================================

interface City {
  id: string;
  name: string;
  code: string;
}

interface SharePointConfigFormProps {
  config?: SharePointConfigResponse;
  cities: City[];
  onSubmit: (data: SharePointConfigFormData) => Promise<void>;
  onCancel: () => void;
  onTestConnection?: (data: ConnectionTestInput) => Promise<ConnectionTestResult>;
}

interface ConnectionTestInput {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  siteUrl: string;
  libraryPath: string;
}

// ============================================================
// Validation Schema
// ============================================================

const formSchema = z.object({
  name: z.string().min(1, '名稱不能為空').max(100, '名稱不能超過 100 字元'),
  description: z.string().max(500, '說明不能超過 500 字元').optional(),
  siteUrl: z.string().url('請輸入有效的 SharePoint 站點 URL'),
  tenantId: z.string().uuid('Tenant ID 格式不正確'),
  clientId: z.string().uuid('Client ID 格式不正確'),
  clientSecret: z.string().min(1, 'Client Secret 不能為空'),
  libraryPath: z.string().min(1, '文件庫路徑不能為空'),
  rootFolderPath: z.string().optional(),
  cityId: z.string().optional().nullable(),
  isGlobal: z.boolean().optional(),
  fileExtensions: z.string().optional(),
  maxFileSizeMb: z.coerce.number().min(1).max(100).optional(),
  excludeFolders: z.string().optional(),
});

type SharePointConfigFormData = z.infer<typeof formSchema>;

// ============================================================
// Component
// ============================================================

/**
 * SharePoint 配置表單
 */
export function SharePointConfigForm({
  config,
  cities,
  onSubmit,
  onCancel,
  onTestConnection,
}: SharePointConfigFormProps) {
  const t = useTranslations('integrations');
  const tc = useTranslations('common');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [isTesting, setIsTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<ConnectionTestResult | null>(null);

  const isEditing = !!config;

  const form = useForm<SharePointConfigFormData>({
    resolver: zodResolver(formSchema) as Resolver<SharePointConfigFormData>,
    defaultValues: {
      name: config?.name ?? '',
      description: config?.description ?? '',
      siteUrl: config?.siteUrl ?? '',
      tenantId: config?.tenantId ?? '',
      clientId: config?.clientId ?? '',
      clientSecret: '',
      libraryPath: config?.libraryPath ?? '',
      rootFolderPath: config?.rootFolderPath ?? '',
      cityId: config?.cityId ?? null,
      isGlobal: config?.isGlobal ?? false,
      fileExtensions: config?.fileExtensions?.join(', ') ?? '.pdf, .jpg, .jpeg, .png, .tiff',
      maxFileSizeMb: config?.maxFileSizeMb ?? 50,
      excludeFolders: config?.excludeFolders?.join(', ') ?? '',
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

  const handleFormSubmit = async (data: SharePointConfigFormData) => {
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
    if (!values.tenantId || !values.clientId || !values.clientSecret || !values.siteUrl || !values.libraryPath) {
      setTestResult({
        success: false,
        error: t('sharepoint.form.test.missingFields'),
      });
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    try {
      const result = await onTestConnection({
        tenantId: values.tenantId,
        clientId: values.clientId,
        clientSecret: values.clientSecret,
        siteUrl: values.siteUrl,
        libraryPath: values.libraryPath,
      });
      setTestResult(result);
    } catch {
      setTestResult({
        success: false,
        error: t('sharepoint.form.test.failed'),
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
          <CardTitle>{t('sharepoint.form.basicInfo.title')}</CardTitle>
          <CardDescription>{t('sharepoint.form.basicInfo.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">{t('sharepoint.form.name.label')}</Label>
            <Input
              id="name"
              {...register('name')}
              placeholder={t('sharepoint.form.name.placeholder')}
            />
            {errors.name && (
              <p className="text-sm text-red-500">{errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">{t('sharepoint.form.description.label')}</Label>
            <Textarea
              id="description"
              {...register('description')}
              placeholder={t('sharepoint.form.description.placeholder')}
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
          <CardTitle>{t('sharepoint.form.azureAd.title')}</CardTitle>
          <CardDescription>{t('sharepoint.form.azureAd.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tenantId">{t('sharepoint.form.tenantId.label')}</Label>
            <Input
              id="tenantId"
              {...register('tenantId')}
              placeholder={t('sharepoint.form.tenantId.placeholder')}
            />
            {errors.tenantId && (
              <p className="text-sm text-red-500">{errors.tenantId.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="clientId">{t('sharepoint.form.clientId.label')}</Label>
            <Input
              id="clientId"
              {...register('clientId')}
              placeholder={t('sharepoint.form.clientId.placeholder')}
            />
            {errors.clientId && (
              <p className="text-sm text-red-500">{errors.clientId.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="clientSecret">
              {t('sharepoint.form.clientSecret.label')}
              {isEditing && (
                <span className="text-muted-foreground ml-2">
                  {t('sharepoint.form.clientSecret.editHint')}
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
                  ? t('sharepoint.form.clientSecret.placeholderEdit')
                  : t('sharepoint.form.clientSecret.placeholderCreate')
              }
            />
            {errors.clientSecret && (
              <p className="text-sm text-red-500">{errors.clientSecret.message}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* SharePoint 設定 */}
      <Card>
        <CardHeader>
          <CardTitle>{t('sharepoint.form.sharepoint.title')}</CardTitle>
          <CardDescription>{t('sharepoint.form.sharepoint.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="siteUrl">{t('sharepoint.form.siteUrl.label')}</Label>
            <Input
              id="siteUrl"
              {...register('siteUrl')}
              placeholder={t('sharepoint.form.siteUrl.placeholder')}
            />
            {errors.siteUrl && (
              <p className="text-sm text-red-500">{errors.siteUrl.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="libraryPath">{t('sharepoint.form.libraryPath.label')}</Label>
            <Input
              id="libraryPath"
              {...register('libraryPath')}
              placeholder={t('sharepoint.form.libraryPath.placeholder')}
            />
            {errors.libraryPath && (
              <p className="text-sm text-red-500">{errors.libraryPath.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="rootFolderPath">{t('sharepoint.form.rootFolderPath.label')}</Label>
            <Input
              id="rootFolderPath"
              {...register('rootFolderPath')}
              placeholder={t('sharepoint.form.rootFolderPath.placeholder')}
            />
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
                    {t('sharepoint.form.test.testing')}
                  </>
                ) : (
                  <>
                    <TestTube className="mr-2 h-4 w-4" />
                    {t('sharepoint.form.test.button')}
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
                        <p>{t('sharepoint.form.test.success')}</p>
                        {testResult.details?.siteInfo && (
                          <p className="text-sm text-muted-foreground">
                            {t('sharepoint.form.test.site', {
                              name: testResult.details.siteInfo.name,
                            })}
                          </p>
                        )}
                        {testResult.details?.driveInfo && (
                          <p className="text-sm text-muted-foreground">
                            {t('sharepoint.form.test.library', {
                              name: testResult.details.driveInfo.name,
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

      {/* 檔案過濾設定 */}
      <Card>
        <CardHeader>
          <CardTitle>{t('sharepoint.form.fileFilter.title')}</CardTitle>
          <CardDescription>{t('sharepoint.form.fileFilter.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="fileExtensions">{t('sharepoint.form.fileExtensions.label')}</Label>
            <Input
              id="fileExtensions"
              {...register('fileExtensions')}
              placeholder={t('sharepoint.form.fileExtensions.placeholder')}
            />
            <p className="text-sm text-muted-foreground">{t('sharepoint.form.fileExtensions.hint')}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="maxFileSizeMb">{t('sharepoint.form.maxFileSizeMb.label')}</Label>
            <Input
              id="maxFileSizeMb"
              type="number"
              {...register('maxFileSizeMb')}
              min={1}
              max={100}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="excludeFolders">{t('sharepoint.form.excludeFolders.label')}</Label>
            <Input
              id="excludeFolders"
              {...register('excludeFolders')}
              placeholder={t('sharepoint.form.excludeFolders.placeholder')}
            />
            <p className="text-sm text-muted-foreground">{t('sharepoint.form.excludeFolders.hint')}</p>
          </div>
        </CardContent>
      </Card>

      {/* 城市關聯 */}
      <Card>
        <CardHeader>
          <CardTitle>{t('sharepoint.form.city.title')}</CardTitle>
          <CardDescription>{t('sharepoint.form.city.description')}</CardDescription>
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
            <Label htmlFor="isGlobal">{t('sharepoint.form.city.isGlobalLabel')}</Label>
          </div>

          {!isGlobal && (
            <div className="space-y-2">
              <Label htmlFor="cityId">{t('sharepoint.form.city.selectCityLabel')}</Label>
              <Select
                value={watch('cityId') ?? undefined}
                onValueChange={(value) => setValue('cityId', value)}
                disabled={isEditing}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('sharepoint.form.city.selectCityPlaceholder')} />
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
              {t('sharepoint.form.submit.saving')}
            </>
          ) : isEditing ? (
            t('sharepoint.form.submit.update')
          ) : (
            t('sharepoint.form.submit.create')
          )}
        </Button>
      </div>
    </form>
  );
}
