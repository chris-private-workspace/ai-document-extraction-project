/**
 * @fileoverview FieldDefinitionSet API - 詳情、更新、刪除
 * @module src/app/api/v1/field-definition-sets/[id]
 * @since CHANGE-042 Phase 3
 * @lastModified 2026-02-23
 *
 * @endpoints
 *   GET    /api/v1/field-definition-sets/:id - 查詢詳情
 *   PATCH  /api/v1/field-definition-sets/:id - 更新
 *   DELETE /api/v1/field-definition-sets/:id - 刪除
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getFieldDefinitionSetById,
  updateFieldDefinitionSet,
  deleteFieldDefinitionSet,
} from '@/services/field-definition-set.service';
import { updateFieldDefinitionSetSchema } from '@/lib/validations/field-definition-set.schema';
import { requireApiSession } from '@/lib/auth/api-session';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/v1/field-definition-sets/:id
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { id } = await params;
    const result = await getFieldDefinitionSetById(id);

    if (!result) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/not-found',
          title: 'Not Found',
          status: 404,
          detail: `Field definition set with id ${id} not found`,
        },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error('[FieldDefinitionSet:GET:id] Error:', error);
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred',
      },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/v1/field-definition-sets/:id
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { id } = await params;
    const body = await request.json();

    const parsed = updateFieldDefinitionSetSchema.safeParse(body);
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

    const result = await updateFieldDefinitionSet(id, parsed.data);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    if (message.startsWith('NOT_FOUND:')) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/not-found',
          title: 'Not Found',
          status: 404,
          detail: message.replace('NOT_FOUND: ', ''),
        },
        { status: 404 }
      );
    }

    console.error('[FieldDefinitionSet:PATCH] Error:', error);
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while updating field definition set',
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/v1/field-definition-sets/:id
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { id } = await params;
    await deleteFieldDefinitionSet(id);

    return NextResponse.json({ success: true, data: { id } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    if (message.startsWith('NOT_FOUND:')) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/not-found',
          title: 'Not Found',
          status: 404,
          detail: message.replace('NOT_FOUND: ', ''),
        },
        { status: 404 }
      );
    }

    console.error('[FieldDefinitionSet:DELETE] Error:', error);
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while deleting field definition set',
      },
      { status: 500 }
    );
  }
}
