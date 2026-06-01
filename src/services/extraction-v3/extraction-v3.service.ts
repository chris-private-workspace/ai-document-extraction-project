/**
 * @fileoverview Extraction V3/V3.1 主服務 - 統一提取管線協調器
 * @description
 *   V3/V3.1 統一提取服務的主要入口：
 *
 *   V3 (7 步管線)：
 *   1. FILE_PREPARATION - 文件準備
 *   2. DYNAMIC_PROMPT_ASSEMBLY - 動態 Prompt 組裝
 *   3. UNIFIED_GPT_EXTRACTION - 統一 GPT 提取
 *   4. RESULT_VALIDATION - 結果驗證
 *   5. TERM_RECORDING - 術語記錄
 *   6. CONFIDENCE_CALCULATION - 信心度計算
 *   7. ROUTING_DECISION - 路由決策
 *
 *   V3.1 (7 步管線，3 階段提取 - CHANGE-024)：
 *   1. FILE_PREPARATION - 文件準備
 *   2. STAGE_1_COMPANY_IDENTIFICATION - 公司識別 (GPT-5-nano)
 *   3. STAGE_2_FORMAT_IDENTIFICATION - 格式識別 (GPT-5-nano)
 *   4. STAGE_3_FIELD_EXTRACTION - 欄位提取 (GPT-5.2)
 *   5. TERM_RECORDING - 術語記錄
 *   6. CONFIDENCE_CALCULATION - 信心度計算
 *   7. ROUTING_DECISION - 路由決策
 *
 * @module src/services/extraction-v3/extraction-v3
 * @since CHANGE-021 - Unified Processor V3 Refactoring
 * @lastModified 2026-02-01
 *
 * @features
 *   - V3: 7 步處理管線（單階段 GPT 提取）
 *   - V3.1: 7 步處理管線（三階段 GPT 提取）
 *   - Feature Flags 控制 V3/V3.1 切換
 *   - 錯誤處理和回退支援
 *   - 步驟時間追蹤
 *
 * @dependencies
 *   - ./utils/pdf-converter - PDF 轉換
 *   - ./prompt-assembly.service - Prompt 組裝 (V3)
 *   - ./unified-gpt-extraction.service - GPT 提取 (V3)
 *   - ./result-validation.service - 結果驗證 (V3)
 *   - ./confidence-v3.service - 信心度計算 (V3)
 *   - ./stages/stage-orchestrator.service - 三階段協調器 (V3.1)
 *   - ./confidence-v3-1.service - 信心度計算 (V3.1)
 *
 * @related
 *   - src/types/extraction-v3.types.ts - V3/V3.1 類型定義
 *   - src/constants/processing-steps-v3.ts - V3 步驟常數
 */

import type {
  ExtractionV3Input,
  ExtractionV3Output,
  ProcessingContextV3,
  StepResultV3,
  ExtractionV3Flags,
  AiDetailsV3,
  // V3.1 types
  ExtractionV3_1Output,
  ProcessingStepV3_1,
  StepResultV3_1,
} from '@/types/extraction-v3.types';
import {
  ProcessingStepV3,
  UnifiedFileType,
} from '@/types/extraction-v3.types';
import {
  PROCESSING_STEP_ORDER_V3,
  STEP_PRIORITY_V3,
  STEP_TIMEOUT_V3,
  STEP_RETRY_COUNT_V3,
  isRequiredStepV3,
  getStepDisplayNameV3,
} from '@/constants/processing-steps-v3';
import { StepPriorityV3 } from '@/types/extraction-v3.types';
import { DEFAULT_EXTRACTION_V3_FLAGS } from '@/types/extraction-v3.types';
import { PdfConverter } from './utils/pdf-converter';
import { PromptAssemblyService } from './prompt-assembly.service';
import { UnifiedGptExtractionService } from './unified-gpt-extraction.service';
import { ResultValidationService } from './result-validation.service';
import { ConfidenceV3Service } from './confidence-v3.service';
// V3.1 imports (CHANGE-024)
import { StageOrchestratorService } from './stages/stage-orchestrator.service';
import { ConfidenceV3_1Service } from './confidence-v3-1.service';
import { prisma } from '@/lib/prisma';
// CHANGE-032 imports
import type {
  ReferenceNumberMatchResult,
  ExchangeRateConversionResult,
} from '@/types/extraction-v3.types';
import { ReferenceNumberMatcherService } from './stages/reference-number-matcher.service';
import { ExchangeRateConverterService } from './stages/exchange-rate-converter.service';
import { resolveEffectiveConfig } from '@/services/pipeline-config.service';

// ============================================================================
// Types
// ============================================================================

/**
 * V3 服務配置
 */
