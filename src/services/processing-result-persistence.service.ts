/**
 * @fileoverview 統一處理結果持久化服務
 * @description
 *   將 UnifiedDocumentProcessor 的處理結果寫入資料庫：
 *   - 轉換 MappedFieldValue[] → ExtractionResult.fieldMappings JSON
 *   - Upsert ExtractionResult 記錄
 *   - 更新 Document 狀態、companyId、processingPath
 *   - 使用 Prisma 交易確保原子性
 *
 * @module src/services/processing-result-persistence
 * @since CHANGE-014 Phase 2 — 端到端管線整合
 * @lastModified 2026-02-26 (FIX-048: 在持久化交易中建立 ProcessingQueue 記錄)
 *
 * @features
 *   - UnifiedProcessingResult → ExtractionResult 轉換
 *   - 原子性資料庫寫入（Prisma $transaction）
 *   - 成功/失敗兩種路徑的狀態更新
 *
 * @dependencies
 *   - @/lib/prisma - Prisma Client
 *   - @/types/unified-processor - 統一處理結果類型
 *
 * @related
 *   - src/services/unified-processor/ - 統一處理器（產生結果）
 *   - src/services/template-matching-engine.service.ts - 模版匹配（消費 ExtractionResult）
 */

import { Prisma, ProcessingPath, QueueStatus } from '@prisma/client';
import prisma from '@/lib/prisma';
import { withDbRetry } from '@/lib/db-retry';
import type {
  UnifiedProcessingResult,
  UnifiedRoutingDecision,
  MappedFieldValue,
  UnmappedField,
  StepResult,
} from '@/types/unified-processor';
import type {
  ExtractionV3_1Output,
  Stage1CompanyResult,
  Stage2FormatResult,
  Stage3ExtractionResult,
  StepResultV3_1,
  ReferenceNumberMatchResult,
  ExchangeRateConversionResult,
} from '@/types/extraction-v3.types';

// ============================================================================
// Types
// ============================================================================

/**
 * 持久化輸入參數
 */
export interface PersistProcessingResultInput {
  /** 文件 ID */
  documentId: string;
  /** 統一處理結果 */
  result: UnifiedProcessingResult;
  /** 操作用戶 ID */
  userId: string;
}

/**
 * 持久化輸出結果
 */
export interface PersistProcessingResultOutput {
  /** ExtractionResult 記錄 ID */
  extractionResultId: string;
  /** 更新後的 Document 狀態 */
  documentStatus: string;
  /** 欄位統計 */
  fieldCount: {
    total: number;
    mapped: number;
    unmapped: number;
  };
}

/**
 * ExtractionResult.fieldMappings 中每個欄位的結構
 */
interface FieldMappingEntry {
  value: string | number | null;
  rawValue: string;
  confidence: number;
  source: string;
  ruleId?: string;
  extractionMethod: string;
}

// ============================================================================
// Conversion Functions
// ============================================================================

/**
 * 將 MappedFieldValue[] 轉換為 ExtractionResult.fieldMappings JSON 格式
 *
 * @description
 *   統一處理器產出 MappedFieldValue[]（陣列格式），
 *   ExtractionResult.fieldMappings 需要 Record<string, FieldMappingEntry>（物件格式）。
 *   此函數負責轉換。
 *
 * @param mappedFields - 統一處理器的映射結果
 * @param overallConfidence - 整體信心度 (0-1)
 * @returns fieldMappings JSON 物件
 */
function convertMappedFieldsToJson(
  mappedFields: MappedFieldValue[],
  overallConfidence: number = 0,
): Record<string, FieldMappingEntry> {
  const fieldMappings: Record<string, FieldMappingEntry> = {};

  for (const field of mappedFields) {
    if (!field.success) continue;

    fieldMappings[field.targetField] = {
      value: field.value,
      rawValue: String(field.originalValues?.[0] ?? ''),
      confidence: Math.round(overallConfidence * 100),
      source: 'unified',
      ruleId: field.ruleId,
      extractionMethod: field.transformType ?? 'DIRECT',
    };
  }

  return fieldMappings;
}

