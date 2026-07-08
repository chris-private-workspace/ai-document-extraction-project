/**
 * @fileoverview 統一文件處理器服務
 * @description
 *   UnifiedDocumentProcessor 是 Epic 15 的核心服務，提供：
 *   - 11 步處理管道的統一入口 (V2)
 *   - 7 步純 GPT Vision 管道 (V3 - CHANGE-021)
 *   - Feature Flag 控制的漸進式部署
 *   - 與 Legacy 處理器的向後兼容
 *   - 完整的處理過程追蹤和錯誤處理
 *
 * @module src/services/unified-processor
 * @since Epic 15 - Story 15.1 (處理流程重構 - 統一入口)
 * @lastModified 2026-02-24
 *
 * @features
 *   - 統一處理入口
 *   - V2: 11 步處理管道 (Azure DI + GPT)
 *   - V3: 7 步純 GPT Vision 管道 (CHANGE-021)
 *   - 中間狀態更新（OCR_PROCESSING / MAPPING_PROCESSING）
 *   - Feature Flag 控制 (V2/V3 切換)
 *   - Legacy 適配器支援
 *   - 錯誤回退機制 (V3 → V2)
 *   - 完整錯誤追蹤
 *
 * @dependencies
 *   - src/types/unified-processor.ts - 類型定義
 *   - src/constants/processing-steps.ts - 步驟配置
 *   - src/services/unified-processor/factory/step-factory.ts - 步驟工廠
 *   - src/services/unified-processor/adapters/legacy-processor.adapter.ts - Legacy 適配器
 *   - src/services/extraction-v3/ - V3 提取服務 (CHANGE-021)
 *
 * @related
 *   - docs/04-implementation/tech-specs/epic-15-unified-processing/tech-spec-story-15-1.md
 *   - claudedocs/4-changes/feature-changes/CHANGE-021-unified-processor-v3-pure-gpt-vision.md
 */

import {
  ProcessFileInput,
  UnifiedProcessingContext,
  UnifiedProcessingResult,
  UnifiedProcessorFlags,
  StepResult,
  ProcessingStep,
  StepPriority,
  UnifiedRoutingDecision,
  MappedFieldValue,
} from '@/types/unified-processor';
import type { TransformType } from '@/types/field-mapping';
import {
  DEFAULT_PROCESSOR_FLAGS,
  getStepConfig,
} from '@/constants/processing-steps';
import { getStepHandlerFactory } from './factory/step-factory';
import { legacyProcessorAdapter } from './adapters/legacy-processor.adapter';
import { IStepHandler } from './interfaces/step-handler.interface';
import { prisma } from '@/lib/prisma';
import { withDbRetry, isTransientDbError } from '@/lib/db-retry';

// V3 相關導入 (CHANGE-021)
import {
  ExtractionV3Service,
  type ExtractionV3Input,
  type ExtractionV3Output,
} from '@/services/extraction-v3';
import {
  shouldUseExtractionV3,
  getExtractionV3Flags,
  getExtractionV3_1Flags,
  type ExtractionV3FeatureFlags,
} from '@/config/feature-flags';

// ============================================================================
// 中間狀態映射（CHANGE-019）
// ============================================================================

/**
 * 管線步驟 → Document 狀態映射
 * 在進入這些關鍵步驟前，更新 Document 狀態以提供即時回饋
 */
const STEP_STATUS_MAP: Partial<Record<ProcessingStep, string>> = {
  [ProcessingStep.AZURE_DI_EXTRACTION]: 'OCR_PROCESSING',
  [ProcessingStep.FIELD_MAPPING]: 'MAPPING_PROCESSING',
};

/**
 * 處理選項
 */
export interface ProcessOptions {
  /** Feature Flags（覆蓋預設值） */
  flags?: Partial<UnifiedProcessorFlags>;
  /** 是否強制使用 Legacy 處理器 */
  forceLegacy?: boolean;
  /** 是否強制使用 V3 處理器 (CHANGE-021) */
  forceV3?: boolean;
  /** 是否強制使用 V2 處理器 (跳過 V3 灰度檢查) */
  forceV2?: boolean;
  /** V3 Feature Flags 覆蓋 */
  v3Flags?: Partial<ExtractionV3FeatureFlags>;
}

