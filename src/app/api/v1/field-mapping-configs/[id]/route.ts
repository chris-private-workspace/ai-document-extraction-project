/**
 * @fileoverview Field Mapping Config API - 單一配置操作
 * @description
 *   提供單一欄位映射配置的查詢、更新和刪除功能。
 *   更新時使用樂觀鎖（version）防止並發衝突。
 *
 * @module src/app/api/v1/field-mapping-configs/[id]
 * @since Epic 13 - Story 13.4
 * @lastModified 2026-01-02
 *
 * @endpoints
 *   GET    /api/v1/field-mapping-configs/:id - 查詢單一配置
 *   PATCH  /api/v1/field-mapping-configs/:id - 更新配置
 *   DELETE /api/v1/field-mapping-configs/:id - 刪除配置（級聯刪除規則）
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { FieldMappingScope, Prisma } from '@prisma/client';

// =====================
// Validation Schemas
// =====================

/**
 * 更新配置 Schema
 */
const updateConfigSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  scope: z.nativeEnum(FieldMappingScope).optional(),
  companyId: z.string().uuid().optional().nullable(),
  documentFormatId: z.string().cuid().optional().nullable(),
  isActive: z.boolean().optional(),
  version: z.number().int().positive(), // 必須提供版本號進行樂觀鎖檢查
});

// =====================
// Route Context Type
// =====================

interface RouteContext {
  params: Promise<{ id: string }>;
}

// =====================
// API Handlers
// =====================

/**
 * GET /api/v1/field-mapping-configs/:id
 * 查詢單一配置（包含所有規則）
 */