/**
 * 將 UnmappedField[] 轉換為 ExtractionResult.unmappedFieldDetails JSON 格式
 *
 * @param unmappedFields - 未映射欄位列表
 * @returns unmappedFieldDetails JSON 物件
 */
function convertUnmappedFieldsToJson(
  unmappedFields: UnmappedField[],
): Record<string, { reason: string; attempts: string[] }> {
  const details: Record<string, { reason: string; attempts: string[] }> = {};

  for (const field of unmappedFields) {
    details[field.fieldName] = {
      reason: field.reason,
      attempts: [],
    };
  }

  return details;
}

/**
 * 將 UnifiedRoutingDecision 轉換為 Prisma ProcessingPath enum 值
 *
 * @param routingDecision - 統一處理器的路由決策
 * @returns Prisma ProcessingPath 值
 */
function mapRoutingDecisionToProcessingPath(
  routingDecision?: UnifiedRoutingDecision,
): ProcessingPath | undefined {
  if (!routingDecision) return undefined;

  // UnifiedRoutingDecision 值與 ProcessingPath enum 值相同
  const mapping: Record<string, ProcessingPath> = {
    AUTO_APPROVE: ProcessingPath.AUTO_APPROVE,
    QUICK_REVIEW: ProcessingPath.QUICK_REVIEW,
    FULL_REVIEW: ProcessingPath.FULL_REVIEW,
  };
  return mapping[routingDecision];
}

/**
 * 將 StepResult[] 轉換為可持久化的 JSON 格式
 *
 * @description
 *   只保留步驟元資料（step, success, error, durationMs, skipped），
 *   不保存 data 屬性（step-specific 大資料，會造成 JSON 過大）。
 *
 * @param stepResults - 統一處理器的步驟結果列表
 * @returns 持久化用 JSON 陣列
 */
function convertStepResultsToJson(
  stepResults: StepResult[],
): Array<{
  step: string;
  success: boolean;
  error?: string;
  durationMs: number;
  skipped?: boolean;
  retryAttempts?: number;
}> {
  return stepResults.map((sr) => ({
    step: sr.step,
    success: sr.success,
    ...(sr.error ? { error: sr.error } : {}),
    durationMs: sr.durationMs,
    ...(sr.skipped ? { skipped: sr.skipped } : {}),
    ...(sr.retryAttempts ? { retryAttempts: sr.retryAttempts } : {}),
  }));
}

// ============================================================================
// Main Service
// ============================================================================

/**
 * 持久化統一處理結果
 *
 * @description
 *   將 UnifiedProcessingResult 寫入資料庫：
 *   1. 轉換 mappedFields → fieldMappings JSON
 *   2. Upsert ExtractionResult（以 documentId 唯一鍵）
 *   3. 更新 Document 狀態和關聯欄位
 *   4. 使用 Prisma 交易確保原子性
 *
 * @param input - 持久化輸入（documentId + result + userId）
 * @returns 持久化結果摘要
 * @throws 如果資料庫操作失敗
 */
