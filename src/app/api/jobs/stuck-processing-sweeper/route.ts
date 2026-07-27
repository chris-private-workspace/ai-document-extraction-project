/**
 * @fileoverview 殭屍處理回收任務 API 路由（FIX-094）
 * @description
 *   提供殭屍處理（卡在 OCR_PROCESSING / MAPPING_PROCESSING）回收任務的觸發與狀態查詢：
 *   - POST: 觸發掃描，將逾時卡住的文件標記為 OCR_FAILED
 *   - GET: 查詢目前卡住的文件狀態（唯讀）
 *
 * @module src/app/api/jobs/stuck-processing-sweeper/route
 * @since FIX-094
 *
 * @permissions
 *   - POST: INVOICE_REVIEW（或提供有效的 x-cron-secret）
 *   - GET: INVOICE_VIEW
 *
 * @cron
 *   可配合 n8n / Vercel Cron 使用：
 *   - Schedule: 每 5 分鐘（閾值預設 10 分鐘，可由 STUCK_PROCESSING_THRESHOLD_MINUTES 調整）
 *   - Header: x-cron-secret
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { sessionHasPermission } from '@/lib/auth/has-permission';
import { PERMISSIONS } from '@/types/permissions';
import {
  triggerStuckProcessingSweep,
  getStuckProcessingStatus,
} from '@/jobs/stuck-processing-sweeper-job';

// ============================================================
// Configuration
// ============================================================

/** Cron 密鑰（用於外部排程器調用驗證） */
const CRON_SECRET = process.env.CRON_SECRET;

// ============================================================
// Helper Functions
// ============================================================

/**
 * 驗證 Cron 密鑰
 */
function isValidCronSecret(request: NextRequest): boolean {
  if (!CRON_SECRET) return false;
  const providedSecret = request.headers.get('x-cron-secret');
  return providedSecret === CRON_SECRET;
}

// ============================================================
// POST /api/jobs/stuck-processing-sweeper - 觸發掃描
// ============================================================

/**
 * 觸發殭屍處理回收
 *
 * @authentication
 *   - 需要 INVOICE_REVIEW 權限
 *   - 或提供有效的 x-cron-secret header
 */
export async function POST(request: NextRequest) {
  // 外部排程器（x-cron-secret）
  if (isValidCronSecret(request)) {
    try {
      const result = await triggerStuckProcessingSweep();
      return NextResponse.json({ success: result.success, data: result });
    } catch (error) {
      console.error('[StuckProcessingSweeper API] Cron trigger failed:', error);
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'internal_error',
            title: 'Internal Server Error',
            status: 500,
            detail: 'Failed to trigger stuck-processing sweep',
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
  if (!sessionHasPermission(session.user, PERMISSIONS.INVOICE_REVIEW)) {
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'INVOICE_REVIEW permission required',
        },
      },
      { status: 403 }
    );
  }

  try {
    const result = await triggerStuckProcessingSweep();
    return NextResponse.json({ success: result.success, data: result });
  } catch (error) {
    console.error('[StuckProcessingSweeper API] Trigger failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'internal_error',
          title: 'Internal Server Error',
          status: 500,
          detail: 'Failed to trigger stuck-processing sweep',
        },
      },
      { status: 500 }
    );
  }
}

// ============================================================
// GET /api/jobs/stuck-processing-sweeper - 狀態查詢
// ============================================================

/**
 * 查詢目前的殭屍處理文件狀態（唯讀）
 *
 * @authentication
 *   需要 INVOICE_VIEW 權限
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
  if (!sessionHasPermission(session.user, PERMISSIONS.INVOICE_VIEW)) {
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'INVOICE_VIEW permission required',
        },
      },
      { status: 403 }
    );
  }

  try {
    const status = await getStuckProcessingStatus();
    return NextResponse.json({ success: true, data: status });
  } catch (error) {
    console.error('[StuckProcessingSweeper API] Get status failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'internal_error',
          title: 'Internal Server Error',
          status: 500,
          detail: 'Failed to get stuck-processing status',
        },
      },
      { status: 500 }
    );
  }
}
