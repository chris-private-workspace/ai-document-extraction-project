'use client'

/**
 * @fileoverview Exchange Rate 編輯頁面
 * @description
 *   提供編輯匯率的頁面：
 *   - 載入現有匯率資料
 *   - 整合 ExchangeRateForm 組件
 *   - 成功後導向列表頁
 *
 * @module src/app/[locale]/(dashboard)/admin/exchange-rates/[id]
 * @since Epic 21 - Story 21.7 (Management Page - Form)
 * @lastModified 2026-02-06
 */

import * as React from 'react'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowLeft, Coins, Loader2, AlertCircle } from 'lucide-react'
import { Link } from '@/i18n/routing'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { useExchangeRate } from '@/hooks/use-exchange-rates'
import { ExchangeRateForm } from '@/components/features/exchange-rate'

// ============================================================
// Loading Skeleton
// ============================================================

function FormSkeleton() {
  return (
    <div className="space-y-6">
      {/* 貨幣選擇 */}
      <div className="flex items-end gap-4">
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-full" />
        </div>
        <Skeleton className="h-6 w-6 mb-2" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
      {/* 匯率 */}
      <div className="space-y-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-4 w-48" />
      </div>
      {/* 年份 */}
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-full" />
      </div>
      {/* 日期 */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-full" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
      {/* 說明 */}
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-20 w-full" />
      </div>
      {/* 按鈕 */}
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

export default function EditExchangeRatePage() {
  const t = useTranslations('exchangeRate')
  const params = useParams<{ id: string }>()
  const id = params.id

  // --- 查詢現有資料 ---
  const { data, isLoading, error } = useExchangeRate(id)

  // --- 載入中狀態 ---
  if (isLoading) {
    return (
      <div className="container mx-auto py-6">
        <Button variant="ghost" className="mb-4" asChild>
          <Link href="/admin/exchange-rates">
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
          <Link href="/admin/exchange-rates">
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
              : 'Failed to load exchange rate'}
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
        <Link href="/admin/exchange-rates">
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('title')}
        </Link>
      </Button>

      {/* 表單卡片 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Coins className="h-5 w-5" />
            {t('form.title.edit')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ExchangeRateForm initialData={data} />
        </CardContent>
      </Card>
    </div>
  )
}