export async function persistProcessingResult(
  input: PersistProcessingResultInput,
): Promise<PersistProcessingResultOutput> {
  const { documentId, result } = input;

  // 計算欄位統計
  const mappedFieldsList = result.mappedFields?.filter((f) => f.success) ?? [];
  const unmappedFieldsList = result.unmappedFields ?? [];
  const totalFields = mappedFieldsList.length + unmappedFieldsList.length;

  // 轉換欄位格式
  const fieldMappings = convertMappedFieldsToJson(
    result.mappedFields ?? [],
    result.overallConfidence,
  );
  const unmappedFieldDetails = convertUnmappedFieldsToJson(unmappedFieldsList);

  // 轉換 pipeline steps
  const pipelineSteps = result.stepResults?.length
    ? convertStepResultsToJson(result.stepResults)
    : null;

  // 構建信心度分數 JSON
  const confidenceScores = result.confidenceBreakdown
    ? {
        overall: result.overallConfidence ?? 0,
        breakdown: result.confidenceBreakdown,
        routingDecision: result.routingDecision,
      }
    : null;

  // 決定 Document 狀態
  // FIX-036: REF_MATCH_FAILED 狀態判斷
  const isRefMatchFailed = !result.success && result.error?.includes('REF_MATCH_ABORT');
  const documentStatus = isRefMatchFailed
    ? 'REF_MATCH_FAILED'
    : result.success ? 'MAPPING_COMPLETED' : 'OCR_FAILED';
  const processingPath = mapRoutingDecisionToProcessingPath(result.routingDecision);

  // FIX-048: 查詢 Document.cityCode 以建立 ProcessingQueue
  const currentDocument = await prisma.document.findUnique({
    where: { id: documentId },
    select: { cityCode: true },
  });

  // 構建交易操作列表（FIX-048: 改為動態陣列以支援條件性 ProcessingQueue 建立）
  const txOperations: Prisma.PrismaPromise<unknown>[] = [
    // 1. Upsert ExtractionResult
    prisma.extractionResult.upsert({
      where: { documentId },
      create: {
        documentId,
        companyId: result.companyId ?? null,
        fieldMappings: fieldMappings as unknown as Prisma.InputJsonValue,
        totalFields,
        mappedFields: mappedFieldsList.length,
        unmappedFields: unmappedFieldsList.length,
        averageConfidence: (result.overallConfidence ?? 0) * 100,
        confidenceScores: confidenceScores as unknown as Prisma.InputJsonValue,
        processingTime: result.totalDurationMs,
        rulesApplied: mappedFieldsList.filter((f) => f.ruleId).length,
        status: result.success ? 'COMPLETED' : 'FAILED',
        errorMessage: result.error ?? null,
        unmappedFieldDetails: unmappedFieldDetails as unknown as Prisma.InputJsonValue,
        pipelineSteps: pipelineSteps as unknown as Prisma.InputJsonValue,
        // CHANGE-023: 存儲 AI 詳情
        gptPrompt: result.aiDetails?.prompt ?? null,
        gptResponse: result.aiDetails?.response ?? null,
        promptTokens: result.aiDetails?.tokenUsage?.input ?? null,
        completionTokens: result.aiDetails?.tokenUsage?.output ?? null,
        totalTokens: result.aiDetails?.tokenUsage?.total ?? null,
        gptModelUsed: result.aiDetails?.model ?? null,
        imageDetailMode: result.aiDetails?.imageDetailMode ?? null,
        // CHANGE-024: V3.1 三階段欄位
        extractionVersion: result.extractionVersion ?? null,
        stage1Result: result.stage1Result as unknown as Prisma.InputJsonValue ?? null,
        stage2Result: result.stage2Result as unknown as Prisma.InputJsonValue ?? null,
        stage3Result: result.stage3Result as unknown as Prisma.InputJsonValue ?? null,
        stage1AiDetails: result.stageAiDetails?.stage1 as unknown as Prisma.InputJsonValue ?? null,
        stage2AiDetails: result.stageAiDetails?.stage2 as unknown as Prisma.InputJsonValue ?? null,
        stage3AiDetails: result.stageAiDetails?.stage3 as unknown as Prisma.InputJsonValue ?? null,
        stage1DurationMs: result.stageAiDetails?.stage1?.durationMs ?? null,
        stage2DurationMs: result.stageAiDetails?.stage2?.durationMs ?? null,
        stage3DurationMs: result.stageAiDetails?.stage3?.durationMs ?? null,
        // CHANGE-072: 持久化 FX 換算審計（覆蓋寫回後原值僅存於此）
        fxConversionResult: result.exchangeRateConversion
          ? (result.exchangeRateConversion as unknown as Prisma.InputJsonValue)
          : undefined,
        // FIX-092: 持久化參考編號匹配結果（供 Template 注入 _ref_*）
        referenceNumberMatch: result.referenceNumberMatch
          ? (result.referenceNumberMatch as unknown as Prisma.InputJsonValue)
          : undefined,
      },
      update: {
        companyId: result.companyId ?? null,
        fieldMappings: fieldMappings as unknown as Prisma.InputJsonValue,
        totalFields,
        mappedFields: mappedFieldsList.length,
        unmappedFields: unmappedFieldsList.length,
        averageConfidence: (result.overallConfidence ?? 0) * 100,
        confidenceScores: confidenceScores as unknown as Prisma.InputJsonValue,
        processingTime: result.totalDurationMs,
        rulesApplied: mappedFieldsList.filter((f) => f.ruleId).length,
        status: result.success ? 'COMPLETED' : 'FAILED',
        errorMessage: result.error ?? null,
        unmappedFieldDetails: unmappedFieldDetails as unknown as Prisma.InputJsonValue,
        pipelineSteps: pipelineSteps as unknown as Prisma.InputJsonValue,
        // CHANGE-023: 存儲 AI 詳情
        gptPrompt: result.aiDetails?.prompt ?? null,
        gptResponse: result.aiDetails?.response ?? null,
        promptTokens: result.aiDetails?.tokenUsage?.input ?? null,
        completionTokens: result.aiDetails?.tokenUsage?.output ?? null,
        totalTokens: result.aiDetails?.tokenUsage?.total ?? null,
        gptModelUsed: result.aiDetails?.model ?? null,
        imageDetailMode: result.aiDetails?.imageDetailMode ?? null,
        // CHANGE-024: V3.1 三階段欄位
        extractionVersion: result.extractionVersion ?? null,
        stage1Result: result.stage1Result as unknown as Prisma.InputJsonValue ?? null,
        stage2Result: result.stage2Result as unknown as Prisma.InputJsonValue ?? null,
        stage3Result: result.stage3Result as unknown as Prisma.InputJsonValue ?? null,
        stage1AiDetails: result.stageAiDetails?.stage1 as unknown as Prisma.InputJsonValue ?? null,
        stage2AiDetails: result.stageAiDetails?.stage2 as unknown as Prisma.InputJsonValue ?? null,
        stage3AiDetails: result.stageAiDetails?.stage3 as unknown as Prisma.InputJsonValue ?? null,
        stage1DurationMs: result.stageAiDetails?.stage1?.durationMs ?? null,
        stage2DurationMs: result.stageAiDetails?.stage2?.durationMs ?? null,
        stage3DurationMs: result.stageAiDetails?.stage3?.durationMs ?? null,
        // CHANGE-072: 持久化 FX 換算審計（覆蓋寫回後原值僅存於此）
        fxConversionResult: result.exchangeRateConversion
          ? (result.exchangeRateConversion as unknown as Prisma.InputJsonValue)
          : undefined,
        // FIX-092: 持久化參考編號匹配結果（供 Template 注入 _ref_*）
        referenceNumberMatch: result.referenceNumberMatch
          ? (result.referenceNumberMatch as unknown as Prisma.InputJsonValue)
          : undefined,
      },
    }),

    // 2. 更新 Document
    prisma.document.update({
      where: { id: documentId },
      data: {
        status: documentStatus,
        companyId: result.companyId ?? undefined,
        processingPath: processingPath ?? undefined,
        routingDecision: result.routingDecision
          ? ({ decision: result.routingDecision, confidence: result.overallConfidence } as unknown as Prisma.InputJsonValue)
          : undefined,
        processingEndedAt: new Date(),
        processingDuration: result.totalDurationMs,
        errorMessage: result.success ? null : (result.error ?? 'Processing failed'),
      },
    }),
  ];

  // FIX-048: 建立 ProcessingQueue（僅 QUICK_REVIEW/FULL_REVIEW 且處理成功的文件）
  if (
    processingPath &&
    processingPath !== ProcessingPath.AUTO_APPROVE &&
    result.success &&
    !isRefMatchFailed
  ) {
    const queuePriority = processingPath === ProcessingPath.FULL_REVIEW ? 10 : 5;
    txOperations.push(
      prisma.processingQueue.upsert({
        where: { documentId },
        create: {
          documentId,
          cityCode: currentDocument?.cityCode || '',
          processingPath,
          priority: queuePriority,
          routingReason: `信心度 ${Math.round((result.overallConfidence ?? 0) * 100)}%`,
          status: QueueStatus.PENDING,
        },
        update: {
          processingPath,
          priority: queuePriority,
          routingReason: `信心度 ${Math.round((result.overallConfidence ?? 0) * 100)}%`,
          status: QueueStatus.PENDING,
        },
      })
    );
  }

  // 使用 Prisma 交易確保原子性
  // CHANGE-098: 以 withDbRetry 包裝。交易內全為冪等操作（upsert / update by id）且具原子性，
  // 連線瞬斷時整批 rollback，重試安全 → 避免提取結果因 transient 連線錯誤而遺失。
  const [extractionResult] = (await withDbRetry(
    () => prisma.$transaction(txOperations),
    { label: `persistProcessingResult:${documentId}` },
  )) as [{ id: string }, ...unknown[]];

  return {
    extractionResultId: extractionResult.id,
    documentStatus,
    fieldCount: {
      total: totalFields,
      mapped: mappedFieldsList.length,
      unmapped: unmappedFieldsList.length,
    },
  };
}

