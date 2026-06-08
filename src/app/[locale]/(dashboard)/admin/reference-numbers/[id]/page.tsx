/**
 * @fileoverview Reference Number 編輯頁面
 * @description
 *   提供編輯 Reference Number 的表單頁面：
 *   - 載入現有資料
 *   - 顯示唯讀欄位（code, matchCount）
 *   - 提交後導向列表頁
 *   - Toast 通知成功/失敗
 *
 * @module src/app/(dashboard)/admin/reference-numbers/[id]
 * @since Epic 20 - Story 20.6 (Management Page - Form & Import)
 * @lastModified 2026-02-05
 */

'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import { useParams } from 'next/navigation'
import { ArrowLeft, Hash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Link, useRouter } from '@/i18n/routing'
import { useToast } from '@/hooks/use-toast'
import {
  useReferenceNumber,
  useUpdateReferenceNumber,
} from '@/hooks/use-reference-numbers'
import {
  ReferenceNumberForm,
} from '@/components/features/reference-number'
import type { ReferenceNumberFormValues } from '@/components/features/reference-number/ReferenceNumberForm'

// ============================================================
// Page Component
// ============================================================

export default function EditReferenceNumberPage() {
  const t = useTranslations('referenceNumber')
  const router = useRouter()
  const { toast } = useToast()
  const params = useParams<{ id: string }>()
  const id = params.id

  const { data: item, isLoading } = useReferenceNumber(id)
  const updateMutation = useUpdateReferenceNumber()

  const handleSubmit = async (values: ReferenceNumberFormValues) => {
    try {
      await updateMutation.mutateAsync({
        id,
        input: {
          number: values.number,
          type: values.type,
          year: values.year,
          regionId: values.regionId,
          description: values.description || null,
          validFrom: values.validFrom ? values.validFrom.toISOString() : null,
          validUntil: values.validUntil ? values.validUntil.toISOString() : null,
        },
      })
      toast({ title: t('messages.updated') })
      router.push('/admin/reference-numbers')
    } catch {
      toast({
        variant: 'destructive',
        title: t('messages.updateFailed'),
      })
    }
  }

  // --- Loading State ---

  if (isLoading) {
    return (
      <div className="container mx-auto py-6">
        <Skeleton className="h-8 w-32 mb-4" />
        <Skeleton className="h-[500px] w-full rounded-lg" />
      </div>
    )
  }

  // --- Not Found ---

  if (!item) {
    return (
      <div className="container mx-auto py-6">
        <Button variant="ghost" className="mb-4" asChild>
          <Link href="/admin/reference-numbers">
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t('title')}
          </Link>
        </Button>
        <p className="text-muted-foreground">{t('notFound')}</p>
      </div>
    )
  }

  // --- Render ---

  return (
    <div className="container mx-auto py-6">
      {/* 返回連結 */}
      <Button variant="ghost" className="mb-4" asChild>
        <Link href="/admin/reference-numbers">
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('title')}
        </Link>
      </Button>

      {/* 表單卡片 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Hash className="h-5 w-5" />
            {t('edit.title')}
          </CardTitle>
          <p className="text-sm text-muted-foreground">{t('edit.description')}</p>
        </CardHeader>
        <CardContent>
          <ReferenceNumberForm
            defaultValues={{
              number: item.number,
              type: item.type as ReferenceNumberFormValues['type'],
              year: item.year,
              regionId: item.regionId,
              description: item.description || '',
              validFrom: item.validFrom ? new Date(item.validFrom) : null,
              validUntil: item.validUntil ? new Date(item.validUntil) : null,
            }}
            onSubmit={handleSubmit}
            isEditing
            code={item.code}
            matchCount={item.matchCount}
          />
        </CardContent>
      </Card>
    </div>
  )
}
