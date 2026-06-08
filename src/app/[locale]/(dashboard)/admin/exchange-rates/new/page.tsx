/**
 * @fileoverview Exchange Rate 新增頁面
 * @description
 *   提供新增匯率的頁面：
 *   - 整合 ExchangeRateForm 組件
 *   - 支援反向匯率同時建立
 *   - 成功後導向列表頁
 *
 * @module src/app/[locale]/(dashboard)/admin/exchange-rates/new
 * @since Epic 21 - Story 21.7 (Management Page - Form)
 * @lastModified 2026-02-06
 */

import { getTranslations } from 'next-intl/server'
import { ArrowLeft, Coins } from 'lucide-react'
import { Link } from '@/i18n/routing'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ExchangeRateForm } from '@/components/features/exchange-rate'

// ============================================================
// Page Component
// ============================================================

export default async function NewExchangeRatePage() {
  const t = await getTranslations('exchangeRate')

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
            {t('form.title.create')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ExchangeRateForm />
        </CardContent>
      </Card>
    </div>
  )
}
