/**
 * @fileoverview 疑似重複公司審核頁面
 * @description
 *   CHANGE-103 Phase 2（組件 4）：灰帶 JIT 建立的 PENDING 疑似重複公司人工審核頁。
 *   - 顯示待審核佇列（PENDING 公司 + 疑似重複目標 + 文件數）
 *   - 兩個審核動作：確認為新公司 / 併入疑似目標
 *   - 需 FORWARDER_VIEW 檢視；動作需 FORWARDER_MANAGE
 *
 * @module src/app/(dashboard)/admin/companies/duplicate-review/page
 * @since CHANGE-103 Phase 2（組件 4）
 * @lastModified 2026-07-16
 *
 * @dependencies
 *   - @/hooks/use-duplicate-review - 審核佇列資料獲取與動作
 *
 * @related
 *   - src/app/api/companies/pending/route.ts - 審核佇列 API
 */

import { Suspense } from 'react'
import { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { hasPermission } from '@/lib/auth/city-permission'
import { PERMISSIONS } from '@/types/permissions'
import { Skeleton } from '@/components/ui/skeleton'
import { DuplicateReviewContent } from './duplicate-review-content'

// ============================================================
// Metadata
// ============================================================

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('companies')
  return {
    title: t('duplicateReview.pageTitle'),
    description: t('duplicateReview.metaDescription'),
  }
}

// ============================================================
// Loading Component
// ============================================================

function DuplicateReviewSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-24" />
      </div>
      <div className="rounded-lg border">
        <div className="border-b p-4">
          <div className="flex gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-32" />
            ))}
          </div>
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="border-b p-4 last:border-b-0">
            <div className="flex items-center gap-4">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-6 w-16 rounded-full" />
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-8 w-48" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ============================================================
// Page Component
// ============================================================

export default async function DuplicateReviewPage() {
  const session = await auth()

  if (!session?.user) {
    redirect('/auth/login')
  }

  const hasViewPerm = hasPermission(session.user, PERMISSIONS.FORWARDER_VIEW)
  if (!hasViewPerm) {
    redirect('/unauthorized')
  }

  const hasManagePerm = hasPermission(session.user, PERMISSIONS.FORWARDER_MANAGE)

  return (
    <div className="container mx-auto py-6 space-y-6">
      <Suspense fallback={<DuplicateReviewSkeleton />}>
        <DuplicateReviewContent canManage={hasManagePerm} />
      </Suspense>
    </div>
  )
}