/**
 * 標記文件處理失敗
 *
 * @description
 *   用於在處理過程的任何階段發生不可恢復錯誤時，
 *   更新 Document 狀態為失敗。
 *
 * @param documentId - 文件 ID
 * @param errorMessage - 錯誤訊息
 */
export async function markDocumentProcessingFailed(
  documentId: string,
  errorMessage: string,
): Promise<void> {
  await prisma.document.update({
    where: { id: documentId },
    data: {
      status: 'OCR_FAILED',
      errorMessage,
      processingEndedAt: new Date(),
    },
  });
}

// ============================================================================
// CHANGE-024: V3.1 三階段結果持久化
// ============================================================================

/**
 * V3.1 持久化輸入參數
 */
export interface PersistV3_1ResultInput {
  /** 文件 ID */
  documentId: string;
  /** V3.1 處理輸出 */
  result: ExtractionV3_1Output;
  /** 操作用戶 ID */
  userId: string;
  /** FIX-036: 參考編號匹配結果（從 V3 pipeline 傳入） */
  referenceNumberMatch?: ReferenceNumberMatchResult;
  /** FIX-037 BUG-2: 匯率轉換結果（從 V3 pipeline 傳入） */
  exchangeRateConversion?: ExchangeRateConversionResult;
}

/**
 * V3.1 持久化輸出結果
 */
