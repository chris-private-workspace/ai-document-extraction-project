/**
 * @fileoverview FieldDefinitionSet Resolve API
 * @module src/app/api/v1/field-definition-sets/resolve
 * @since CHANGE-042 Phase 3
 * @lastModified 2026-02-23
 *
 * @endpoints
 *   GET /api/v1/field-definition-sets/resolve - 依 companyId+formatId 擇一解析欄位集
 *
 * @remarks
 *   🔴 本端點**不合併三層**。它呼叫 getResolvedFields，依 FORMAT → COMPANY → GLOBAL
 *   順序取「第一個命中的那一層」並整份回傳，`data.source` 標示實際採用的層級。
 *
 *   若 FORMAT 層只放了少數覆蓋用欄位，這裡就只會回傳那幾個 —— 這**不等於**提取管線
 *   實際使用的欄位集（管線採合併語意，會補上 COMPANY / GLOBAL 的其餘欄位）。
 *   因此請勿用本端點驗證「某份文件提取時會拿到哪些欄位」。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getResolvedFields } from '@/services/field-definition-set.service';
import { resolveFieldsQuerySchema } from '@/lib/validations/field-definition-set.schema';

/**
 * GET /api/v1/field-definition-sets/resolve?companyId=xxx&documentFormatId=yyy
 *
 * @returns `{ fields, setId?, source }` —— `source` 為 FORMAT / COMPANY / GLOBAL / FALLBACK，
 *   代表 fields 取自哪一層。**非三層合併結果**，詳見檔案頂部 @remarks。
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const queryParams = Object.fromEntries(searchParams.entries());

    const parsed = resolveFieldsQuerySchema.safeParse(queryParams);
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

    const result = await getResolvedFields(parsed.data.companyId, parsed.data.documentFormatId);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error('[FieldDefinitionSet:resolve] Error:', error);
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred while resolving fields',
      },
      { status: 500 }
    );
  }
}
