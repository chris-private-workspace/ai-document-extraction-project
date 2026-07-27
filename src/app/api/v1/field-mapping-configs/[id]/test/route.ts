/**
 * @fileoverview Field Mapping Config API - 測試配置
 * @description
 *   提供映射配置的測試功能，驗證規則是否正確映射。
 *   支援提供樣本數據進行測試，或獲取有效規則列表。
 *   注意：CUSTOM transform 類型因安全考量不執行動態代碼。
 *
 * @module src/app/api/v1/field-mapping-configs/[id]/test
 * @since Epic 13 - Story 13.4
 * @lastModified 2026-01-02
 *
 * @endpoints
 *   POST /api/v1/field-mapping-configs/:id/test - 測試映射配置
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { FieldMappingScope, FieldTransformType } from '@prisma/client';

// =====================
// Validation Schemas
// =====================

/**
 * 測試請求 Schema
 */
const testRequestSchema = z.object({
  sampleData: z.record(z.string(), z.unknown()).optional(),
  companyId: z.string().uuid().optional(),
  documentFormatId: z.string().cuid().optional(),
});

// =====================
// Transform Functions
// =====================

/**
 * 從嵌套路徑獲取值
 * @example getNestedValue({ a: { b: 1 } }, 'a.b') → 1
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current === 'object' && current !== null) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * DIRECT transform - 直接傳遞值
 */
function applyDirectTransform(values: unknown[]): unknown {
  return values[0];
}

/**
 * CONCAT transform - 連接多個值
 */
function applyConcatTransform(
  values: unknown[],
  params: { separator?: string } | null
): unknown {
  const separator = params?.separator ?? '';
  return values
    .map((v) => (v === null || v === undefined ? '' : String(v)))
    .join(separator);
}

/**
 * SPLIT transform - 分割字串取特定部分
 */
function applySplitTransform(
  values: unknown[],
  params: { separator: string; index: number }
): unknown {
  const { separator, index } = params;
  const value = values[0];
  if (typeof value !== 'string') {
    return value;
  }
  const parts = value.split(separator);
  return parts[index] ?? null;
}

/**
 * LOOKUP transform - 查表映射
 */
function applyLookupTransform(
  values: unknown[],
  params: { mapping: Record<string, string>; defaultValue?: string }
): unknown {
  const { mapping, defaultValue } = params;
  const key = String(values[0]);
  return mapping[key] ?? defaultValue ?? key;
}

/**
 * 應用 transform 到值
 */
