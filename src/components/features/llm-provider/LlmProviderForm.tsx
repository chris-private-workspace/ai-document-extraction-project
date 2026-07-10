'use client'

/**
 * @fileoverview LLM Provider 新增/編輯表單（Epic 23 - Story 23.2）
 * @description
 *   後台 provider 憑證管理表單（React Hook Form + Zod）：
 *   - 新增模式：明文輸入 apiKey（服務層加密後落庫）。
 *   - 編輯模式：顯示末 4 碼預覽 `apiKeyPreview`；apiKey 留空＝保留既有憑證。
 *   - 非 Azure provider：顯示 §7 資料合規警示 + `allowSensitiveData` 勾選（D4 護欄）。
 *
 * @module src/components/features/llm-provider/LlmProviderForm
 * @since Epic 23 - Story 23.2
 * @lastModified 2026-07-10
 *
 * @dependencies
 *   - react-hook-form / @hookform/resolvers/zod - 表單狀態與驗證
 *   - next-intl - 國際化
 *   - @/hooks/use-llm-providers - API 操作 hooks
 *   - @/hooks/use-toast - 通知提示
 */

import * as React from 'react'
import { useTranslations } from 'next-intl'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import {
  LLM_PROVIDER_TYPES,
  useCreateLlmProvider,
  useLlmProvider,
  useUpdateLlmProvider,
  type CreateLlmProviderInput,
  type UpdateLlmProviderInput,
} from '@/hooks/use-llm-providers'

// ============================================================
// Types
// ============================================================

interface LlmProviderFormProps {
  /** 編輯模式的 provider ID；省略＝新增模式 */
  providerId?: string
  /** 成功後回調（關閉 dialog） */
  onSuccess: () => void
  /** 取消回調 */
  onCancel: () => void
}

// ============================================================
// Form Schema
// ============================================================

const formSchema = z.object({
  name: z.string().min(1).max(100),
  providerType: z.enum(LLM_PROVIDER_TYPES),
  baseUrl: z.union([z.string().url().max(500), z.literal('')]),
  apiVersion: z.string().max(50),
  apiKey: z.string().max(500),
  isEnabled: z.boolean(),
  isDefault: z.boolean(),
  allowSensitiveData: z.boolean(),
})

type FormValues = z.infer<typeof formSchema>

const DEFAULT_VALUES: FormValues = {
  name: '',
  providerType: 'AZURE_OPENAI',
  baseUrl: '',
  apiVersion: '',
  apiKey: '',
  isEnabled: true,
  isDefault: false,
  allowSensitiveData: false,
}

// ============================================================
// Component
// ============================================================

/**
 * LLM Provider 新增/編輯表單組件
 */
