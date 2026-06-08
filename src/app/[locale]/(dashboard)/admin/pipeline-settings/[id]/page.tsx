'use client'

/**
 * @fileoverview Pipeline Config 編輯頁面
 * @description
 *   提供編輯管線配置的頁面：
 *   - 載入現有配置資料
 *   - 整合 PipelineConfigForm 組件
 *   - 成功後導向列表頁
 *
 * @module src/app/[locale]/(dashboard)/admin/pipeline-settings/[id]
 * @since CHANGE-032 - Pipeline Reference Number Matching & FX Conversion
 * @lastModified 2026-02-08
 */

import * as React from 'react'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowLeft, Settings2, Loader2, AlertCircle } from 'lucide-react'
import { Link } from '@/i18n/routing'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { usePipelineConfig } from '@/hooks/use-pipeline-configs'
import { PipelineConfigForm } from '@/components/features/pipeline-config'

// ============================================================
// Loading Skeleton
// ============================================================

function FormSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-full" />
      </div>
      <Skeleton className="h-px w-full" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-12 w-full" />
      </div>
      <Skeleton className="h-px w-full" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-12 w-full" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-20 w-full" />
      </div>
      <div className="flex gap-4">
        <Skeleton className="h-10 w-20" />
        <Skeleton className="h-10 w-20" />
      </div>
    </div>
  )
}

// ============================================================
// Page Component
// ============================================================

export default function EditPipelineConfigPage() {
  const t = useTranslations('pipelineConfig')
  const params = useParams<{ id: string }>()
  const id = params.id

  // --- 查詢現有資料 ---
  const { data, isLoading, error } = usePipelineConfig(id)

  // --- 載入中狀態 ---
  if (isLoading) {
    return (
      <div className="container mx-auto py-6">
        <Button variant="ghost" className="mb-4" asChild>
          <Link href="/admin/pipeline-settings">
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t('title')}
          </Link>
        </Button>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              {t('form.title.edit')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <FormSkeleton />
          </CardContent>
        </Card>
      </div>
    )
  }

  // --- 錯誤狀態 ---
  if (error || !data) {
    return (
      <div className="container mx-auto py-6">
        <Button variant="ghost" className="mb-4" asChild>
          <Link href="/admin/pipeline-settings">
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t('title')}
          </Link>
        </Button>

        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            {error instanceof Error
              ? error.message
              : 'Failed to load pipeline config'}
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  // --- 正常渲染 ---
  return (
    <div className="container mx-auto py-6">
      {/* 返回連結 */}
      <Button variant="ghost" className="mb-4" asChild>
        <Link href="/admin/pipeline-settings">
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('title')}
        </Link>
      </Button>

      {/* 表單卡片 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings2 className="h-5 w-5" />
            {t('form.title.edit')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <PipelineConfigForm initialData={data} />
        </CardContent>
      </Card>
    </div>
  )
}
