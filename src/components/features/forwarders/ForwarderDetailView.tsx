'use client'

/**
 * @fileoverview Forwarder 詳情檢視主組件（國際化版本）
 * @description
 *   整合 Forwarder 詳情頁面的所有子組件，提供：
 *   - 標題區域（名稱、狀態、返回按鈕）
 *   - Tabs 導航（總覽、規則、統計、文件）
 *   - 各 Tab 內容區域
 *   - 完整國際化支援
 *
 * @module src/components/features/forwarders/ForwarderDetailView
 * @author Development Team
 * @since Epic 5 - Story 5.2 (Forwarder Detail Config View)
 * @lastModified 2026-01-17
 *
 * @changelog
 *   - 2026-01-17 (Epic 17): 國際化支援
 *   - 2026-01-12 (Story 16-1): 新增「格式」Tab，顯示公司文件格式列表
 *
 * @dependencies
 *   - next-intl - 國際化
 *   - @/hooks/use-forwarder-detail - 數據獲取
 *   - @/types/forwarder - 類型定義
 *   - @/components/ui - UI 組件
 */

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useForwarderDetail } from '@/hooks/use-forwarder-detail'
import { ForwarderInfo } from './ForwarderInfo'
import { ForwarderStatsPanel } from './ForwarderStatsPanel'
import { ForwarderRulesTable } from './ForwarderRulesTable'
import { RecentDocumentsTable } from './RecentDocumentsTable'
import { FormatList } from '@/components/features/formats'
import { MergeCompanyButton } from '@/components/features/companies'
import { TemplateMatchingConfigAlert } from '@/components/features/template-match/TemplateMatchingConfigAlert'
// REFACTOR-001: 從 company.ts 導入 ForwarderDetailView 類型（已棄用的 forwarder 類型）
import type { ForwarderDetailView } from '@/types/company'
import {
  LEGACY_FORWARDER_STATUS_CONFIG,
  getForwarderDisplayStatus,
} from '@/types/forwarder'
import { ArrowLeft, Building2, RefreshCw } from 'lucide-react'
import Link from 'next/link'

// ============================================================
// Types
// ============================================================

interface ForwarderDetailViewProps {
  /** Forwarder ID */
  forwarderId: string
  /** 是否具管理權限（FORWARDER_MANAGE），控制合併等操作入口顯示（FIX-131） */
  canManage?: boolean
}

// ============================================================
// Sub Components
// ============================================================

/**
 * 載入狀態骨架屏
 */
function DetailSkeleton() {
  return (
    <div className="space-y-6">
      {/* 標題骨架 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Skeleton className="h-10 w-10 rounded-lg" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
        <Skeleton className="h-8 w-20" />
      </div>

      {/* Tabs 骨架 */}
      <Skeleton className="h-10 w-full max-w-md" />

      {/* 內容骨架 */}
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    </div>
  )
}

/**
 * 錯誤狀態顯示
 */
function ErrorDisplay({ message, t }: { message: string; t: (key: string) => string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="rounded-full bg-destructive/10 p-4 mb-4">
        <Building2 className="h-8 w-8 text-destructive" />
      </div>
      <h2 className="text-lg font-semibold mb-2">{t('detail.loadFailed')}</h2>
      <p className="text-muted-foreground mb-4">{message}</p>
      <Link href="/companies">
        <Button variant="outline">
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('detail.backToList')}
        </Button>
      </Link>
    </div>
  )
}

/**
 * 404 狀態顯示
 */
function NotFoundDisplay({ t }: { t: (key: string) => string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="rounded-full bg-muted p-4 mb-4">
        <Building2 className="h-8 w-8 text-muted-foreground" />
      </div>
      <h2 className="text-lg font-semibold mb-2">{t('detail.notFound')}</h2>
      <p className="text-muted-foreground mb-4">
        {t('detail.notFoundDescription')}
      </p>
      <Link href="/companies">
        <Button variant="outline">
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('detail.backToList')}
        </Button>
      </Link>
    </div>
  )
}

