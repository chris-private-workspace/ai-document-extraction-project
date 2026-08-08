/**
 * @fileoverview FieldDefinitionSet Candidates API
 * @module src/app/api/v1/field-definition-sets/candidates
 * @since CHANGE-042 Phase 3
 * @lastModified 2026-02-23
 *
 * @endpoints
 *   GET /api/v1/field-definition-sets/candidates - 取得候選欄位清單
 */

import { NextResponse } from 'next/server';
import { getCandidateFields } from '@/services/field-definition-set.service';
import { requireApiSession } from '@/lib/auth/api-session';

/**
 * GET /api/v1/field-definition-sets/candidates
 *
 * @description 回傳 invoice-fields.ts 中定義的所有標準欄位，
 *   轉為 FieldDefinitionEntry[] 格式，供 FieldCandidatePicker 使用。
 */
export async function GET() {
  try {
    const gate = await requireApiSession();
    if (!gate.ok) return gate.response;

    const candidates = getCandidateFields();

    return NextResponse.json({
      success: true,
      data: candidates,
      meta: { total: candidates.length },
    });
  } catch (error) {
    console.error('[FieldDefinitionSet:candidates] Error:', error);
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while fetching candidate fields',
      },
      { status: 500 }
    );
  }
}
