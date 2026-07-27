/**
 * @fileoverview 模式分析任務 API 路由
 * @description
 *   提供模式分析任務的手動觸發和狀態查詢：
 *   - POST: 手動觸發模式分析
 *   - GET: 獲取分析狀態
 *
 * @module src/app/api/jobs/pattern-analysis/route
 * @since Epic 4 - Story 4.3
 * @lastModified 2025-12-19
 *
 * @features
 *   - 手動觸發分析任務
 *   - 支援 Cron 密鑰驗證
 *   - 分析狀態查詢
 *
 * @permissions
 *   - POST: RULE_MANAGE
 *   - GET: RULE_VIEW
 *
 * @cron
 *   可配合 Vercel Cron 或 n8n 使用：
 *   - Schedule: 0 2 * * * (每天凌晨 2 點)
 *   - Header: x-cron-secret
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { sessionHasPermission } from '@/lib/auth/has-permission';
import { PERMISSIONS } from '@/types/permissions';
import {
  triggerPatternAnalysis,
  getPatternAnalysisStatus,
} from '@/jobs/pattern-analysis-job';

// ============================================================
// Configuration
// ============================================================

/**
 * Cron 密鑰（用於外部排程器調用驗證）
 */
const CRON_SECRET = process.env.CRON_SECRET;

// ============================================================
// Helper Functions
// ============================================================

/**
 * 驗證 Cron 密鑰
 *
 * @param request - HTTP 請求
 * @returns 密鑰是否有效
 */
function isValidCronSecret(request: NextRequest): boolean {
  if (!CRON_SECRET) return false;
  const providedSecret = request.headers.get('x-cron-secret');
  return providedSecret === CRON_SECRET;
}

// ============================================================
// POST /api/jobs/pattern-analysis - 手動觸發分析
// ============================================================

/**
 * 手動觸發模式分析
 *
 * @description
 *   允許 Super User 手動觸發模式分析任務
 *   也支援透過 Cron 密鑰從外部排程器調用
 *
 * @authentication
 *   - 需要 RULE_MANAGE 權限
 *   - 或提供有效的 x-cron-secret header
 */
export async function POST(request: NextRequest) {
  // 檢查 Cron 密鑰（用於外部排程器）
  if (isValidCronSecret(request)) {
    try {
      const result = await triggerPatternAnalysis();

      return NextResponse.json({
        success: result.success,
        data: result.result,
        error: result.error,
        timestamp: result.timestamp,
      });
    } catch (error) {
      console.error('[PatternAnalysis API] Cron trigger failed:', error);
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'internal_error',
            title: 'Internal Server Error',
            status: 500,
            detail: 'Failed to trigger pattern analysis',
          },
        },
        { status: 500 }
      );
    }
  }

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

  try {
    const result = await triggerPatternAnalysis();

    return NextResponse.json({
      success: result.success,
      data: result.result,
      error: result.error,
      timestamp: result.timestamp,
    });
  } catch (error) {
    console.error('[PatternAnalysis API] Trigger failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'internal_error',
          title: 'Internal Server Error',
          status: 500,
          detail: 'Failed to trigger pattern analysis',
        },
      },
      { status: 500 }
    );
  }
}

// ============================================================
// GET /api/jobs/pattern-analysis - 獲取分析狀態
// ============================================================

/**
 * 獲取分析任務狀態
 *
 * @description
 *   返回最近一次分析的狀態和統計資訊
 *
 * @authentication
 *   需要 RULE_VIEW 權限
 */
export async function GET() {
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

  try {
    const status = await getPatternAnalysisStatus();

    return NextResponse.json({
      success: true,
      data: status,
    });
  } catch (error) {
    console.error('[PatternAnalysis API] Get status failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'internal_error',
          title: 'Internal Server Error',
          status: 500,
          detail: 'Failed to get analysis status',
        },
      },
      { status: 500 }
    );
  }
}
