/**
 * @fileoverview 編輯數據模版頁面（國際化版本）
 * @description
 *   提供編輯現有數據模版的表單頁面
 *   系統模版為唯讀模式
 *   - i18n 國際化支援 (Epic 17)
 *
 * @module src/app/(dashboard)/admin/data-templates/[id]
 * @since Epic 16 - Story 16.7
 * @lastModified 2026-01-20
 */

'use client';

import * as React from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FileCode, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import { DataTemplateForm } from '@/components/features/data-template';
import {
  useDataTemplate,
  useUpdateDataTemplate,
} from '@/hooks/use-data-templates';
import type { DataTemplateField } from '@/types/data-template';

// ============================================================================
// Types
// ============================================================================

interface FormValues {
  name: string;
  description?: string | null;
  scope: 'GLOBAL' | 'COMPANY';
  companyId?: string | null;
  fields: DataTemplateField[];
  isActive?: boolean;
}

// ============================================================================
// Page Component
// ============================================================================

export default function EditDataTemplatePage() {
  const router = useRouter();
  const params = useParams();
  const { toast } = useToast();
  const t = useTranslations('dataTemplates');

  const id = params.id as string;

  // --- Queries ---
  const { data: template, isLoading, error } = useDataTemplate(id);

  // --- Mutations ---
  const updateMutation = useUpdateDataTemplate();

  // --- Handlers ---

  const handleSubmit = React.useCallback(
    async (data: FormValues) => {
      try {
        await updateMutation.mutateAsync({
          id,
          input: {
            name: data.name,
            description: data.description ?? null,
            fields: data.fields,
          },
        });

        toast({
          title: t('toast.updateSuccess'),
          description: t('toast.updateSuccessDesc', { name: data.name }),
        });

        router.push('/admin/data-templates');
      } catch (err) {
        toast({
          variant: 'destructive',
          title: t('toast.updateFailed'),
          description: err instanceof Error ? err.message : t('page.unknownError'),
        });
      }
    },
    [id, updateMutation, router, toast, t]
  );

  const handleCancel = React.useCallback(() => {
    router.push('/admin/data-templates');
  }, [router]);

  // --- Loading State ---
  if (isLoading) {
    return (
      <div className="container mx-auto py-6">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  // --- Error State ---
  if (error || !template) {
    return (
      <div className="container mx-auto py-6">
        <Alert variant="destructive">
          <AlertDescription>
            {error?.message || t('edit.notFound')}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // --- Render ---
  const isReadOnly = template.isSystem;

  return (
    <div className="container mx-auto py-6">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <FileCode className="h-6 w-6" />
          {isReadOnly ? t('edit.viewTitle') : t('edit.editTitle')}
        </h1>
        <p className="text-muted-foreground">
          {isReadOnly
            ? t('edit.viewDescription')
            : t('edit.editDescription', { name: template.name })}
        </p>
      </div>

      {/* Read-Only Notice */}
      {isReadOnly && (
        <Alert className="mb-6">
          <AlertDescription>
            {t('edit.systemNotice')}
          </AlertDescription>
        </Alert>
      )}

      {/* Form */}
      <DataTemplateForm
        initialData={template}
        isEditMode={true}
        readOnly={isReadOnly}
        isSubmitting={updateMutation.isPending}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
      />
    </div>
  );
}