export function LlmProviderForm({
  providerId,
  onSuccess,
  onCancel,
}: LlmProviderFormProps) {
  const t = useTranslations('llmProviders')
  const { toast } = useToast()

  const isEditing = !!providerId

  // --- Data ---
  const { data: existing, isLoading: isLoadingExisting } = useLlmProvider(
    providerId ?? null
  )
  const createMutation = useCreateLlmProvider()
  const updateMutation = useUpdateLlmProvider()
  const isPending = createMutation.isPending || updateMutation.isPending

  // --- Form ---
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: DEFAULT_VALUES,
  })

  // 編輯模式：資料載入後帶入表單（apiKey 一律留空＝保留既有憑證）
  React.useEffect(() => {
    if (existing) {
      form.reset({
        name: existing.name,
        providerType: existing.providerType,
        baseUrl: existing.baseUrl ?? '',
        apiVersion: existing.apiVersion ?? '',
        apiKey: '',
        isEnabled: existing.isEnabled,
        isDefault: existing.isDefault,
        allowSensitiveData: existing.allowSensitiveData,
      })
    }
  }, [existing, form])

  const watchProviderType = form.watch('providerType')
  const isNonAzure = watchProviderType !== 'AZURE_OPENAI'

  // --- Submit ---
  const onSubmit = async (values: FormValues) => {
    const trimmedKey = values.apiKey.trim()
    try {
      if (isEditing && providerId) {
        const input: UpdateLlmProviderInput = {
          name: values.name,
          providerType: values.providerType,
          baseUrl: values.baseUrl.trim() || null,
          apiVersion: values.apiVersion.trim() || null,
          isEnabled: values.isEnabled,
          isDefault: values.isDefault,
          allowSensitiveData: values.allowSensitiveData,
        }
        // apiKey 有輸入才更新，留空則保留既有憑證
        if (trimmedKey) input.apiKey = trimmedKey
        await updateMutation.mutateAsync({ id: providerId, input })
        toast({ title: t('messages.updated') })
      } else {
        const input: CreateLlmProviderInput = {
          name: values.name,
          providerType: values.providerType,
          isEnabled: values.isEnabled,
          isDefault: values.isDefault,
          allowSensitiveData: values.allowSensitiveData,
        }
        if (values.baseUrl.trim()) input.baseUrl = values.baseUrl.trim()
        if (values.apiVersion.trim()) input.apiVersion = values.apiVersion.trim()
        if (trimmedKey) input.apiKey = trimmedKey
        await createMutation.mutateAsync(input)
        toast({ title: t('messages.created') })
      }
      onSuccess()
    } catch (error) {
      toast({
        title: isEditing ? t('messages.updateError') : t('messages.createError'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    }
  }

  // --- Loading（編輯模式資料載入中） ---
  if (isEditing && isLoadingExisting) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        {/* 名稱 */}
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('form.name')}</FormLabel>
              <FormControl>
                <Input placeholder={t('form.namePlaceholder')} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Provider 類型 */}
        <FormField
          control={form.control}
          name="providerType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('form.providerType')}</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder={t('form.providerTypePlaceholder')} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {LLM_PROVIDER_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(`types.${type}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* 非 Azure 合規警示（§7 / D4） */}
        {isNonAzure && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t('form.complianceWarningTitle')}</AlertTitle>
            <AlertDescription>{t('form.complianceWarning')}</AlertDescription>
          </Alert>
        )}

        {/* Base URL */}
        <FormField
          control={form.control}
          name="baseUrl"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('form.baseUrl')}</FormLabel>
              <FormControl>
                <Input placeholder={t('form.baseUrlPlaceholder')} {...field} />
              </FormControl>
              <FormDescription>{t('form.baseUrlDescription')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* API Version（Azure 專用） */}
        {watchProviderType === 'AZURE_OPENAI' && (
          <FormField
            control={form.control}
            name="apiVersion"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('form.apiVersion')}</FormLabel>
                <FormControl>
                  <Input placeholder={t('form.apiVersionPlaceholder')} {...field} />
                </FormControl>
                <FormDescription>{t('form.apiVersionDescription')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {/* API Key */}
        <FormField
          control={form.control}
          name="apiKey"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('form.apiKey')}</FormLabel>
              {isEditing && existing?.hasApiKey && (
                <p className="text-xs text-muted-foreground">
                  {t('form.apiKeyCurrent', {
                    preview: existing.apiKeyPreview ?? '••••',
                  })}
                </p>
              )}
              <FormControl>
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    isEditing
                      ? t('form.apiKeyEditPlaceholder')
                      : t('form.apiKeyPlaceholder')
                  }
                  {...field}
                />
              </FormControl>
              <FormDescription>{t('form.apiKeyDescription')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* 啟用 / 預設 開關 */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="isEnabled"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3">
                <div className="space-y-0.5">
                  <FormLabel>{t('form.isEnabled')}</FormLabel>
                  <FormDescription>{t('form.isEnabledDescription')}</FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="isDefault"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3">
                <div className="space-y-0.5">
                  <FormLabel>{t('form.isDefault')}</FormLabel>
                  <FormDescription>{t('form.isDefaultDescription')}</FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
        </div>

        {/* 敏感資料合規勾選（D4 護欄） */}
        <FormField
          control={form.control}
          name="allowSensitiveData"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start space-x-3 rounded-lg border p-4">
              <FormControl>
                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
              <div className="space-y-1 leading-none">
                <FormLabel className="cursor-pointer font-normal">
                  {t('form.allowSensitiveDataLabel')}
                </FormLabel>
                <FormDescription>{t('form.allowSensitiveData')}</FormDescription>
              </div>
            </FormItem>
          )}
        />

        {/* 按鈕 */}
        <div className="flex justify-end gap-3 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isPending}
          >
            {t('form.cancel')}
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('form.submit')}
          </Button>
        </div>
      </form>
    </Form>
  )
}
