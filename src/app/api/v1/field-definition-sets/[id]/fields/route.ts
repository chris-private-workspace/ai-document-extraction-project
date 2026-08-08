/**
 * @fileoverview FieldDefinitionSet Fields API
 * @module src/app/api/v1/field-definition-sets/[id]/fields
 * @since CHANGE-042 Phase 3
 * @lastModified 2026-02-23
 *
 * @endpoints
 *   GET /api/v1/field-definition-sets/:id/fields - 取得欄位列表（給 SourceFieldCombobox）
 */

import { NextRequest, NextResponse } from 'next/server';
import { getFieldsForSet } from '@/services/field-definition-set.service';
import { requireApiSession } from '@/lib/auth/api-session';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/v1/field-definition-sets/:id/fields
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { id } = await params;
    const fields = await getFieldsForSet(id);

    return NextResponse.json({ success: true, data: fields });
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

    console.error('[FieldDefinitionSet:fields] Error:', error);
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while fetching fields',
      },
      { status: 500 }
    );
  }
}
