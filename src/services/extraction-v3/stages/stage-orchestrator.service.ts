/**
 * @fileoverview Stage Orchestrator - 三階段協調器服務
 * @description
 *   協調三階段提取流程的執行：
 *   - Stage 1: 公司識別 → Stage 2: 格式識別 → Stage 3: 欄位提取
 *   - 管理階段間的數據傳遞和錯誤處理
 *   - 提供整合的處理結果輸出
 *
 * @module src/services/extraction-v3/stages/stage-orchestrator.service
 * @since CHANGE-024 - Three-Stage Extraction Architecture
 * @lastModified 2026-02-01
 *
 * @features
 *   - 三階段順序執行和協調
 *   - 階段間數據傳遞
 *   - 統一錯誤處理和回退策略
 *   - 完整的處理上下文追蹤
 *   - 可觀測性（每階段時間、Token、AI 詳情）
 *
 * @dependencies
 *   - Stage1CompanyService - 公司識別
 *   - Stage2FormatService - 格式識別
 *   - Stage3ExtractionService - 欄位提取
 *   - PrismaClient - 資料庫訪問
 *
 * @related
 *   - src/types/extraction-v3.types.ts - ProcessingContextV3_1 類型
 *   - src/services/extraction-v3/extraction-v3.service.ts - V3 主服務
 */

import { PrismaClient } from '@prisma/client';
import type {
  ExtractionV3Input,
  ExtractionV3_1Output,
  ProcessingContextV3_1,
  ProcessingStepV3_1,
  Stage1CompanyResult,
  Stage2FormatResult,
  Stage3ExtractionResult,
  StepResultV3_1,
  KnownCompanyForPrompt,
  StageAiDetails,
} from '@/types/extraction-v3.types';
import { PROCESSING_STEP_ORDER_V3_1 } from '@/types/extraction-v3.types';
import { Stage1CompanyService } from './stage-1-company.service';
import { Stage2FormatService } from './stage-2-format.service';
import { Stage3ExtractionService } from './stage-3-extraction.service';
// CHANGE-113 階段一 A: PDF 註解透傳至 Stage 3
import type { PdfAnnotationInfo } from '../utils/pdf-converter';

// ============================================================================
// Types
// ============================================================================

/**
 * Orchestrator 輸入參數
 */
export interface OrchestratorInput {
  /** 輸入資料（與 V3 相同） */
  input: ExtractionV3Input;
  /** Base64 編碼的圖片陣列（FILE_PREPARATION 步驟產出） */
  imageBase64Array: string[];
  /** 頁數 */
  pageCount: number;
  /**
   * PDF FreeText 註解（FILE_PREPARATION 步驟產出）
   * @description CHANGE-113 階段一 A：供 Stage 3 作為 `groupKey` 候選清單
   */
  annotations?: PdfAnnotationInfo[];
}

/**
 * Orchestrator 選項
 */
export interface OrchestratorOptions {
  /** 是否自動創建公司（預設 true） */
  autoCreateCompany?: boolean;
  /** 是否自動創建格式（預設 true） */
  autoCreateFormat?: boolean;
  /** 圖片詳情模式（預設 auto） */
  imageDetailMode?: 'auto' | 'low' | 'high';
  /** Stage 失敗時是否繼續（預設 false） */
  continueOnStageFailure?: boolean;
}

/**
 * 三階段協調結果
 */
interface ThreeStageResult {
  stage1: Stage1CompanyResult | null;
  stage2: Stage2FormatResult | null;
  stage3: Stage3ExtractionResult | null;
  stepResults: StepResultV3_1[];
  success: boolean;
  error?: string;
}

// ============================================================================
// Service Class
// ============================================================================

/**
 * Stage Orchestrator 服務
 * @description 協調三階段提取流程的執行
 * @since CHANGE-024
 */
