'use client'

/**
 * @fileoverview LLM Provider 管理客戶端主組件
 * @description
 *   後台 provider 列表 + 新增/編輯（Dialog 遮罩憑證）+ 刪除確認 + 連線測試的協調組件。
 *   - 非 globalAdmin：唯讀檢視（無操作按鈕，顯示提示）。
 *   - 憑證一律遮罩；新增/編輯憑證明文輸入後由服務層加密落庫，永不回傳明文。
 *
 * @module src/app/[locale]/(dashboard)/admin/llm-providers/client
 * @since Epic 23 - Story 23.2
 * @lastModified 2026-07-10
 *
 * @dependencies
 *   - next-auth/react - Session（判斷 isGlobalAdmin）
 *   - next-intl - 國際化
 *   - @/hooks/use-llm-providers - Provider CRUD Hooks
 *   - @/hooks/use-toast - Toast 通知
 */

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useSession } from 'next-auth/react'
import { Loader2, Plus } from 'lucide-react'
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
import {
  useDeleteLlmProvider,
  useLlmProviders,
  useTestLlmProviderConnection,
  type LlmProviderMasked,
} from '@/hooks/use-llm-providers'
import { LlmProviderForm } from '@/components/features/llm-provider/LlmProviderForm'
import { LlmProviderList } from '@/components/features/llm-provider/LlmProviderList'

/**
 * LLM Provider 管理客戶端主組件
 */
export function LlmProvidersClient() {
  const t = useTranslations('llmProviders')
  const { toast } = useToast()
  const { data: session } = useSession()
  const isGlobalAdmin = session?.user?.isGlobalAdmin ?? false

  // --- Data ---
  const { data: providers, isLoading, isError } = useLlmProviders()
  const deleteMutation = useDeleteLlmProvider()
  const testMutation = useTestLlmProviderConnection()

  // --- State ---
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LlmProviderMasked | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)

  // --- Handlers ---
  const openCreate = () => {
    setEditingId(null)
    setFormOpen(true)
  }

  const openEdit = (id: string) => {
    setEditingId(id)
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    setEditingId(null)
  }

  const handleTest = async (id: string) => {
    setTestingId(id)
    try {
      const result = await testMutation.mutateAsync(id)
      if (!result.supported) {
        toast({ title: t('test.unsupported') })
      } else if (result.success) {
        toast({ title: t('test.success') })
      } else {
        toast({
          title: t('test.failed'),
          description: result.statusCode
            ? t('test.statusCode', { code: result.statusCode })
            : undefined,
          variant: 'destructive',
        })
      }
    } catch (error) {
      toast({
        title: t('test.failed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setTestingId(null)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    try {
      await deleteMutation.mutateAsync(deleteTarget.id)
      toast({ title: t('messages.deleted') })
    } catch (error) {
      toast({
        title: t('messages.deleteError'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setDeleteTarget(null)
    }
  }

  // --- Loading state ---
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // --- Error state ---
  if (isError || !providers) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-destructive">
          {t('loadError')}
        </CardContent>
      </Card>
    )
  }

  // --- Render ---
  return (
    <div className="space-y-4">
      {!isGlobalAdmin && (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800 dark:border-yellow-900/40 dark:bg-yellow-900/20 dark:text-yellow-300">
          {t('readOnlyNotice')}
        </div>
      )}

      {isGlobalAdmin && (
        <div className="flex justify-end">
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            {t('addProvider')}
          </Button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {providers.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {t('empty')}
            </div>
          ) : (
            <LlmProviderList
              providers={providers}
              isGlobalAdmin={isGlobalAdmin}
              testingId={testingId}
              onTest={handleTest}
              onEdit={openEdit}
              onDelete={setDeleteTarget}
            />
          )}
        </CardContent>
      </Card>

      {/* 新增/編輯 Dialog */}
      <Dialog open={formOpen} onOpenChange={(open) => !open && closeForm()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingId ? t('form.editTitle') : t('form.createTitle')}
            </DialogTitle>
            <DialogDescription>
              {editingId ? t('form.editDescription') : t('form.createDescription')}
            </DialogDescription>
          </DialogHeader>
          {formOpen && (
            <LlmProviderForm
              providerId={editingId ?? undefined}
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
            <AlertDialogTitle>{t('delete.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('delete.description', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t('delete.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleDeleteConfirm()
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {t('delete.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
