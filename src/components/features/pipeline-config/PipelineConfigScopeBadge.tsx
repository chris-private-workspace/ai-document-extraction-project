'use client'

/**
 * @fileoverview Pipeline Config Scope Badge 組件
 * @description
 *   根據 PipelineConfig 的 scope（GLOBAL/REGION/COMPANY）
 *   顯示不同顏色的徽章。
 *
 * @module src/components/features/pipeline-config/PipelineConfigScopeBadge
 * @since CHANGE-032 - Pipeline Reference Number Matching & FX Conversion
 * @lastModified 2026-02-08
 */

import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// ============================================================
// Types
// ============================================================

interface PipelineConfigScopeBadgeProps {
  scope: 'GLOBAL' | 'REGION' | 'COMPANY' | 'FORMAT'
  className?: string
}

// ============================================================
// Constants
// ============================================================

const SCOPE_STYLES: Record<string, string> = {
  GLOBAL: 'bg-blue-100 text-blue-800 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400',
  REGION: 'bg-green-100 text-green-800 hover:bg-green-100 dark:bg-green-900/30 dark:text-green-400',
  COMPANY: 'bg-orange-100 text-orange-800 hover:bg-orange-100 dark:bg-orange-900/30 dark:text-orange-400',
  FORMAT: 'bg-purple-100 text-purple-800 hover:bg-purple-100 dark:bg-purple-900/30 dark:text-purple-400',
}

// ============================================================
// Component
// ============================================================

/**
 * Pipeline Config Scope 徽章
 */
export function PipelineConfigScopeBadge({
  scope,
  className,
}: PipelineConfigScopeBadgeProps) {
  const t = useTranslations('pipelineConfig')

  return (
    <Badge
      variant="outline"
      className={cn(SCOPE_STYLES[scope], className)}
    >
      {t(`scope.${scope}`)}
    </Badge>
  )
}
