/**
 * @fileoverview 編輯模版欄位映射頁面
 * @module src/app/[locale]/(dashboard)/admin/template-field-mappings/[id]
 * @since Epic 19 - Story 19.4
 * @lastModified 2026-01-22
 */

import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { TemplateFieldMappingForm } from '@/components/features/template-field-mapping';
import { prisma } from '@/lib/prisma';

interface PageProps {
  params: Promise<{ id: string; locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = await getTranslations('templateFieldMapping');
  const { id } = await params;

  const mapping = await prisma.templateFieldMapping.findUnique({
    where: { id },
    select: { name: true },
  });

  if (!mapping) {
    return {
      title: t('page.notFound'),
    };
  }

  return {
    title: t('page.editTitle', { name: mapping.name }),
    description: t('page.editDescription'),
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

  // Fetch companies (only active ones)
  const companies = await prisma.company.findMany({
    where: { status: 'ACTIVE' },
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

export default async function EditTemplateFieldMappingPage({ params }: PageProps) {
  const t = await getTranslations('templateFieldMapping');
  const { id } = await params;

  // Check if mapping exists
  const mapping = await prisma.templateFieldMapping.findUnique({
    where: { id },
    select: { id: true, name: true },
  });

  if (!mapping) {
    notFound();
  }

  const { dataTemplates, companies, documentFormats } = await getFormData();

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          {t('page.editTitle', { name: mapping.name })}
        </h1>
        <p className="text-muted-foreground">{t('page.editDescription')}</p>
      </div>

      <TemplateFieldMappingForm
        mappingId={id}
        dataTemplates={dataTemplates}
        companies={companies}
        documentFormats={documentFormats}
      />
    </div>
  );
}
