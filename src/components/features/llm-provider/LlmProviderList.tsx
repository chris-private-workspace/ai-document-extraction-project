'use client'

/**
 * @fileoverview LLM Provider 列表表格（Epic 23 - Story 23.2）
 * @description
 *   後台 provider 列表：名稱（含預設標記）、類型、Base URL、憑證狀態、敏感資料合規、
 *   啟用狀態、操作（測試/編輯/刪除，限 globalAdmin）。憑證一律遮罩，僅顯示是否已設定。
 *
 * @module src/components/features/llm-provider/LlmProviderList
 * @since Epic 23 - Story 23.2
 * @lastModified 2026-07-10
 *
 * @dependencies
 *   - next-intl - 國際化
 *   - @/components/ui/* - shadcn/ui 組件
 *   - @/hooks/use-llm-providers - 型別
 */

import * as React from 'react'
import { useTranslations } from 'next-intl'
import { Check, KeyRound, Loader2, Pencil, PlugZap, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { LlmProviderMasked } from '@/hooks/use-llm-providers'

// ============================================================
// Types
// ============================================================

interface LlmProviderListProps {
  providers: LlmProviderMasked[]
  isGlobalAdmin: boolean
  /** 正在測試連線的 provider ID（顯示 spinner） */
  testingId: string | null
  onTest: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (provider: LlmProviderMasked) => void
}

// ============================================================
// Sub-components
// ============================================================

/** 布林指示（勾選 / 叉） */
function BoolIcon({ value }: { value: boolean }) {
  return value ? (
    <Check className="h-4 w-4 text-green-600" />
  ) : (
    <X className="h-4 w-4 text-muted-foreground" />
  )
}

// ============================================================
// Component
// ============================================================

/**
 * LLM Provider 列表表格組件
 */
export function LlmProviderList({
  providers,
  isGlobalAdmin,
  testingId,
  onTest,
  onEdit,
  onDelete,
}: LlmProviderListProps) {
  const t = useTranslations('llmProviders')

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('columns.name')}</TableHead>
          <TableHead>{t('columns.type')}</TableHead>
          <TableHead>{t('columns.baseUrl')}</TableHead>
          <TableHead className="text-center">{t('columns.apiKey')}</TableHead>
          <TableHead className="text-center">{t('columns.sensitiveData')}</TableHead>
          <TableHead className="text-center">{t('columns.status')}</TableHead>
          {isGlobalAdmin && (
            <TableHead className="text-right">{t('columns.actions')}</TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {providers.map((provider) => (
          <TableRow key={provider.id}>
            {/* 名稱 + 預設標記 */}
            <TableCell className="font-medium">
              <div className="flex items-center gap-2">
                <span>{provider.name}</span>
                {provider.isDefault && (
                  <Badge variant="secondary">{t('badges.default')}</Badge>
                )}
              </div>
            </TableCell>

            {/* 類型 */}
            <TableCell>
              <Badge variant="outline">{t(`types.${provider.providerType}`)}</Badge>
            </TableCell>

            {/* Base URL */}
            <TableCell className="max-w-[220px] truncate text-muted-foreground">
              {provider.baseUrl || '—'}
            </TableCell>

            {/* 憑證狀態 */}
            <TableCell className="text-center">
              {provider.hasApiKey ? (
                <span className="inline-flex items-center gap-1 text-green-600">
                  <KeyRound className="h-4 w-4" />
                  <span className="text-xs">{t('badges.hasKey')}</span>
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {t('badges.noKey')}
                </span>
              )}
            </TableCell>

            {/* 敏感資料合規 */}
            <TableCell className="text-center">
              <div className="flex justify-center">
                <BoolIcon value={provider.allowSensitiveData} />
              </div>
            </TableCell>

            {/* 啟用狀態 */}
            <TableCell className="text-center">
              <Badge variant={provider.isEnabled ? 'default' : 'secondary'}>
                {provider.isEnabled ? t('badges.enabled') : t('badges.disabled')}
              </Badge>
            </TableCell>

            {/* 操作 */}
            {isGlobalAdmin && (
              <TableCell>
                <div className="flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onTest(provider.id)}
                    disabled={testingId === provider.id}
                    title={t('actions.test')}
                  >
                    {testingId === provider.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <PlugZap className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onEdit(provider.id)}
                    title={t('actions.edit')}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDelete(provider)}
                    title={t('actions.delete')}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