/**
 * 統一文件處理器服務
 * @description 提供統一的文件處理入口，支援 V2 (11步) 和 V3 (7步) 處理管道
 */
export class UnifiedDocumentProcessorService {
  /** 當前使用的 Feature Flags */
  private flags: UnifiedProcessorFlags;

  /** 步驟處理器列表 (V2) */
  private stepHandlers: IStepHandler[];

  /** V3 提取服務實例 (CHANGE-021) */
  private v3Service: ExtractionV3Service | null = null;

  constructor(flags?: Partial<UnifiedProcessorFlags>) {
    this.flags = { ...DEFAULT_PROCESSOR_FLAGS, ...flags };
    this.stepHandlers = getStepHandlerFactory().createAllHandlers();
  }

  /**
   * 獲取或創建 V3 服務實例
   * @private
   */
  private getV3Service(): ExtractionV3Service {
    if (!this.v3Service) {
      const v3Flags = getExtractionV3Flags();
      const v3_1Flags = getExtractionV3_1Flags();
      this.v3Service = new ExtractionV3Service({
        flags: {
          useExtractionV3: v3Flags.useExtractionV3,
          extractionV3Percentage: v3Flags.extractionV3Percentage,
          fallbackToV2OnError: v3Flags.fallbackToV2OnError,
          enableAzureDIFallback: v3Flags.enableAzureDIFallback,
          logPromptAssembly: v3Flags.logPromptAssembly,
          logGptResponse: v3Flags.logGptResponse,
          // V3.1 三階段架構 (CHANGE-024)
          useExtractionV3_1: v3_1Flags.useExtractionV3_1,
          extractionV3_1Percentage: v3_1Flags.extractionV3_1Percentage,
          fallbackToV3OnError: v3_1Flags.fallbackToV3OnError,
        },
        debug: v3Flags.logPromptAssembly || v3Flags.logGptResponse,
      });
    }
    return this.v3Service;
  }

  /**
   * 處理單個文件
   * @param input - 文件輸入
   * @param options - 處理選項
   * @returns 處理結果
   */
  async processFile(
    input: ProcessFileInput,
    options?: ProcessOptions
  ): Promise<UnifiedProcessingResult> {
    const startTime = Date.now();
    const flags = { ...this.flags, ...options?.flags };

    // 檢查是否使用 Legacy 處理器
    if (options?.forceLegacy || !flags.enableUnifiedProcessor) {
      return this.useLegacyProcessor(input);
    }

    // CHANGE-021: 檢查是否使用 V3 處理器
    const useV3 = this.shouldUseV3(input.fileId, options);
    if (useV3) {
      return this.processWithV3(input, options, startTime);
    }

    // V2: 創建處理上下文
    const context = this.createContext(input);

    try {
      // V2: 執行 11 步處理管道
      const stepResults = await this.executePipeline(context, flags);

      // V2: 構建處理結果
      return this.buildResult(context, stepResults, startTime);
    } catch (error) {
      // 處理未預期的錯誤
      const err = error instanceof Error ? error : new Error(String(error));
      return this.buildErrorResult(input.fileId, err, context, startTime);
    }
  }

  /**
   * 判斷是否應該使用 V3 處理器
   * @private
   * @since CHANGE-021
   */
  private shouldUseV3(fileId: string, options?: ProcessOptions): boolean {
    // 強制 V2
    if (options?.forceV2) {
      console.log('[CHANGE-024 DEBUG] shouldUseV3: forceV2 = true, returning false');
      return false;
    }

    // 強制 V3
    if (options?.forceV3) {
      console.log('[CHANGE-024 DEBUG] shouldUseV3: forceV3 = true, returning true');
      return true;
    }

    // 診斷：輸出 Feature Flags 狀態
    const v3Flags = getExtractionV3Flags();
    const v3_1Flags = getExtractionV3_1Flags();
    console.log('[CHANGE-024 DEBUG] shouldUseV3 checking Feature Flags:', {
      'FEATURE_EXTRACTION_V3': process.env.FEATURE_EXTRACTION_V3,
      'FEATURE_EXTRACTION_V3_PERCENTAGE': process.env.FEATURE_EXTRACTION_V3_PERCENTAGE,
      'v3Flags.useExtractionV3': v3Flags.useExtractionV3,
      'v3Flags.extractionV3Percentage': v3Flags.extractionV3Percentage,
      'v3_1Flags.useExtractionV3_1': v3_1Flags.useExtractionV3_1,
    });

    // 使用 Feature Flag 決定
    const result = shouldUseExtractionV3(fileId);
    console.log('[CHANGE-024 DEBUG] shouldUseExtractionV3 result:', result);
    return result;
  }

