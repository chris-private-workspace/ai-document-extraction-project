'use client'

/**
 * @fileoverview LLM 模型新增/編輯表單（Epic 23 - Story 23.2）
 * @description
 *   某 provider 底下模型的 CRUD 表單（React Hook Form + Zod）：
 *   - capability 為核心必填（maxTokens + supports* 能力旗標）；pricing 為選填附加。
 *   - 編輯模式由 parent 直接傳入既有 model 物件（列表查詢已載入），不再額外查詢。
 *   - `isEnabled` 決定該模型是否出現在 model-settings 的指派下拉。
 *
 * @module src/components/features/llm-provider/LlmModelForm
 * @since Epic 23 - Story 23.2
 * @lastModified 2026-07-10
 *
 * @dependencies
 *   - react-hook-form / @hookform/resolvers/zod - 表單狀態與驗證
 *   - next-intl - 國際化
 *   - @/hooks/use-llm-models - 模型 CRUD hooks
 *   - @/hooks/use-toast - 通知提示
 */

import * as React from 'react'
import { useTranslations } from 'next-intl'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
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
  useCreateLlmModel,
  useUpdateLlmModel,
  type CreateLlmModelInput,
  type LlmModelPublic,
  type ModelCapability,
  type ModelPricing,
  type UpdateLlmModelInput,
} from '@/hooks/use-llm-models'

// ============================================================
// Types
// ============================================================

interface LlmModelFormProps {
  providerId: string
  /** 編輯模式的既有模型；省略＝新增模式 */
  model?: LlmModelPublic
  onSuccess: () => void
  onCancel: () => void
}

/** 影像細節「未設定」哨兵（送出時轉為 undefined） */
const IMAGE_DETAIL_NONE = 'none'
const IMAGE_DETAIL_OPTIONS = ['auto', 'low', 'high'] as const

// ============================================================
// Form Schema
// ============================================================

const formSchema = z.object({
  modelKey: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  maxTokens: z.number().int().positive(),
  supportsTemperature: z.boolean(),
  temperature: z.number().optional(),
  defaultImageDetail: z.enum([IMAGE_DETAIL_NONE, ...IMAGE_DETAIL_OPTIONS]),
  supportsJsonSchema: z.boolean(),
  supportsVision: z.boolean(),
  priceInput: z.number().nonnegative().optional(),
  priceOutput: z.number().nonnegative().optional(),
  currency: z.string().max(10),
  isEnabled: z.boolean(),
})

type FormValues = z.infer<typeof formSchema>

/** 既有 model → 表單值（編輯模式） */
function toFormValues(model: LlmModelPublic): FormValues {
  const c = model.capability
  const p = model.pricing
  return {
    modelKey: model.modelKey,
    label: model.label,
    maxTokens: c.maxTokens,
    supportsTemperature: c.supportsTemperature,
    temperature: c.temperature,
    defaultImageDetail: c.defaultImageDetail ?? IMAGE_DETAIL_NONE,
    supportsJsonSchema: c.supportsJsonSchema,
    supportsVision: c.supportsVision,
    priceInput: p?.inputPer1k,
    priceOutput: p?.outputPer1k,
    currency: p?.currency ?? '',
    isEnabled: model.isEnabled,
  }
}

const DEFAULT_VALUES: FormValues = {
  modelKey: '',
  label: '',
  maxTokens: 8192,
  supportsTemperature: false,
  temperature: undefined,
  defaultImageDetail: IMAGE_DETAIL_NONE,
  supportsJsonSchema: true,
  supportsVision: false,
  priceInput: undefined,
  priceOutput: undefined,
  currency: '',
  isEnabled: true,
}

// ============================================================
// Component
// ============================================================

/**
 * LLM 模型新增/編輯表單組件
 */
