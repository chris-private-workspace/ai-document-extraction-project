'use client';

/**
 * @fileoverview FieldDefinitionSet 編輯頁面
 * @description
 *   提供編輯 FieldDefinitionSet 的頁面：
 *   - 載入現有資料
 *   - 整合 FieldDefinitionSetForm 組件
 *   - 顯示 FieldCoverageSummary 回饋面板
 *   - 成功後導向列表頁
 *
 * @module src/app/[locale]/(dashboard)/admin/field-definition-sets/[id]
 * @since CHANGE-042 Phase 3
 * @lastModified 2026-02-23
 */

import * as React from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Layers, Loader2, AlertCircle } from 'lucide-react';
import { Link } from '@/i18n/routing';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { useFieldDefinitionSet } from '@/hooks/use-field-definition-sets';
import {
  FieldDefinitionSetForm,
  FieldCoverageSummary,
} from '@/components/features/field-definition-set';

// ============================================================
// Page
// ============================================================

export default function EditFieldDefinitionSetPage() {
  const t = useTranslations('fieldDefinitionSet');
  const params = useParams<{ id: string }>();
  const id = params.id;

  const { data, isLoading, error } = useFieldDefinitionSet(id);

  // Loading
  if (isLoading) {
    return (
      <div className="container mx-auto py-6">
        <Button variant="ghost" className="mb-4" asChild>
          <Link href="/admin/field-definition-sets">
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t('title')}
          </Link>
        </Button>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              {t('form.title.edit')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Error
  if (error || !data) {
    return (
      <div className="container mx-auto py-6">
        <Button variant="ghost" className="mb-4" asChild>
          <Link href="/admin/field-definition-sets">
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t('title')}
          </Link>
        </Button>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            {error instanceof Error
              ? error.message
              : 'Failed to load field definition set'}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6 space-y-6">
      {/* Back link */}
      <Button variant="ghost" asChild>
        <Link href="/admin/field-definition-sets">
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('title')}
        </Link>
      </Button>

      {/* Form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5" />
            {t('form.title.edit')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FieldDefinitionSetForm initialData={data} />
        </CardContent>
      </Card>

      <Separator />

      {/* Coverage Summary */}
      <Card>
        <CardContent className="pt-6">
          <FieldCoverageSummary fieldDefinitionSetId={id} />
        </CardContent>
      </Card>
    </div>
  );
}
