/**
 * @fileoverview FieldDefinitionSet Toggle API
 * @module src/app/api/v1/field-definition-sets/[id]/toggle
 * @since CHANGE-042 Phase 3
 * @lastModified 2026-02-23
 *
 * @endpoints
 *   POST /api/v1/field-definition-sets/:id/toggle - 切換啟用狀態
 */

import { NextRequest, NextResponse } from 'next/server';
import { toggleFieldDefinitionSet } from '@/services/field-definition-set.service';
import { requireApiSession } from '@/lib/auth/api-session';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/v1/field-definition-sets/:id/toggle
 */
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const { id } = await params;
    const result = await toggleFieldDefinitionSet(id);

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

    console.error('[FieldDefinitionSet:toggle] Error:', error);
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while toggling status',
      },
      { status: 500 }
    );
  }
}
