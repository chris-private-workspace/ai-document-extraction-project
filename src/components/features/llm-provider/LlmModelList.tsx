'use client'

/**
 * @fileoverview LLM 模型列表表格（Epic 23 - Story 23.2）
 * @description
 *   某 provider 底下的模型列表：標籤、modelKey、能力旗標（Vision/JSON/Temperature）、
 *   maxTokens、啟用狀態、操作（編輯/刪除，限 globalAdmin）。
 *
 * @module src/components/features/llm-provider/LlmModelList
 * @since Epic 23 - Story 23.2
 * @lastModified 2026-07-10
 *
 * @dependencies
 *   - next-intl - 國際化
 *   - @/components/ui/* - shadcn/ui 組件
 *   - @/hooks/use-llm-models - 型別
 */

import * as React from 'react'
import { useTranslations } from 'next-intl'
import { Pencil, Trash2 } from 'lucide-react'
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
import type { LlmModelPublic } from '@/hooks/use-llm-models'

// ============================================================
// Types
// ============================================================

interface LlmModelListProps {
  models: LlmModelPublic[]
  isGlobalAdmin: boolean
  onEdit: (model: LlmModelPublic) => void
  onDelete: (model: LlmModelPublic) => void
}

// ============================================================
// Component
// ============================================================

/**
 * LLM 模型列表表格組件
 */
export function LlmModelList({ models, isGlobalAdmin, onEdit, onDelete }: LlmModelListProps) {
  const t = useTranslations('llmProviders')

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('models.columns.label')}</TableHead>
          <TableHead>{t('models.columns.modelKey')}</TableHead>
          <TableHead>{t('models.columns.capabilities')}</TableHead>
          <TableHead className="text-right">{t('models.columns.maxTokens')}</TableHead>
          <TableHead className="text-center">{t('models.columns.status')}</TableHead>
          {isGlobalAdmin && (
            <TableHead className="text-right">{t('models.columns.actions')}</TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {models.map((model) => (
          <TableRow key={model.id}>
            <TableCell className="font-medium">{model.label}</TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">
              {model.modelKey}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {model.capability.supportsVision && (
                  <Badge variant="outline">{t('models.capabilities.vision')}</Badge>
                )}
                {model.capability.supportsJsonSchema && (
                  <Badge variant="outline">{t('models.capabilities.jsonSchema')}</Badge>
                )}
                {model.capability.supportsTemperature && (
                  <Badge variant="outline">{t('models.capabilities.temperature')}</Badge>
                )}
              </div>
            </TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">
              {model.capability.maxTokens?.toLocaleString() ?? '—'}
            </TableCell>
            <TableCell className="text-center">
              <Badge variant={model.isEnabled ? 'default' : 'secondary'}>
                {model.isEnabled ? t('badges.enabled') : t('badges.disabled')}
              </Badge>
            </TableCell>
            {isGlobalAdmin && (
              <TableCell>
                <div className="flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onEdit(model)}
                    title={t('models.actions.edit')}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDelete(model)}
                    title={t('models.actions.delete')}
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