export async function GET(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const params = await context.params;
    const { id } = params;

    // 驗證 ID 格式
    if (!id || typeof id !== 'string') {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/validation',
          title: 'Validation Error',
          status: 400,
          detail: 'Invalid config ID',
        },
        { status: 400 }
      );
    }

    const config = await prisma.fieldMappingConfig.findUnique({
      where: { id },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        documentFormat: {
          select: {
            id: true,
            name: true,
            documentType: true,
            documentSubtype: true,
          },
        },
        rules: {
          orderBy: { priority: 'desc' },
          select: {
            id: true,
            sourceFields: true,
            targetField: true,
            transformType: true,
            transformParams: true,
            priority: true,
            isActive: true,
            description: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    if (!config) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/not-found',
          title: 'Not Found',
          status: 404,
          detail: `Field mapping config with id '${id}' not found`,
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        id: config.id,
        name: config.name,
        description: config.description,
        scope: config.scope,
        companyId: config.companyId,
        company: config.company,
        documentFormatId: config.documentFormatId,
        documentFormat: config.documentFormat,
        isActive: config.isActive,
        version: config.version,
        rules: config.rules.map((rule) => ({
          id: rule.id,
          sourceFields: rule.sourceFields,
          targetField: rule.targetField,
          transformType: rule.transformType,
          transformParams: rule.transformParams,
          priority: rule.priority,
          isActive: rule.isActive,
          description: rule.description,
          createdAt: rule.createdAt.toISOString(),
          updatedAt: rule.updatedAt.toISOString(),
        })),
        createdAt: config.createdAt.toISOString(),
        updatedAt: config.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('[FieldMappingConfig:GET:id] Error:', error);
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while fetching field mapping config',
      },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/v1/field-mapping-configs/:id
 * 更新配置（使用樂觀鎖）
 */
export async function PATCH(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const params = await context.params;
    const { id } = params;
    const body = await request.json();

    // 驗證 ID 格式
    if (!id || typeof id !== 'string') {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/validation',
          title: 'Validation Error',
          status: 400,
          detail: 'Invalid config ID',
        },
        { status: 400 }
      );
    }

    // 驗證請求體
    const parsed = updateConfigSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/validation',
          title: 'Validation Error',
          status: 400,
          detail: 'Invalid request body',
          errors: parsed.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const { version, ...updateData } = parsed.data;

    // 檢查配置是否存在
    const existing = await prisma.fieldMappingConfig.findUnique({
      where: { id },
    });

    if (!existing) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/not-found',
          title: 'Not Found',
          status: 404,
          detail: `Field mapping config with id '${id}' not found`,
        },
        { status: 404 }
      );
    }

    // 樂觀鎖檢查
    if (existing.version !== version) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/conflict',
          title: 'Conflict',
          status: 409,
          detail: `Version mismatch: expected ${version}, but current version is ${existing.version}. The config may have been modified by another user.`,
        },
        { status: 409 }
      );
    }

    // 驗證 scope 組合
    const newScope = updateData.scope ?? existing.scope;
    const newCompanyId = updateData.companyId !== undefined ? updateData.companyId : existing.companyId;
    const newDocumentFormatId = updateData.documentFormatId !== undefined ? updateData.documentFormatId : existing.documentFormatId;

    // 驗證 scope 與 ID 的組合邏輯
    if (newScope === FieldMappingScope.GLOBAL && (newCompanyId || newDocumentFormatId)) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/validation',
          title: 'Validation Error',
          status: 400,
          detail: 'GLOBAL scope should not have companyId or documentFormatId',
        },
        { status: 400 }
      );
    }

    if (newScope === FieldMappingScope.COMPANY && (!newCompanyId || newDocumentFormatId)) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/validation',
          title: 'Validation Error',
          status: 400,
          detail: 'COMPANY scope requires companyId and should not have documentFormatId',
        },
        { status: 400 }
      );
    }

    if (newScope === FieldMappingScope.FORMAT && !newDocumentFormatId) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/validation',
          title: 'Validation Error',
          status: 400,
          detail: 'FORMAT scope requires documentFormatId',
        },
        { status: 400 }
      );
    }

    // 檢查唯一約束（如果更改了 scope 組合）
    if (
      updateData.scope !== undefined ||
      updateData.companyId !== undefined ||
      updateData.documentFormatId !== undefined
    ) {
      const duplicate = await prisma.fieldMappingConfig.findFirst({
        where: {
          scope: newScope,
          companyId: newCompanyId ?? null,
          documentFormatId: newDocumentFormatId ?? null,
          id: { not: id },
        },
      });

      if (duplicate) {
        return NextResponse.json(
          {
            type: 'https://api.example.com/errors/conflict',
            title: 'Conflict',
            status: 409,
            detail: 'A configuration with this scope combination already exists',
          },
          { status: 409 }
        );
      }
    }

    // 驗證關聯實體存在
    if (updateData.companyId) {
      const company = await prisma.company.findUnique({ where: { id: updateData.companyId } });
      if (!company) {
        return NextResponse.json(
          {
            type: 'https://api.example.com/errors/not-found',
            title: 'Not Found',
            status: 404,
            detail: `Company with id '${updateData.companyId}' not found`,
          },
          { status: 404 }
        );
      }
    }

    if (updateData.documentFormatId) {
      const format = await prisma.documentFormat.findUnique({ where: { id: updateData.documentFormatId } });
      if (!format) {
        return NextResponse.json(
          {
            type: 'https://api.example.com/errors/not-found',
            title: 'Not Found',
            status: 404,
            detail: `Document format with id '${updateData.documentFormatId}' not found`,
          },
          { status: 404 }
        );
      }
    }

    // 更新配置（版本號自動遞增）
    const updated = await prisma.fieldMappingConfig.update({
      where: { id },
      data: {
        ...updateData,
        version: { increment: 1 },
      },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        documentFormat: {
          select: {
            id: true,
            name: true,
            documentType: true,
          },
        },
        _count: {
          select: { rules: true },
        },
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        scope: updated.scope,
        companyId: updated.companyId,
        company: updated.company,
        documentFormatId: updated.documentFormatId,
        documentFormat: updated.documentFormat,
        isActive: updated.isActive,
        version: updated.version,
        rulesCount: updated._count.rules,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('[FieldMappingConfig:PATCH] Error:', error);

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/conflict',
          title: 'Conflict',
          status: 409,
          detail: 'A configuration with this scope combination already exists',
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while updating field mapping config',
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/v1/field-mapping-configs/:id
 * 刪除配置（規則會級聯刪除）
 */
export async function DELETE(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const params = await context.params;
    const { id } = params;

    // 驗證 ID 格式
    if (!id || typeof id !== 'string') {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/validation',
          title: 'Validation Error',
          status: 400,
          detail: 'Invalid config ID',
        },
        { status: 400 }
      );
    }

    // 檢查配置是否存在
    const existing = await prisma.fieldMappingConfig.findUnique({
      where: { id },
      include: {
        _count: {
          select: { rules: true },
        },
      },
    });

    if (!existing) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/not-found',
          title: 'Not Found',
          status: 404,
          detail: `Field mapping config with id '${id}' not found`,
        },
        { status: 404 }
      );
    }

    // 刪除配置（規則會因 onDelete: Cascade 自動刪除）
    await prisma.fieldMappingConfig.delete({
      where: { id },
    });

    return NextResponse.json({
      success: true,
      data: {
        id,
        deletedRulesCount: existing._count.rules,
        message: `Field mapping config '${existing.name}' and ${existing._count.rules} associated rules have been deleted`,
      },
    });
  } catch (error) {
    console.error('[FieldMappingConfig:DELETE] Error:', error);
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while deleting field mapping config',
      },
      { status: 500 }
    );
  }
}
