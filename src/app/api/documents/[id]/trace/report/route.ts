/**
 * @fileoverview 追溯報告生成 API 端點
 * @description
 *   提供追溯報告的生成功能。
 *   報告包含完整追溯鏈和 SHA256 完整性驗證。
 *
 * @module src/app/api/documents/[id]/trace/report/route
 * @since Epic 8 - Story 8.4 (原始文件追溯)
 * @lastModified 2025-12-20
 *
 * @features
 *   - POST: 生成追溯報告
 *   - 權限控制：AUDITOR、GLOBAL_ADMIN
 *   - SHA256 完整性雜湊
 *   - 審計日誌記錄
 *
 * @dependencies
 *   - @/lib/auth - 認證函數
 *   - @/services/traceability.service - 追溯服務
 *   - @/middlewares/audit-log.middleware - 審計日誌中間件
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { sessionHasAuditAccess } from '@/lib/auth/has-permission';
import { traceabilityService } from '@/services/traceability.service';
import { withAuditLogParams } from '@/middlewares/audit-log.middleware';

// ============================================================
// Types
// ============================================================

interface RouteParams {
  id: string;
}

// ============================================================
// POST Handler
// ============================================================

/**
 * 生成追溯報告
 *
 * @description
 *   生成包含完整追溯鏈的報告，特性：
 *   - 完整追溯鏈數據
 *   - SHA256 雜湊值確保完整性
 *   - 完整性驗證結果
 *   - 報告儲存到資料庫
 *
 * @param request - Next.js 請求對象
 * @param context - 路由參數
 * @returns 生成的追溯報告
 */
async function handlePost(
  request: NextRequest,
  context: { params: Promise<RouteParams> }
): Promise<NextResponse> {
  // 驗證認證
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    );
  }

  // 驗證權限（FIX-134）：改以 AUDIT_VIEW / AUDIT_EXPORT 權限判斷。
  // 原本比對角色名 ['AUDITOR','GLOBAL_ADMIN']，但實際角色名為 'Auditor' / 'System Admin'，永遠不符。
  if (!sessionHasAuditAccess(session.user)) {
    return NextResponse.json(
      {
        success: false,
        error: 'Access denied. Audit permission required.',
      },
      { status: 403 }
    );
  }

  const { id } = await context.params;

  try {
    // 生成追溯報告
    const report = await traceabilityService.generateTraceabilityReport(id, {
      id: session.user.id as string,
      name: session.user.name || 'Unknown',
    });

    return NextResponse.json({
      success: true,
      data: report,
    });
  } catch (error) {
    console.error('Error generating traceability report:', error);

    // 檢查是否為文件不存在的錯誤
    if (error instanceof Error && error.message.includes('not found')) {
      return NextResponse.json(
        { success: false, error: 'Document not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    );
  }
}

// ============================================================
// Exports
// ============================================================

export const POST = withAuditLogParams<RouteParams>(
  {
    action: 'EXPORT',
    resourceType: 'traceabilityReport',
    getResourceId: (_req: NextRequest, _result?: unknown, params?: RouteParams) => params?.id,
    getDescription: () => '生成文件追溯報告',
  },
  handlePost
);
