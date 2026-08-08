/**
 * @fileoverview FieldDefinitionSet API - 列表與建立
 * @module src/app/api/v1/field-definition-sets
 * @since CHANGE-042 Phase 3
 * @lastModified 2026-02-23
 *
 * @endpoints
 *   GET  /api/v1/field-definition-sets - 列表查詢（支援分頁、篩選、排序）
 *   POST /api/v1/field-definition-sets - 建立新欄位定義集
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getFieldDefinitionSets,
  createFieldDefinitionSet,
} from '@/services/field-definition-set.service';
import {
  createFieldDefinitionSetSchema,
  getFieldDefinitionSetsQuerySchema,
} from '@/lib/validations/field-definition-set.schema';
import { requireApiSession } from '@/lib/auth/api-session';

/**
 * GET /api/v1/field-definition-sets
 * 查詢欄位定義集列表
 */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { searchParams } = new URL(request.url);
    const queryParams = Object.fromEntries(searchParams.entries());

    const parsed = getFieldDefinitionSetsQuerySchema.safeParse(queryParams);
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

    const result = await getFieldDefinitionSets(parsed.data);

    return NextResponse.json({
      success: true,
      data: result.items,
      meta: { pagination: result.pagination },
    });
  } catch (error) {
    console.error('[FieldDefinitionSet:GET] Error:', error);
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while fetching field definition sets',
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/v1/field-definition-sets
 * 建立新欄位定義集
 */
export async function POST(request: NextRequest) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const body = await request.json();

    const parsed = createFieldDefinitionSetSchema.safeParse(body);
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

    const result = await createFieldDefinitionSet(parsed.data);

    return NextResponse.json(
      { success: true, data: result },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    if (message.startsWith('DUPLICATE_SCOPE:')) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/conflict',
          title: 'Conflict',
          status: 409,
          detail: message.replace('DUPLICATE_SCOPE: ', ''),
        },
        { status: 409 }
      );
    }

    console.error('[FieldDefinitionSet:POST] Error:', error);
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while creating field definition set',
      },
      { status: 500 }
    );
  }
}
