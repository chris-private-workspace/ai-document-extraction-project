/**
 * @fileoverview Dashboard 佈局組件
 * @description
 *   儀表板區域的共用佈局，包含側邊欄導航、頂部工具列和主要內容區域。
 *   此佈局僅適用於已認證用戶。
 *
 *   設計特點：
 *   - 固定側邊欄導航（桌面端 288px）
 *   - 響應式移動端 overlay 側邊欄
 *   - 頂部工具列（搜尋、通知、主題切換、用戶選單）
 *   - 主要內容區域最大寬度 1600px
 *
 * @module src/app/(dashboard)/layout
 * @author Development Team
 * @since Epic 1 - Story 1.1 (Azure AD SSO Login)
 * @lastModified 2025-12-21
 *
 * @features
 *   - 用戶 Session 驗證
 *   - 側邊欄導航（分類選單）
 *   - 頂部工具列
 *   - 響應式設計
 *   - 主題切換支援
 *
 * @dependencies
 *   - next-auth - Session 獲取
 *   - @/components/layout/DashboardLayout - 儀表板佈局組件
 *
 * @related
 *   - src/lib/auth.ts - NextAuth 配置
 *   - src/components/layout/DashboardLayout.tsx - 佈局容器
 *   - src/components/layout/Sidebar.tsx - 側邊欄組件
 *   - src/components/layout/TopBar.tsx - 頂部工具列
 *
 * @change CHANGE-001 - Dashboard Layout Redesign (2025-12-21)
 */

import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { DashboardLayout } from '@/components/layout/DashboardLayout'

export default async function DashboardRootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()

  // 未認證用戶重定向至登入頁面
  //
  // FIX-170：判斷取用 `session?.user` 而非裸物件。Auth.js 在伺服器配置錯誤時
  // （AUTH_SECRET 未設、provider 配置缺失、資料庫不可用）會讓 auth() 回傳帶 error
  // 的物件而非 null，裸檢查 `!session` 因而 fail open（GHSA-8fpg-xm3f-6cx3）。
  // next-auth 5.0.0-beta.32 已修正該行為，此處改寫是不把保證寄託在單一套件版本上。
  if (!session?.user) {
    redirect('/auth/login')
  }

  return <DashboardLayout>{children}</DashboardLayout>
}
