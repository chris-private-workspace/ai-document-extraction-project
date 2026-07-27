/**
 * @fileoverview 公司詳情頁面
 * @description
 *   公司詳情配置檢視頁面，顯示：
 *   - 基本資訊
 *   - 映射規則
 *   - 處理統計
 *   - 近期文件
 *
 *   使用動態路由 [id] 參數獲取特定公司資料。
 *   需要使用者認證和 FORWARDER_VIEW 權限。
 *
 * @module src/app/(dashboard)/companies/[id]/page
 * @author Development Team
 * @since Epic 5 - Story 5.2 (Company Detail Config View)
 * @lastModified 2026-01-28
 *
 * @dependencies
 *   - @/components/features/forwarders/ForwarderDetailView - 詳情組件
 *
 * @related
 *   - src/app/api/companies/[id]/route.ts - Detail API
 *   - src/components/features/forwarders/ForwarderDetailView.tsx - UI 組件
 */

import { getTranslations } from 'next-intl/server'

import { auth } from '@/lib/auth'
import { hasPermission } from '@/lib/auth/city-permission'
import { PERMISSIONS } from '@/types/permissions'
import { ForwarderDetailView } from '@/components/features/forwarders/ForwarderDetailView'

// ============================================================
// Types
// ============================================================

interface PageProps {
  params: Promise<{
    id: string
  }>
}

// ============================================================
// Metadata
// ============================================================

export async function generateMetadata() {
  const t = await getTranslations('companies.detail')
  return {
    title: t('pageTitle'),
    description: t('pageDescription'),
  }
}

// ============================================================
// Page Component
// ============================================================

/**
 * 公司詳情頁面
 *
 * @description
 *   動態路由頁面，根據 URL 中的 id 參數顯示對應公司詳情
 *
 * @param props - 頁面屬性
 * @param props.params - 路由參數（包含 id）
 */
export default async function CompanyDetailPage({ params }: PageProps) {
  const resolvedParams = await params
  const forwarderId = resolvedParams.id

  // FIX-131: 合併入口需 FORWARDER_MANAGE 權限（與合併 API 一致）
  const session = await auth()
  const canManage = session?.user
    ? hasPermission(session.user, PERMISSIONS.FORWARDER_MANAGE)
    : false

  return (
    <div className="container mx-auto py-6 px-4 sm:px-6 lg:px-8">
      <ForwarderDetailView forwarderId={forwarderId} canManage={canManage} />
    </div>
  )
}