export interface ExtractionV3Config {
  /** Feature Flags */
  flags?: Partial<ExtractionV3Flags>;
  /** 是否啟用調試日誌 */
  debug?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/** 檔案類型映射 */
const MIME_TYPE_TO_FILE_TYPE: Record<string, UnifiedFileType> = {
  'application/pdf': UnifiedFileType.NATIVE_PDF, // V3 統一使用 GPT Vision，不區分 PDF 類型
  'image/jpeg': UnifiedFileType.IMAGE,
  'image/png': UnifiedFileType.IMAGE,
  'image/tiff': UnifiedFileType.IMAGE,
  'image/webp': UnifiedFileType.IMAGE,
};

// ============================================================================
// Service Class
// ============================================================================

/**
 * Extraction V3 主服務
 *
 * @description 協調 7 步處理管線的主服務
 *
 * @example
 * ```typescript
 * const service = new ExtractionV3Service();
 * const result = await service.processFile({
 *   fileId: 'file_123',
 *   fileBuffer: buffer,
 *   fileName: 'invoice.pdf',
 *   mimeType: 'application/pdf',
 *   cityCode: 'HKG',
 * });
 * ```
 */
export class ExtractionV3Service {
  private flags: ExtractionV3Flags;
  private debug: boolean;
  private stageOrchestrator: StageOrchestratorService | null = null;

  constructor(config: ExtractionV3Config = {}) {
    this.flags = { ...DEFAULT_EXTRACTION_V3_FLAGS, ...config.flags };
    this.debug = config.debug ?? false;
    // V3.1: 延遲初始化 StageOrchestratorService
  }

  /**
   * 獲取或創建 StageOrchestratorService（V3.1）
   */
  private getStageOrchestrator(): StageOrchestratorService {
    if (!this.stageOrchestrator) {
      this.stageOrchestrator = new StageOrchestratorService(prisma);
    }
    return this.stageOrchestrator;
  }

  /**
   * 判斷是否應該使用 V3.1 三階段架構
   */
  private shouldUseV3_1(): boolean {
    if (!this.flags.useExtractionV3_1) {
      return false;
    }

    // 灰度發布：根據百分比決定
    if (this.flags.extractionV3_1Percentage < 100) {
      const random = Math.random() * 100;
      return random < this.flags.extractionV3_1Percentage;
    }

    return true;
  }

  /**
   * 處理文件（主入口）
   *
   * @description
   *   根據 Feature Flags 決定使用 V3 或 V3.1 架構：
   *   - V3: 單階段 GPT 提取（7 步管線）
   *   - V3.1: 三階段 GPT 提取（7 步管線，CHANGE-024）
   *
   * @param input - 處理輸入
   * @returns 處理輸出
   */
  async processFile(input: ExtractionV3Input): Promise<ExtractionV3Output> {
    // 決定使用 V3 還是 V3.1
    const useV3_1 = this.shouldUseV3_1();

    if (useV3_1) {
      this.log('使用 V3.1 三階段架構');
      try {
        return await this.processFileV3_1(input);
      } catch (error) {
        // V3.1 失敗，嘗試回退到 V3
        if (this.flags.fallbackToV3OnError) {
          this.log('V3.1 失敗，回退到 V3 架構');
          return this.processFileV3(input);
        }
        throw error;
      }
    }

    this.log('使用 V3 單階段架構');
    return this.processFileV3(input);
  }

  /**
   * V3 處理流程（原有的 7 步管線）
   */
  private async processFileV3(input: ExtractionV3Input): Promise<ExtractionV3Output> {
    const startTime = Date.now();
    const stepTimings: Partial<Record<ProcessingStepV3, number>> = {};
    const stepResults: StepResultV3[] = [];
    const warnings: string[] = [];

    // 初始化處理上下文
    const context: ProcessingContextV3 = {
      input,
      status: 'PROCESSING',
      currentStep: 'FILE_PREPARATION' as ProcessingStepV3,
      startTime,
      stepResults: [],
      warnings: [],
    };

    try {
      // 執行 7 步處理管線
      for (const step of PROCESSING_STEP_ORDER_V3) {
        context.currentStep = step;
        const stepStartTime = Date.now();

        this.log(`開始步驟: ${getStepDisplayNameV3(step)}`);

        try {
          const stepResult = await this.executeStep(step, context);
          stepTimings[step] = Date.now() - stepStartTime;

          stepResults.push(stepResult);
          context.stepResults.push(stepResult);

          if (!stepResult.success) {
            // 檢查步驟優先級
            if (isRequiredStepV3(step)) {
              // 必要步驟失敗，中斷處理
              throw new Error(`必要步驟失敗: ${getStepDisplayNameV3(step)} - ${stepResult.error}`);
            } else {
              // 可選步驟失敗，記錄警告並繼續
              warnings.push(`可選步驟失敗: ${getStepDisplayNameV3(step)} - ${stepResult.error}`);
            }
          }

          this.log(`完成步驟: ${getStepDisplayNameV3(step)} (${stepTimings[step]}ms)`);
        } catch (stepError) {
          const errorMessage = stepError instanceof Error ? stepError.message : '未知錯誤';

          stepResults.push({
            step,
            success: false,
            error: errorMessage,
            durationMs: Date.now() - stepStartTime,
          });

          if (isRequiredStepV3(step)) {
            throw stepError;
          } else {
            warnings.push(`可選步驟異常: ${getStepDisplayNameV3(step)} - ${errorMessage}`);
          }
        }
      }

      // 處理成功
      context.status = 'COMPLETED';

      return {
        success: true,
        result: context.validatedResult,
        confidenceResult: context.confidenceResult,
        routingDecision: context.routingDecision,
        aiDetails: context.aiDetails, // CHANGE-023: 包含 AI 詳情
        timing: {
          totalMs: Date.now() - startTime,
          stepTimings,
        },
        stepResults,
        warnings: [...warnings, ...context.warnings],
      };
    } catch (error) {
      context.status = 'FAILED';

      return {
        success: false,
        error: error instanceof Error ? error.message : '處理過程發生未知錯誤',
        timing: {
          totalMs: Date.now() - startTime,
          stepTimings,
        },
        stepResults,
        warnings,
      };
    }
  }

