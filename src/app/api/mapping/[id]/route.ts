/**
 * @fileoverview 單一文件欄位映射結果 API 端點
 * @description
 *   提供單一文件的欄位映射結果查詢：
 *   - GET /api/mapping/[id] - 取得文件的提取結果
 *
 * @module src/app/api/mapping/[id]/route
 * @since Epic 2 - Story 2.4 (Field Mapping & Extraction)
 * @lastModified 2025-12-21
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { hasPermission } from '@/lib/auth/city-permission';
import { PERMISSIONS } from '@/types/permissions';
import { getExtractionResult } from '@/services/mapping.service';

// ============================================================
// Validation Schemas
// ============================================================

const paramsSchema = z.object({
  id: z.string().uuid(),
});

// ============================================================
// GET /api/mapping/[id] - 取得文件的提取結果
// ============================================================

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

    // 權限檢查：查看提取結果需要 RULE_VIEW
    if (!hasPermission(session.user, PERMISSIONS.RULE_VIEW)) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'You do not have permission to view extraction results',
        },
        { status: 403 }
      );
    }

    const resolvedParams = await params;
    const { id } = paramsSchema.parse(resolvedParams);

    const result = await getExtractionResult(id);

    if (!result) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/not-found',
          title: 'Not Found',
          status: 404,
          detail: `Extraction result not found for document: ${id}`,
        },
        { status: 404 }
      );
    }

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
          detail: 'Invalid document ID',
          errors: error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    console.error('Get extraction result error:', error);
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: error instanceof Error ? error.message : 'Failed to get extraction result',
      },
      { status: 500 }
    );
  }
}