  /**
   * 使用 V3 處理器處理文件
   * @private
   * @since CHANGE-021
   */
  private async processWithV3(
    input: ProcessFileInput,
    options: ProcessOptions | undefined,
    startTime: number
  ): Promise<UnifiedProcessingResult> {
    const v3Flags = { ...getExtractionV3Flags(), ...options?.v3Flags };

    try {
      // 更新文件狀態為處理中
      // CHANGE-098: 標記為 critical — 這是初始關鍵狀態轉換，retry 後仍失敗即上拋，
      // 觸發下方 catch 的 fail-stop，避免在 DB 不可用時仍白燒 GPT 產生半殘結果。
      await this.updateDocumentStatus(input.fileId, 'OCR_PROCESSING', { critical: true });

      // 構建 V3 輸入
      const v3Input: ExtractionV3Input = {
        fileId: input.fileId,
        fileBuffer: input.fileBuffer,
        fileName: input.fileName,
        mimeType: input.mimeType,
        cityCode: input.cityCode ?? 'HKG', // 預設城市代碼
        options: {
          autoCreateCompany: true,
          autoCreateFormat: true,
          existingCompanyId: input.companyId,
        },
      };

      // 執行 V3 處理
      const v3Result = await this.getV3Service().processFile(v3Input);

      // 轉換 V3 結果為統一格式
      return this.convertV3Result(input.fileId, v3Result, startTime);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      // CHANGE-098 fail-stop: transient DB 連線錯誤（如 "Connection terminated unexpectedly"）
      // 代表 DB 當下不可用，重試已耗盡。此時不回退 V2（V2 同樣寫不進 DB，只會白燒 GPT），
      // 直接標為失敗結果（可重試），避免產生半殘資料拖垮下游 template 匹配。
      if (isTransientDbError(err)) {
        // 格式字串使用字面常量 + %s 佔位符（動態值作為後續參數），
        // 避免非字面變數進入 console 格式字串（Semgrep unsafe-formatstring）。
        console.error(
          '[UnifiedProcessor] transient DB error for %s, aborting (no V2 fallback): %s',
          input.fileId,
          err.message,
        );
        return this.buildErrorResult(input.fileId, err, null, startTime);
      }

      // 檢查是否需要回退到 V2
      if (v3Flags.fallbackToV2OnError) {
        console.warn(
          '[UnifiedProcessor] V3 failed for %s, falling back to V2: %s',
          input.fileId,
          err.message
        );
        // 回退到 V2
        const context = this.createContext(input);
        try {
          const stepResults = await this.executePipeline(context, this.flags);
          const result = this.buildResult(context, stepResults, startTime);
          // 標記使用了回退
          result.usedV3Fallback = true;
          return result;
        } catch (v2Error) {
          const v2Err = v2Error instanceof Error ? v2Error : new Error(String(v2Error));
          return this.buildErrorResult(input.fileId, v2Err, context, startTime);
        }
      }

      // 不回退，直接返回錯誤
      return this.buildErrorResult(input.fileId, err, null, startTime);
    }
  }

  /**
   * 更新文件狀態
   * @private
   */
  private async updateDocumentStatus(
    fileId: string,
    status: import('@prisma/client').DocumentStatus,
    options?: { critical?: boolean }
  ): Promise<void> {
    try {
      // CHANGE-098: transient 連線錯誤自動重試（update by id 為冪等操作，重試安全）。
      await withDbRetry(
        () =>
          prisma.document.update({
            where: { id: fileId },
            data: { status },
          }),
        { label: `updateDocumentStatus:${status}` }
      );
    } catch (statusErr) {
      console.warn(
        `[UnifiedProcessor] Failed to update status to ${status} for ${fileId}:`,
        statusErr
      );
      // CHANGE-098: 關鍵狀態轉換 retry 後仍失敗 → 上拋，由呼叫方 fail-stop；
      // 非關鍵（中間狀態）維持 best-effort，僅記錄不中斷。
      if (options?.critical) {
        throw statusErr;
      }
    }
  }