export function LlmModelForm({ providerId, model, onSuccess, onCancel }: LlmModelFormProps) {
  const t = useTranslations('llmProviders')
  const { toast } = useToast()

  const isEditing = !!model

  const createMutation = useCreateLlmModel(providerId)
  const updateMutation = useUpdateLlmModel(providerId)
  const isPending = createMutation.isPending || updateMutation.isPending

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: model ? toFormValues(model) : DEFAULT_VALUES,
  })

  // --- Submit ---
  const onSubmit = async (values: FormValues) => {
    const capability: ModelCapability = {
      maxTokens: values.maxTokens,
      supportsTemperature: values.supportsTemperature,
      supportsJsonSchema: values.supportsJsonSchema,
      supportsVision: values.supportsVision,
    }
    if (values.temperature !== undefined) capability.temperature = values.temperature
    if (values.defaultImageDetail !== IMAGE_DETAIL_NONE) {
      capability.defaultImageDetail = values.defaultImageDetail
    }

    const currency = values.currency.trim()
    let pricing: ModelPricing | undefined
    if (values.priceInput !== undefined || values.priceOutput !== undefined || currency) {
      pricing = {}
      if (values.priceInput !== undefined) pricing.inputPer1k = values.priceInput
      if (values.priceOutput !== undefined) pricing.outputPer1k = values.priceOutput
      if (currency) pricing.currency = currency
    }

    try {
      if (isEditing && model) {
        const input: UpdateLlmModelInput = {
          modelKey: values.modelKey,
          label: values.label,
          capability,
          pricing: pricing ?? null,
          isEnabled: values.isEnabled,
        }
        await updateMutation.mutateAsync({ modelId: model.id, input })
        toast({ title: t('models.messages.updated') })
      } else {
        const input: CreateLlmModelInput = {
          modelKey: values.modelKey,
          label: values.label,
          capability,
          isEnabled: values.isEnabled,
        }
        if (pricing) input.pricing = pricing
        await createMutation.mutateAsync(input)
        toast({ title: t('models.messages.created') })
      }
      onSuccess()
    } catch (error) {
      toast({
        title: isEditing ? t('models.messages.updateError') : t('models.messages.createError'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    }
  }

  /** 選填數字欄位的 onChange（空＝undefined，避免 0 誤填） */
  const numberChange = (onChange: (v: number | undefined) => void) => (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => onChange(e.target.value === '' ? undefined : e.target.valueAsNumber)

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        {/* modelKey */}
        <FormField
          control={form.control}
          name="modelKey"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('models.form.modelKey')}</FormLabel>
              <FormControl>
                <Input placeholder={t('models.form.modelKeyPlaceholder')} {...field} />
              </FormControl>
              <FormDescription>{t('models.form.modelKeyDescription')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* label */}
        <FormField
          control={form.control}
          name="label"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('models.form.label')}</FormLabel>
              <FormControl>
                <Input placeholder={t('models.form.labelPlaceholder')} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* maxTokens */}
        <FormField
          control={form.control}
          name="maxTokens"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('models.form.maxTokens')}</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  min={1}
                  value={field.value ?? ''}
                  onChange={(e) => field.onChange(e.target.valueAsNumber)}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* 能力旗標 */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="supportsJsonSchema"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3">
                <FormLabel className="font-normal">{t('models.form.supportsJsonSchema')}</FormLabel>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="supportsVision"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3">
                <FormLabel className="font-normal">{t('models.form.supportsVision')}</FormLabel>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="supportsTemperature"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3">
                <FormLabel className="font-normal">{t('models.form.supportsTemperature')}</FormLabel>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="isEnabled"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3">
                <FormLabel className="font-normal">{t('models.form.isEnabled')}</FormLabel>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
        </div>

        {/* temperature（選填） */}
        <FormField
          control={form.control}
          name="temperature"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('models.form.temperature')}</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  step="0.1"
                  placeholder={t('models.form.temperaturePlaceholder')}
                  value={field.value ?? ''}
                  onChange={numberChange(field.onChange)}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* defaultImageDetail（選填） */}
        <FormField
          control={form.control}
          name="defaultImageDetail"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('models.form.imageDetail')}</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value={IMAGE_DETAIL_NONE}>
                    {t('models.form.imageDetailNone')}
                  </SelectItem>
                  {IMAGE_DETAIL_OPTIONS.map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {t(`models.form.imageDetailOptions.${opt}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* pricing（選填） */}
        <div className="space-y-2 rounded-lg border p-4">
          <p className="text-sm font-medium">{t('models.form.pricingTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('models.form.pricingDescription')}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField
              control={form.control}
              name="priceInput"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('models.form.priceInput')}</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.001"
                      min={0}
                      value={field.value ?? ''}
                      onChange={numberChange(field.onChange)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="priceOutput"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('models.form.priceOutput')}</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.001"
                      min={0}
                      value={field.value ?? ''}
                      onChange={numberChange(field.onChange)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="currency"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('models.form.currency')}</FormLabel>
                  <FormControl>
                    <Input placeholder={t('models.form.currencyPlaceholder')} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* 按鈕 */}
        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
            {t('models.form.cancel')}
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('models.form.submit')}
          </Button>
        </div>
      </form>
    </Form>
  )
}
