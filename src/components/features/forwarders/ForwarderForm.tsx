'use client'

/**
 * @fileoverview Forwarder 表單組件（國際化版本）
 * @description
 *   提供 Forwarder 創建和編輯的表單。
 *   支援即時代碼驗證、Logo 上傳和表單驗證。
 *   - 完整國際化支援
 *
 * @module src/components/features/forwarders/ForwarderForm
 * @author Development Team
 * @since Epic 5 - Story 5.5 (新增/停用貨代商配置)
 * @lastModified 2026-01-17
 *
 * @features
 *   - 創建/編輯模式
 *   - 即時代碼唯一性驗證（debounce）
 *   - Logo 上傳和預覽
 *   - Zod 表單驗證
 *   - 提交狀態管理
 *   - 完整國際化支援
 *
 * @dependencies
 *   - next-intl - 國際化
 *   - react-hook-form - 表單管理
 *   - @hookform/resolvers/zod - Zod 驗證
 *   - use-debounce - Debounce Hook
 *   - @/types/forwarder - 類型和驗證 Schema
 */

import * as React from 'react'
import { useTranslations } from 'next-intl'
import { useCallback, useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useDebouncedCallback } from 'use-debounce'
import { useRouter } from 'next/navigation'
import { Loader2, Check, X, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Slider } from '@/components/ui/slider'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { cn } from '@/lib/utils'
import { LogoUploader } from './LogoUploader'
import {
  CreateForwarderSchema,
  CreateForwarderFormData,
} from '@/types/forwarder'

// ============================================================
// Types
// ============================================================

interface ForwarderFormProps {
  /** 編輯模式的初始數據 */
  initialData?: {
    id: string
    name: string
    code: string
    description?: string | null
    contactEmail?: string | null
    defaultConfidence?: number
    logoUrl?: string | null
  }
  /** 是否為編輯模式 */
  isEdit?: boolean
  /** 自定義 className */
  className?: string
}

interface CodeCheckState {
  status: 'idle' | 'checking' | 'available' | 'taken' | 'error'
  message?: string
}

// ============================================================
// Component
// ============================================================

/**
 * @component ForwarderForm
 * @description
 *   Forwarder 創建/編輯表單。
 *   提供完整的表單驗證、即時代碼檢查和 Logo 上傳功能。
 */
