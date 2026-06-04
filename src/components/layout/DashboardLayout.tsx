/**
 * @fileoverview DashboardLayout Component - 儀表板佈局容器組件
 *
 * @description
 *   提供應用程式儀表板的整體佈局結構，整合側邊欄、頂部工具列和主要內容區域。
 *   支援響應式設計，在移動端使用 overlay 側邊欄，在桌面端使用固定側邊欄。
 *
 * @component DashboardLayout
 *
 * @features
 *   - 固定側邊欄（桌面端 w-72）
 *   - 響應式移動端 overlay 側邊欄
 *   - 頂部工具列整合
 *   - 主要內容區域
 *   - 側邊欄收合功能
 *
 * @since CHANGE-001 - Dashboard Layout Redesign
 * @lastModified 2025-12-21
 *
 * @dependencies
 *   - @/components/layout/Sidebar - 側邊欄組件
 *   - @/components/layout/TopBar - 頂部工具列組件
 */

'use client'

import * as React from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { SessionGuard } from '@/components/layout/SessionGuard'

// ============================================================
// Types
// ============================================================

interface DashboardLayoutProps {
  children: React.ReactNode
}

// ============================================================
// Component
// ============================================================

/**
 * @component DashboardLayout
 * @description 儀表板佈局容器，整合側邊欄、頂部工具列和主要內容區域
 */
export function DashboardLayout({ children }: DashboardLayoutProps) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = React.useState(false)

  // 關閉移動端選單
  const closeMobileMenu = React.useCallback(() => {
    setIsMobileMenuOpen(false)
  }, [])

  // 處理 Escape 鍵關閉移動端選單
  React.useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeMobileMenu()
      }
    }

    if (isMobileMenuOpen) {
      document.addEventListener('keydown', handleEscape)
      // 防止背景滾動
      document.body.style.overflow = 'hidden'
    }

    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = ''
    }
  }, [isMobileMenuOpen, closeMobileMenu])

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-950">
      {/* Session 守衛：session 過期時導回登入頁（FIX-061） */}
      <SessionGuard />

      {/* Desktop Sidebar - 固定在左側 */}
      <div
        className={cn(
          'hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:flex-col transition-all duration-300',
          isSidebarCollapsed ? 'lg:w-16' : 'lg:w-72'
        )}
      >
        <Sidebar
          isCollapsed={isSidebarCollapsed}
          onCollapsedChange={setIsSidebarCollapsed}
        />
      </div>

      {/* Mobile Sidebar Overlay */}
      {isMobileMenuOpen && (
        <div className="relative z-50 lg:hidden">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-gray-900/80 transition-opacity"
            onClick={closeMobileMenu}
          />

          {/* Sidebar Panel */}
          <div className="fixed inset-0 flex">
            <div className="relative flex w-full max-w-xs flex-1">
              {/* Close button */}
              <div className="absolute left-full top-0 flex w-16 justify-center pt-5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-white hover:bg-white/10"
                  onClick={closeMobileMenu}
                >
                  <X className="h-6 w-6" />
                  <span className="sr-only">關閉選單</span>
                </Button>
              </div>

              {/* Sidebar */}
              <Sidebar />
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div
        className={cn(
          'transition-all duration-300',
          isSidebarCollapsed ? 'lg:pl-16' : 'lg:pl-72'
        )}
      >
        {/* Top Bar - 固定在頂部 */}
        <div className="sticky top-0 z-40">
          <TopBar onMenuClick={() => setIsMobileMenuOpen(true)} />
        </div>

        {/* Main Content */}
        <main className="px-4 py-6 sm:px-6 lg:px-8">
          <div className="max-w-[1600px] mx-auto">{children}</div>
        </main>
      </div>
    </div>
  )
}