export class StageOrchestratorService {
  private prisma: PrismaClient;
  private stage1Service: Stage1CompanyService;
  private stage2Service: Stage2FormatService;
  private stage3Service: Stage3ExtractionService;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.stage1Service = new Stage1CompanyService(prisma);
    this.stage2Service = new Stage2FormatService(prisma);
    this.stage3Service = new Stage3ExtractionService(prisma);
  }

  /**
   * 執行三階段提取
   * @param input Orchestrator 輸入
   * @param options Orchestrator 選項
   * @returns 三階段協調結果
   */
  async execute(
    input: OrchestratorInput,
    options: OrchestratorOptions = {}
  ): Promise<ThreeStageResult> {
    const stepResults: StepResultV3_1[] = [];
    let stage1Result: Stage1CompanyResult | null = null;
    let stage2Result: Stage2FormatResult | null = null;
    let stage3Result: Stage3ExtractionResult | null = null;

    try {
      // ========== Stage 1: 公司識別 ==========
      const stage1StartTime = Date.now();
      try {
        // 載入已知公司列表
        const knownCompanies = await this.loadKnownCompanies(
          input.input.cityCode
        );

        stage1Result = await this.stage1Service.execute({
          imageBase64Array: input.imageBase64Array,
          knownCompanies,
          options: {
            autoCreateCompany: options.autoCreateCompany,
            cityCode: input.input.cityCode,
          },
          // Epic 23 step 4b：gateway 一致性灰度雜湊鍵（三階段同路徑）
          fileId: input.input.fileId,
        });

        stepResults.push({
          step: 'STAGE_1_COMPANY_IDENTIFICATION' as ProcessingStepV3_1,
          success: stage1Result.success,
          data: stage1Result,
          durationMs: Date.now() - stage1StartTime,
          error: stage1Result.error,
        });

        if (!stage1Result.success && !options.continueOnStageFailure) {
          return {
            stage1: stage1Result,
            stage2: null,
            stage3: null,
            stepResults,
            success: false,
            error: `Stage 1 failed: ${stage1Result.error}`,
          };
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        stepResults.push({
          step: 'STAGE_1_COMPANY_IDENTIFICATION' as ProcessingStepV3_1,
          success: false,
          durationMs: Date.now() - stage1StartTime,
          error: errorMessage,
        });

        if (!options.continueOnStageFailure) {
          return {
            stage1: null,
            stage2: null,
            stage3: null,
            stepResults,
            success: false,
            error: `Stage 1 exception: ${errorMessage}`,
          };
        }
      }

      // ========== Stage 2: 格式識別 ==========
      const stage2StartTime = Date.now();
      try {
        // Stage 2 需要 Stage 1 結果
        if (!stage1Result?.success) {
          // 如果 Stage 1 失敗但設定為繼續，創建一個空的 Stage 1 結果
          stage1Result = this.createEmptyStage1Result();
        }

        stage2Result = await this.stage2Service.execute({
          imageBase64Array: input.imageBase64Array,
          stage1Result,
          options: {
            autoCreateFormat: options.autoCreateFormat,
          },
          // Epic 23 step 4b：gateway 一致性灰度雜湊鍵（三階段同路徑）
          fileId: input.input.fileId,
        });

        stepResults.push({
          step: 'STAGE_2_FORMAT_IDENTIFICATION' as ProcessingStepV3_1,
          success: stage2Result.success,
          data: stage2Result,
          durationMs: Date.now() - stage2StartTime,
          error: stage2Result.error,
        });

        if (!stage2Result.success && !options.continueOnStageFailure) {
          return {
            stage1: stage1Result,
            stage2: stage2Result,
            stage3: null,
            stepResults,
            success: false,
            error: `Stage 2 failed: ${stage2Result.error}`,
          };
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        stepResults.push({
          step: 'STAGE_2_FORMAT_IDENTIFICATION' as ProcessingStepV3_1,
          success: false,
          durationMs: Date.now() - stage2StartTime,
          error: errorMessage,
        });

        if (!options.continueOnStageFailure) {
          return {
            stage1: stage1Result,
            stage2: null,
            stage3: null,
            stepResults,
            success: false,
            error: `Stage 2 exception: ${errorMessage}`,
          };
        }
      }

      // ========== Stage 3: 欄位提取 ==========
      const stage3StartTime = Date.now();
      try {
        // Stage 3 需要 Stage 1 和 Stage 2 結果
        if (!stage1Result?.success) {
          stage1Result = this.createEmptyStage1Result();
        }
        if (!stage2Result?.success) {
          stage2Result = this.createEmptyStage2Result();
        }

        stage3Result = await this.stage3Service.execute({
          imageBase64Array: input.imageBase64Array,
          stage1Result,
          stage2Result,
          options: {
            imageDetailMode: options.imageDetailMode,
          },
          // CHANGE-042 Phase 3: pass documentId for feedback recording
          documentId: input.input.fileId,
          // CHANGE-113 階段一 A: 分組鍵候選清單
          annotations: input.annotations,
        });

        stepResults.push({
          step: 'STAGE_3_FIELD_EXTRACTION' as ProcessingStepV3_1,
          success: stage3Result.success,
          data: stage3Result,
          durationMs: Date.now() - stage3StartTime,
          error: stage3Result.error,
        });

        if (!stage3Result.success) {
          return {
            stage1: stage1Result,
            stage2: stage2Result,
            stage3: stage3Result,
            stepResults,
            success: false,
            error: `Stage 3 failed: ${stage3Result.error}`,
          };
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        stepResults.push({
          step: 'STAGE_3_FIELD_EXTRACTION' as ProcessingStepV3_1,
          success: false,
          durationMs: Date.now() - stage3StartTime,
          error: errorMessage,
        });

        return {
          stage1: stage1Result,
          stage2: stage2Result,
          stage3: null,
          stepResults,
          success: false,
          error: `Stage 3 exception: ${errorMessage}`,
        };
      }

      // ========== 成功完成三階段 ==========
      return {
        stage1: stage1Result,
        stage2: stage2Result,
        stage3: stage3Result,
        stepResults,
        success: true,
      };
    } catch (error) {
      return {
        stage1: stage1Result,
        stage2: stage2Result,
        stage3: stage3Result,
        stepResults,
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Unknown orchestrator error',
      };
    }
  }

  /**
   * 載入已知公司列表
   * @param _cityCode 城市代碼（目前未使用，保留作為未來擴展）
   * @returns 已知公司列表（用於 Prompt）
   */
  private async loadKnownCompanies(
    _cityCode: string
  ): Promise<KnownCompanyForPrompt[]> {
    // 查詢活躍的公司
    const companies = await this.prisma.company.findMany({
      where: {
        status: 'ACTIVE',
      },
      select: {
        id: true,
        name: true,
        nameVariants: true,
        identificationPatterns: true,
      },
      take: 50, // 限制數量以控制 Prompt 長度
      orderBy: {
        priority: 'desc', // 優先級高的公司排在前面
      },
    });

    return companies.map((c) => ({
      id: c.id,
      name: c.name,
      aliases: c.nameVariants || [],
      identifiers: c.identificationPatterns || [],
    }));
  }

  /**
   * 創建空的 Stage 1 結果
   * @description 用於 Stage 1 失敗但需要繼續執行後續階段的情況
   */
  private createEmptyStage1Result(): Stage1CompanyResult {
    return {
      stageName: 'STAGE_1_COMPANY_IDENTIFICATION',
      success: false,
      durationMs: 0,
      companyName: '',
      identificationMethod: 'LLM_INFERRED',
      confidence: 0,
      isNewCompany: true,
      aiDetails: {
        stage: 'STAGE_1',
        model: '',
        prompt: '',
        response: '',
        tokenUsage: { input: 0, output: 0, total: 0 },
        durationMs: 0,
      },
      error: 'Stage 1 skipped or failed',
    };
  }

  /**
   * 創建空的 Stage 2 結果
   * @description 用於 Stage 2 失敗但需要繼續執行後續階段的情況
   */
  private createEmptyStage2Result(): Stage2FormatResult {
    return {
      stageName: 'STAGE_2_FORMAT_IDENTIFICATION',
      success: false,
      durationMs: 0,
      formatName: '',
      confidence: 0,
      isNewFormat: true,
      configSource: 'LLM_INFERRED',
      aiDetails: {
        stage: 'STAGE_2',
        model: '',
        prompt: '',
        response: '',
        tokenUsage: { input: 0, output: 0, total: 0 },
        durationMs: 0,
      },
      error: 'Stage 2 skipped or failed',
    };
  }

  /**
   * 計算總 Token 使用量
   * @param result 三階段結果
   * @returns 總 Token 使用量
   */
  calculateTotalTokenUsage(result: ThreeStageResult): {
    input: number;
    output: number;
    total: number;
  } {
    let input = 0;
    let output = 0;

    if (result.stage1?.aiDetails?.tokenUsage) {
      input += result.stage1.aiDetails.tokenUsage.input;
      output += result.stage1.aiDetails.tokenUsage.output;
    }

    if (result.stage2?.aiDetails?.tokenUsage) {
      input += result.stage2.aiDetails.tokenUsage.input;
      output += result.stage2.aiDetails.tokenUsage.output;
    }

    if (result.stage3?.tokenUsage) {
      input += result.stage3.tokenUsage.input;
      output += result.stage3.tokenUsage.output;
    }

    return { input, output, total: input + output };
  }

  /**
   * 計算總處理時間
   * @param result 三階段結果
   * @returns 總處理時間（毫秒）
   */
  calculateTotalDuration(result: ThreeStageResult): number {
    let total = 0;

    if (result.stage1) {
      total += result.stage1.durationMs;
    }

    if (result.stage2) {
      total += result.stage2.durationMs;
    }

    if (result.stage3) {
      total += result.stage3.durationMs;
    }

    return total;
  }

  /**
   * 獲取各階段 AI 詳情
   * @param result 三階段結果
   * @returns 每階段的 AI 詳情
   */
  getStageAiDetails(result: ThreeStageResult): {
    stage1?: StageAiDetails;
    stage2?: StageAiDetails;
    stage3?: StageAiDetails;
  } {
    return {
      stage1: result.stage1?.aiDetails,
      stage2: result.stage2?.aiDetails,
      stage3: result.stage3?.aiDetails,
    };
  }
}