  /**
   * V3.1 處理流程（三階段 GPT 提取 - CHANGE-024）
   *
   * @description
   *   執行三階段提取流程：
   *   1. FILE_PREPARATION - 文件準備（PDF → Base64 圖片）
   *   2. STAGE_1_COMPANY_IDENTIFICATION - 公司識別（GPT-5-nano）
   *   3. STAGE_2_FORMAT_IDENTIFICATION - 格式識別（GPT-5-nano）
   *   4. STAGE_3_FIELD_EXTRACTION - 欄位提取（GPT-5.2）
   *   5. TERM_RECORDING - 術語記錄
   *   6. CONFIDENCE_CALCULATION - 信心度計算（V3.1 5 維度）
   *   7. ROUTING_DECISION - 路由決策
   */
  private async processFileV3_1(input: ExtractionV3Input): Promise<ExtractionV3Output> {
    const startTime = Date.now();
    const stepTimings: Partial<Record<string, number>> = {};
    const stepResults: StepResultV3[] = [];
    const warnings: string[] = [];

    try {
      // ========== Step 1: FILE_PREPARATION ==========
      const filePreparationStart = Date.now();
      this.log('V3.1 Step 1: 文件準備');

      const { fileBuffer, mimeType } = input;
      const conversionResult = await PdfConverter.convertToBase64(fileBuffer, mimeType);

      if (!conversionResult.success) {
        return {
          success: false,
          error: conversionResult.error || '文件轉換失敗',
          timing: { totalMs: Date.now() - startTime, stepTimings },
          stepResults,
          warnings,
        };
      }

      stepTimings['FILE_PREPARATION'] = Date.now() - filePreparationStart;
      stepResults.push({
        step: 'FILE_PREPARATION' as ProcessingStepV3,
        success: true,
        data: { pageCount: conversionResult.pageCount, imageCount: conversionResult.images.length },
        durationMs: stepTimings['FILE_PREPARATION'],
      });

      if (conversionResult.warnings) {
        warnings.push(...conversionResult.warnings);
      }

      // ========== CHANGE-032: REFERENCE_NUMBER_MATCHING ==========
      let refMatchResult: ReferenceNumberMatchResult | undefined;
      let pipelineConfig;
      try {
        const refMatchStart = Date.now();
        this.log('V3.1 CHANGE-032: 參考號碼匹配');

        pipelineConfig = await resolveEffectiveConfig({
          regionId: input.regionId,
        });

        if (pipelineConfig.refMatchEnabled) {
          const matcher = new ReferenceNumberMatcherService();
          refMatchResult = await matcher.match({
            fileName: input.fileName || '',
            config: pipelineConfig,
            regionId: input.regionId,
          });

          stepTimings['REFERENCE_NUMBER_MATCHING'] = Date.now() - refMatchStart;

          // FIX-036: 啟用即阻塞 — matchesFound === 0 時中止 pipeline
          const hasMatches = refMatchResult.summary.matchesFound > 0;

          stepResults.push({
            step: 'REFERENCE_NUMBER_MATCHING' as ProcessingStepV3,
            success: hasMatches,
            data: {
              candidatesFound: refMatchResult.summary.candidatesFound,
              matchesFound: refMatchResult.summary.matchesFound,
            },
            durationMs: stepTimings['REFERENCE_NUMBER_MATCHING'],
          });

          if (!hasMatches) {
            // FIX-036: 啟用 ref match 但未匹配到任何結果 → 中止 pipeline
            // NOTE: error 必須包含 'REF_MATCH_ABORT' 標記，供 persistence service 判定 REF_MATCH_FAILED 狀態
            return {
              success: false,
              error: `REF_MATCH_ABORT: Reference number matching enabled but no matches found in filename "${input.fileName}". Pipeline aborted.`,
              referenceNumberMatch: refMatchResult,
              timing: {
                totalMs: Date.now() - startTime,
                stepTimings,
              },
              stepResults,
              warnings: [
                ...warnings,
                'REF_MATCH_ABORT: No reference numbers matched. File processing stopped.',
              ],
            } as unknown as ExtractionV3Output;
          }
        } else {
          refMatchResult = {
            enabled: false,
            matches: [],
            summary: { candidatesFound: 0, matchesFound: 0, sources: [] },
            processingTimeMs: 0,
          };
          stepTimings['REFERENCE_NUMBER_MATCHING'] = Date.now() - refMatchStart;
          stepResults.push({
            step: 'REFERENCE_NUMBER_MATCHING' as ProcessingStepV3,
            success: true,
            data: { skipped: true, reason: 'disabled' },
            durationMs: stepTimings['REFERENCE_NUMBER_MATCHING'],
            skipped: true,
          });
        }
      } catch (refMatchError) {
        const errorMsg = refMatchError instanceof Error ? refMatchError.message : 'Unknown ref match error';
        warnings.push(`Reference number matching failed: ${errorMsg}`);
        stepResults.push({
          step: 'REFERENCE_NUMBER_MATCHING' as ProcessingStepV3,
          success: false,
          durationMs: 0,
          error: errorMsg,
        });
      }

      // ========== Steps 2-4: 三階段提取 ==========
      this.log('V3.1 Steps 2-4: 三階段 GPT 提取');
      const orchestrator = this.getStageOrchestrator();

      const threeStageResult = await orchestrator.execute(
        {
          input,
          imageBase64Array: conversionResult.images,
          pageCount: conversionResult.pageCount,
        },
        {
          autoCreateCompany: input.options?.autoCreateCompany ?? true,
          autoCreateFormat: input.options?.autoCreateFormat ?? true,
          imageDetailMode: 'auto',
          continueOnStageFailure: false,
        }
      );

      // 記錄三階段步驟結果
      for (const stepResult of threeStageResult.stepResults) {
        stepTimings[stepResult.step] = stepResult.durationMs;
        stepResults.push({
          step: stepResult.step as unknown as ProcessingStepV3, // V3.1 步驟名稱兼容
          success: stepResult.success,
          data: stepResult.data,
          durationMs: stepResult.durationMs,
          error: stepResult.error,
        });
      }

      if (!threeStageResult.success) {
        return {
          success: false,
          error: threeStageResult.error || '三階段提取失敗',
          timing: { totalMs: Date.now() - startTime, stepTimings },
          stepResults,
          warnings,
        };
      }

      // ========== CHANGE-032: EXCHANGE_RATE_CONVERSION ==========
      let fxConversionResult: ExchangeRateConversionResult | undefined;
      try {
        const fxStart = Date.now();
        this.log('V3.1 CHANGE-032: 匯率轉換');

        // 重新 resolve（此時已知 company，可能有 COMPANY-level override）
        const fxConfig = await resolveEffectiveConfig({
          regionId: input.regionId,
          companyId: threeStageResult.stage1?.companyId || undefined,
          // CHANGE-071: 傳入 Stage 2 格式 ID，支援 FORMAT scope 條件式 FX 轉換
          formatId: threeStageResult.stage2?.formatId || undefined,
        });

        if (fxConfig.fxConversionEnabled && threeStageResult.stage3) {
          const converter = new ExchangeRateConverterService();
          fxConversionResult = await converter.convert({
            stage3Result: threeStageResult.stage3,
            config: fxConfig,
            // CHANGE-072: 傳入公司/格式 ID，載入合併 FieldDefinitionSet 判定動態 currency 欄位
            companyId: threeStageResult.stage1?.companyId || undefined,
            formatId: threeStageResult.stage2?.formatId || undefined,
          });

          stepTimings['EXCHANGE_RATE_CONVERSION'] = Date.now() - fxStart;
          stepResults.push({
            step: 'EXCHANGE_RATE_CONVERSION' as ProcessingStepV3,
            success: true,
            data: {
              conversionsCount: fxConversionResult.conversions.length,
              sourceCurrency: fxConversionResult.sourceCurrency,
              targetCurrency: fxConversionResult.targetCurrency,
            },
            durationMs: stepTimings['EXCHANGE_RATE_CONVERSION'],
          });

          if (fxConversionResult.warnings.length > 0) {
            warnings.push(...fxConversionResult.warnings);
          }
        } else {
          fxConversionResult = {
            enabled: false,
            conversions: [],
            warnings: [],
            processingTimeMs: 0,
          };
          stepTimings['EXCHANGE_RATE_CONVERSION'] = Date.now() - fxStart;
          stepResults.push({
            step: 'EXCHANGE_RATE_CONVERSION' as ProcessingStepV3,
            success: true,
            data: { skipped: true, reason: fxConfig.fxConversionEnabled ? 'no-stage3-result' : 'disabled' },
            durationMs: stepTimings['EXCHANGE_RATE_CONVERSION'],
            skipped: true,
          });
        }
      } catch (fxError) {
        const errorMsg = fxError instanceof Error ? fxError.message : 'Unknown FX conversion error';
        warnings.push(`Exchange rate conversion failed: ${errorMsg}`);
        stepResults.push({
          step: 'EXCHANGE_RATE_CONVERSION' as ProcessingStepV3,
          success: false,
          durationMs: 0,
          error: errorMsg,
        });
      }

      // ========== Step 5: TERM_RECORDING ==========
      const termRecordingStart = Date.now();
      this.log('V3.1 Step 5: 術語記錄');
      // TODO: 實現術語記錄邏輯（與 V3 相同，可選步驟）
      stepTimings['TERM_RECORDING'] = Date.now() - termRecordingStart;
      stepResults.push({
        step: 'TERM_RECORDING' as ProcessingStepV3,
        success: true,
        data: { newTermsCount: 0, matchedTermsCount: 0 },
        durationMs: stepTimings['TERM_RECORDING'],
      });

      // ========== Step 6: CONFIDENCE_CALCULATION (V3.1) ==========
      const confidenceStart = Date.now();
      this.log('V3.1 Step 6: 信心度計算（5 維度）');

      const confidenceServiceResult = ConfidenceV3_1Service.calculate({
        stage1Result: threeStageResult.stage1!,
        stage2Result: threeStageResult.stage2!,
        stage3Result: threeStageResult.stage3!,
        refMatchResult,
        refMatchEnabled: pipelineConfig?.refMatchEnabled ?? false,
      });

      if (!confidenceServiceResult.success || !confidenceServiceResult.result) {
        return {
          success: false,
          error: confidenceServiceResult.error || '信心度計算失敗',
          timing: { totalMs: Date.now() - startTime, stepTimings },
          stepResults,
          warnings,
        };
      }

      const confidenceResult = confidenceServiceResult.result;

      stepTimings['CONFIDENCE_CALCULATION'] = Date.now() - confidenceStart;
      stepResults.push({
        step: 'CONFIDENCE_CALCULATION' as ProcessingStepV3,
        success: true,
        data: { overallScore: confidenceResult.overallScore, level: confidenceResult.level },
        durationMs: stepTimings['CONFIDENCE_CALCULATION'],
      });

      // ========== Step 7: ROUTING_DECISION ==========
      const routingStart = Date.now();
      this.log('V3.1 Step 7: 路由決策');

      // 根據信心度決定路由
      let routingPath: 'AUTO_APPROVE' | 'QUICK_REVIEW' | 'FULL_REVIEW';
      if (confidenceResult.overallScore >= 90) {
        routingPath = 'AUTO_APPROVE';
      } else if (confidenceResult.overallScore >= 70) {
        routingPath = 'QUICK_REVIEW';
      } else {
        routingPath = 'FULL_REVIEW';
      }

      const routingDecision = {
        decision: routingPath, // 與 convertV3Result 期望的結構一致
        recommendedPath: routingPath, // 保持向後兼容
        confidence: confidenceResult.overallScore,
        reasons: confidenceResult.dimensions.map((d) => `${d.dimension}: ${d.rawScore}`),
      };

      stepTimings['ROUTING_DECISION'] = Date.now() - routingStart;
      stepResults.push({
        step: 'ROUTING_DECISION' as ProcessingStepV3,
        success: true,
        data: routingDecision,
        durationMs: stepTimings['ROUTING_DECISION'],
      });

      // ========== 構建輸出結果 ==========
      const totalTokenUsage = orchestrator.calculateTotalTokenUsage(threeStageResult);
      const stageAiDetails = orchestrator.getStageAiDetails(threeStageResult);

      // CHANGE-025: 計算智能路由標記
      const isNewCompany = threeStageResult.stage1?.isNewCompany || false;
      const isNewFormat = threeStageResult.stage2?.isNewFormat || false;
      const needsConfigReview = isNewCompany || isNewFormat;
      const configSource = threeStageResult.stage2?.configSource || 'LLM_INFERRED';

      return {
        success: true,
        extractionVersion: 'v3.1',
        // CHANGE-025: 智能路由標記
        newCompanyDetected: isNewCompany,
        newFormatDetected: isNewFormat,
        needsConfigReview,
        configSource: configSource === 'COMPANY_SPECIFIC' ? 'FORMAT'
          : configSource === 'UNIVERSAL' ? 'GLOBAL'
          : 'DEFAULT',
        result: threeStageResult.stage3 ? {
          standardFields: threeStageResult.stage3.standardFields,
          customFields: threeStageResult.stage3.customFields,
          fields: threeStageResult.stage3.fields, // FIX-045: 傳遞原始 FieldDefinitionSet key
          lineItems: threeStageResult.stage3.lineItems,
          // CHANGE-045: extraCharges removed from Stage 3 output
          overallConfidence: threeStageResult.stage3.overallConfidence,
          // FIX: V3.1 需要設定 resolvedCompanyId/resolvedFormatId
          // 統一處理器的 convertV3Result 依賴這兩個欄位寫入 Document.companyId
          resolvedCompanyId: threeStageResult.stage1?.companyId || '',
          resolvedFormatId: threeStageResult.stage2?.formatId,
          // 從 Stage 1/2 獲取公司和格式信息
          issuerIdentification: {
            companyId: threeStageResult.stage1?.companyId,
            companyName: threeStageResult.stage1?.companyName || '',
            confidence: threeStageResult.stage1?.confidence || 0,
            isNewCompany: threeStageResult.stage1?.isNewCompany || false,
          },
          formatIdentification: {
            formatId: threeStageResult.stage2?.formatId,
            formatName: threeStageResult.stage2?.formatName || '',
            confidence: threeStageResult.stage2?.confidence || 0,
            isNewFormat: threeStageResult.stage2?.isNewFormat || false,
          },
          validation: { isValid: true, errors: [], warnings: [] },
          jitCreated: {
            company: threeStageResult.stage1?.isNewCompany || false,
            format: threeStageResult.stage2?.isNewFormat || false,
          },
        } : undefined,
        confidenceResult: {
          overallScore: confidenceResult.overallScore,
          level: confidenceResult.level,
          dimensions: confidenceResult.dimensions.map((d) => ({
            dimension: d.dimension as string,
            score: d.rawScore,
            weight: d.weight,
          })),
          calculatedAt: confidenceResult.calculatedAt,
        },
        routingDecision,
        aiDetails: {
          prompt: stageAiDetails.stage3?.prompt || '',
          response: stageAiDetails.stage3?.response || '',
          tokenUsage: totalTokenUsage,
          model: stageAiDetails.stage3?.model || 'gpt-5.2',
        },
        // V3.1 特有：三階段 AI 詳情
        stageAiDetails,
        // CHANGE-032: Pipeline 擴展結果
        referenceNumberMatch: refMatchResult,
        exchangeRateConversion: fxConversionResult,
        timing: {
          totalMs: Date.now() - startTime,
          stepTimings,
        },
        stepResults,
        warnings,
      } as unknown as ExtractionV3Output;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'V3.1 處理過程發生未知錯誤',
        timing: {
          totalMs: Date.now() - startTime,
          stepTimings,
        },
        stepResults,
        warnings,
      };
    }
  }

