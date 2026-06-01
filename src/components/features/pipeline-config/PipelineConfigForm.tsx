'use client'

/**
 * @fileoverview Pipeline Config 表單組件
 * @description
 *   提供 Pipeline Config 的新增和編輯表單：
 *   - Scope 區塊：Radio group (GLOBAL/REGION/COMPANY)，條件顯示 RegionSelect/CompanySelect
 *   - Ref Match 區塊：Switch enabled，multi-select types，switches filename/content
 *   - FX Conversion 區塊：Switch enabled，target currency，precision，fallback
 *   - General 區塊：isActive, description
 *
 * @module src/components/features/pipeline-config/PipelineConfigForm
 * @since CHANGE-032 - Pipeline Reference Number Matching & FX Conversion
 * @lastModified 2026-02-08
 *
 * @dependencies
 *   - react-hook-form + @hookform/resolvers/zod - 表單管理
 *   - next-intl - 國際化
 *   - @/hooks/use-pipeline-configs - CRUD hooks
 *   - @/hooks/use-regions - Region 資料
 *   - @/hooks/use-companies - Company 資料
 *   - @/i18n/routing - i18n-aware 路由
 */

import * as React from 'react'
import { useTranslations } from 'next-intl'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useRouter } from '@/i18n/routing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useToast } from '@/hooks/use-toast'
import {
  useCreatePipelineConfig,
  useUpdatePipelineConfig,
  type PipelineConfigItem,
} from '@/hooks/use-pipeline-configs'
import { RegionSelect } from '@/components/features/region/RegionSelect'
import { useCompanies } from '@/hooks/use-companies'
import { useCompanyFormats } from '@/hooks/use-company-formats'
import { COMMON_CURRENCIES } from '@/types/exchange-rate'

// ============================================================
// Types
// ============================================================

interface PipelineConfigFormProps {
  initialData?: PipelineConfigItem
}

// ============================================================
// Constants
// ============================================================

const REF_MATCH_TYPES = [
  'SHIPMENT',
  'DELIVERY',
  'BOOKING',
  'CONTAINER',
  'HAWB',
  'MAWB',
  'BL',
  'CUSTOMS',
  'OTHER',
] as const

const FALLBACK_OPTIONS = ['skip', 'warn', 'error'] as const

// ============================================================
// Form Schema
// ============================================================

const formSchema = z
  .object({
    scope: z.enum(['GLOBAL', 'REGION', 'COMPANY', 'FORMAT']),
    regionId: z.string().nullable().optional(),
    companyId: z.string().nullable().optional(),
    documentFormatId: z.string().nullable().optional(),
    refMatchEnabled: z.boolean(),
    refMatchTypes: z.array(z.string()),
    refMatchMaxResults: z.number().int().min(1).max(100),
    fxConversionEnabled: z.boolean(),
    fxTargetCurrency: z.string().nullable().optional(),
    fxConvertLineItems: z.boolean(),
    fxConvertExtraCharges: z.boolean(),
    fxRoundingPrecision: z.number().int().min(0).max(8),
    fxFallbackBehavior: z.enum(['skip', 'warn', 'error']),
    fxSourceCurrencies: z.array(z.string()),
    isActive: z.boolean(),
    description: z.string().nullable().optional(),
  })
  .refine(
    (data) => {
      if (data.scope === 'REGION') return !!data.regionId
      return true
    },
    { message: 'Region is required for REGION scope', path: ['regionId'] }
  )
  .refine(
    (data) => {
      if (data.scope === 'COMPANY') return !!data.companyId
      return true
    },
    { message: 'Company is required for COMPANY scope', path: ['companyId'] }
  )
  .refine(
    (data) => {
      if (data.scope === 'FORMAT') return !!data.documentFormatId
      return true
    },
    { message: 'Format is required for FORMAT scope', path: ['documentFormatId'] }
  )

type FormValues = z.infer<typeof formSchema>

// ============================================================
// Component
// ============================================================

/**
 * Pipeline Config 表單（新增/編輯）
 */