  /**
   * 轉換 V3 結果為統一格式
   * @private
   * @since CHANGE-021
   */
  private convertV3Result(
    fileId: string,
    v3Result: ExtractionV3Output,
    startTime: number
  ): UnifiedProcessingResult {
    const totalDurationMs = Date.now() - startTime;

    if (!v3Result.success || !v3Result.result) {
      return {
        success: false,
        fileId,
        status: 'FAILED',
        totalDurationMs,
        stepResults: v3Result.stepResults.map((sr) => ({
          step: sr.step as unknown as ProcessingStep,
          success: sr.success,
          skipped: sr.skipped,
          durationMs: sr.durationMs,
          error: sr.error,
        })),
        error: v3Result.error ?? 'V3 extraction failed',
        warnings: v3Result.warnings.map((w) => ({
          step: ProcessingStep.FILE_TYPE_DETECTION,
          message: w,
          timestamp: new Date().toISOString(),
        })),
        usedLegacyProcessor: false,
        usedV3: true,
      };
    }

    // 成功結果轉換
    const result = v3Result.result;

    // 轉換 V3 標準欄位為 V2 格式
    const extractedData = {
      invoiceData: {
        invoiceNumber: result.standardFields.invoiceNumber.value?.toString(),
        invoiceDate: result.standardFields.invoiceDate.value?.toString(),
        dueDate: result.standardFields.dueDate?.value?.toString(),
        vendorName: result.standardFields.vendorName.value?.toString(),
        customerName: result.standardFields.customerName?.value?.toString(),
        totalAmount:
          typeof result.standardFields.totalAmount.value === 'number'
            ? result.standardFields.totalAmount.value
            : parseFloat(result.standardFields.totalAmount.value ?? '0'),
        currency: result.standardFields.currency.value?.toString(),
        lineItems: result.lineItems.map((li) => ({
          description: li.description,
          quantity: li.quantity ?? 1,
          unitPrice: li.unitPrice ?? li.amount,
          amount: li.amount,
        })),
      },
      lineItems: result.lineItems.map((li) => ({
        description: li.description,
        quantity: li.quantity ?? 1,
        unitPrice: li.unitPrice ?? li.amount,
        amount: li.amount,
      })),
      gptConfidence: result.overallConfidence / 100,
    };

    // 轉換 V3 信心度分項為 V2 格式
    const confidenceBreakdown = v3Result.confidenceResult
      ? {
          extraction: v3Result.confidenceResult.dimensions.find(
            (d) => d.dimension === 'EXTRACTION'
          )?.rawScore,
          issuerIdentification: v3Result.confidenceResult.dimensions.find(
            (d) => d.dimension === 'ISSUER_IDENTIFICATION'
          )?.rawScore,
          formatMatching: v3Result.confidenceResult.dimensions.find(
            (d) => d.dimension === 'FORMAT_MATCHING'
          )?.rawScore,
        }
      : undefined;

    // 轉換 V3 路由決策為 V2 枚舉
    let routingDecision: UnifiedRoutingDecision | undefined;
    if (v3Result.routingDecision?.decision) {
      switch (v3Result.routingDecision.decision) {
        case 'AUTO_APPROVE':
          routingDecision = UnifiedRoutingDecision.AUTO_APPROVE;
          break;
        case 'QUICK_REVIEW':
          routingDecision = UnifiedRoutingDecision.QUICK_REVIEW;
          break;
        case 'FULL_REVIEW':
          routingDecision = UnifiedRoutingDecision.FULL_REVIEW;
          break;
      }
    }

    return {
      success: true,
      fileId,
      status: 'COMPLETED',
      totalDurationMs,
      stepResults: v3Result.stepResults.map((sr) => ({
        step: sr.step as unknown as ProcessingStep,
        success: sr.success,
        skipped: sr.skipped,
        durationMs: sr.durationMs,
        error: sr.error,
      })),
      extractedData,
      // FIX-044: 將 V3.1 欄位轉為 V2 MappedFieldValue[] 填入 mappedFields
      // FIX-045: 優先使用 fields（保留 FieldDefinitionSet 原始 key），fallback 到 standardFields（camelCase）
      mappedFields: this.convertStandardFieldsToMappedFields(
        result.fields ?? null,
        { ...result.standardFields },
        result.customFields ? { ...result.customFields } : undefined
      ),
      // FIX: V3.1 可能未設定 resolvedCompanyId，fallback 到 issuerIdentification.companyId
      companyId: result.resolvedCompanyId || result.issuerIdentification?.companyId,
      companyName: result.issuerIdentification.companyName,
      isNewCompany: result.jitCreated?.company ?? false,
      documentFormatId: result.resolvedFormatId,
      documentFormatName: result.formatIdentification.formatName,
      isNewFormat: result.jitCreated?.format ?? false,
      // CHANGE-025: 智能路由標記（優先使用 V3 輸出的值，回退到 jitCreated）
      newCompanyDetected: v3Result.newCompanyDetected ?? result.jitCreated?.company ?? false,
      newFormatDetected: v3Result.newFormatDetected ?? result.jitCreated?.format ?? false,
      needsConfigReview: v3Result.needsConfigReview ??
        ((result.jitCreated?.company ?? false) || (result.jitCreated?.format ?? false)),
      configSource: v3Result.configSource,
      overallConfidence: v3Result.confidenceResult?.overallScore
        ? v3Result.confidenceResult.overallScore / 100
        : result.overallConfidence / 100,
      confidenceBreakdown,
      routingDecision,
      warnings: v3Result.warnings.map((w) => ({
        step: ProcessingStep.FILE_TYPE_DETECTION,
        message: w,
        timestamp: new Date().toISOString(),
      })),
      usedLegacyProcessor: false,
      usedV3: true,
      v3Metadata: {
        // V3.1 兼容：metadata 可能不存在，從 aiDetails 獲取
        tokensUsed: result.metadata?.tokensUsed ?? v3Result.aiDetails?.tokenUsage ?? {
          input: 0,
          output: 0,
          total: 0,
        },
        modelUsed: result.metadata?.modelUsed ?? v3Result.aiDetails?.model ?? 'gpt-5.2',
        processingTimeMs: result.metadata?.processingTimeMs ?? totalDurationMs,
      },
      // CHANGE-023: 傳遞 AI 詳情
      aiDetails: v3Result.aiDetails,
      // CHANGE-024: V3.1 三階段欄位
      extractionVersion: v3Result.extractionVersion as 'v2' | 'v3' | 'v3.1' | undefined,
      stageAiDetails: v3Result.stageAiDetails,
      stage1Result: result.issuerIdentification ? {
        companyId: result.issuerIdentification.companyId,
        companyName: result.issuerIdentification.companyName,
        confidence: result.issuerIdentification.confidence,
        isNewCompany: result.issuerIdentification.isNewCompany,
      } : undefined,
      stage2Result: result.formatIdentification ? {
        formatId: result.formatIdentification.formatId,
        formatName: result.formatIdentification.formatName,
        confidence: result.formatIdentification.confidence,
        isNewFormat: result.formatIdentification.isNewFormat,
      } : undefined,
      // FIX-044: 保留完整 Stage 3 數據（原本只存摘要，導致事後無法回填）
      stage3Result: v3Result.result ? {
        success: true,
        fieldCount: Object.keys(result.standardFields || {}).length,
        lineItemCount: result.lineItems?.length || 0,
        overallConfidence: result.overallConfidence,
        standardFields: { ...result.standardFields },
        customFields: result.customFields ? { ...result.customFields } : undefined,
        fields: result.fields ? { ...result.fields } : undefined, // FIX-045: 保留原始 key
        lineItems: result.lineItems ? [...result.lineItems] : undefined,
      } : undefined,
      // CHANGE-072: 帶上 FX 換算結果，使 persistProcessingResult 能持久化審計原值
      //（覆蓋寫回後，原始金額僅存於 fxConversionResult.conversions[]）
      exchangeRateConversion: v3Result.exchangeRateConversion,
      // FIX-092: 帶上參考編號匹配結果，使 persistProcessingResult 能持久化 referenceNumberMatch
      //（否則 ExtractionResult.referenceNumberMatch 永遠 NULL，Template 注入不到 _ref_*）
      referenceNumberMatch: v3Result.referenceNumberMatch,
    };
  }