export interface PersistV3_1ResultOutput {
  /** ExtractionResult 記錄 ID */
  extractionResultId: string;
  /** 更新後的 Document 狀態 */
  documentStatus: string;
  /** 提取版本 */
  extractionVersion: 'v3.1';
  /** Stage 統計 */
  stageStats: {
    stage1Success: boolean;
    stage2Success: boolean;
    stage3Success: boolean;
    totalDurationMs: number;
  };
}

/**
 * 將 StepResultV3_1[] 轉換為可持久化的 JSON 格式
 */
function convertV3_1StepResultsToJson(
  stepResults: StepResultV3_1[],
): Array<{
  step: string;
  success: boolean;
  error?: string;
  durationMs: number;
  skipped?: boolean;
}> {
  return stepResults.map((sr) => ({
    step: sr.step,
    success: sr.success,
    ...(sr.error ? { error: sr.error } : {}),
    durationMs: sr.durationMs,
    ...(sr.skipped ? { skipped: sr.skipped } : {}),
  }));
}

/**
 * 持久化 V3.1 三階段處理結果
 *
 * @description
 *   將 ExtractionV3_1Output 寫入資料庫：
 *   1. 存儲三階段結果（stage1Result, stage2Result, stage3Result）
 *   2. 存儲各階段 AI 詳情
 *   3. 計算並存儲信心度
 *   4. 更新 Document 狀態
 *
 * @param input - V3.1 持久化輸入
 * @returns 持久化結果摘要
 */