export function ForwarderForm({
  initialData,
  isEdit = false,
  className,
}: ForwarderFormProps) {
  const t = useTranslations('companies')
  const router = useRouter()
  const isEditMode = isEdit || !!initialData?.id
  // CHANGE-095: 已有 code 的公司維持鎖定；僅空 code 可補填
  const isCodeLocked = isEditMode && !!initialData?.code

  // 動態標題和描述
  const title = isEditMode ? t('form.editTitle') : t('form.title')
  const description = t('form.description')
  const submitLabel = isEditMode ? t('form.submitEdit') : t('form.submit')

  // --- State ---
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [removeLogo, setRemoveLogo] = useState(false)
  const [codeCheck, setCodeCheck] = useState<CodeCheckState>({ status: 'idle' })

  // --- Form ---
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreateForwarderFormData>({
    resolver: zodResolver(CreateForwarderSchema),
    defaultValues: {
      name: initialData?.name || '',
      code: initialData?.code || '',
      description: initialData?.description || '',
      contactEmail: initialData?.contactEmail || '',
      defaultConfidence: initialData?.defaultConfidence || 0.8,
    },
  })

  const watchedCode = watch('code')
  const watchedConfidence = watch('defaultConfidence')

  // --- Code Check ---
  const checkCodeAvailability = useDebouncedCallback(async (code: string) => {
    // 如果是編輯模式且代碼未變更，跳過檢查
    if (isEditMode && code === initialData?.code) {
      setCodeCheck({ status: 'idle' })
      return
    }

    // 驗證代碼格式
    if (!code || code.length < 2) {
      setCodeCheck({ status: 'idle' })
      return
    }

    if (!/^[A-Z0-9_]+$/.test(code)) {
      setCodeCheck({
        status: 'error',
        message: t('form.codeCheck.invalidFormat'),
      })
      return
    }

    setCodeCheck({ status: 'checking' })

    try {
      // CHANGE-095: 編輯模式補填時排除自身，避免誤判自身 code 佔用
      const checkUrl = isEditMode && initialData?.id
        ? `/api/companies/check-code?code=${encodeURIComponent(code)}&excludeId=${initialData.id}`
        : `/api/companies/check-code?code=${encodeURIComponent(code)}`
      const response = await fetch(checkUrl)
      const data = await response.json()

      if (data.success && data.data.available) {
        setCodeCheck({
          status: 'available',
          message: t('form.codeCheck.available'),
        })
      } else {
        setCodeCheck({
          status: 'taken',
          message: t('form.codeCheck.taken'),
        })
      }
    } catch {
      setCodeCheck({
        status: 'error',
        message: t('form.codeCheck.error'),
      })
    }
  }, 300)

  // 監聽代碼變更
  useEffect(() => {
    if (watchedCode) {
      checkCodeAvailability(watchedCode)
    }
  }, [watchedCode, checkCodeAvailability])

  // --- Handlers ---
  const handleLogoChange = useCallback((file: File | null) => {
    setLogoFile(file)
    if (file) {
      setRemoveLogo(false)
    }
  }, [])

  const handleRemoveLogo = useCallback(() => {
    setRemoveLogo(true)
    setLogoFile(null)
  }, [])

  const onSubmit = async (data: CreateForwarderFormData) => {
    // 檢查代碼是否可用（創建或補填皆須擋 taken）
    if (codeCheck.status === 'taken') {
      setSubmitError(t('form.codeCheck.taken'))
      return
    }

    setIsSubmitting(true)
    setSubmitError(null)

    try {
      // FIX-102: 後端 POST/PUT 皆解析 'data' JSON blob，故以單一 payload 送出
      const payload: Record<string, unknown> = {
        name: data.name,
        defaultConfidence: data.defaultConfidence,
      }
      // CHANGE-095: 已鎖定的 code 不送出，僅創建或補空值時送
      if (!isCodeLocked && data.code) {
        payload.code = data.code
      }
      if (data.description) {
        payload.description = data.description
      }
      if (data.contactEmail) {
        payload.contactEmail = data.contactEmail
      }

      const formData = new FormData()
      formData.append('data', JSON.stringify(payload))
      if (logoFile) {
        formData.append('logo', logoFile)
      }
      if (removeLogo) {
        formData.append('removeLogo', 'true')
      }

      const url = isEditMode && initialData?.id ? `/api/companies/${initialData.id}` : '/api/companies'
      const method = isEditMode ? 'PUT' : 'POST'

      const response = await fetch(url, {
        method,
        body: formData,
      })

      const result = await response.json()

      if (!response.ok || !result.success) {
        throw new Error(result.error?.detail || t('form.submitError'))
      }

      // 成功後跳轉
      router.push('/companies')
      router.refresh()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : t('form.submitErrorRetry'))
    } finally {
      setIsSubmitting(false)
    }
  }

  // --- Render Helpers ---
  const renderCodeStatus = () => {
    switch (codeCheck.status) {
      case 'checking':
        return (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('form.codeCheck.checking')}
          </span>
        )
      case 'available':
        return (
          <span className="flex items-center gap-1 text-xs text-green-600">
            <Check className="h-3 w-3" />
            {codeCheck.message}
          </span>
        )
      case 'taken':
        return (
          <span className="flex items-center gap-1 text-xs text-destructive">
            <X className="h-3 w-3" />
            {codeCheck.message}
          </span>
        )
      case 'error':
        return (
          <span className="flex items-center gap-1 text-xs text-destructive">
            <AlertCircle className="h-3 w-3" />
            {codeCheck.message}
          </span>
        )
      default:
        return null
    }
  }

  // --- Render ---
  return (
    <Card className={cn('w-full max-w-2xl', className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          {/* 錯誤提示 */}
          {submitError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}

          {/* 基本資訊區 */}
          <div className="grid gap-4 sm:grid-cols-2">
            {/* 名稱 */}
            <div className="space-y-2">
              <Label htmlFor="name">{t('form.name')}</Label>
              <Input
                id="name"
                placeholder={t('form.namePlaceholder')}
                {...register('name')}
                disabled={isSubmitting}
              />
              {errors.name && (
                <p className="text-xs text-destructive">{errors.name.message}</p>
              )}
            </div>

            {/* 代碼 */}
            <div className="space-y-2">
              <Label htmlFor="code">{t('form.code')}</Label>
              <Input
                id="code"
                placeholder={t('form.codePlaceholder')}
                {...register('code', {
                  onChange: (e) => {
                    // 自動轉大寫
                    e.target.value = e.target.value.toUpperCase()
                  },
                })}
                disabled={isSubmitting || isCodeLocked}
                className="uppercase"
              />
              {errors.code ? (
                <p className="text-xs text-destructive">{errors.code.message}</p>
              ) : (
                <div className="h-4">{renderCodeStatus()}</div>
              )}
              <p className="text-xs text-muted-foreground">
                {t('form.codeDescription')}
              </p>
            </div>
          </div>

          {/* 描述 */}
          <div className="space-y-2">
            <Label htmlFor="description">{t('form.descriptionField')}</Label>
            <Textarea
              id="description"
              placeholder={t('form.descriptionPlaceholder')}
              rows={3}
              {...register('description')}
              disabled={isSubmitting}
            />
            {errors.description && (
              <p className="text-xs text-destructive">{errors.description.message}</p>
            )}
          </div>

          {/* 聯絡信箱 */}
          <div className="space-y-2">
            <Label htmlFor="contactEmail">{t('form.contactEmail')}</Label>
            <Input
              id="contactEmail"
              type="email"
              placeholder={t('form.contactEmailPlaceholder')}
              {...register('contactEmail')}
              disabled={isSubmitting}
            />
            {errors.contactEmail && (
              <p className="text-xs text-destructive">{errors.contactEmail.message}</p>
            )}
          </div>

          {/* 預設信心度 */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label>{t('form.defaultConfidence')}</Label>
              <span className="text-sm font-medium">
                {Math.round((watchedConfidence || 0.8) * 100)}%
              </span>
            </div>
            <Slider
              value={[watchedConfidence || 0.8]}
              min={0}
              max={1}
              step={0.05}
              onValueChange={(value) => setValue('defaultConfidence', value[0])}
              disabled={isSubmitting}
              className="py-2"
            />
            <p className="text-xs text-muted-foreground">
              {t('form.defaultConfidenceDescription')}
            </p>
          </div>

          {/* Logo 上傳 */}
          <div className="space-y-2">
            <Label>{t('form.logo')}</Label>
            <LogoUploader
              currentLogoUrl={removeLogo ? null : initialData?.logoUrl}
              onLogoChange={handleLogoChange}
              onRemoveLogo={handleRemoveLogo}
              disabled={isSubmitting}
            />
          </div>

          {/* 操作按鈕 */}
          <div className="flex justify-end gap-3 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.back()}
              disabled={isSubmitting}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || codeCheck.status === 'taken'}
            >
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {submitLabel}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
