/**
 * @fileoverview 欄位映射 API 端點
 * @description
 *   提供欄位映射相關 API：
 *   - POST /api/mapping - 執行文件欄位映射
 *   - GET /api/mapping - 取得映射規則列表
 *
 * @module src/app/api/mapping/route
 * @since Epic 2 - Story 2.4 (Field Mapping & Extraction)
 * @lastModified 2025-12-22
 * @refactor REFACTOR-001 (Forwarder → Company)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { hasPermission } from '@/lib/auth/city-permission';
import { PERMISSIONS } from '@/types/permissions';
import {
  mapDocumentFields,
  getMappingRules,
  getApplicableRules,
} from '@/services/mapping.service';

// ============================================================
// Validation Schemas
// ============================================================

const mapFieldsSchema = z.object({
  documentId: z.string().uuid(),
  companyId: z.string().uuid().optional(), // REFACTOR-001: 原 forwarderId
  force: z.boolean().optional().default(false),
});

const getMappingRulesSchema = z.object({
  companyId: z.string().uuid().optional().nullable(), // REFACTOR-001: 原 forwarderId
  category: z.string().optional(),
  fieldName: z.string().optional(),
  isActive: z
    .string()
    .optional()
    .transform((val) => {
      if (val === 'true') return true;
      if (val === 'false') return false;
      return undefined;
    }),
});

// ============================================================
// POST /api/mapping - 執行文件欄位映射
// ============================================================

export async function POST(request: NextRequest) {
  try {
    // 認證檢查
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: 'Authentication required',
        },
        { status: 401 }
      );
    }

    // 權限檢查：觸發映射處理需要 RULE_MANAGE
    if (!hasPermission(session.user, PERMISSIONS.RULE_MANAGE)) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'You do not have permission to perform field mapping',
        },
        { status: 403 }
      );
    }

    const body = await request.json();
    const validatedData = mapFieldsSchema.parse(body);

    // REFACTOR-001: 原 forwarderId
    const result = await mapDocumentFields(validatedData.documentId, {
      companyId: validatedData.companyId,
      force: validatedData.force,
    });

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/validation',
          title: 'Validation Error',
          status: 400,
          detail: 'One or more fields failed validation',
          errors: error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    if (error instanceof Error) {
      // 特定錯誤處理
      if (error.message.includes('not found')) {
        return NextResponse.json(
          {
            type: 'https://api.example.com/errors/not-found',
            title: 'Not Found',
            status: 404,
            detail: error.message,
          },
          { status: 404 }
        );
      }
    }

    console.error('Field mapping error:', error);
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: error instanceof Error ? error.message : 'Failed to map fields',
      },
      { status: 500 }
    );
  }
}

// ============================================================
// GET /api/mapping - 取得映射規則列表
// ============================================================

export async function GET(request: NextRequest) {
  try {
    // 認證檢查
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: 'Authentication required',
        },
        { status: 401 }
      );
    }

    // 權限檢查：查看映射規則需要 RULE_VIEW
    if (!hasPermission(session.user, PERMISSIONS.RULE_VIEW)) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'You do not have permission to view mapping rules',
        },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);

    // REFACTOR-001: 原 forwarderId 改為 companyId
    const params = getMappingRulesSchema.parse({
      companyId: searchParams.get('companyId'),
      category: searchParams.get('category'),
      fieldName: searchParams.get('fieldName'),
      isActive: searchParams.get('isActive'),
    });

    // 如果指定了 companyId，取得該 Company 的適用規則（含通用規則）
    // 否則取得所有規則
    // REFACTOR-001: 原 Forwarder
    let rules;
    if (params.companyId) {
      rules = await getApplicableRules(params.companyId);
    } else {
      rules = await getMappingRules({
        companyId: params.companyId,
        category: params.category,
        fieldName: params.fieldName,
        isActive: params.isActive,
      });
    }

    // 計算統計
    // REFACTOR-001: 原 forwarderId
    const universalCount = rules.filter((r) => r.companyId === null).length;
    const companySpecificCount = rules.filter((r) => r.companyId !== null).length;

    return NextResponse.json({
      success: true,
      data: rules,
      meta: {
        total: rules.length,
        universalCount,
        companySpecificCount, // REFACTOR-001: 原 forwarderSpecificCount
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/validation',
          title: 'Validation Error',
          status: 400,
          detail: 'Invalid query parameters',
          errors: error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    console.error('Get mapping rules error:', error);
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: error instanceof Error ? error.message : 'Failed to get mapping rules',
      },
      { status: 500 }
    );
  }
}
