/**
 * @fileoverview Field Mapping Config API - 列表與建立
 * @description
 *   提供欄位映射配置的列表查詢和建立功能。
 *   支援三層範圍繼承：GLOBAL → COMPANY → FORMAT
 *
 * @module src/app/api/v1/field-mapping-configs
 * @since Epic 13 - Story 13.4
 * @lastModified 2026-01-02
 *
 * @endpoints
 *   GET  /api/v1/field-mapping-configs - 列表查詢（支援篩選和分頁）
 *   POST /api/v1/field-mapping-configs - 建立新配置
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { FieldMappingScope, Prisma } from '@prisma/client';

// =====================
// Validation Schemas
// =====================

/**
 * 列表查詢參數 Schema
 */
const listQuerySchema = z.object({
  scope: z.nativeEnum(FieldMappingScope).optional(),
  companyId: z.string().uuid().optional(),
  documentFormatId: z.string().cuid().optional(),
  isActive: z.enum(['true', 'false']).transform(v => v === 'true').optional(),
  search: z.string().max(100).optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  sortBy: z.enum(['name', 'scope', 'createdAt', 'updatedAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * 建立配置 Schema
 */
const createConfigSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  scope: z.nativeEnum(FieldMappingScope).default(FieldMappingScope.GLOBAL),
  companyId: z.string().uuid().optional().nullable(),
  documentFormatId: z.string().cuid().optional().nullable(),
  isActive: z.boolean().default(true),
}).refine(
  (data) => {
    // GLOBAL scope 不應有 companyId 或 documentFormatId
    if (data.scope === FieldMappingScope.GLOBAL) {
      return !data.companyId && !data.documentFormatId;
    }
    // COMPANY scope 必須有 companyId
    if (data.scope === FieldMappingScope.COMPANY) {
      return !!data.companyId && !data.documentFormatId;
    }
    // FORMAT scope 必須有 documentFormatId
    if (data.scope === FieldMappingScope.FORMAT) {
      return !!data.documentFormatId;
    }
    return true;
  },
  {
    message: 'Scope requirements not met: GLOBAL requires no IDs, COMPANY requires companyId, FORMAT requires documentFormatId',
  }
);

// =====================
// API Handlers
// =====================

/**
 * GET /api/v1/field-mapping-configs
 * 查詢欄位映射配置列表
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const queryParams = Object.fromEntries(searchParams.entries());

    // 驗證查詢參數
    const parsed = listQuerySchema.safeParse(queryParams);
    if (!parsed.success) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/validation',
          title: 'Validation Error',
          status: 400,
          detail: 'Invalid query parameters',
          errors: parsed.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const { scope, companyId, documentFormatId, isActive, search, page, limit, sortBy, sortOrder } = parsed.data;

    // 建立查詢條件
    const where: Prisma.FieldMappingConfigWhereInput = {};

    if (scope) {
      where.scope = scope;
    }

    if (companyId) {
      where.companyId = companyId;
    }

    if (documentFormatId) {
      where.documentFormatId = documentFormatId;
    }

    if (typeof isActive === 'boolean') {
      where.isActive = isActive;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    // 計算總數
    const total = await prisma.fieldMappingConfig.count({ where });

    // 查詢資料
    const configs = await prisma.fieldMappingConfig.findMany({
      where,
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
      orderBy: { [sortBy]: sortOrder },
      skip: (page - 1) * limit,
      take: limit,
    });

    // 格式化響應
    const data = configs.map((config) => ({
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
      rulesCount: config._count.rules,
      createdAt: config.createdAt.toISOString(),
      updatedAt: config.updatedAt.toISOString(),
    }));

    return NextResponse.json({
      success: true,
      data,
      meta: {
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('[FieldMappingConfig:GET] Error:', error);
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while fetching field mapping configs',
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/v1/field-mapping-configs
 * 建立新的欄位映射配置
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // 驗證請求體
    const parsed = createConfigSchema.safeParse(body);
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

    const { name, description, scope, companyId, documentFormatId, isActive } = parsed.data;

    // 檢查唯一約束：相同 scope + companyId + documentFormatId 組合不可重複
    const existing = await prisma.fieldMappingConfig.findFirst({
      where: {
        scope,
        companyId: companyId ?? null,
        documentFormatId: documentFormatId ?? null,
      },
    });

    if (existing) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/conflict',
          title: 'Conflict',
          status: 409,
          detail: `A configuration already exists for this scope combination (scope=${scope}, companyId=${companyId || 'null'}, documentFormatId=${documentFormatId || 'null'})`,
        },
        { status: 409 }
      );
    }

    // 驗證關聯實體存在
    if (companyId) {
      const company = await prisma.company.findUnique({ where: { id: companyId } });
      if (!company) {
        return NextResponse.json(
          {
            type: 'https://api.example.com/errors/not-found',
            title: 'Not Found',
            status: 404,
            detail: `Company with id '${companyId}' not found`,
          },
          { status: 404 }
        );
      }
    }

    if (documentFormatId) {
      const format = await prisma.documentFormat.findUnique({ where: { id: documentFormatId } });
      if (!format) {
        return NextResponse.json(
          {
            type: 'https://api.example.com/errors/not-found',
            title: 'Not Found',
            status: 404,
            detail: `Document format with id '${documentFormatId}' not found`,
          },
          { status: 404 }
        );
      }
    }

    // 建立配置
    const config = await prisma.fieldMappingConfig.create({
      data: {
        name,
        description,
        scope,
        companyId: companyId ?? null,
        documentFormatId: documentFormatId ?? null,
        isActive,
        version: 1,
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
      },
    });

    return NextResponse.json(
      {
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
          createdAt: config.createdAt.toISOString(),
          updatedAt: config.updatedAt.toISOString(),
        },
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('[FieldMappingConfig:POST] Error:', error);

    // 處理唯一約束違反（如果資料庫層面捕獲）
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
        detail: 'An unexpected error occurred while creating field mapping config',
      },
      { status: 500 }
    );
  }
}
