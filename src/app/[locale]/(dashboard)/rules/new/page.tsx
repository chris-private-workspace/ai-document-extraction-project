'use client'

/**
 * @fileoverview 新增映射規則建議頁面
 * @description
 *   Story 4-2: 建議新映射規則
 *   提供創建新規則建議的功能：
 *   - 選擇 Company 和欄位
 *   - 配置提取模式（REGEX, POSITION, KEYWORD, AI_PROMPT, TEMPLATE）
 *   - 即時測試提取效果
 *   - 提交建議或存為草稿
 *
 * @module src/app/(dashboard)/rules/new/page
 * @since Epic 4 - Story 4.2 (建議新映射規則)
 * @lastModified 2026-02-22
 *
 * @dependencies
 *   - @/components/features/rules/NewRuleForm - 新規則表單
 */

import { Suspense } from 'react'
import { useTranslations } from 'next-intl'
import { NewRuleForm } from '@/components/features/rules/NewRuleForm'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ArrowLeft } from 'lucide-react'
import { Link } from '@/i18n/routing'

// ============================================================
// Loading Skeleton
// ============================================================

/**
 * 表單載入骨架
 */
function NewRuleFormSkeleton() {
  return (
    <div className="space-y-6">
      {/* Company 選擇區 */}
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-full" />
      </div>

      {/* 欄位選擇區 */}
      <div className="space-y-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-10 w-full" />
      </div>

      {/* 提取類型選擇 */}
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <div className="flex gap-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-10 w-24" />
          ))}
        </div>
      </div>

      {/* Pattern 編輯器 */}
      <div className="space-y-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-40 w-full" />
      </div>

      {/* 測試面板 */}
      <div className="border rounded-lg p-4 space-y-4">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-10 w-24" />
      </div>

      {/* 提交按鈕 */}
      <div className="flex justify-end gap-4">
        <Skeleton className="h-10 w-28" />
        <Skeleton className="h-10 w-28" />
      </div>
    </div>
  )
}

// ============================================================
// Page Component
// ============================================================

/**
 * 新增映射規則建議頁面
 *
 * @description
 *   提供創建新規則建議的完整界面：
 *   1. 選擇 Company（或通用）
 *   2. 選擇目標欄位
 *   3. 配置提取模式
 *   4. 測試提取效果
 *   5. 提交建議或存為草稿
 */
export default function NewRulePage() {
  const t = useTranslations('rules')

  return (
    <div className="container mx-auto py-6 space-y-6">
      {/* 頁面標題 */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/rules">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold">{t('newRule.pageTitle')}</h1>
          <p className="text-muted-foreground mt-1">
            {t('newRule.pageDescription')}
          </p>
        </div>
      </div>

      {/* 說明卡片 */}
      <div className="bg-muted/50 border rounded-lg p-4">
        <h3 className="font-medium mb-2">{t('newRule.instructions.title')}</h3>
        <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
          <li>{t('newRule.instructions.step1')}</li>
          <li>{t('newRule.instructions.step2')}</li>
          <li>{t('newRule.instructions.step3')}</li>
          <li>{t('newRule.instructions.step4')}</li>
          <li>{t('newRule.instructions.step5')}</li>
        </ol>
      </div>

      {/* 新規則表單 */}
      <Suspense fallback={<NewRuleFormSkeleton />}>
        <NewRuleForm />
      </Suspense>
    </div>
  )
}
