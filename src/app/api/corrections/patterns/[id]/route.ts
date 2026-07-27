/**
 * @fileoverview 修正模式詳情與更新 API 路由
 * @description
 *   提供單一修正模式的詳情查詢和狀態更新：
 *   - GET: 獲取模式詳情（含相關修正記錄）
 *   - PATCH: 更新模式狀態
 *
 * @module src/app/api/corrections/patterns/[id]/route
 * @since Epic 4 - Story 4.3
 * @lastModified 2025-12-22
 * @refactor REFACTOR-001 (Forwarder → Company)
 *
 * @features
 *   - 模式詳情查詢
 *   - 相關修正記錄展示
 *   - 狀態更新（IGNORED, PROCESSED）
 *
 * @permissions
 *   - GET: RULE_VIEW
 *   - PATCH: RULE_MANAGE
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { sessionHasPermission } from '@/lib/auth/has-permission';
import { prisma } from '@/lib/prisma';
import { PERMISSIONS } from '@/types/permissions';
import { z } from 'zod';

// ============================================================
// Types
// ============================================================

interface RouteContext {
  params: Promise<{ id: string }>;
}

// ============================================================
// Validation Schemas
// ============================================================

/**
 * 更新狀態請求驗證
 */
const updateStatusSchema = z.object({
  status: z.enum(['IGNORED', 'PROCESSED', 'SUGGESTED']),
  reason: z.string().optional(),
});

// ============================================================
// Helper Functions
// ============================================================

// ============================================================
// GET /api/corrections/patterns/[id] - 獲取模式詳情
// ============================================================

/**
 * 獲取修正模式詳情
 *
 * @description
 *   返回模式的完整資訊，包括：
 *   - 基本資訊（Company、欄位、狀態等）
 *   - 相關的修正記錄（最近 20 筆）
 *   - 統計資訊
 *
 * @authentication
 *   需要 RULE_VIEW 權限
 */
export async function GET(request: NextRequest, context: RouteContext) {
  // 驗證用戶認證
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: 'Authentication required',
        },
      },
      { status: 401 }
    );
  }

  // 檢查權限
  if (!sessionHasPermission(session.user, PERMISSIONS.RULE_VIEW)) {
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'RULE_VIEW permission required',
        },
      },
      { status: 403 }
    );
  }

  const { id: patternId } = await context.params;

  try {
    const pattern = await prisma.correctionPattern.findUnique({
      where: { id: patternId },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            code: true,
            displayName: true,
          },
        },
        corrections: {
          include: {
            document: {
              select: {
                id: true,
                fileName: true,
              },
            },
            corrector: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!pattern) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'not_found',
            title: 'Not Found',
            status: 404,
            detail: `Pattern ${patternId} not found`,
          },
        },
        { status: 404 }
      );
    }

    // 從 patterns JSON 中提取代表性模式
    const patternsData = pattern.patterns as Array<{
      originalValue?: string;
      correctedValue?: string;
      samples?: Array<{
        originalValue?: string;
        correctedValue?: string;
        documentId?: string;
        correctedAt?: string;
      }>;
    }>;
    const firstPattern = patternsData?.[0];

    return NextResponse.json({
      success: true,
      data: {
        id: pattern.id,
        company: pattern.company,
        fieldName: pattern.fieldName,
        patternHash: pattern.patternHash,
        originalPattern: firstPattern?.originalValue || '',
        correctedPattern: firstPattern?.correctedValue || '',
        occurrenceCount: pattern.occurrenceCount,
        status: pattern.status,
        confidence: pattern.confidence,
        sampleValues: firstPattern?.samples || [],
        firstSeenAt: pattern.firstSeenAt.toISOString(),
        lastSeenAt: pattern.lastSeenAt.toISOString(),
        analyzedAt: pattern.analyzedAt?.toISOString() || null,
        suggestedAt: pattern.suggestedAt?.toISOString() || null,
        processedAt: pattern.processedAt?.toISOString() || null,
        corrections: pattern.corrections.map((c) => ({
          id: c.id,
          documentId: c.document.id,
          documentName: c.document.fileName,
          originalValue: c.originalValue,
          correctedValue: c.correctedValue,
          correctedBy: c.corrector,
          correctedAt: c.createdAt.toISOString(),
        })),
      },
    });
  } catch (error) {
    console.error('[Patterns API] Failed to fetch pattern detail:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'internal_error',
          title: 'Internal Server Error',
          status: 500,
          detail: 'Failed to fetch pattern detail',
        },
      },
      { status: 500 }
    );
  }
}

// ============================================================
// PATCH /api/corrections/patterns/[id] - 更新模式狀態
// ============================================================

/**
 * 更新修正模式狀態
 *
 * @description
 *   允許更新模式狀態為：
 *   - IGNORED: 標記為忽略，不再建議
 *   - PROCESSED: 標記為已處理（已轉為規則）
 *   - SUGGESTED: 標記為已建議
 *
 * @authentication
 *   需要 RULE_MANAGE 權限
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  // 驗證用戶認證
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: 'Authentication required',
        },
      },
      { status: 401 }
    );
  }

  // 檢查權限
  if (!sessionHasPermission(session.user, PERMISSIONS.RULE_MANAGE)) {
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'RULE_MANAGE permission required',
        },
      },
      { status: 403 }
    );
  }

  const { id: patternId } = await context.params;

  try {
    const body = await request.json();
    const parsed = updateStatusSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'validation_error',
            title: 'Validation Error',
            status: 400,
            detail: 'Invalid request body',
            errors: parsed.error.flatten().fieldErrors,
          },
        },
        { status: 400 }
      );
    }

    const { status } = parsed.data;

    // 檢查模式是否存在
    const existing = await prisma.correctionPattern.findUnique({
      where: { id: patternId },
      select: { id: true, status: true },
    });

    if (!existing) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'not_found',
            title: 'Not Found',
            status: 404,
            detail: `Pattern ${patternId} not found`,
          },
        },
        { status: 404 }
      );
    }

    // 構建更新資料
    const updateData: Record<string, unknown> = { status };

    if (status === 'SUGGESTED') {
      updateData.suggestedAt = new Date();
    } else if (status === 'PROCESSED' || status === 'IGNORED') {
      updateData.processedAt = new Date();
    }

    // 更新狀態
    const updated = await prisma.correctionPattern.update({
      where: { id: patternId },
      data: updateData,
    });

    return NextResponse.json({
      success: true,
      data: {
        id: updated.id,
        status: updated.status,
        suggestedAt: updated.suggestedAt?.toISOString() || null,
        processedAt: updated.processedAt?.toISOString() || null,
      },
    });
  } catch (error) {
    console.error('[Patterns API] Failed to update pattern status:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'internal_error',
          title: 'Internal Server Error',
          status: 500,
          detail: 'Failed to update pattern status',
        },
      },
      { status: 500 }
    );
  }
}