export async function persistV3_1ProcessingResult(
  input: PersistV3_1ResultInput,
): Promise<PersistV3_1ResultOutput> {
  const { documentId, result, referenceNumberMatch, exchangeRateConversion } = input;
  const { stage1Result, stage2Result, stage3Result } = result;

  // 計算統計
  const stage1Success = stage1Result?.success ?? false;
  const stage2Success = stage2Result?.success ?? false;
  const stage3Success = stage3Result?.success ?? false;

  const totalDurationMs =
    (stage1Result?.durationMs ?? 0) +
    (stage2Result?.durationMs ?? 0) +
    (stage3Result?.durationMs ?? 0);

  // CHANGE-042: 優先使用動態 fields（所有欄位），fallback 到 standardFields
  const dynamicFields = stage3Result?.fields;
  const standardFields = stage3Result?.standardFields ?? {};
  const fieldMappingsData = dynamicFields && Object.keys(dynamicFields).length > 0
    ? dynamicFields
    : standardFields;
  const lineItems = stage3Result?.lineItems ?? [];
  const extraCharges = stage3Result?.extraCharges ?? [];

  // 計算欄位統計（基於實際存入的 fieldMappings）
  const fieldKeys = Object.keys(fieldMappingsData);
  const totalFields = fieldKeys.length + lineItems.length + extraCharges.length;
  const mappedFields = fieldKeys.filter(
    (key) => {
      const field = (fieldMappingsData as Record<string, { value?: string | number | null }>)[key];
      return field?.value !== null && field?.value !== undefined && field?.value !== '';
    }
  ).length;

  // 計算整體信心度
  const overallConfidence = result.confidenceResult?.overallScore ?? 0;

  // Token 統計
  const totalTokens =
    (stage1Result?.aiDetails?.tokenUsage?.total ?? 0) +
    (stage2Result?.aiDetails?.tokenUsage?.total ?? 0) +
    (stage3Result?.tokenUsage?.total ?? 0);

  // FIX-036: REF_MATCH_FAILED 狀態判斷
  const isRefMatchAbort = !result.success && result.error?.includes('REF_MATCH_ABORT');
  const documentStatus = isRefMatchAbort
    ? 'REF_MATCH_FAILED'
    : result.success ? 'MAPPING_COMPLETED' : 'OCR_FAILED';

  // 構建 pipeline steps
  const pipelineSteps = result.stepResults?.length
    ? convertV3_1StepResultsToJson(result.stepResults)
    : null;

  // 構建信心度分數
  const confidenceScores = result.confidenceResult
    ? {
        overall: overallConfidence,
        dimensions: result.confidenceResult.dimensions,
        level: result.confidenceResult.level,
        routingDecision: result.routingDecision?.decision,
      }
    : null;

  // FIX-048: 查詢 Document.cityCode 以建立 ProcessingQueue
  const currentDocument = await prisma.document.findUnique({
    where: { id: documentId },
    select: { cityCode: true },
  });

  // FIX-048: 預先計算 processingPath（供 Document 更新和 ProcessingQueue 建立使用）
  const processingPath: ProcessingPath = result.routingDecision?.decision === 'AUTO_APPROVE'
    ? ProcessingPath.AUTO_APPROVE
    : result.routingDecision?.decision === 'QUICK_REVIEW'
      ? ProcessingPath.QUICK_REVIEW
      : ProcessingPath.FULL_REVIEW;

  // 構建交易操作列表（FIX-048: 改為動態陣列以支援條件性 ProcessingQueue 建立）
  const txOperations: Prisma.PrismaPromise<unknown>[] = [
    // 1. Upsert ExtractionResult
    prisma.extractionResult.upsert({
      where: { documentId },
      create: {
        documentId,
        companyId: stage1Result?.companyId ?? null,
        fieldMappings: fieldMappingsData as unknown as Prisma.InputJsonValue,
        totalFields,
        mappedFields,
        unmappedFields: totalFields - mappedFields,
        averageConfidence: overallConfidence,
        confidenceScores: confidenceScores as unknown as Prisma.InputJsonValue,
        processingTime: totalDurationMs,
        rulesApplied: 0, // V3.1 不使用規則
        status: result.success ? 'COMPLETED' : 'FAILED',
        errorMessage: result.error ?? null,
        pipelineSteps: pipelineSteps as unknown as Prisma.InputJsonValue,

        // V3.1 三階段欄位
        extractionVersion: 'v3.1',
        stage1Result: stage1Result as unknown as Prisma.InputJsonValue,
        stage2Result: stage2Result as unknown as Prisma.InputJsonValue,
        stage3Result: stage3Result as unknown as Prisma.InputJsonValue,
        stage1AiDetails: stage1Result?.aiDetails as unknown as Prisma.InputJsonValue,
        stage2AiDetails: stage2Result?.aiDetails as unknown as Prisma.InputJsonValue,
        stage3AiDetails: stage3Result?.aiDetails as unknown as Prisma.InputJsonValue,
        stage1DurationMs: stage1Result?.durationMs ?? null,
        stage2DurationMs: stage2Result?.durationMs ?? null,
        stage3DurationMs: stage3Result?.durationMs ?? null,
        stage2ConfigSource: stage2Result?.configSource ?? null,
        stage3ConfigScope: stage3Result?.configUsed?.promptConfigScope ?? null,

        // FIX-036: 保存 referenceNumberMatch 結果
        referenceNumberMatch: referenceNumberMatch
          ? (referenceNumberMatch as unknown as Prisma.InputJsonValue)
          : undefined,

        // FIX-037 BUG-2: 保存 exchangeRateConversion 結果
        fxConversionResult: exchangeRateConversion
          ? (exchangeRateConversion as unknown as Prisma.InputJsonValue)
          : undefined,

        // Token 統計（合計三階段）
        totalTokens,
        promptTokens:
          (stage1Result?.aiDetails?.tokenUsage?.input ?? 0) +
          (stage2Result?.aiDetails?.tokenUsage?.input ?? 0) +
          (stage3Result?.tokenUsage?.input ?? 0),
        completionTokens:
          (stage1Result?.aiDetails?.tokenUsage?.output ?? 0) +
          (stage2Result?.aiDetails?.tokenUsage?.output ?? 0) +
          (stage3Result?.tokenUsage?.output ?? 0),
        gptModelUsed: stage3Result?.aiDetails?.model ?? stage1Result?.aiDetails?.model ?? null,
      },
      update: {
        companyId: stage1Result?.companyId ?? null,
        fieldMappings: fieldMappingsData as unknown as Prisma.InputJsonValue,
        totalFields,
        mappedFields,
        unmappedFields: totalFields - mappedFields,
        averageConfidence: overallConfidence,
        confidenceScores: confidenceScores as unknown as Prisma.InputJsonValue,
        processingTime: totalDurationMs,
        status: result.success ? 'COMPLETED' : 'FAILED',
        errorMessage: result.error ?? null,
        pipelineSteps: pipelineSteps as unknown as Prisma.InputJsonValue,

        // V3.1 三階段欄位
        extractionVersion: 'v3.1',
        stage1Result: stage1Result as unknown as Prisma.InputJsonValue,
        stage2Result: stage2Result as unknown as Prisma.InputJsonValue,
        stage3Result: stage3Result as unknown as Prisma.InputJsonValue,
        stage1AiDetails: stage1Result?.aiDetails as unknown as Prisma.InputJsonValue,
        stage2AiDetails: stage2Result?.aiDetails as unknown as Prisma.InputJsonValue,
        stage3AiDetails: stage3Result?.aiDetails as unknown as Prisma.InputJsonValue,
        stage1DurationMs: stage1Result?.durationMs ?? null,
        stage2DurationMs: stage2Result?.durationMs ?? null,
        stage3DurationMs: stage3Result?.durationMs ?? null,
        stage2ConfigSource: stage2Result?.configSource ?? null,
        stage3ConfigScope: stage3Result?.configUsed?.promptConfigScope ?? null,

        // FIX-036: 保存 referenceNumberMatch 結果
        referenceNumberMatch: referenceNumberMatch
          ? (referenceNumberMatch as unknown as Prisma.InputJsonValue)
          : undefined,

        // FIX-037 BUG-2: 保存 exchangeRateConversion 結果
        fxConversionResult: exchangeRateConversion
          ? (exchangeRateConversion as unknown as Prisma.InputJsonValue)
          : undefined,

        // Token 統計
        totalTokens,
        promptTokens:
          (stage1Result?.aiDetails?.tokenUsage?.input ?? 0) +
          (stage2Result?.aiDetails?.tokenUsage?.input ?? 0) +
          (stage3Result?.tokenUsage?.input ?? 0),
        completionTokens:
          (stage1Result?.aiDetails?.tokenUsage?.output ?? 0) +
          (stage2Result?.aiDetails?.tokenUsage?.output ?? 0) +
          (stage3Result?.tokenUsage?.output ?? 0),
        gptModelUsed: stage3Result?.aiDetails?.model ?? stage1Result?.aiDetails?.model ?? null,
      },
    }),

    // 2. 更新 Document
    prisma.document.update({
      where: { id: documentId },
      data: {
        status: documentStatus,
        companyId: stage1Result?.companyId ?? undefined,
        processingPath,
        routingDecision: result.routingDecision
          ? ({
              decision: result.routingDecision.decision,
              confidence: overallConfidence,
              reasons: result.routingDecision.reasons,
            } as unknown as Prisma.InputJsonValue)
          : undefined,
        processingEndedAt: new Date(),
        processingDuration: totalDurationMs,
        errorMessage: result.success ? null : (result.error ?? 'Processing failed'),
      },
    }),
  ];

  // FIX-048: 建立 ProcessingQueue（僅 QUICK_REVIEW/FULL_REVIEW 且處理成功的文件）
  if (
    processingPath !== ProcessingPath.AUTO_APPROVE &&
    result.success &&
    !isRefMatchAbort
  ) {
    const queuePriority = processingPath === ProcessingPath.FULL_REVIEW ? 10 : 5;
    txOperations.push(
      prisma.processingQueue.upsert({
        where: { documentId },
        create: {
          documentId,
          cityCode: currentDocument?.cityCode || '',
          processingPath,
          priority: queuePriority,
          routingReason: result.routingDecision?.reasons?.join('; ') || `信心度 ${Math.round(overallConfidence)}%`,
          status: QueueStatus.PENDING,
        },
        update: {
          processingPath,
          priority: queuePriority,
          routingReason: result.routingDecision?.reasons?.join('; ') || `信心度 ${Math.round(overallConfidence)}%`,
          status: QueueStatus.PENDING,
        },
      })
    );
  }

  // 使用 Prisma 交易確保原子性
  const [extractionResult] = await prisma.$transaction(txOperations) as [{ id: string }, ...unknown[]];

  return {
    extractionResultId: extractionResult.id,
    documentStatus,
    extractionVersion: 'v3.1',
    stageStats: {
      stage1Success,
      stage2Success,
      stage3Success,
      totalDurationMs,
    },
  };
}
