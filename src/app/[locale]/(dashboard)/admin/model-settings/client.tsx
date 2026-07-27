'use client'

/**
 * @fileoverview LLM 模型指派客戶端主組件
 * @description
 *   為系統中**每一個 LLM 呼叫環節**指派模型（Epic 23 Story 23.4）。
 *
 *   - 環節目錄（顯示順序 / i18n key / 是否核心提取）來自 `@/lib/constants/llm-stages`，
 *     與服務層、gateway 橋接共用同一份定義。
 *   - 下拉選項來自 GET /api/v1/model-configs 的 models（**已啟用 provider 的已啟用模型**，
 *     依 provider 分組；value = LlmModel.id），不硬編白名單。
 *   - **核心提取環節**（產出發票欄位值）× 非 Azure 模型 → 顯示準確率回歸警示。指派會存下來，
 *     但執行期由 `resolveModelIdForStage` 強制回退 Azure，直到準確率回歸與 per-model
 *     信心度校準完成（D6 + OQ-E）。
 *   - **低風險環節**（分類 / 驗證）可直接指派非 Azure 模型。
 *   - 只送出有異動的環節（PUT 支援部分更新）。
 *   - 非 globalAdmin 進入時為唯讀檢視（停用下拉與儲存，並顯示提示）。
 *
 * @module src/app/[locale]/(dashboard)/admin/model-settings/client
 * @since CHANGE-099 - LLM 模型選擇管理
 * @lastModified 2026-07-27
 *
 * @dependencies
 *   - next-auth/react - Session（判斷 isGlobalAdmin）
 *   - next-intl - 國際化
 *   - @/lib/constants/llm-stages - 環節目錄（單一真實來源）
 *   - @/hooks/use-model-configs - 模型配置查詢/更新 Hooks
 *   - @/hooks/use-toast - Toast 通知
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useSession } from 'next-auth/react'
import { AlertTriangle, Check, Cpu, Info, Loader2, ShieldCheck, X } from 'lucide-react'
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
import { LLM_STAGES, type LlmStageDefinition } from '@/lib/constants/llm-stages'
import { useToast } from '@/hooks/use-toast'
import {
  useModelConfigs,
  useUpdateModelConfigs,
  type LlmModel,
  type StageAssignments,
} from '@/hooks/use-model-configs'

// ============================================================
// Constants
// ============================================================

/** Azure provider 類型（其餘視為非 Azure，觸發核心環節警示） */
const AZURE_PROVIDER_TYPE = 'AZURE_OPENAI'

/** 依 provider 分組的下拉選項 */
interface ModelGroup {
  providerName: string
  models: LlmModel[]
}

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

/**
 * 單一環節的模型指派列
 *
 * @description 名稱 + 說明 + 模型下拉 + 能力提示；核心環節選了非 Azure 時附加準確率回歸警示。
 */
function StageAssignmentRow({
  stage,
  value,
  modelById,
  modelGroups,
  disabled,
  gatewayEnabled,
  onChange,
}: {
  stage: LlmStageDefinition
  value: string
  modelById: Map<string, LlmModel>
  modelGroups: ModelGroup[]
  disabled: boolean
  gatewayEnabled: boolean
  onChange: (value: string) => void
}) {
  const t = useTranslations('systemSettings')

  const selectedModel = modelById.get(value)
  const showAccuracyWarning =
    stage.isCore &&
    !!selectedModel &&
    selectedModel.providerType !== AZURE_PROVIDER_TYPE
  // 主開關關閉 → 這些環節的指派完全不會被讀取，必須讓管理員看見（否則儲存成功但毫無作用）
  const showGatewayDisabledNotice = stage.requiresGateway && !gatewayEnabled

  return (
    <div className="space-y-2">
      <Label>{t(`modelSettings.stages.${stage.i18nKey}`)}</Label>
      <p className="text-sm text-muted-foreground">
        {t(`modelSettings.stages.${stage.i18nKey}Description`)}
      </p>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="max-w-md">
          <SelectValue placeholder={t('modelSettings.selectPlaceholder')} />
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
      {showGatewayDisabledNotice && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>{t('modelSettings.gatewayDisabledTitle')}</AlertTitle>
          <AlertDescription>
            {t('modelSettings.gatewayDisabledNotice')}
          </AlertDescription>
        </Alert>
      )}
      {showAccuracyWarning && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t('modelSettings.accuracyWarningTitle')}</AlertTitle>
          <AlertDescription>{t('modelSettings.accuracyWarning')}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

// ============================================================
// Component
// ============================================================

/**
 * LLM 模型指派客戶端主組件
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
  const [assignments, setAssignments] = useState<StageAssignments | null>(null)

  // 載入完成後帶入目前指派
  useEffect(() => {
    if (data?.assignments) {
      setAssignments(data.assignments)
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
    const groups: ModelGroup[] = []
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

  const coreStages = useMemo(() => LLM_STAGES.filter((s) => s.isCore), [])
  const lowRiskStages = useMemo(() => LLM_STAGES.filter((s) => !s.isCore), [])

  /** 有異動且已選妥模型的環節（送出的 payload 只含這些） */
  const changedStageKeys = useMemo(() => {
    if (!data?.assignments || !assignments) return []
    return LLM_STAGES.filter(
      (s) => assignments[s.key] !== data.assignments[s.key]
    ).map((s) => s.key)
  }, [data, assignments])

  const hasChanges = changedStageKeys.length > 0

  /** 任一異動環節留空即不可儲存（避免送出空 id 被後端拒絕） */
  const allChangedSelected = useMemo(
    () => !!assignments && changedStageKeys.every((key) => !!assignments[key]),
    [assignments, changedStageKeys]
  )

  // --- Handlers ---
  const handleStageChange = (stageKey: string, value: string) => {
    setAssignments((prev) => (prev ? { ...prev, [stageKey]: value } : prev))
  }

  const handleSave = async () => {
    if (!assignments) return
    const payload: StageAssignments = {}
    for (const key of changedStageKeys) {
      payload[key] = assignments[key]
    }

    try {
      await updateMutation.mutateAsync(payload)
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
  if (isError || !assignments) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-destructive">
          {t('modelSettings.loadError')}
        </CardContent>
      </Card>
    )
  }

  const renderStage = (stage: LlmStageDefinition) => (
    <StageAssignmentRow
      key={stage.key}
      stage={stage}
      value={assignments[stage.key] ?? ''}
      modelById={modelById}
      modelGroups={modelGroups}
      disabled={!isGlobalAdmin || updateMutation.isPending}
      gatewayEnabled={data?.gatewayEnabled ?? false}
      onChange={(value) => handleStageChange(stage.key, value)}
    />
  )

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
            {t('modelSettings.coreCardTitle')}
          </CardTitle>
          <CardDescription>
            {t('modelSettings.coreCardDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {coreStages.map(renderStage)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            {t('modelSettings.lowRiskCardTitle')}
          </CardTitle>
          <CardDescription>
            {t('modelSettings.lowRiskCardDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {lowRiskStages.map(renderStage)}
        </CardContent>
      </Card>

      {isGlobalAdmin && (
        <div className="flex items-center justify-end gap-3">
          {hasChanges && (
            <span className="text-sm text-muted-foreground">
              {t('modelSettings.pendingChanges', {
                count: changedStageKeys.length,
              })}
            </span>
          )}
          <Button
            onClick={handleSave}
            disabled={
              !hasChanges || !allChangedSelected || updateMutation.isPending
            }
          >
            {updateMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {t('modelSettings.save')}
          </Button>
        </div>
      )}
    </div>
  )
}
