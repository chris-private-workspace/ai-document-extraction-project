/**
 * @fileoverview 公司合併 API
 * @description
 *   提供公司合併功能：
 *   - 將多個副公司合併到主公司
 *   - 自動轉移名稱變體
 *   - 更新合併關係
 *
 * @module src/app/api/admin/companies/merge
 * @since Epic 0 - Story 0.3
 * @lastModified 2025-12-23
 *
 * @features
 *   - 多公司合併
 *   - 名稱變體轉移
 *   - 合併關係追蹤
 *
 * @dependencies
 *   - company-auto-create.service - 公司合併服務
 *
 * @related
 *   - src/components/features/companies/CompanyMergeDialog.tsx - 合併對話框
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { hasPermission } from '@/lib/auth/city-permission'
import { PERMISSIONS } from '@/types/permissions'
import { autoMergeCompanies } from '@/services/company-auto-create.service'
import { prisma } from '@/lib/prisma'

// ============================================================
// Validation Schemas
// ============================================================

const MergeCompaniesSchema = z.object({
  primaryId: z.string().uuid('主公司 ID 格式無效'),
  secondaryIds: z.array(z.string().uuid('副公司 ID 格式無效')).min(1, '至少需要一個副公司'),
})

// ============================================================
// POST Handler
// ============================================================

/**
 * 合併公司
 *
 * @description
 *   將多個副公司合併到主公司：
 *   1. 副公司的名稱變體添加到主公司
 *   2. 副公司的名稱作為變體添加到主公司
 *   3. 副公司狀態設為 MERGED
 *   4. 記錄 mergedIntoId 關係
 *
 * @param request - Next.js 請求對象
 * @returns 合併後的主公司
 *
 * @example
 * ```http
 * POST /api/admin/companies/merge
 * Content-Type: application/json
 *
 * {
 *   "primaryId": "xxx-xxx-xxx",
 *   "secondaryIds": ["yyy-yyy-yyy", "zzz-zzz-zzz"]
 * }
 * ```
 */
export async function POST(request: NextRequest) {
  try {
    // 驗證認證
    const session = await auth()
    if (!session?.user) {
      return NextResponse.json(
        { success: false, error: '未授權' },
        { status: 401 }
      )
    }

    // 檢查權限
    const hasManagePerm = hasPermission(session.user, PERMISSIONS.FORWARDER_MANAGE)
    if (!hasManagePerm) {
      return NextResponse.json(
        { success: false, error: '權限不足' },
        { status: 403 }
      )
    }

    // 解析請求體
    const body = await request.json()
    const validation = MergeCompaniesSchema.safeParse(body)

    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          error: '請求參數無效',
          details: validation.error.flatten(),
        },
        { status: 400 }
      )
    }

    const { primaryId, secondaryIds } = validation.data

    // 驗證主公司存在
    const primaryCompany = await prisma.company.findUnique({
      where: { id: primaryId },
    })

    if (!primaryCompany) {
      return NextResponse.json(
        { success: false, error: '主公司不存在' },
        { status: 404 }
      )
    }

    // 驗證所有副公司存在
    const secondaryCompanies = await prisma.company.findMany({
      where: { id: { in: secondaryIds } },
    })

    if (secondaryCompanies.length !== secondaryIds.length) {
      const foundIds = new Set(secondaryCompanies.map((c) => c.id))
      const missingIds = secondaryIds.filter((id) => !foundIds.has(id))
      return NextResponse.json(
        {
          success: false,
          error: '部分副公司不存在',
          details: { missingIds },
        },
        { status: 404 }
      )
    }

    // 驗證主公司不在副公司列表中
    if (secondaryIds.includes(primaryId)) {
      return NextResponse.json(
        { success: false, error: '主公司不能同時是副公司' },
        { status: 400 }
      )
    }

    // 執行合併
    const { company: mergedCompany, knowledgeTransfer } = await autoMergeCompanies(
      primaryId,
      secondaryIds
    )

    return NextResponse.json({
      success: true,
      data: mergedCompany,
      message: `成功合併 ${secondaryIds.length} 個公司`,
      details: {
        primaryId,
        mergedCount: secondaryIds.length,
        mergedIds: secondaryIds,
      },
      // FIX-129: 處理知識轉移報告（含因唯一鍵衝突而跳過的記錄），供前端顯示
      knowledgeTransfer,
    })
  } catch (error) {
    console.error('Error merging companies:', error)
    return NextResponse.json(
      {
        success: false,
        error: '合併公司失敗',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}
