/**
 * @fileoverview 模版實例導出 API
 * @description
 *   提供模版實例的 Excel 和 CSV 導出功能
 *
 *   GET    /api/v1/template-instances/:id/export - 導出實例數據
 *
 * @module src/app/api/v1/template-instances/[id]/export
 * @since Epic 19 - Story 19.6
 * @lastModified 2026-01-23
 *
 * @features
 *   - 支援 Excel (.xlsx) 和 CSV (.csv) 格式
 *   - 支援行篩選（全部、有效、無效）
 *   - 支援欄位選擇
 *   - 支援格式化選項
 *   - 自動更新導出狀態
 *
 * @dependencies
 *   - templateExportService - 導出服務
 *   - templateInstanceService - 實例服務
 *   - dataTemplateService - 模版服務
 */

import { NextRequest, NextResponse } from 'next/server';
import { templateExportService, type RowFilter } from '@/services/template-export.service';
import { templateInstanceService } from '@/services/template-instance.service';
import { requireApiSession } from '@/lib/auth/api-session';
import { PERMISSIONS } from '@/types/permissions';

// ============================================================================
// Types
// ============================================================================

interface RouteParams {
  params: Promise<{ id: string }>;
}

// ============================================================================
// GET Handler
// ============================================================================

/**
 * GET /api/v1/template-instances/:id/export
 * @description
 *   導出模版實例數據為 Excel 或 CSV 格式
 *
 * @query format - 導出格式：xlsx | csv (預設: xlsx)
 * @query rowFilter - 行篩選：all | valid | invalid (預設: all)
 * @query fields - 選擇的欄位，逗號分隔 (預設: 全部欄位)
 * @query dateFormat - 日期格式 (預設: YYYY-MM-DD)
 * @query useThousandSeparator - 是否使用千分位 (預設: true)
 * @query includeValidationErrors - 是否包含驗證錯誤欄位 (預設: false)
 *
 * @returns 文件下載流
 */
export async function GET(request: NextRequest, context: RouteParams) {
  try {
    const gate = await requireApiSession(PERMISSIONS.REPORT_EXPORT);
    if (!gate.ok) return gate.response;

    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    // 1. 解析查詢參數
    const format = (searchParams.get('format') || 'xlsx') as 'xlsx' | 'csv';
    const rowFilter = (searchParams.get('rowFilter') || 'all') as RowFilter;
    const fieldsParam = searchParams.get('fields');
    const selectedFields = fieldsParam ? fieldsParam.split(',').filter(Boolean) : undefined;
    const dateFormat = searchParams.get('dateFormat') || 'YYYY-MM-DD';
    const useThousandSeparator = searchParams.get('useThousandSeparator') !== 'false';
    const includeValidationErrors = searchParams.get('includeValidationErrors') === 'true';

    // 2. 驗證格式參數
    if (!['xlsx', 'csv'].includes(format)) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'VALIDATION_ERROR',
            title: '無效的導出格式',
            status: 400,
            detail: 'format 參數必須是 xlsx 或 csv',
          },
        },
        { status: 400 }
      );
    }

    // 3. 獲取實例和模版資訊
    const instance = await templateInstanceService.getByIdWithTemplate(id);

    if (!instance) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'NOT_FOUND',
            title: '實例不存在',
            status: 404,
            detail: `找不到 ID 為 ${id} 的模版實例`,
          },
        },
        { status: 404 }
      );
    }

    // 4. 檢查實例狀態（只有 COMPLETED 或 EXPORTED 狀態可以導出）
    if (!['COMPLETED', 'EXPORTED'].includes(instance.status)) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'CONFLICT',
            title: '無法導出',
            status: 409,
            detail: `實例狀態為 ${instance.status}，只有 COMPLETED 或 EXPORTED 狀態的實例可以導出`,
          },
        },
        { status: 409 }
      );
    }

    // 5. 獲取模版欄位定義
    const templateFields = instance.dataTemplate?.fields;

    if (!templateFields || templateFields.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: {
            type: 'VALIDATION_ERROR',
            title: '模版欄位定義缺失',
            status: 400,
            detail: '模版沒有定義任何欄位',
          },
        },
        { status: 400 }
      );
    }

    // 6. 執行導出
    const exportParams = {
      instanceId: id,
      instanceName: instance.name,
      templateFields,
      rowFilter,
      selectedFields,
      formatOptions: {
        dateFormat,
        useThousandSeparator,
        includeHeader: true,
        includeValidationErrors,
      },
    };

    let result;
    if (format === 'xlsx') {
      result = await templateExportService.exportToExcel(exportParams);
    } else {
      result = await templateExportService.exportToCsv(exportParams);
    }

    // 7. 更新實例導出狀態（如果是首次導出）
    if (instance.status === 'COMPLETED') {
      try {
        await templateInstanceService.markExported(id, format);
      } catch (e) {
        // 狀態更新失敗不影響導出
        console.warn('[Export] Failed to update export status:', e);
      }
    }

    // 8. 返回文件下載流
    const headers = new Headers();
    headers.set('Content-Type', result.mimeType);
    headers.set(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(result.filename)}"`
    );

    if (format === 'xlsx') {
      // Excel 返回 Buffer - 需要轉換為 Uint8Array
      const buffer = result.content as Buffer;
      return new NextResponse(new Uint8Array(buffer), { headers });
    } else {
      // CSV 返回字串
      return new NextResponse(result.content as string, { headers });
    }
  } catch (error) {
    console.error('[GET /api/v1/template-instances/:id/export] Error:', error);

    return NextResponse.json(
      {
        success: false,
        error: {
          type: 'INTERNAL_ERROR',
          title: '導出失敗',
          status: 500,
          detail: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      { status: 500 }
    );
  }
}
