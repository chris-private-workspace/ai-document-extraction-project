'use client'

/**
 * @fileoverview Pipeline Config 列表組件
 * @description
 *   顯示 Pipeline Config 資料表格，支援：
 *   - 排序（點擊欄位標題切換升序/降序）
 *   - 分頁導航
 *   - 操作選單（編輯、刪除）
 *   - Scope Badge 顯示
 *   - RefMatch / FX 啟用狀態
 *
 * @module src/components/features/pipeline-config/PipelineConfigList
 * @since CHANGE-032 - Pipeline Reference Number Matching & FX Conversion
 * @lastModified 2026-02-08
 *
 * @dependencies
 *   - next-intl - 國際化
 *   - @/components/ui/table - 表格基礎組件
 *   - @/hooks/use-pipeline-configs - React Query hooks
 *   - @/i18n/routing - i18n-aware 路由
 */

import * as React from 'react'
import { useTranslations } from 'next-intl'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  MoreHorizontal,
  Pencil,
  Trash2,
  ArrowUpDown,
} from 'lucide-react'
import { Link } from '@/i18n/routing'
import { useToast } from '@/hooks/use-toast'
import {
  useDeletePipelineConfig,
  type PipelineConfigItem,
} from '@/hooks/use-pipeline-configs'
import { PipelineConfigScopeBadge } from './PipelineConfigScopeBadge'

// ============================================================
// Types
// ============================================================

interface PaginationInfo {
  page: number
  limit: number
  total: number
  totalPages: number
}

interface PipelineConfigListProps {
  data: PipelineConfigItem[]
  pagination?: PaginationInfo
  isLoading: boolean
  currentSortBy?: string
  currentSortOrder?: 'asc' | 'desc'
  onPageChange: (page: number) => void
  onSortChange: (sortBy: string, sortOrder: 'asc' | 'desc') => void
}

// ============================================================
// Component
// ============================================================

/**
 * Pipeline Config 列表表格
 */
export function PipelineConfigList({
  data,
  pagination,
  isLoading,
  currentSortBy = 'createdAt',
  currentSortOrder = 'desc',
  onPageChange,
  onSortChange,
}: PipelineConfigListProps) {
  const t = useTranslations('pipelineConfig')
  const { toast } = useToast()
  const [deleteId, setDeleteId] = React.useState<string | null>(null)

  const deleteMutation = useDeletePipelineConfig()

  // --- Handlers ---

  const handleSort = React.useCallback(
    (column: string) => {
      const isSameColumn = currentSortBy === column
      const newOrder = isSameColumn && currentSortOrder === 'asc' ? 'desc' : 'asc'
      onSortChange(column, newOrder)
    },
    [currentSortBy, currentSortOrder, onSortChange]
  )

  const handleDelete = React.useCallback(
    async (id: string) => {
      try {
        await deleteMutation.mutateAsync(id)
        toast({ title: t('messages.deleted') })
      } catch {
        toast({
          variant: 'destructive',
          title: t('messages.deleteFailed'),
        })
      }
      setDeleteId(null)
    },
    [deleteMutation, toast, t]
  )

  /**
   * 取得 Region/Company 顯示名稱
   */
  const getTargetLabel = React.useCallback(
    (item: PipelineConfigItem): string => {
      if (item.scope === 'GLOBAL') return t('list.global')
      if (item.scope === 'REGION' && item.region) return item.region.name
      if (item.scope === 'COMPANY' && item.company) return item.company.name
      // CHANGE-071: FORMAT scope 顯示「公司 / 格式名」
      if (item.scope === 'FORMAT' && item.documentFormat) {
        const fmt = item.documentFormat
        const name = fmt.name || fmt.id
        return fmt.company ? `${fmt.company.name} / ${name}` : name
      }
      return '-'
    },
    [t]
  )

  // --- Loading State ---

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  // --- Render ---

  return (
    <>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {/* Scope - 可排序 */}
              <TableHead className="w-28">
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-3 h-8"
                  onClick={() => handleSort('scope')}
                >
                  {t('list.scope')}
                  <ArrowUpDown className="ml-2 h-3 w-3" />
                </Button>
              </TableHead>
              {/* Target */}
              <TableHead className="w-48">{t('list.target')}</TableHead>
              {/* Ref Match */}
              <TableHead className="w-28">{t('list.refMatch')}</TableHead>
              {/* FX Conversion */}
              <TableHead className="w-28">{t('list.fxConversion')}</TableHead>
              {/* Status */}
              <TableHead className="w-24">{t('list.status')}</TableHead>
              {/* Description */}
              <TableHead>{t('list.description')}</TableHead>
              {/* Actions */}
              <TableHead className="w-20">{t('list.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8">
                  {t('list.empty')}
                </TableCell>
              </TableRow>
            ) : (
              data.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <PipelineConfigScopeBadge scope={item.scope} />
                  </TableCell>
                  <TableCell className="text-sm">
                    {getTargetLabel(item)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={item.refMatchEnabled ? 'default' : 'secondary'}>
                      {item.refMatchEnabled
                        ? t('list.enabled')
                        : t('list.disabled')}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={item.fxConversionEnabled ? 'default' : 'secondary'}>
                      {item.fxConversionEnabled
                        ? t('list.enabled')
                        : t('list.disabled')}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={item.isActive ? 'default' : 'secondary'}>
                      {item.isActive
                        ? t('filters.active')
                        : t('filters.inactive')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground truncate max-w-[200px]">
                    {item.description || '-'}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link href={`/admin/pipeline-settings/${item.id}`}>
                            <Pencil className="h-4 w-4 mr-2" />
                            {t('actions.edit')}
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => setDeleteId(item.id)}
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          {t('actions.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* 分頁 */}
      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between pt-4">
          <div className="text-sm text-muted-foreground">
            {t('pagination.showing', {
              from: (pagination.page - 1) * pagination.limit + 1,
              to: Math.min(pagination.page * pagination.limit, pagination.total),
              total: pagination.total,
            })}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page === 1}
              onClick={() => onPageChange(pagination.page - 1)}
            >
              {t('pagination.previous')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page === pagination.totalPages}
              onClick={() => onPageChange(pagination.page + 1)}
            >
              {t('pagination.next')}
            </Button>
          </div>
        </div>
      )}

      {/* 刪除確認對話框 */}
      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('actions.delete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('messages.confirmDelete')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('form.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && handleDelete(deleteId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