  /**
   * 將 V3.1 欄位轉為 V2 MappedFieldValue[] 格式
   * @private
   * @since FIX-044 (initial), FIX-045 (fields priority)
   * @description
   *   優先使用 Stage 3 的 fields Record（保留 FieldDefinitionSet 原始 key），
   *   如果不存在（無 FieldDefinition 配置時），fallback 到 standardFields（camelCase）。
   */
  private convertStandardFieldsToMappedFields(
    fields: Record<string, { value: string | number | null; confidence: number }> | null,
    standardFields: Record<string, { value: string | number | null; confidence: number; source?: string }>,
    customFields?: Record<string, { value: string | number | null; confidence: number }> | undefined
  ): MappedFieldValue[] {
    const mappedFields: MappedFieldValue[] = [];

    // FIX-045: 優先使用 fields（原始 FieldDefinitionSet key）
    const primarySource = fields ?? standardFields;

    for (const [key, fieldValue] of Object.entries(primarySource)) {
      if (fieldValue && typeof fieldValue === 'object' && 'value' in fieldValue) {
        mappedFields.push({
          targetField: key,
          value: fieldValue.value,
          sourceFields: [key],
          originalValues: [fieldValue.value],
          transformType: 'DIRECT' as TransformType,
          success: fieldValue.value !== null && fieldValue.value !== undefined,
        });
      }
    }

    // 如果使用了 fields，則 customFields 已包含在內（Stage 3 的 fields 包含所有欄位）
    // 僅在 fallback 到 standardFields 時才需要額外處理 customFields
    if (!fields && customFields) {
      for (const [key, fieldValue] of Object.entries(customFields)) {
        if (fieldValue && typeof fieldValue === 'object' && 'value' in fieldValue) {
          mappedFields.push({
            targetField: key,
            value: fieldValue.value,
            sourceFields: [key],
            originalValues: [fieldValue.value],
            transformType: 'DIRECT' as TransformType,
            success: fieldValue.value !== null && fieldValue.value !== undefined,
          });
        }
      }
    }

    return mappedFields;
  }

