'use client'

/**
 * @fileoverview 配置編輯對話框組件
 * @description
 *   用於編輯配置值的對話框，支援不同類型的輸入欄位。
 *
 * @module src/components/features/admin/config/ConfigEditDialog
 * @author Development Team
 * @since Epic 12 - Story 12-4 (系統設定管理)
 * @lastModified 2025-12-21
 *
 * @dependencies
 *   - lucide-react - 圖示
 *
 * @related
 *   - src/components/features/admin/config/ConfigItem.tsx - 配置項目
 *   - src/hooks/use-system-config.ts - 配置 Hooks
 */

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle, Shield } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { ConfigValue } from '@/types/config'

// ============================================================
// Types
// ============================================================

interface ConfigEditDialogProps {
  /** 是否開啟 */
  open: boolean
  /** 關閉回調 */
  onOpenChange: (open: boolean) => void
  /** 配置項目 */
  config: ConfigValue
  /** 儲存回調 */
  onSave: (key: string, value: unknown, changeReason?: string) => Promise<void>
  /** 是否正在儲存 */
  isSaving?: boolean
}

// ============================================================
// Component
// ============================================================

/**
 * 配置編輯對話框組件
 *
 * @description
 *   支援以下值類型的編輯：
 *   - STRING: 文字輸入
 *   - NUMBER: 數值輸入（含範圍驗證）
 *   - BOOLEAN: 下拉選擇
 *   - JSON: 多行文字輸入
 *   - ENUM: 下拉選擇
 *   - SECRET: 密碼輸入
 */
export function ConfigEditDialog({
  open,
  onOpenChange,
  config,
  onSave,
  isSaving = false,
}: ConfigEditDialogProps) {
  const [value, setValue] = useState<string>(
    typeof config.value === 'object'
      ? JSON.stringify(config.value, null, 2)
      : String(config.value ?? '')
  )
  const [changeReason, setChangeReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const t = useTranslations('systemSettings')

  /**
   * 解析並驗證值
   */
  const parseValue = (): { valid: boolean; parsed: unknown; error?: string } => {
    try {
      switch (config.valueType) {
        case 'NUMBER': {
          const num = parseFloat(value)
          if (isNaN(num)) {
            return { valid: false, parsed: null, error: t('config.editDialog.errors.invalidNumber') }
          }
          if (config.validation?.min !== undefined && num < config.validation.min) {
            return { valid: false, parsed: null, error: t('config.editDialog.errors.minValue', { min: config.validation.min }) }
          }
          if (config.validation?.max !== undefined && num > config.validation.max) {
            return { valid: false, parsed: null, error: t('config.editDialog.errors.maxValue', { max: config.validation.max }) }
          }
          return { valid: true, parsed: num }
        }
        case 'BOOLEAN':
          return { valid: true, parsed: value === 'true' }
        case 'JSON':
          try {
            return { valid: true, parsed: JSON.parse(value) }
          } catch {
            return { valid: false, parsed: null, error: t('config.editDialog.errors.invalidJson') }
          }
        case 'ENUM':
          if (config.validation?.options && !config.validation.options.includes(value)) {
            return { valid: false, parsed: null, error: t('config.editDialog.errors.invalidOption') }
          }
          return { valid: true, parsed: value }
        default:
          return { valid: true, parsed: value }
      }
    } catch {
      return { valid: false, parsed: null, error: t('config.editDialog.errors.invalidValue') }
    }
  }

  /**
   * 提交處理
   */
  const handleSubmit = async () => {
    // 敏感配置需要確認
    if (config.isEncrypted && !confirmed) {
      setError(t('config.editDialog.errors.confirmRequired'))
      return
    }

    // 解析值
    const { valid, parsed, error: parseError } = parseValue()
    if (!valid) {
      setError(parseError || t('config.editDialog.errors.invalidValue'))
      return
    }

    setError(null)

    try {
      await onSave(config.key, parsed, changeReason || undefined)
      onOpenChange(false)
    } catch {
      setError(t('config.editDialog.errors.saveFailed'))
    }
  }

  /**
   * 渲染輸入欄位
   */
  const renderInput = () => {
    switch (config.valueType) {
      case 'BOOLEAN':
        return (
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger>
              <SelectValue placeholder={t('config.editDialog.selectPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">{t('config.editDialog.booleanTrue')}</SelectItem>
              <SelectItem value="false">{t('config.editDialog.booleanFalse')}</SelectItem>
            </SelectContent>
          </Select>
        )

      case 'ENUM':
        return (
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger>
              <SelectValue placeholder={t('config.editDialog.selectPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {config.validation?.options?.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )

      case 'JSON':
        return (
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={8}
            className="font-mono text-sm"
            placeholder={t('config.editDialog.jsonPlaceholder')}
          />
        )

      case 'NUMBER':
        return (
          <Input
            type="number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            min={config.validation?.min}
            max={config.validation?.max}
            step={
              config.validation?.min !== undefined && config.validation.min < 1 ? 0.01 : 1
            }
          />
        )

      case 'SECRET':
        return (
          <Input
            type="password"
            autoComplete="new-password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t('config.editDialog.secretPlaceholder')}
          />
        )

      default:
        return (
          <Input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t('config.editDialog.title', { name: config.name })}</DialogTitle>
          <DialogDescription>{config.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* 影響說明 */}
          {config.impactNote && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{config.impactNote}</AlertDescription>
            </Alert>
          )}

          {/* 效果類型提示 */}
          {config.effectType !== 'IMMEDIATE' && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {t('config.editDialog.effectNote', {
                  effect: t(`config.effectType.${config.effectType}`),
                })}
                {config.effectType === 'RESTART_REQUIRED' &&
                  t('config.editDialog.restartRequiredSuffix')}
              </AlertDescription>
            </Alert>
          )}

          {/* 值輸入 */}
          <div className="space-y-2">
            <Label htmlFor="config-value">{t('config.editDialog.valueLabel')}</Label>
            {renderInput()}
            {config.validation && (
              <p className="text-xs text-muted-foreground">
                {config.validation.min !== undefined &&
                  config.validation.max !== undefined && (
                    <>
                      {t('config.editDialog.range', {
                        min: config.validation.min,
                        max: config.validation.max,
                      })}
                    </>
                  )}
                {config.validation.pattern && (
                  <>{t('config.editDialog.pattern', { pattern: config.validation.pattern })}</>
                )}
              </p>
            )}
          </div>

          {/* 變更原因 */}
          <div className="space-y-2">
            <Label htmlFor="change-reason">
              {t('config.editDialog.changeReasonLabel')}{' '}
              <span className="text-muted-foreground">{t('config.editDialog.optional')}</span>
            </Label>
            <Input
              id="change-reason"
              value={changeReason}
              onChange={(e) => setChangeReason(e.target.value)}
              placeholder={t('config.editDialog.changeReasonPlaceholder')}
            />
          </div>

          {/* 敏感配置確認 */}
          {config.isEncrypted && (
            <Alert>
              <Shield className="h-4 w-4" />
              <AlertDescription>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="confirm-sensitive"
                    checked={confirmed}
                    onCheckedChange={(checked) => setConfirmed(checked as boolean)}
                  />
                  <label htmlFor="confirm-sensitive" className="text-sm cursor-pointer">
                    {t('config.editDialog.confirmSensitive')}
                  </label>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {/* 錯誤訊息 */}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t('actions.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={isSaving}>
            {isSaving ? t('config.editDialog.saving') : t('actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
