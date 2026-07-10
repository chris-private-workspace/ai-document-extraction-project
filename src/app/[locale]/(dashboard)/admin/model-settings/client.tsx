'use client'

/**
 * @fileoverview LLM 模型設定客戶端主組件
 * @description
 *   為文件處理 Stage 1-3（公司識別 / 格式匹配 / 欄位提取）各選擇一個 LLM 模型。
 *
 *   - Epic 23 step 3b：下拉選項來自 GET /api/v1/model-configs 回傳的 models
 *     （**已啟用 provider 的已啟用模型**，依 provider 分組；value = LlmModel.id），不硬編白名單。
 *   - 核心環節（Stage 3）× 非 Azure 模型 → 顯示準確率回歸警示（D6：切非 Azure 前需準確率回歸）。
 *   - 載入時帶入目前 selection；儲存呼叫 PUT（寫 StageModelAssignment）。
 *   - 非 globalAdmin 進入時為唯讀檢視（停用下拉與儲存，並顯示提示）。
 *
 * @module src/app/[locale]/(dashboard)/admin/model-settings/client
 * @since CHANGE-099 - LLM 模型選擇管理
 * @lastModified 2026-07-10
 *
 * @dependencies
 *   - next-auth/react - Session（判斷 isGlobalAdmin）
 *   - next-intl - 國際化
 *   - @/hooks/use-model-configs - 模型配置查詢/更新 Hooks
 *   - @/hooks/use-toast - Toast 通知
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useSession } from 'next-auth/react'
import { AlertTriangle, Check, Cpu, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import {
  useModelConfigs,
  useUpdateModelConfigs,
  type LlmModel,
  type StageModelSelection,
} from '@/hooks/use-model-configs'

// ============================================================
// Constants
// ============================================================

/** 三個階段的識別碼（對應 API selection 欄位） */
const STAGE_KEYS = ['stage1', 'stage2', 'stage3'] as const
type StageKey = (typeof STAGE_KEYS)[number]

/** 核心環節（切非 Azure 前需準確率回歸；D6） */
const CORE_STAGES: readonly StageKey[] = ['stage3']

/** Azure provider 類型（其餘視為非 Azure，觸發核心環節警示） */
const AZURE_PROVIDER_TYPE = 'AZURE_OPENAI'

// ============================================================
// Sub-components
// ============================================================

/**
 * 模型能力提示
 *
 * @description 依選定模型顯示 maxTokens、temperature、json_schema 與影像細節能力。
 */
function CapabilityHints({ model }: { model: LlmModel | undefined }) {
  const t = useTranslations('systemSettings')

  if (!model) return null

  const { capability } = model

  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span>
        {t('modelSettings.capability.maxTokens', {
          value: capability.maxTokens,
        })}
      </span>
      <span className="flex items-center gap-1">
        {capability.supportsTemperature ? (
          <Check className="h-3 w-3 text-green-600" />
        ) : (
          <X className="h-3 w-3 text-muted-foreground" />
        )}
        {capability.supportsTemperature
          ? t('modelSettings.capability.temperature')
          : t('modelSettings.capability.noTemperature')}
      </span>
      <span className="flex items-center gap-1">
        {capability.supportsJsonSchema ? (
          <Check className="h-3 w-3 text-green-600" />
        ) : (
          <X className="h-3 w-3 text-muted-foreground" />
        )}
        {capability.supportsJsonSchema
          ? t('modelSettings.capability.jsonSchema')
          : t('modelSettings.capability.noJsonSchema')}
      </span>
      {capability.defaultImageDetail && (
        <span>
          {t('modelSettings.capability.imageDetail', {
            value: capability.defaultImageDetail,
          })}
        </span>
      )}
    </div>
  )
}

// ============================================================
// Component
// ============================================================

/**
 * LLM 模型設定客戶端主組件
 */