// ============================================================
// Main Component
// ============================================================

/**
 * Forwarder 詳情檢視主組件
 *
 * @description
 *   整合所有詳情頁面子組件，提供 Tabs 導航
 *
 * @param props - 組件屬性
 * @param props.forwarderId - Forwarder ID
 */
export function ForwarderDetailView({
  forwarderId,
  canManage = false,
}: ForwarderDetailViewProps) {
  const t = useTranslations('companies')

  // 獲取 Forwarder 詳情
  // REFACTOR-001: useForwarderDetail 返回 { company: ... }
  // company 類型為 CompanyDetailView，ForwarderDetailView 是其 type alias
  const { company: forwarder, isLoading, error, refetch } = useForwarderDetail(forwarderId)

  // 載入中狀態
  if (isLoading) {
    return <DetailSkeleton />
  }

  // 錯誤狀態
  if (error) {
    return <ErrorDisplay message={error.message} t={t} />
  }

  // 找不到資料
  if (!forwarder) {
    return <NotFoundDisplay t={t} />
  }

  // 計算狀態顯示
  const displayStatus = getForwarderDisplayStatus(forwarder.isActive)
  const statusI18nKey = forwarder.isActive ? 'active' : 'inactive'

  return (
    <div className="space-y-6">
      {/* 頁面標題區 */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          {/* 返回按鈕 */}
          <Link href="/companies">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>

          {/* Logo 和名稱 */}
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
              <Building2 className="h-6 w-6 text-primary" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold">
                  {forwarder.displayName || forwarder.name}
                </h1>
                <Badge className={LEGACY_FORWARDER_STATUS_CONFIG[displayStatus].className}>
                  {t(`status.${statusI18nKey}`)}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground font-mono">
                {forwarder.code}
              </p>
            </div>
          </div>
        </div>

        {/* 操作按鈕 */}
        <div className="flex items-center gap-2">
          {/* FIX-131: 合併公司入口（僅具管理權限時顯示） */}
          {canManage && (
            <MergeCompanyButton
              currentCompany={{
                id: forwarderId,
                name: forwarder.name,
                documentCount: forwarder.stats?.totalDocuments,
              }}
              onMerged={() => refetch()}
            />
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {t('actions.refresh')}
          </Button>
        </div>
      </div>

      {/* Tabs 導航 */}
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="grid w-full max-w-xl grid-cols-5">
          <TabsTrigger value="overview">{t('detail.overview')}</TabsTrigger>
          <TabsTrigger value="rules">{t('detail.rules')}</TabsTrigger>
          <TabsTrigger value="formats">{t('detail.formats')}</TabsTrigger>
          <TabsTrigger value="stats">{t('detail.stats')}</TabsTrigger>
          <TabsTrigger value="documents">{t('detail.documents')}</TabsTrigger>
        </TabsList>

        {/* 總覽 Tab */}
        <TabsContent value="overview" className="space-y-4">
          {/* CHANGE-037: 自動匹配配置狀態提醒 */}
          <TemplateMatchingConfigAlert companyId={forwarderId} />
          <ForwarderInfo forwarder={forwarder} />
        </TabsContent>

        {/* 規則 Tab */}
        <TabsContent value="rules" className="space-y-4">
          <ForwarderRulesTable forwarderId={forwarderId} />
        </TabsContent>

        {/* 格式 Tab (Story 16-1) */}
        <TabsContent value="formats" className="space-y-4">
          <FormatList companyId={forwarderId} />
        </TabsContent>

        {/* 統計 Tab */}
        <TabsContent value="stats" className="space-y-4">
          <ForwarderStatsPanel stats={forwarder.stats} />
        </TabsContent>

        {/* 文件 Tab */}
        <TabsContent value="documents" className="space-y-4">
          <RecentDocumentsTable forwarderId={forwarderId} limit={10} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