  /**
   * 執行單一步驟
   */
  private async executeStep(
    step: ProcessingStepV3,
    context: ProcessingContextV3
  ): Promise<StepResultV3> {
    const startTime = Date.now();

    switch (step) {
      case 'FILE_PREPARATION':
        return this.executeFilePreparation(context, startTime);

      case 'DYNAMIC_PROMPT_ASSEMBLY':
        return this.executeDynamicPromptAssembly(context, startTime);

      case 'UNIFIED_GPT_EXTRACTION':
        return this.executeUnifiedGptExtraction(context, startTime);

      case 'RESULT_VALIDATION':
        return this.executeResultValidation(context, startTime);

      case 'TERM_RECORDING':
        return this.executeTermRecording(context, startTime);

      case 'CONFIDENCE_CALCULATION':
        return this.executeConfidenceCalculation(context, startTime);

      case 'ROUTING_DECISION':
        return this.executeRoutingDecision(context, startTime);

      default:
        return {
          step,
          success: false,
          error: `未知步驟: ${step}`,
          durationMs: Date.now() - startTime,
        };
    }
  }

  // ============================================================================
  // Step Implementations
  // ============================================================================

  /**
   * Step 1: 文件準備
   */
  private async executeFilePreparation(
    context: ProcessingContextV3,
    startTime: number
  ): Promise<StepResultV3> {
    try {
      const { fileBuffer, mimeType } = context.input;

      // 檢測文件類型
      const fileType = MIME_TYPE_TO_FILE_TYPE[mimeType];
      if (!fileType) {
        return {
          step: 'FILE_PREPARATION' as ProcessingStepV3,
          success: false,
          error: `不支援的文件類型: ${mimeType}`,
          durationMs: Date.now() - startTime,
        };
      }

      // 轉換為 Base64 圖片
      const conversionResult = await PdfConverter.convertToBase64(
        fileBuffer,
        mimeType
      );

      if (!conversionResult.success) {
        return {
          step: 'FILE_PREPARATION' as ProcessingStepV3,
          success: false,
          error: conversionResult.error || '文件轉換失敗',
          durationMs: Date.now() - startTime,
        };
      }

      // 更新上下文
      context.fileType = fileType as UnifiedFileType;
      context.imageBase64Array = conversionResult.images;
      context.pageCount = conversionResult.pageCount;

      if (conversionResult.warnings) {
        context.warnings.push(...conversionResult.warnings);
      }

      return {
        step: 'FILE_PREPARATION' as ProcessingStepV3,
        success: true,
        data: {
          fileType,
          pageCount: conversionResult.pageCount,
          imageCount: conversionResult.images.length,
        },
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        step: 'FILE_PREPARATION' as ProcessingStepV3,
        success: false,
        error: error instanceof Error ? error.message : '文件準備失敗',
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Step 2: 動態 Prompt 組裝
   */
  private async executeDynamicPromptAssembly(
    context: ProcessingContextV3,
    startTime: number
  ): Promise<StepResultV3> {
    try {
      const result = await PromptAssemblyService.assemblePrompt(
        {
          cityCode: context.input.cityCode,
          existingCompanyId: context.input.options?.existingCompanyId,
          existingFormatId: context.input.options?.existingFormatId,
        },
        context.imageBase64Array?.length || 1
      );

      if (!result.success || !result.prompt) {
        return {
          step: 'DYNAMIC_PROMPT_ASSEMBLY' as ProcessingStepV3,
          success: false,
          error: result.error || 'Prompt 組裝失敗',
          durationMs: Date.now() - startTime,
        };
      }

      // 更新上下文
      context.assembledPrompt = result.prompt;
      context.promptConfig = result.config;

      if (this.flags.logPromptAssembly) {
        this.log('組裝的 Prompt:', result.prompt.metadata);
      }

      return {
        step: 'DYNAMIC_PROMPT_ASSEMBLY' as ProcessingStepV3,
        success: true,
        data: result.prompt.metadata,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        step: 'DYNAMIC_PROMPT_ASSEMBLY' as ProcessingStepV3,
        success: false,
        error: error instanceof Error ? error.message : 'Prompt 組裝失敗',
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Step 3: 統一 GPT 提取
   */
  private async executeUnifiedGptExtraction(
    context: ProcessingContextV3,
    startTime: number
  ): Promise<StepResultV3> {
    try {
      if (!context.assembledPrompt || !context.imageBase64Array) {
        return {
          step: 'UNIFIED_GPT_EXTRACTION' as ProcessingStepV3,
          success: false,
          error: '缺少 Prompt 或圖片',
          durationMs: Date.now() - startTime,
        };
      }

      const result = await UnifiedGptExtractionService.extract(
        context.assembledPrompt,
        context.imageBase64Array
      );

      if (!result.success || !result.result) {
        return {
          step: 'UNIFIED_GPT_EXTRACTION' as ProcessingStepV3,
          success: false,
          error: result.error || 'GPT 提取失敗',
          durationMs: Date.now() - startTime,
        };
      }

      // 更新上下文
      context.extractionResult = result.result;

      // CHANGE-023: 收集 AI 詳情
      if (result.fullPrompt && result.tokenUsage) {
        context.aiDetails = {
          prompt: result.fullPrompt.combinedPrompt,
          response: result.rawResponse || '',
          tokenUsage: {
            input: result.tokenUsage.input,
            output: result.tokenUsage.output,
            total: result.tokenUsage.total,
          },
          model: result.result.metadata.modelUsed,
          imageDetailMode: result.fullPrompt.imageDetailMode,
          imageCount: result.fullPrompt.imageCount,
        };
      }

      if (this.flags.logGptResponse) {
        this.log('GPT 響應:', result.rawResponse);
      }

      return {
        step: 'UNIFIED_GPT_EXTRACTION' as ProcessingStepV3,
        success: true,
        data: {
          overallConfidence: result.result.overallConfidence,
          tokensUsed: result.tokenUsage,
          lineItemsCount: result.result.lineItems.length,
        },
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        step: 'UNIFIED_GPT_EXTRACTION' as ProcessingStepV3,
        success: false,
        error: error instanceof Error ? error.message : 'GPT 提取失敗',
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Step 4: 結果驗證
   */
  private async executeResultValidation(
    context: ProcessingContextV3,
    startTime: number
  ): Promise<StepResultV3> {
    try {
      if (!context.extractionResult) {
        return {
          step: 'RESULT_VALIDATION' as ProcessingStepV3,
          success: false,
          error: '缺少提取結果',
          durationMs: Date.now() - startTime,
        };
      }

      const result = await ResultValidationService.validate(
        context.extractionResult,
        {
          cityCode: context.input.cityCode,
          autoCreateCompany: context.input.options?.autoCreateCompany ?? true,
          autoCreateFormat: context.input.options?.autoCreateFormat ?? true,
          promptConfig: context.promptConfig,
        }
      );

      if (!result.success || !result.result) {
        return {
          step: 'RESULT_VALIDATION' as ProcessingStepV3,
          success: false,
          error: result.error || '結果驗證失敗',
          durationMs: Date.now() - startTime,
        };
      }

      // 更新上下文
      context.validatedResult = result.result;
      context.companyId = result.result.resolvedCompanyId;
      context.companyName = result.result.issuerIdentification.companyName;
      context.isNewCompany = result.result.jitCreated?.company || false;
      context.documentFormatId = result.result.resolvedFormatId;
      context.documentFormatName = result.result.formatIdentification.formatName;
      context.isNewFormat = result.result.jitCreated?.format || false;

      // 添加驗證警告
      if (result.result.validation.warnings.length > 0) {
        context.warnings.push(...result.result.validation.warnings);
      }

      return {
        step: 'RESULT_VALIDATION' as ProcessingStepV3,
        success: true,
        data: {
          isValid: result.result.validation.isValid,
          errorsCount: result.result.validation.errors.length,
          warningsCount: result.result.validation.warnings.length,
          jitCreated: result.result.jitCreated,
        },
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        step: 'RESULT_VALIDATION' as ProcessingStepV3,
        success: false,
        error: error instanceof Error ? error.message : '結果驗證失敗',
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Step 5: 術語記錄（可選步驟）
   */
  private async executeTermRecording(
    context: ProcessingContextV3,
    startTime: number
  ): Promise<StepResultV3> {
    try {
      // TODO: 實現術語記錄邏輯
      // 這是可選步驟，暫時返回成功

      const lineItemsWithClassification = context.validatedResult?.lineItems.filter(
        (item) => item.classifiedAs
      ).length || 0;

      const itemsNeedingClassification = context.validatedResult?.lineItems.filter(
        (item) => item.needsClassification
      ).length || 0;

      context.termRecordingStats = {
        totalDetected: context.validatedResult?.lineItems.length || 0,
        newTermsCount: itemsNeedingClassification,
        matchedTermsCount: lineItemsWithClassification,
      };

      return {
        step: 'TERM_RECORDING' as ProcessingStepV3,
        success: true,
        data: context.termRecordingStats,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        step: 'TERM_RECORDING' as ProcessingStepV3,
        success: false,
        error: error instanceof Error ? error.message : '術語記錄失敗',
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Step 6: 信心度計算
   */
  private async executeConfidenceCalculation(
    context: ProcessingContextV3,
    startTime: number
  ): Promise<StepResultV3> {
    try {
      if (!context.validatedResult) {
        return {
          step: 'CONFIDENCE_CALCULATION' as ProcessingStepV3,
          success: false,
          error: '缺少驗證結果',
          durationMs: Date.now() - startTime,
        };
      }

      const result = ConfidenceV3Service.calculate(context.validatedResult);

      if (!result.success || !result.result) {
        return {
          step: 'CONFIDENCE_CALCULATION' as ProcessingStepV3,
          success: false,
          error: result.error || '信心度計算失敗',
          durationMs: Date.now() - startTime,
        };
      }

      // 更新上下文
      context.confidenceResult = result.result;
      context.overallConfidence = result.result.overallScore / 100;

      return {
        step: 'CONFIDENCE_CALCULATION' as ProcessingStepV3,
        success: true,
        data: {
          overallScore: result.result.overallScore,
          level: result.result.level,
        },
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        step: 'CONFIDENCE_CALCULATION' as ProcessingStepV3,
        success: false,
        error: error instanceof Error ? error.message : '信心度計算失敗',
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Step 7: 路由決策
   */
  private async executeRoutingDecision(
    context: ProcessingContextV3,
    startTime: number
  ): Promise<StepResultV3> {
    try {
      if (!context.validatedResult || !context.confidenceResult) {
        return {
          step: 'ROUTING_DECISION' as ProcessingStepV3,
          success: false,
          error: '缺少信心度結果',
          durationMs: Date.now() - startTime,
        };
      }

      // 重新計算以獲取路由決策
      const result = ConfidenceV3Service.calculate(context.validatedResult);

      if (!result.routingDecision) {
        return {
          step: 'ROUTING_DECISION' as ProcessingStepV3,
          success: false,
          error: '無法生成路由決策',
          durationMs: Date.now() - startTime,
        };
      }

      // 更新上下文
      context.routingDecision = result.routingDecision;

      return {
        step: 'ROUTING_DECISION' as ProcessingStepV3,
        success: true,
        data: result.routingDecision,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        step: 'ROUTING_DECISION' as ProcessingStepV3,
        success: false,
        error: error instanceof Error ? error.message : '路由決策失敗',
        durationMs: Date.now() - startTime,
      };
    }
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * 調試日誌
   */
  private log(message: string, data?: unknown): void {
    if (this.debug) {
      console.log(`[ExtractionV3] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
  }

  /**
   * 更新 Feature Flags
   */
  updateFlags(flags: Partial<ExtractionV3Flags>): void {
    this.flags = { ...this.flags, ...flags };
  }

  /**
   * 獲取當前 Feature Flags
   */
  getFlags(): ExtractionV3Flags {
    return { ...this.flags };
  }

  // ============================================================================
  // Static Methods
  // ============================================================================

  /**
   * 快速處理（使用預設配置）
   */
  static async processFile(
    input: ExtractionV3Input,
    config?: ExtractionV3Config
  ): Promise<ExtractionV3Output> {
    const service = new ExtractionV3Service(config);
    return service.processFile(input);
  }

  /**
   * 檢查服務健康狀態
   */
  static async checkHealth(): Promise<{
    healthy: boolean;
    components: Record<string, boolean>;
  }> {
    const components: Record<string, boolean> = {
      pdfConverter: true, // PDF 轉換器總是可用
      promptAssembly: true, // Prompt 組裝總是可用
      gptService: false,
    };

    // 檢查 GPT 服務
    try {
      components.gptService = await UnifiedGptExtractionService.checkHealth();
    } catch {
      components.gptService = false;
    }

    const healthy = Object.values(components).every((v) => v);

    return { healthy, components };
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * 處理文件（使用預設配置）
 */
export async function processFileV3(
  input: ExtractionV3Input,
  config?: ExtractionV3Config
): Promise<ExtractionV3Output> {
  return ExtractionV3Service.processFile(input, config);
}

/**
 * 檢查 V3 服務健康狀態
 */
export async function checkExtractionV3Health(): Promise<{
  healthy: boolean;
  components: Record<string, boolean>;
}> {
  return ExtractionV3Service.checkHealth();
}
