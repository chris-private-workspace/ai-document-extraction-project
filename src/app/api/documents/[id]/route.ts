/**
 * @fileoverview 單個文件詳情 API 端點
 * @description
 *   提供單個文件的詳細資訊查詢，支援動態關聯加載：
 *   - 文件基本資訊 + blobUrl（Proxy URL 避免 CORS）
 *   - 上傳者 / 公司 / 城市資訊（透過 include 參數）
 *   - 提取欄位（從 ExtractionResult.fieldMappings 轉換）
 *   - 信心度（從 ExtractionResult.averageConfidence）
 *
 *   端點：
 *   - GET /api/documents/[id]?include=extractedFields,uploadedBy,company,city
 *   - DELETE /api/documents/[id]（FIX-096：補上缺失的刪除 handler）
 *
 * @module src/app/api/documents/[id]/route
 * @author Development Team
 * @since Epic 2 - Story 2.7 (Processing Status Tracking & Display)
 * @lastModified 2026-06-29
 *
 * @dependencies
 *   - next/server - Next.js API 處理
 *   - @/lib/auth - NextAuth 認證
 *   - @/lib/prisma - Prisma Client
 *
 * @related
 *   - src/app/api/documents/[id]/blob/route.ts - Blob Proxy（串流文件避免 CORS）
 *   - src/hooks/use-document-detail.ts - React Query Hook
 *   - CHANGE-018 - Invoice 詳情頁 API 增強
 */

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { deleteDocument } from '@/services/document.service'
import { logAudit } from '@/lib/audit'
import type { ExtractedField } from '@/types/extracted-field'
import { getConfidenceLevelFromScore } from '@/types/extracted-field'
import { detectExtractionVersion } from '@/types/extraction-v3.types'
import type { LineItemV3 } from '@/types/extraction-v3.types'

// ============================================================
// Types
// ============================================================

interface RouteParams {
  params: Promise<{ id: string }>
}

