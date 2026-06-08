'use client';

/**
 * @fileoverview FieldDefinitionSet 新增頁面
 * @description
 *   提供新增 FieldDefinitionSet 的頁面：
 *   - 整合 FieldDefinitionSetForm 組件
 *   - 含 FieldCandidatePicker 候選欄位選擇
 *   - 成功後導向列表頁
 *
 * @module src/app/[locale]/(dashboard)/admin/field-definition-sets/new
 * @since CHANGE-042 Phase 3
 * @lastModified 2026-02-23
 */

import { useTranslations } from 'next-intl';
import { ArrowLeft, Layers } from 'lucide-react';
import { Link } from '@/i18n/routing';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { FieldDefinitionSetForm } from '@/components/features/field-definition-set';

// ============================================================
// Page
// ============================================================

export default function NewFieldDefinitionSetPage() {
  const t = useTranslations('fieldDefinitionSet');

  return (
    <div className="container mx-auto py-6">
      {/* Back link */}
      <Button variant="ghost" className="mb-4" asChild>
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
            {t('form.title.create')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FieldDefinitionSetForm />
        </CardContent>
      </Card>
    </div>
  );
}
