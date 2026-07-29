/**
 * @fileoverview 創建模版欄位映射頁面
 * @description
 *   支援 `?copyFrom=<id>` 複製模式（CHANGE-107）：於 server 端載入來源記錄，
 *   讓表單第一次 render 就持有預填值 —— 避免 Radix Select 無法顯示異步載入值
 *   的問題（見 TemplateFieldMappingForm 檔頭說明）。
 *
 * @module src/app/[locale]/(dashboard)/admin/template-field-mappings/new
 * @since Epic 19 - Story 19.4
 * @lastModified 2026-07-25
 */

import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import {
  TemplateFieldMappingForm,
  type TemplateFieldMappingCopySource,
} from '@/components/features/template-field-mapping';
import { prisma } from '@/lib/prisma';
import type { TemplateFieldMappingRule } from '@/types/template-field-mapping';

interface PageProps {
  searchParams: Promise<{ copyFrom?: string }>;
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const t = await getTranslations('templateFieldMapping');
  const { copyFrom } = await searchParams;

  if (copyFrom) {
    return {
      title: t('page.copyTitle'),
      description: t('page.copyDescription'),
    };
  }

  return {
    title: t('page.createTitle'),
    description: t('page.createDescription'),
  };
}

/**
 * 載入複製來源
 * @description
 *   只取可重用的內容欄位。四個身分欄位刻意不取 —— 它們構成
 *   unique_template_mapping 唯一鍵，複製時必須由使用者重選。
 *   找不到來源時回傳 null（退化為一般新建，不阻斷流程）。
 */
async function getCopySource(
  copyFrom: string | undefined
): Promise<TemplateFieldMappingCopySource | null> {
  if (!copyFrom) {
    return null;
  }

  const source = await prisma.templateFieldMapping.findUnique({
    where: { id: copyFrom },
    select: {
      name: true,
      description: true,
      priority: true,
      isActive: true,
      mappings: true,
    },
  });

  if (!source) {
    return null;
  }

  return {
    name: source.name,
    description: source.description,
    priority: source.priority,
    isActive: source.isActive,
    mappings: Array.isArray(source.mappings)
      ? (source.mappings as unknown as TemplateFieldMappingRule[])
      : [],
  };
}

async function getFormData() {
  // Fetch data templates
  const dataTemplates = await prisma.dataTemplate.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      fields: true,
    },
    orderBy: { name: 'asc' },
  });

  // FIX-142: 納入 PENDING（CHANGE-103 Phase 2 灰帶待審核公司），與欄位定義集的公司來源對齊 ——
  //   灰帶公司已綁著文件且可建欄位定義集，卻選不到來建映射，是本頁獨有的缺口。
  //   仍排除 MERGED：那是已併入他人的記錄，不該再掛新映射。
  const companies = await prisma.company.findMany({
    where: { status: { in: ['ACTIVE', 'PENDING'] } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  // Fetch document formats
  const documentFormats = await prisma.documentFormat.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  // Transform data templates to include fields array
  const templatesWithFields = dataTemplates.map((template) => ({
    id: template.id,
    name: template.name,
    fields: Array.isArray(template.fields)
      ? (template.fields as Array<{ name: string; label: string; type: string; isRequired: boolean }>)
      : [],
  }));

  // Transform document formats to ensure name is non-null
  const formatsWithName = documentFormats
    .filter((f) => f.name !== null)
    .map((f) => ({ id: f.id, name: f.name as string }));

  return {
    dataTemplates: templatesWithFields,
    companies,
    documentFormats: formatsWithName,
  };
}

export default async function CreateTemplateFieldMappingPage({ searchParams }: PageProps) {
  const t = await getTranslations('templateFieldMapping');
  const { copyFrom } = await searchParams;

  const [{ dataTemplates, companies, documentFormats }, copySource] = await Promise.all([
    getFormData(),
    getCopySource(copyFrom),
  ]);

  const isCopying = !!copySource;

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          {isCopying ? t('page.copyTitle') : t('page.createTitle')}
        </h1>
        <p className="text-muted-foreground">
          {isCopying ? t('page.copyDescription') : t('page.createDescription')}
        </p>
      </div>

      <TemplateFieldMappingForm
        copySource={copySource ?? undefined}
        dataTemplates={dataTemplates}
        companies={companies}
        documentFormats={documentFormats}
      />
    </div>
  );
}