  /**
   * 批量處理文件
   * @param inputs - 文件輸入列表
   * @param options - 處理選項
   * @returns 處理結果列表
   */
  async processFiles(
    inputs: ProcessFileInput[],
    options?: ProcessOptions
  ): Promise<UnifiedProcessingResult[]> {
    // 並行處理所有文件
    return Promise.all(inputs.map((input) => this.processFile(input, options)));
  }

  /**
   * 使用 Legacy 處理器
   */
  private async useLegacyProcessor(
    input: ProcessFileInput
  ): Promise<UnifiedProcessingResult> {
    return legacyProcessorAdapter.processFile(input);
  }

  /**
   * 創建處理上下文
   */
  private createContext(input: ProcessFileInput): UnifiedProcessingContext {
    return {
      input,
      status: 'PROCESSING',
      currentStep: ProcessingStep.FILE_TYPE_DETECTION,
      stepResults: [],
      extractedData: {},
      warnings: [],
      startTime: Date.now(),
    };
  }

  /**
   * 執行處理管道
   * @description 按順序執行所有步驟，處理 REQUIRED/OPTIONAL 邏輯
   */
  private async executePipeline(
    context: UnifiedProcessingContext,
    flags: UnifiedProcessorFlags
  ): Promise<StepResult[]> {
    const stepResults: StepResult[] = [];

    for (const handler of this.stepHandlers) {
      // 更新當前步驟
      context.currentStep = handler.step;

      // CHANGE-019: 在關鍵步驟前更新 Document 狀態，提供即時 UX 回饋
      const intermediateStatus = STEP_STATUS_MAP[handler.step];
      if (intermediateStatus) {
        try {
          await prisma.document.update({
            where: { id: context.input.fileId },
            data: { status: intermediateStatus as import('@prisma/client').DocumentStatus },
          });
        } catch (statusErr) {
          // 狀態更新失敗不應中斷處理管線
          console.warn(
            `[UnifiedProcessor] Failed to update status to ${intermediateStatus} for ${context.input.fileId}:`,
            statusErr
          );
        }
      }

      // 檢查是否應該跳過
      if (!handler.shouldExecute(context, flags)) {
        stepResults.push({
          step: handler.step,
          success: true,
          skipped: true,
          durationMs: 0,
        });
        continue;
      }

      // 執行步驟
      const result = await handler.execute(context, flags);
      stepResults.push(result);
      context.stepResults.push(result);

      // 處理步驟失敗
      if (!result.success && !result.skipped) {
        const stepConfig = getStepConfig(handler.step);

        if (stepConfig?.priority === StepPriority.REQUIRED) {
          // REQUIRED 步驟失敗：中斷整個流程
          context.status = 'FAILED';
          break;
        } else {
          // OPTIONAL 步驟失敗：記錄警告並繼續
          context.warnings.push({
            step: handler.step,
            message: result.error ?? 'Step failed',
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // 如果沒有失敗，標記為完成
    if (context.status !== 'FAILED') {
      context.status = 'COMPLETED';
    }

    return stepResults;
  }

  /**
   * 構建處理結果
   */
  private buildResult(
    context: UnifiedProcessingContext,
    stepResults: StepResult[],
    startTime: number
  ): UnifiedProcessingResult {
    const totalDurationMs = Date.now() - startTime;

    if (context.status === 'FAILED') {
      // 找到失敗的步驟
      const failedStep = stepResults.find((r) => !r.success && !r.skipped);
      return {
        success: false,
        fileId: context.input.fileId,
        status: 'FAILED',
        totalDurationMs,
        stepResults,
        error: failedStep?.error ?? 'Processing failed',
        warnings: context.warnings,
        usedLegacyProcessor: false,
      };
    }

    return {
      success: true,
      fileId: context.input.fileId,
      status: 'COMPLETED',
      totalDurationMs,
      stepResults,
      fileType: context.fileType,
      processingMethod: context.processingMethod,
      extractedData: context.extractedData,
      companyId: context.companyId,
      companyName: context.companyName,
      isNewCompany: context.isNewCompany,
      documentFormatId: context.documentFormatId,
      documentFormatName: context.documentFormatName,
      isNewFormat: context.isNewFormat,
      mappedFields: context.mappedFields,
      unmappedFields: context.unmappedFields,
      recordedTerms: context.recordedTerms,
      overallConfidence: context.overallConfidence,
      confidenceBreakdown: context.confidenceBreakdown,
      routingDecision: context.routingDecision,
      warnings: context.warnings,
      usedLegacyProcessor: false,
    };
  }

  /**
   * 構建錯誤結果
   */
  private buildErrorResult(
    fileId: string,
    error: Error,
    context: UnifiedProcessingContext | null,
    startTime: number
  ): UnifiedProcessingResult {
    return {
      success: false,
      fileId,
      status: 'FAILED',
      totalDurationMs: Date.now() - startTime,
      stepResults: context?.stepResults ?? [],
      error: error.message,
      warnings: context?.warnings ?? [],
      usedLegacyProcessor: false,
    };
  }

  /**
   * 更新 Feature Flags
   */
  updateFlags(flags: Partial<UnifiedProcessorFlags>): void {
    this.flags = { ...this.flags, ...flags };
  }

  /**
   * 取得當前 Feature Flags
   */
  getFlags(): UnifiedProcessorFlags {
    return { ...this.flags };
  }

  /**
   * 檢查統一處理器是否啟用
   */
  isUnifiedProcessorEnabled(): boolean {
    return this.flags.enableUnifiedProcessor;
  }
}

// ============================================================================
// 服務單例
// ============================================================================

let serviceInstance: UnifiedDocumentProcessorService | null = null;

/**
 * 取得統一文件處理器服務單例
 */
export function getUnifiedDocumentProcessor(
  flags?: Partial<UnifiedProcessorFlags>
): UnifiedDocumentProcessorService {
  if (!serviceInstance) {
    serviceInstance = new UnifiedDocumentProcessorService(flags);
  } else if (flags) {
    serviceInstance.updateFlags(flags);
  }
  return serviceInstance;
}

/**
 * 重置服務單例（用於測試）
 */
export function resetUnifiedDocumentProcessor(): void {
  serviceInstance = null;
}

// 預設導出
export default UnifiedDocumentProcessorService;