function applyTransform(
  values: unknown[],
  transformType: FieldTransformType,
  transformParams: unknown
): { value: unknown; warning?: string } {
  switch (transformType) {
    case FieldTransformType.DIRECT:
      return { value: applyDirectTransform(values) };

    case FieldTransformType.CONCAT:
      return {
        value: applyConcatTransform(
          values,
          transformParams as { separator?: string } | null
        ),
      };

    case FieldTransformType.SPLIT: {
      const params = transformParams as {
        separator: string;
        index: number;
      } | null;
      if (!params?.separator || params?.index === undefined) {
        return {
          value: values[0],
          warning: 'SPLIT transform missing required params',
        };
      }
      return { value: applySplitTransform(values, params) };
    }

    case FieldTransformType.LOOKUP: {
      const params = transformParams as {
        mapping: Record<string, string>;
        defaultValue?: string;
      } | null;
      if (!params?.mapping) {
        return {
          value: values[0],
          warning: 'LOOKUP transform missing mapping',
        };
      }
      return { value: applyLookupTransform(values, params) };
    }

    case FieldTransformType.CUSTOM: {
      // 安全考量：不執行動態代碼
      const params = transformParams as { expression?: string } | null;
      return {
        value: `[CUSTOM: ${params?.expression ?? 'no expression'}]`,
        warning:
          'CUSTOM transforms are not executed in test mode for security reasons',
      };
    }

    default:
      return { value: values[0], warning: `Unknown transform type` };
  }
}

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
 * POST /api/v1/field-mapping-configs/:id/test
 * 測試映射配置
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const params = await context.params;
    const { id: configId } = params;
    const body = await request.json();

    // 驗證 configId 格式
    if (!configId || typeof configId !== 'string') {
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
    const parsed = testRequestSchema.safeParse(body);
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

    const { sampleData, companyId, documentFormatId } = parsed.data;

    // 查詢配置和規則
    const config = await prisma.fieldMappingConfig.findUnique({
      where: { id: configId },
      include: {
        rules: {
          where: { isActive: true },
          orderBy: { priority: 'desc' },
        },
        company: {
          select: { id: true, name: true },
        },
        documentFormat: {
          select: { id: true, name: true },
        },
      },
    });

    if (!config) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/not-found',
          title: 'Not Found',
          status: 404,
          detail: `Field mapping config with id '${configId}' not found`,
        },
        { status: 404 }
      );
    }

    // 如果配置是 COMPANY 或 FORMAT 範圍，驗證是否適用
    const applicabilityWarnings: string[] = [];

    if (config.scope === FieldMappingScope.COMPANY && companyId) {
      if (config.companyId !== companyId) {
        applicabilityWarnings.push(
          `Config is for company '${config.company?.name}' but testing with different company`
        );
      }
    }

    if (config.scope === FieldMappingScope.FORMAT && documentFormatId) {
      if (config.documentFormatId !== documentFormatId) {
        applicabilityWarnings.push(
          `Config is for format '${config.documentFormat?.name}' but testing with different format`
        );
      }
    }

    // 如果沒有提供 sampleData，只返回有效規則列表
    if (!sampleData) {
      return NextResponse.json({
        success: true,
        data: {
          configId: config.id,
          configName: config.name,
          scope: config.scope,
          isActive: config.isActive,
          rulesCount: config.rules.length,
          rules: config.rules.map((rule) => ({
            id: rule.id,
            sourceFields: rule.sourceFields,
            targetField: rule.targetField,
            transformType: rule.transformType,
            transformParams: rule.transformParams,
            priority: rule.priority,
          })),
          message: 'No sample data provided. Returning config rules.',
          applicabilityWarnings:
            applicabilityWarnings.length > 0 ? applicabilityWarnings : undefined,
        },
      });
    }

    // 執行測試映射
    const testResults: Array<{
      ruleId: string;
      targetField: string;
      sourceFields: string[];
      sourceValues: unknown[];
      transformType: FieldTransformType;
      result: unknown;
      warning?: string;
    }> = [];

    const mappedOutput: Record<string, unknown> = {};
    const warnings: string[] = [...applicabilityWarnings];

    for (const rule of config.rules) {
      const sourceFields = rule.sourceFields as string[];
      const sourceValues = sourceFields.map((field) =>
        getNestedValue(sampleData, field)
      );

      const { value, warning } = applyTransform(
        sourceValues,
        rule.transformType,
        rule.transformParams
      );

      testResults.push({
        ruleId: rule.id,
        targetField: rule.targetField,
        sourceFields,
        sourceValues,
        transformType: rule.transformType,
        result: value,
        warning,
      });

      mappedOutput[rule.targetField] = value;

      if (warning) {
        warnings.push(`Rule '${rule.targetField}': ${warning}`);
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        configId: config.id,
        configName: config.name,
        scope: config.scope,
        input: sampleData,
        output: mappedOutput,
        testResults,
        summary: {
          totalRules: config.rules.length,
          appliedRules: testResults.length,
          warningsCount: warnings.length,
        },
        warnings: warnings.length > 0 ? warnings : undefined,
      },
    });
  } catch (error) {
    console.error('[FieldMappingConfig:Test] Error:', error);
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while testing field mapping config',
      },
      { status: 500 }
    );
  }
}