export function PipelineConfigForm({ initialData }: PipelineConfigFormProps) {
  const t = useTranslations('pipelineConfig')
  const router = useRouter()
  const { toast } = useToast()
  const isEditing = !!initialData

  const createMutation = useCreatePipelineConfig()
  const updateMutation = useUpdatePipelineConfig()

  // --- Companies query ---
  const { data: companiesData } = useCompanies({ limit: 100 })
  const companies = companiesData?.data ?? []

  // --- CHANGE-071: FORMAT scope「公司 → 格式」級聯（formatCompanyId 僅過濾用，不儲存）---
  const [formatCompanyId, setFormatCompanyId] = React.useState<string>(
    initialData?.documentFormat?.company?.id ?? ''
  )
  const { formats: companyFormats } = useCompanyFormats({
    companyId: formatCompanyId,
    enabled: !!formatCompanyId,
    limit: 100,
  })

  // --- Form ---
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      scope: initialData?.scope ?? 'GLOBAL',
      regionId: initialData?.regionId ?? null,
      companyId: initialData?.companyId ?? null,
      documentFormatId: initialData?.documentFormatId ?? null,
      refMatchEnabled: initialData?.refMatchEnabled ?? false,
      refMatchTypes: (initialData?.refMatchTypes as string[]) ?? [
        'SHIPMENT',
        'HAWB',
        'MAWB',
        'BL',
        'CONTAINER',
      ],
      refMatchMaxResults: initialData?.refMatchMaxResults ?? 10,
      fxConversionEnabled: initialData?.fxConversionEnabled ?? false,
      fxTargetCurrency: initialData?.fxTargetCurrency ?? null,
      fxConvertLineItems: initialData?.fxConvertLineItems ?? true,
      fxConvertExtraCharges: initialData?.fxConvertExtraCharges ?? true,
      fxRoundingPrecision: initialData?.fxRoundingPrecision ?? 2,
      fxFallbackBehavior:
        (initialData?.fxFallbackBehavior as 'skip' | 'warn' | 'error') ?? 'skip',
      fxSourceCurrencies: (initialData?.fxSourceCurrencies as string[]) ?? [],
      isActive: initialData?.isActive ?? true,
      description: initialData?.description ?? null,
    },
  })

  const watchScope = form.watch('scope')
  const watchRefMatchEnabled = form.watch('refMatchEnabled')
  const watchFxEnabled = form.watch('fxConversionEnabled')

  // --- Submit ---
  const onSubmit = React.useCallback(
    async (values: FormValues) => {
      try {
        if (isEditing && initialData) {
          await updateMutation.mutateAsync({
            id: initialData.id,
            input: {
              refMatchEnabled: values.refMatchEnabled,
              refMatchTypes: values.refMatchTypes,
              refMatchMaxResults: values.refMatchMaxResults,
              fxConversionEnabled: values.fxConversionEnabled,
              fxTargetCurrency: values.fxTargetCurrency,
              fxConvertLineItems: values.fxConvertLineItems,
              fxConvertExtraCharges: values.fxConvertExtraCharges,
              fxRoundingPrecision: values.fxRoundingPrecision,
              fxFallbackBehavior: values.fxFallbackBehavior,
              fxSourceCurrencies:
                values.fxSourceCurrencies.length > 0
                  ? values.fxSourceCurrencies
                  : null,
              isActive: values.isActive,
              description: values.description,
            },
          })
          toast({ title: t('messages.updated') })
        } else {
          await createMutation.mutateAsync({
            scope: values.scope,
            regionId: values.scope === 'REGION' ? values.regionId : null,
            companyId: values.scope === 'COMPANY' ? values.companyId : null,
            documentFormatId:
              values.scope === 'FORMAT' ? values.documentFormatId : null,
            refMatchEnabled: values.refMatchEnabled,
            refMatchTypes: values.refMatchTypes,
            refMatchMaxResults: values.refMatchMaxResults,
            fxConversionEnabled: values.fxConversionEnabled,
            fxTargetCurrency: values.fxTargetCurrency,
            fxConvertLineItems: values.fxConvertLineItems,
            fxConvertExtraCharges: values.fxConvertExtraCharges,
            fxRoundingPrecision: values.fxRoundingPrecision,
            fxFallbackBehavior: values.fxFallbackBehavior,
            fxSourceCurrencies:
              values.fxSourceCurrencies.length > 0
                ? values.fxSourceCurrencies
                : null,
            isActive: values.isActive,
            description: values.description,
          })
          toast({ title: t('messages.created') })
        }
        router.push('/admin/pipeline-settings')
      } catch (error) {
        toast({
          variant: 'destructive',
          title: isEditing
            ? t('messages.updateFailed')
            : t('messages.createFailed'),
          description:
            error instanceof Error ? error.message : undefined,
        })
      }
    },
    [isEditing, initialData, createMutation, updateMutation, toast, t, router]
  )

  const isPending = createMutation.isPending || updateMutation.isPending

  // --- Toggle ref type ---
  const toggleRefType = React.useCallback(
    (type: string) => {
      const current = form.getValues('refMatchTypes')
      const updated = current.includes(type)
        ? current.filter((t) => t !== type)
        : [...current, type]
      form.setValue('refMatchTypes', updated)
    },
    [form]
  )

  const selectedRefTypes = form.watch('refMatchTypes')

  // CHANGE-071: 來源幣別多選 toggle
  const selectedSourceCurrencies = form.watch('fxSourceCurrencies')
  const toggleSourceCurrency = React.useCallback(
    (code: string) => {
      const current = form.getValues('fxSourceCurrencies')
      const updated = current.includes(code)
        ? current.filter((c) => c !== code)
        : [...current, code]
      form.setValue('fxSourceCurrencies', updated)
    },
    [form]
  )

  // --- Render ---
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
        {/* ============ Scope Section ============ */}
        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-medium">{t('form.scopeSection')}</h3>
            <p className="text-sm text-muted-foreground">
              {t('form.scopeDescription')}
            </p>
          </div>

          <FormField
            control={form.control}
            name="scope"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('form.scope')}</FormLabel>
                <FormControl>
                  <RadioGroup
                    value={field.value}
                    onValueChange={field.onChange}
                    className="flex gap-4"
                    disabled={isEditing}
                  >
                    {(['GLOBAL', 'REGION', 'COMPANY', 'FORMAT'] as const).map((s) => (
                      <div key={s} className="flex items-center space-x-2">
                        <RadioGroupItem value={s} id={`scope-${s}`} />
                        <Label htmlFor={`scope-${s}`}>{t(`scope.${s}`)}</Label>
                      </div>
                    ))}
                  </RadioGroup>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {watchScope === 'REGION' && (
            <FormField
              control={form.control}
              name="regionId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('form.region')}</FormLabel>
                  <FormControl>
                    <RegionSelect
                      value={field.value ?? undefined}
                      onChange={(val) => field.onChange(val || null)}
                      placeholder={t('form.selectRegion')}
                      disabled={isEditing}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          {watchScope === 'COMPANY' && (
            <FormField
              control={form.control}
              name="companyId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('form.company')}</FormLabel>
                  <FormControl>
                    <Select
                      value={field.value ?? ''}
                      onValueChange={(val) => field.onChange(val || null)}
                      disabled={isEditing}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t('form.selectCompany')} />
                      </SelectTrigger>
                      <SelectContent>
                        {companies.map((c: { id: string; name: string }) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          {watchScope === 'FORMAT' && (
            <>
              {/* CHANGE-071: 先選公司（過濾用，不儲存），再選該公司的格式 */}
              <FormItem>
                <FormLabel>{t('form.company')}</FormLabel>
                <Select
                  value={formatCompanyId}
                  onValueChange={(val) => {
                    setFormatCompanyId(val)
                    form.setValue('documentFormatId', null)
                  }}
                  disabled={isEditing}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t('form.selectCompany')} />
                  </SelectTrigger>
                  <SelectContent>
                    {companies.map((c: { id: string; name: string }) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormItem>

              <FormField
                control={form.control}
                name="documentFormatId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('form.format')}</FormLabel>
                    <FormControl>
                      <Select
                        value={field.value ?? ''}
                        onValueChange={(val) => field.onChange(val || null)}
                        disabled={isEditing || !formatCompanyId}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t('form.selectFormat')} />
                        </SelectTrigger>
                        <SelectContent>
                          {companyFormats.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.name ||
                                `${f.documentType} / ${f.documentSubtype}`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </>
          )}
        </div>

        <Separator />

        {/* ============ Ref Match Section ============ */}
        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-medium">{t('form.refMatchSection')}</h3>
            <p className="text-sm text-muted-foreground">
              {t('form.refMatchDescription')}
            </p>
          </div>

          <FormField
            control={form.control}
            name="refMatchEnabled"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <FormLabel>{t('form.refMatchEnabled')}</FormLabel>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </FormItem>
            )}
          />

          {watchRefMatchEnabled && (
            <>
              {/* Ref Match Types */}
              <div className="space-y-2">
                <Label>{t('form.refMatchTypes')}</Label>
                <div className="flex flex-wrap gap-2">
                  {REF_MATCH_TYPES.map((type) => (
                    <Badge
                      key={type}
                      variant={
                        selectedRefTypes.includes(type) ? 'default' : 'outline'
                      }
                      className="cursor-pointer"
                      onClick={() => toggleRefType(type)}
                    >
                      {t(`refTypes.${type}`)}
                    </Badge>
                  ))}
                </div>
              </div>

              <FormField
                control={form.control}
                name="refMatchMaxResults"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('form.refMatchMaxResults')}</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={100}
                        value={field.value}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </>
          )}
        </div>

        <Separator />

        {/* ============ FX Conversion Section ============ */}
        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-medium">{t('form.fxSection')}</h3>
            <p className="text-sm text-muted-foreground">
              {t('form.fxDescription')}
            </p>
          </div>

          <FormField
            control={form.control}
            name="fxConversionEnabled"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <FormLabel>{t('form.fxConversionEnabled')}</FormLabel>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </FormItem>
            )}
          />

          {watchFxEnabled && (
            <>
              <FormField
                control={form.control}
                name="fxTargetCurrency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('form.fxTargetCurrency')}</FormLabel>
                    <FormControl>
                      <Input
                        placeholder={t('form.fxTargetCurrencyPlaceholder')}
                        maxLength={3}
                        value={field.value ?? ''}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value.toUpperCase() || null
                          )
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* CHANGE-071: 只轉指定來源幣別（不選 = 全轉） */}
              <div className="space-y-2">
                <Label>{t('form.fxSourceCurrencies')}</Label>
                <p className="text-sm text-muted-foreground">
                  {t('form.fxSourceCurrenciesDescription')}
                </p>
                <div className="flex flex-wrap gap-2">
                  {COMMON_CURRENCIES.map((currency) => (
                    <Badge
                      key={currency.code}
                      variant={
                        selectedSourceCurrencies.includes(currency.code)
                          ? 'default'
                          : 'outline'
                      }
                      className="cursor-pointer"
                      onClick={() => toggleSourceCurrency(currency.code)}
                    >
                      {currency.code}
                    </Badge>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="fxConvertLineItems"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between rounded-lg border p-3">
                      <FormLabel className="text-sm">
                        {t('form.fxConvertLineItems')}
                      </FormLabel>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="fxConvertExtraCharges"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between rounded-lg border p-3">
                      <FormLabel className="text-sm">
                        {t('form.fxConvertExtraCharges')}
                      </FormLabel>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="fxRoundingPrecision"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('form.fxRoundingPrecision')}</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          max={8}
                          value={field.value}
                          onChange={(e) =>
                            field.onChange(Number(e.target.value))
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="fxFallbackBehavior"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('form.fxFallbackBehavior')}</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {FALLBACK_OPTIONS.map((opt) => (
                            <SelectItem key={opt} value={opt}>
                              {t(`form.fxFallback.${opt}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </>
          )}
        </div>

        <Separator />

        {/* ============ General Section ============ */}
        <div className="space-y-4">
          <h3 className="text-lg font-medium">{t('form.generalSection')}</h3>

          <FormField
            control={form.control}
            name="isActive"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <FormLabel>{t('form.isActive')}</FormLabel>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('form.description')}</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder={t('form.descriptionPlaceholder')}
                    rows={3}
                    value={field.value ?? ''}
                    onChange={(e) =>
                      field.onChange(e.target.value || null)
                    }
                  />
                </FormControl>
                <FormDescription>
                  {(field.value?.length ?? 0)}/500
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* ============ Actions ============ */}
        <div className="flex gap-4">
          <Button type="submit" disabled={isPending}>
            {t('form.submit')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push('/admin/pipeline-settings')}
          >
            {t('form.cancel')}
          </Button>
        </div>
      </form>
    </Form>
  )
}
