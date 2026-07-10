'use client'

/**
 * @fileoverview LLM Provider 模型管理客戶端主組件
 * @description
 *   某 provider 底下模型列表 + 新增/編輯（Dialog）+ 刪除確認的協調組件。
 *   - 非 globalAdmin：唯讀檢視（無操作按鈕，顯示提示）。
 *   - `isEnabled` 決定該模型是否出現在 model-settings 的環節指派下拉。
 *
 * @module src/app/[locale]/(dashboard)/admin/llm-providers/[id]/models/client
 * @since Epic 23 - Story 23.2
 * @lastModified 2026-07-10
 *
 * @dependencies
 *   - next-auth/react - Session（判斷 isGlobalAdmin）
 *   - next-intl - 國際化
 *   - @/hooks/use-llm-models - 模型 CRUD Hooks
 *   - @/hooks/use-llm-providers - Provider 單筆查詢（取名稱）
 *   - @/hooks/use-toast - Toast 通知
 */

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useSession } from 'next-auth/react'
import { ArrowLeft, Loader2, Plus } from 'lucide-react'
import { Link } from '@/i18n/routing'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { useToast } from '@/hooks/use-toast'
import { useLlmProvider } from '@/hooks/use-llm-providers'
import { useDeleteLlmModel, useProviderModels, type LlmModelPublic } from '@/hooks/use-llm-models'
import { LlmModelForm } from '@/components/features/llm-provider/LlmModelForm'
import { LlmModelList } from '@/components/features/llm-provider/LlmModelList'

interface LlmProviderModelsClientProps {
  providerId: string
}

/**
 * LLM Provider 模型管理客戶端主組件
 */
export function LlmProviderModelsClient({ providerId }: LlmProviderModelsClientProps) {
  const t = useTranslations('llmProviders')
  const { toast } = useToast()
  const { data: session } = useSession()
  const isGlobalAdmin = session?.user?.isGlobalAdmin ?? false

  // --- Data ---
  const { data: provider } = useLlmProvider(providerId)
  const { data: models, isLoading, isError } = useProviderModels(providerId)
  const deleteMutation = useDeleteLlmModel(providerId)

  // --- State ---
  const [formOpen, setFormOpen] = useState(false)
  const [editingModel, setEditingModel] = useState<LlmModelPublic | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LlmModelPublic | null>(null)

  // --- Handlers ---
  const openCreate = () => {
    setEditingModel(null)
    setFormOpen(true)
  }

  const openEdit = (model: LlmModelPublic) => {
    setEditingModel(model)
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    setEditingModel(null)
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    try {
      await deleteMutation.mutateAsync(deleteTarget.id)
      toast({ title: t('models.messages.deleted') })
    } catch (error) {
      toast({
        title: t('models.messages.deleteError'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setDeleteTarget(null)
    }
  }

  return (
    <div className="space-y-4">
      {/* 返回 + 標題 */}
      <div>
        <Button variant="ghost" size="sm" asChild className="mb-2 -ml-2">
          <Link href="/admin/llm-providers">
            <ArrowLeft className="mr-1 h-4 w-4" />
            {t('models.backToProviders')}
          </Link>
        </Button>
        <h1 className="text-3xl font-bold tracking-tight">
          {t('models.pageTitle', { name: provider?.name ?? '' })}
        </h1>
        <p className="text-muted-foreground">{t('models.pageDescription')}</p>
      </div>

      {!isGlobalAdmin && (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800 dark:border-yellow-900/40 dark:bg-yellow-900/20 dark:text-yellow-300">
          {t('models.readOnlyNotice')}
        </div>
      )}

      {isGlobalAdmin && (
        <div className="flex justify-end">
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            {t('models.addModel')}
          </Button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : isError || !models ? (
            <div className="py-8 text-center text-sm text-destructive">
              {t('models.loadError')}
            </div>
          ) : models.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {t('models.empty')}
            </div>
          ) : (
            <LlmModelList
              models={models}
              isGlobalAdmin={isGlobalAdmin}
              onEdit={openEdit}
              onDelete={setDeleteTarget}
            />
          )}
        </CardContent>
      </Card>

      {/* 新增/編輯 Dialog */}
      <Dialog open={formOpen} onOpenChange={(open) => !open && closeForm()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingModel ? t('models.form.editTitle') : t('models.form.createTitle')}
            </DialogTitle>
            <DialogDescription>
              {editingModel
                ? t('models.form.editDescription')
                : t('models.form.createDescription')}
            </DialogDescription>
          </DialogHeader>
          {formOpen && (
            <LlmModelForm
              providerId={providerId}
              model={editingModel ?? undefined}
              onSuccess={closeForm}
              onCancel={closeForm}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* 刪除確認 */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('models.delete.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('models.delete.description', { label: deleteTarget?.label ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t('models.delete.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleDeleteConfirm()
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('models.delete.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
