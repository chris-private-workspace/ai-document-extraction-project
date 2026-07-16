/**
 * @fileoverview Sidebar Component - 側邊欄導航組件（國際化版本）
 *
 * @description
 *   提供應用程式側邊欄導航，包含分類導航選單、用戶資訊顯示和收合功能。
 *   支援響應式設計，在移動端作為 overlay 顯示。
 *   完整的國際化支援。
 *
 * @component Sidebar
 *
 * @features
 *   - 分類導航選單（概覽、文件處理、模版管理、提取配置、規則管理、報表、系統管理、開發工具）
 *   - 收合/展開功能
 *   - 當前路徑高亮
 *   - 用戶資訊顯示
 *   - 響應式設計
 *   - i18n 國際化支援 (Epic 17)
 *
 * @since CHANGE-001 - Dashboard Layout Redesign
 * @lastModified 2026-02-06
 *
 * @dependencies
 *   - next-intl - 國際化
 *   - @/i18n/routing - Locale-aware 路由
 *   - lucide-react: 圖示組件
 *   - @/components/ui: shadcn/ui 組件
 */

'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/routing'
import {
  LayoutDashboard,
  Globe,
  FileText,
  Upload,
  ClipboardCheck,
  AlertTriangle,
  GitBranch,
  Building2,
  BarChart3,
  History,
  Users,
  ChevronLeft,
  ChevronRight,
  Database,
  Layers,
  ArrowRightLeft,
  MessageSquareCode,
  Tags,
  FileSpreadsheet,
  Grid3X3,
  FileStack,
  TestTube2,
  Hash,
  DollarSign,
  Wrench,
  Settings2,
  Cpu,
  CopyCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// ============================================================
// Types
// ============================================================

interface NavItem {
  nameKey: string
  href: string
  icon: React.ComponentType<{ className?: string }>
}

interface NavSection {
  titleKey: string
  items: NavItem[]
}

interface SidebarProps {
  isCollapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}

// ============================================================
// Navigation Configuration
// ============================================================

const navigation: NavSection[] = [
  {
    titleKey: 'sections.overview',
    items: [
      { nameKey: 'sidebar.dashboard', href: '/dashboard', icon: LayoutDashboard },
      { nameKey: 'sidebar.globalView', href: '/global', icon: Globe },
    ],
  },
  {
    titleKey: 'sections.documents',
    items: [
      { nameKey: 'sidebar.documents', href: '/documents', icon: FileText },
      { nameKey: 'sidebar.uploadDocument', href: '/documents/upload', icon: Upload },
      { nameKey: 'sidebar.review', href: '/review', icon: ClipboardCheck },
      { nameKey: 'sidebar.escalations', href: '/escalations', icon: AlertTriangle },
    ],
  },
  {
    titleKey: 'sections.templates',
    items: [
      { nameKey: 'sidebar.dataTemplates', href: '/admin/data-templates', icon: FileSpreadsheet },
      { nameKey: 'sidebar.templateFieldMappings', href: '/admin/template-field-mappings', icon: Grid3X3 },
      { nameKey: 'sidebar.templateInstances', href: '/template-instances', icon: FileStack },
    ],
  },
  {
    titleKey: 'sections.extraction',
    items: [
      { nameKey: 'sidebar.fieldDefinitions', href: '/admin/field-definition-sets', icon: Layers },
      { nameKey: 'sidebar.fieldMapping', href: '/admin/field-mapping-configs', icon: ArrowRightLeft },
      { nameKey: 'sidebar.promptConfig', href: '/admin/prompt-configs', icon: MessageSquareCode },
      { nameKey: 'sidebar.termAnalysis', href: '/admin/term-analysis', icon: Tags },
    ],
  },
  {
    titleKey: 'sections.rules',
    items: [
      { nameKey: 'sidebar.mappingRules', href: '/rules', icon: GitBranch },
      { nameKey: 'sidebar.companies', href: '/companies', icon: Building2 },
      { nameKey: 'sidebar.duplicateReview', href: '/admin/companies/duplicate-review', icon: CopyCheck },
      { nameKey: 'sidebar.referenceNumbers', href: '/admin/reference-numbers', icon: Hash },
      { nameKey: 'sidebar.exchangeRates', href: '/admin/exchange-rates', icon: DollarSign },
      { nameKey: 'sidebar.pipelineSettings', href: '/admin/pipeline-settings', icon: Settings2 },
    ],
  },
  {
    titleKey: 'sections.reports',
    items: [
      { nameKey: 'sidebar.analyticsReports', href: '/reports/monthly', icon: BarChart3 },
      { nameKey: 'sidebar.auditLogs', href: '/audit/query', icon: History },
    ],
  },
  {
    titleKey: 'sections.admin',
    items: [
      { nameKey: 'sidebar.systemSettings', href: '/admin/settings', icon: Wrench },
      { nameKey: 'sidebar.modelSettings', href: '/admin/model-settings', icon: Cpu },
      { nameKey: 'sidebar.users', href: '/admin/users', icon: Users },
      { nameKey: 'sidebar.historicalData', href: '/admin/historical-data', icon: Database },
    ],
  },
  {
    titleKey: 'sections.devTools',
    items: [
      { nameKey: 'sidebar.documentPreview', href: '/admin/document-preview-test', icon: Layers },
      { nameKey: 'sidebar.templateMatchingTest', href: '/admin/test/template-matching', icon: TestTube2 },
    ],
  },
]

// ============================================================
// Component
// ============================================================

/**
 * @component Sidebar
 * @description 側邊欄導航組件，提供應用程式主要導航功能
 */
export function Sidebar({ isCollapsed = false, onCollapsedChange }: SidebarProps) {
  const pathname = usePathname()
  const t = useTranslations('navigation')

  const isActiveLink = (href: string) => {
    // 移除 locale 前綴來比較路徑
    const pathWithoutLocale = pathname.replace(/^\/(en|zh-TW|zh-CN)/, '')
    return pathWithoutLocale === href
  }

  return (
    <TooltipProvider delayDuration={0}>
      <div
        className={cn(
          'flex h-full flex-col bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 transition-all duration-300',
          isCollapsed ? 'w-16' : 'w-72'
        )}
      >
        {/* Logo 區域 */}
        <div className="flex h-16 items-center justify-between px-4 border-b border-gray-200 dark:border-gray-800">
          {!isCollapsed && (
            <div className="flex items-center">
              <div className="h-8 w-8 bg-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
                <FileText className="h-5 w-5 text-white" />
              </div>
              <span className="ml-2 text-lg font-semibold text-gray-900 dark:text-white truncate">
                {t('app.name')}
              </span>
            </div>
          )}
          {isCollapsed && (
            <div className="h-8 w-8 bg-blue-600 rounded-lg flex items-center justify-center mx-auto">
              <FileText className="h-5 w-5 text-white" />
            </div>
          )}
          {onCollapsedChange && (
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'h-8 w-8 flex-shrink-0',
                isCollapsed && 'absolute -right-3 top-5 z-50 rounded-full border bg-white dark:bg-gray-900 shadow-md'
              )}
              onClick={() => onCollapsedChange(!isCollapsed)}
            >
              {isCollapsed ? (
                <ChevronRight className="h-4 w-4" />
              ) : (
                <ChevronLeft className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>

        {/* 導航區域 */}
        <ScrollArea className="flex-1 py-4">
          <nav className="space-y-6 px-2">
            {navigation.map((section, sectionIndex) => (
              <div key={section.titleKey}>
                {!isCollapsed && (
                  <h3 className="mb-2 px-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {t(section.titleKey)}
                  </h3>
                )}
                {isCollapsed && sectionIndex > 0 && (
                  <Separator className="my-2" />
                )}
                <ul className={cn('space-y-1', !isCollapsed && 'pl-2')}>
                  {section.items.map((item) => {
                    const Icon = item.icon
                    const isActive = isActiveLink(item.href)
                    const label = t(item.nameKey)

                    if (isCollapsed) {
                      return (
                        <li key={item.nameKey}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Link
                                href={item.href}
                                className={cn(
                                  'flex items-center justify-center rounded-lg p-3 transition-colors',
                                  isActive
                                    ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white'
                                )}
                              >
                                <Icon className="h-5 w-5" />
                              </Link>
                            </TooltipTrigger>
                            <TooltipContent side="right">
                              {label}
                            </TooltipContent>
                          </Tooltip>
                        </li>
                      )
                    }

                    return (
                      <li key={item.nameKey}>
                        <Link
                          href={item.href}
                          className={cn(
                            'flex items-center rounded-lg px-3 py-2 text-sm transition-colors',
                            isActive
                              ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 font-medium'
                              : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white'
                          )}
                        >
                          <Icon className="h-4 w-4 flex-shrink-0" />
                          <span className="ml-3 truncate">{label}</span>
                          {isActive && (
                            <div className="ml-auto h-2 w-2 rounded-full bg-blue-600" />
                          )}
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </nav>
        </ScrollArea>

        {/* 底部版本資訊 */}
        {!isCollapsed && (
          <div className="border-t border-gray-200 dark:border-gray-800 p-4">
            <div className="text-xs text-gray-500 dark:text-gray-400">
              <p>{t('app.fullName')}</p>
              <p>{t('app.version', { version: '1.0.0' })}</p>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}