/** ExtractionResult.fieldMappings JSON 中單一欄位的結構 */
interface FieldMappingEntry {
  value: string | number | null
  rawValue: string | null
  confidence: number
  source: string
  ruleId?: string
  extractionMethod?: string
  category?: string
  position?: {
    page?: number
    boundingBox?: {
      x: number
      y: number
      width: number
      height: number
    }
  }
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * 將原始欄位 key 轉為人類可讀的顯示名稱
 * 例：airline_document_charge → Airline Document Charge
 */
function humanizeFieldName(fieldName: string): string {
  return fieldName
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

/**
 * 將 ExtractionResult.fieldMappings JSON 轉換為 ExtractedField[] 陣列
 */
function mapFieldMappingsToExtractedFields(
  fieldMappings: Record<string, FieldMappingEntry>
): ExtractedField[] {
  return Object.entries(fieldMappings).map(([fieldName, entry], index) => {
    const confidence = typeof entry.confidence === 'number'
      ? entry.confidence / 100  // 0-100 → 0-1
      : 0

    // 映射 source 到 FieldSource 類型
    const sourceMap: Record<string, ExtractedField['source']> = {
      azure: 'AZURE_DI',
      azure_di: 'AZURE_DI',
      gpt_vision: 'GPT_VISION',
      tier1: 'MAPPING',
      tier2: 'MAPPING',
      tier3: 'GPT_VISION',
      manual: 'MANUAL',
    }
    const source = sourceMap[entry.source?.toLowerCase() ?? ''] ?? 'GPT_VISION'

    return {
      id: `field-${index}-${fieldName}`,
      fieldName,
      displayName: humanizeFieldName(fieldName),
      value: entry.value,
      rawValue: entry.rawValue ?? null,
      confidence,
      confidenceLevel: getConfidenceLevelFromScore(confidence),
      source,
      isEdited: false,
      category: entry.category ?? 'other',
      boundingBox: entry.position?.boundingBox
        ? {
            page: entry.position.page ?? 1,
            x: entry.position.boundingBox.x,
            y: entry.position.boundingBox.y,
            width: entry.position.boundingBox.width,
            height: entry.position.boundingBox.height,
          }
        : undefined,
    }
  })
}

// ============================================================
// GET /api/documents/[id]
// ============================================================

/**
 * GET /api/documents/[id]
 * 獲取單個文件詳情
 *
 * @query include - 逗號分隔的關聯資料名稱
 *   可選值: extractedFields, uploadedBy, company, city, processingSteps, aiDetails
 *   範例: ?include=extractedFields,uploadedBy,company,city,aiDetails
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    // 認證檢查
    const session = await auth()
    if (!session?.user) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const { id } = await params
    const { searchParams } = new URL(request.url)
    const includes = new Set(
      (searchParams.get('include') ?? '').split(',').filter(Boolean)
    )

    // 1. 查詢文件（含動態關聯）
    const document = await prisma.document.findUnique({
      where: { id },
      include: {
        uploader: includes.has('uploadedBy')
          ? { select: { id: true, name: true, email: true } }
          : false,
        company: includes.has('company')
          ? { select: { id: true, name: true, code: true } }
          : false,
        city: includes.has('city')
          ? { select: { id: true, name: true, code: true } }
          : false,
        extractionResult: {
          select: {
            averageConfidence: true,
            confidenceScores: true,
            fieldMappings: includes.has('extractedFields'),
            totalFields: true,
            mappedFields: true,
            status: true,
            pipelineSteps: includes.has('processingSteps'),
            processingTime: includes.has('processingSteps'),
            // CHANGE-023: AI 詳情欄位
            gptPrompt: includes.has('aiDetails'),
            gptResponse: includes.has('aiDetails'),
            promptTokens: includes.has('aiDetails'),
            completionTokens: includes.has('aiDetails'),
            totalTokens: includes.has('aiDetails'),
            gptModelUsed: includes.has('aiDetails'),
            imageDetailMode: includes.has('aiDetails'),
            // CHANGE-024: V3.1 三階段欄位
            // 注意：stage1Result/stage2Result 總是查詢，因為 smartRoutingMarkers 需要
            extractionVersion: true,
            stage1Result: true,
            stage2Result: true,
            // CHANGE-051: 查詢 stage3Result 以取得 lineItems
            stage3Result: includes.has('extractedFields') || includes.has('stageDetails') || includes.has('aiDetails'),
            stage1AiDetails: includes.has('stageDetails') || includes.has('aiDetails'),
            stage2AiDetails: includes.has('stageDetails') || includes.has('aiDetails'),
            stage3AiDetails: includes.has('stageDetails') || includes.has('aiDetails'),
            stage1DurationMs: includes.has('stageDetails'),
            stage2DurationMs: includes.has('stageDetails'),
            stage3DurationMs: includes.has('stageDetails'),
            stage2ConfigSource: includes.has('stageDetails'),
            stage3ConfigScope: includes.has('stageDetails'),
          },
        },
      },
    })

    if (!document) {
      return NextResponse.json(
        { success: false, error: 'Document not found' },
        { status: 404 }
      )
    }

    // 2. 生成 blobUrl（使用 proxy endpoint 避免 CORS 問題）
    //    前端透過 /api/documents/[id]/blob 取得檔案串流
    const blobUrl = document.blobName
      ? `/api/documents/${id}/blob`
      : null

    // 3. 提取 confidence 資料
    const overallConfidence = document.extractionResult?.averageConfidence ?? null

    // 4. 轉換 extractedFields
    let extractedFields: ExtractedField[] | undefined
    if (includes.has('extractedFields') && document.extractionResult?.fieldMappings) {
      try {
        const fieldMappings = document.extractionResult.fieldMappings as unknown as Record<string, FieldMappingEntry>
        extractedFields = mapFieldMappingsToExtractedFields(fieldMappings)
      } catch (err) {
        console.error(`[Document Detail] Failed to parse fieldMappings for ${id}:`, err)
        extractedFields = []
      }
    }

    // CHANGE-051: 提取 lineItems
    let lineItems: LineItemV3[] | undefined
    if (includes.has('extractedFields') && document.extractionResult?.stage3Result) {
      try {
        const stage3 = document.extractionResult.stage3Result as Record<string, unknown>
        const rawLineItems = stage3.lineItems as LineItemV3[] | undefined
        lineItems = Array.isArray(rawLineItems) ? rawLineItems : []
      } catch {
        lineItems = []
      }
    }

    // 5. 轉換 processingSteps
    let processingSteps: Array<{
      step: string
      status: 'completed' | 'failed' | 'pending'
      error?: string | null
      duration?: number | null
    }> | undefined
    if (includes.has('processingSteps') && document.extractionResult?.pipelineSteps) {
      try {
        const raw = document.extractionResult.pipelineSteps as unknown as Array<{
          step: string
          success: boolean
          error?: string
          durationMs: number
          skipped?: boolean
        }>
        processingSteps = raw.map((s) => ({
          step: s.step,
          status: s.skipped ? 'pending' as const : s.success ? 'completed' as const : 'failed' as const,
          error: s.error ?? null,
          duration: s.durationMs != null ? s.durationMs / 1000 : null,
        }))
      } catch (err) {
        console.error(`[Document Detail] Failed to parse pipelineSteps for ${id}:`, err)
        processingSteps = []
      }
    }

    // 6. 組裝回應
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { extractionResult: _er, filePath: _fp, blobName: _bn, uploader, uploadedBy: _fk, ...documentBase } = document as Record<string, unknown>

    // CHANGE-024: 檢測提取版本
    const extractionVersion = document.extractionResult?.extractionVersion as string | null
    const isV3_1 = extractionVersion === 'v3.1'

    // CHANGE-023 + CHANGE-024: 組裝 AI 詳情（支援 V3 和 V3.1）
    let aiDetails: Record<string, unknown> | undefined
    if (includes.has('aiDetails') && document.extractionResult) {
      if (isV3_1) {
        // V3.1: 提供三階段 AI 詳情
        aiDetails = {
          version: 'v3.1',
          stages: {
            stage1: document.extractionResult.stage1AiDetails ?? null,
            stage2: document.extractionResult.stage2AiDetails ?? null,
            stage3: document.extractionResult.stage3AiDetails ?? null,
          },
          tokenUsage: {
            input: document.extractionResult.promptTokens ?? 0,
            output: document.extractionResult.completionTokens ?? 0,
            total: document.extractionResult.totalTokens ?? 0,
          },
          model: document.extractionResult.gptModelUsed ?? null,
        }
      } else {
        // V3: 提供單一 AI 詳情
        aiDetails = {
          version: 'v3',
          prompt: document.extractionResult.gptPrompt ?? null,
          response: document.extractionResult.gptResponse ?? null,
          tokenUsage: {
            input: document.extractionResult.promptTokens ?? 0,
            output: document.extractionResult.completionTokens ?? 0,
            total: document.extractionResult.totalTokens ?? 0,
          },
          model: document.extractionResult.gptModelUsed ?? null,
          imageDetailMode: document.extractionResult.imageDetailMode ?? null,
        }
      }
    }

    // CHANGE-024: 組裝 Stage 詳情
    let stageDetails: Record<string, unknown> | undefined
    if (includes.has('stageDetails') && document.extractionResult && isV3_1) {
      stageDetails = {
        stage1: {
          result: document.extractionResult.stage1Result ?? null,
          durationMs: document.extractionResult.stage1DurationMs ?? null,
        },
        stage2: {
          result: document.extractionResult.stage2Result ?? null,
          durationMs: document.extractionResult.stage2DurationMs ?? null,
          configSource: document.extractionResult.stage2ConfigSource ?? null,
        },
        stage3: {
          result: document.extractionResult.stage3Result ?? null,
          durationMs: document.extractionResult.stage3DurationMs ?? null,
          configScope: document.extractionResult.stage3ConfigScope ?? null,
        },
      }
    }

    // CHANGE-025: 計算智能路由標記
    // 修正：動態檢查公司/格式的當前配置狀態，而不是只依賴處理時的歷史標記
    let smartRoutingMarkers: {
      newCompanyDetected: boolean
      newFormatDetected: boolean
      needsConfigReview: boolean
      configSource: string | null
    } | undefined
    if (document.extractionResult && isV3_1) {
      const stage1Result = document.extractionResult.stage1Result as Record<string, unknown> | null
      const stage2Result = document.extractionResult.stage2Result as Record<string, unknown> | null

      const historicalNewCompany = (stage1Result?.isNewCompany as boolean) ?? false
      const historicalNewFormat = (stage2Result?.isNewFormat as boolean) ?? false

      // 動態檢查公司當前配置狀態
      let companyStillNeedsConfig = false
      if (historicalNewCompany && stage1Result?.companyId) {
        const company = await prisma.company.findUnique({
          where: { id: stage1Result.companyId as string },
          select: { status: true },
        })
        // 如果公司狀態仍是 PENDING，則仍需配置
        companyStillNeedsConfig = company?.status === 'PENDING'
      }

      // 動態檢查格式當前配置狀態
      // 注意：PromptConfig 是可選的進階配置，不應該強制要求
      // 改為檢查 DocumentFormat 是否已被創建（代表格式已被系統識別）
      let formatStillNeedsConfig = false
      if (historicalNewFormat && stage2Result?.formatId) {
        const documentFormat = await prisma.documentFormat.findUnique({
          where: { id: stage2Result.formatId as string },
          select: { id: true },
        })
        // 如果格式存在，則認為已配置（系統已識別出格式）
        // 只有當格式不存在時，才需要配置
        formatStillNeedsConfig = !documentFormat
      }

      smartRoutingMarkers = {
        newCompanyDetected: historicalNewCompany,
        newFormatDetected: historicalNewFormat,
        // 只有當公司或格式仍然需要配置時，才顯示警告
        needsConfigReview: companyStillNeedsConfig || formatStillNeedsConfig,
        configSource: document.extractionResult.stage2ConfigSource ?? null,
      }
    }

    const responseData = {
      ...documentBase,
      blobUrl,
      overallConfidence,
      sourceType: document.sourceType,
      // CHANGE-024: 提取版本
      extractionVersion: extractionVersion ?? 'v3',
      // 前端期望 uploadedBy 為 { id, name, email } 物件
      uploadedBy: uploader ?? null,
      ...(includes.has('extractedFields') && { extractedFields: extractedFields ?? [] }),
      // CHANGE-051: 新增 lineItems
      ...(includes.has('extractedFields') && { lineItems: lineItems ?? [] }),
      ...(includes.has('processingSteps') && {
        processingSteps: processingSteps ?? [],
        totalProcessingTime: document.extractionResult?.processingTime
          ? document.extractionResult.processingTime / 1000
          : null,
      }),
      // CHANGE-023: 新增 AI 詳情
      ...(includes.has('aiDetails') && { aiDetails }),
      // CHANGE-024: 新增 Stage 詳情
      ...(includes.has('stageDetails') && stageDetails && { stageDetails }),
      // CHANGE-025: 智能路由標記（V3.1 才有）
      ...(smartRoutingMarkers && { smartRoutingMarkers }),
    }

    return NextResponse.json({
      success: true,
      data: responseData,
    })
  } catch (error) {
    console.error('Get document error:', error)

    // 在開發環境輸出詳細錯誤
    const errorMessage = error instanceof Error
      ? `${error.name}: ${error.message}`
      : 'Unknown error'

    return NextResponse.json(
      {
        success: false,
        error: process.env.NODE_ENV === 'development' ? errorMessage : 'Internal server error'
      },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/documents/[id]
 *
 * @description
 *   刪除指定文件，重用 `deleteDocument` service（連同 Azure Blob 與
 *   Prisma `onDelete: Cascade` 子表一併清除）。
 *
 *   FIX-096：前端 `DocumentDetailHeader` 早已送出 `DELETE /api/documents/[id]`，
 *   但本路由原本只實作 GET → Next.js 回 405、UI 刪除功能無法運作。此為補上的 handler。
 *
 *   授權（FIX-096 方案 B：admin 角色 + 城市檢查）：
 *   - 全域管理員（`isGlobalAdmin`）：可刪除任何城市的文件
 *   - 區域管理員（`isRegionalManager`）：僅限其可存取城市（`cityCodes` 含該城市或 `'*'`）
 *   - 其餘角色：403
 *
 *   錯誤格式採 RFC 7807 top-level（新端點規範）。
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    // 1. 認證
    const session = await auth()
    if (!session?.user) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: '需要登入才能刪除文件',
        },
        { status: 401 }
      )
    }

    const { id } = await params

    // 2. 查詢文件（取城市做授權判斷 + 確認存在）
    const document = await prisma.document.findUnique({
      where: { id },
      select: { id: true, fileName: true, cityCode: true },
    })

    if (!document) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/not-found',
          title: 'Not Found',
          status: 404,
          detail: '找不到指定文件',
          instance: `/api/documents/${id}`,
        },
        { status: 404 }
      )
    }

    // 3. 授權（方案 B：admin 角色 + 城市檢查）
    const user = session.user
    const cityCodes = user.cityCodes ?? []
    const hasCityAccess =
      cityCodes.includes('*') || cityCodes.includes(document.cityCode)
    const allowed =
      user.isGlobalAdmin === true ||
      (user.isRegionalManager === true && hasCityAccess)

    if (!allowed) {
      return NextResponse.json(
        {
          type: 'https://api.example.com/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: '您沒有刪除此文件的權限',
          instance: `/api/documents/${id}`,
        },
        { status: 403 }
      )
    }

    // 4. 刪除（service 處理 Azure Blob + DB 級聯）
    await deleteDocument(id)

    // 5. 審計
    await logAudit({
      userId: user.id,
      action: 'DOCUMENT_DELETED',
      entityType: 'Document',
      entityId: id,
      details: { fileName: document.fileName, cityCode: document.cityCode },
    })

    // 6. 成功
    return NextResponse.json({ success: true, data: { id, deleted: true } })
  } catch (error) {
    console.error('Delete document error:', error)
    return NextResponse.json(
      {
        type: 'https://api.example.com/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail:
          error instanceof Error ? error.message : '刪除文件時發生錯誤',
      },
      { status: 500 }
    )
  }
}
