/**
 * @fileoverview Pipeline Config 新增頁面
 * @description
 *   提供新增管線配置的頁面：
 *   - 整合 PipelineConfigForm 組件
 *   - 成功後導向列表頁
 *
 * @module src/app/[locale]/(dashboard)/admin/pipeline-settings/new
 * @since CHANGE-032 - Pipeline Reference Number Matching & FX Conversion
 * @lastModified 2026-02-08
 */

import { getTranslations } from 'next-intl/server'
import { ArrowLeft, Settings2 } from 'lucide-react'
import { Link } from '@/i18n/routing'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PipelineConfigForm } from '@/components/features/pipeline-config'

// ============================================================
// Page Component
// ============================================================

export default async function NewPipelineConfigPage() {
  const t = await getTranslations('pipelineConfig')

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
            {t('form.title.create')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <PipelineConfigForm />
        </CardContent>
      </Card>
    </div>
  )
}