export function ModelSettingsClient() {
  const t = useTranslations('systemSettings')
  const { toast } = useToast()
  const { data: session } = useSession()
  const isGlobalAdmin = session?.user?.isGlobalAdmin ?? false

  // --- Data Hooks ---
  const { data, isLoading, isError } = useModelConfigs()
  const updateMutation = useUpdateModelConfigs()

  // --- State ---
  const [selection, setSelection] = useState<StageModelSelection | null>(null)

  // 載入完成後帶入目前 selection
  useEffect(() => {
    if (data?.selection) {
      setSelection(data.selection)
    }
  }, [data])

  // --- Derived ---
  const models = useMemo(() => data?.models ?? [], [data])

  const modelById = useMemo(() => {
    const map = new Map<string, LlmModel>()
    for (const m of models) map.set(m.id, m)
    return map
  }, [models])

  /** 依 provider 分組（保留 API 回傳順序：預設 provider 優先） */
  const modelGroups = useMemo(() => {
    const groups: { providerName: string; models: LlmModel[] }[] = []
    const indexByProvider = new Map<string, number>()
    for (const m of models) {
      let idx = indexByProvider.get(m.providerName)
      if (idx === undefined) {
        idx = groups.length
        indexByProvider.set(m.providerName, idx)
        groups.push({ providerName: m.providerName, models: [] })
      }
      groups[idx].models.push(m)
    }
    return groups
  }, [models])

  const hasChanges = useMemo(() => {
    if (!data?.selection || !selection) return false
    return STAGE_KEYS.some((key) => selection[key] !== data.selection[key])
  }, [data, selection])

  const allStagesSelected = useMemo(
    () => !!selection && STAGE_KEYS.every((key) => !!selection[key]),
    [selection],
  )

  // --- Handlers ---
  const handleStageChange = (stage: StageKey, value: string) => {
    setSelection((prev) => (prev ? { ...prev, [stage]: value } : prev))
  }

  const handleSave = async () => {
    if (!selection) return
    try {
      await updateMutation.mutateAsync(selection)
      toast({ title: t('modelSettings.saveSuccess') })
    } catch {
      toast({
        title: t('modelSettings.saveError'),
        variant: 'destructive',
      })
    }
  }

  // --- Loading state ---
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // --- Error state ---
  if (isError || !selection) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-destructive">
          {t('modelSettings.loadError')}
        </CardContent>
      </Card>
    )
  }

  // --- Render ---
  return (
    <div className="space-y-6">
      {!isGlobalAdmin && (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800 dark:border-yellow-900/40 dark:bg-yellow-900/20 dark:text-yellow-300">
          {t('modelSettings.readOnlyNotice')}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cpu className="h-5 w-5" />
            {t('modelSettings.cardTitle')}
          </CardTitle>
          <CardDescription>
            {t('modelSettings.cardDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {STAGE_KEYS.map((stage) => {
            const selectedModel = modelById.get(selection[stage])
            const showAccuracyWarning =
              CORE_STAGES.includes(stage) &&
              !!selectedModel &&
              selectedModel.providerType !== AZURE_PROVIDER_TYPE
            return (
              <div key={stage} className="space-y-2">
                <Label>{t(`modelSettings.stages.${stage}`)}</Label>
                <p className="text-sm text-muted-foreground">
                  {t(`modelSettings.stages.${stage}Description`)}
                </p>
                <Select
                  value={selection[stage]}
                  onValueChange={(value) => handleStageChange(stage, value)}
                  disabled={!isGlobalAdmin || updateMutation.isPending}
                >
                  <SelectTrigger className="max-w-md">
                    <SelectValue
                      placeholder={t('modelSettings.selectPlaceholder')}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {modelGroups.map((group) => (
                      <SelectGroup key={group.providerName}>
                        <SelectLabel>{group.providerName}</SelectLabel>
                        {group.models.map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            {model.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
                <CapabilityHints model={selectedModel} />
                {showAccuracyWarning && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>
                      {t('modelSettings.accuracyWarningTitle')}
                    </AlertTitle>
                    <AlertDescription>
                      {t('modelSettings.accuracyWarning')}
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            )
          })}

          {isGlobalAdmin && (
            <div className="flex justify-end">
              <Button
                onClick={handleSave}
                disabled={
                  !hasChanges || !allStagesSelected || updateMutation.isPending
                }
              >
                {updateMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {t('modelSettings.save')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
