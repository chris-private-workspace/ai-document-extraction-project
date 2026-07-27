import { Suspense } from 'react'
import { auth } from '@/lib/auth'
import { sessionHasPermission } from '@/lib/auth/has-permission'
import { redirect } from 'next/navigation'
import { PERMISSIONS } from '@/types/permissions'
import { ReviewDetailPage } from '@/components/features/rule-review'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * @fileoverview 規則審核詳情頁面
 * @description
 *   規則建議審核詳情頁面，提供：
 *   - 權限檢查（RULE_APPROVE）
 *   - 建議詳情顯示
 *   - 批准/拒絕操作
 *
 * @module src/app/(dashboard)/rules/review/[id]/page
 * @since Epic 4 - Story 4.6 (審核學習規則)
 * @lastModified 2025-12-19
 */

// ============================================================
// Metadata
// ============================================================

export const metadata = {
  title: '規則審核 - Document Extraction',
  description: '審核規則升級建議',
}

// ============================================================
// Types
// ============================================================

interface PageProps {
  params: Promise<{ id: string }>
}

// ============================================================
// Loading Skeleton
// ============================================================

function ReviewPageSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-1/3" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
      <Skeleton className="h-48" />
    </div>
  )
}

// ============================================================
// Page Component
// ============================================================

/**
 * 規則審核詳情頁面
 */
export default async function ReviewPage({ params }: PageProps) {
  const { id } = await params
  const session = await auth()

  // 權限檢查（FIX-134：統一入口，認得 wildcard `*` 與 isGlobalAdmin）
  if (!sessionHasPermission(session?.user, PERMISSIONS.RULE_APPROVE)) {
    redirect('/unauthorized')
  }

  return (
    <div className="container mx-auto py-6">
      <Suspense fallback={<ReviewPageSkeleton />}>
        <ReviewDetailPage suggestionId={id} />
      </Suspense>
    </div>
  )
}
