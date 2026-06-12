/**
 * @fileoverview V3 信心度計算服務
 * @description
 *   實現簡化的 5 維度加權信心度計算：
 *   - EXTRACTION (30%): GPT 整體提取信心度
 *   - ISSUER_IDENTIFICATION (20%): 發行商識別準確度
 *   - FORMAT_MATCHING (15%): 文件格式匹配程度
 *   - FIELD_COMPLETENESS (20%): 欄位完整性
 *   - HISTORICAL_ACCURACY (15%): 歷史準確率
 *
 * @module src/services/extraction-v3/confidence-v3
 * @since CHANGE-021 - Unified Processor V3 Refactoring
 * @lastModified 2026-01-30
 *
 * @features
 *   - 5 維度加權計算
 *   - 路由決策生成
 *   - 維度分數詳情
 *   - 可配置權重
 *
 * @related
 *   - src/services/extraction-v3/extraction-v3.service.ts - V3 主服務
 *   - src/types/extraction-v3.types.ts - V3 類型定義
 */

import type {
  ValidatedExtractionResult,
  ConfidenceResultV3,
  DimensionScoreV3,
  SimplifiedConfidenceInput,
  ConfidenceWeightsV3,
  ConfidenceDimensionV3,
} from '@/types/extraction-v3.types';
import {
  DEFAULT_CONFIDENCE_WEIGHTS_V3,
} from '@/types/extraction-v3.types';
import { ConfidenceLevelEnum } from '@/types/confidence';

/**
 * V3 路由決策詳情
 * @description 包含決策類型、分數和原因的完整路由決策
 */
export interface RoutingDecisionV3 {
  /** 決策類型 */
  decision: 'AUTO_APPROVE' | 'QUICK_REVIEW' | 'FULL_REVIEW';
  /** 信心度分數 */
  score: number;
  /** 閾值 */
  threshold: number;
  /** 決策原因 */
  reasons: string[];
}

// ============================================================================
// Types
// ============================================================================

/**
 * 信心度計算選項
 */
export interface ConfidenceCalculationOptionsV3 {
  /** 自定義權重 */
  weights?: Partial<ConfidenceWeightsV3>;
  /** 歷史準確率（如已知） */
  historicalAccuracy?: number;
  /** 是否包含維度詳情 */
  includeDetails?: boolean;
}

/**
 * 信心度計算服務結果
 */
export interface ConfidenceServiceResultV3 {
  /** 是否成功 */
  success: boolean;
  /** 信心度結果 */
  result?: ConfidenceResultV3;
  /** 路由決策 */
  routingDecision?: RoutingDecisionV3;
  /** 錯誤訊息 */
  error?: string;
  /** 處理時間（毫秒） */
  processingTimeMs: number;
}

// ============================================================================
// Constants
// ============================================================================

/** 路由閾值 */
export const ROUTING_THRESHOLDS_V3 = {
  /** 自動批准閾值 */
  AUTO_APPROVE: 90,
  /** 快速審核閾值 */
  QUICK_REVIEW: 70,
  /** 完整審核閾值（低於此值） */
  FULL_REVIEW: 0,
} as const;

/** 預設歷史準確率（無歷史數據時使用） */
const DEFAULT_HISTORICAL_ACCURACY = 80;

/** 必填欄位列表 */
const REQUIRED_FIELDS = [
  'invoiceNumber',
  'invoiceDate',
  'vendorName',
  'totalAmount',
  'currency',
] as const;

// ============================================================================
// Service Class
// ============================================================================

/**
 * V3 信心度計算服務
 *
 * @description 實現簡化的 5 維度加權信心度計算
 *
 * @example
 * ```typescript
 * const result = await ConfidenceV3Service.calculate(validatedResult);
 * console.log(result.result.overallScore); // 85.5
 * console.log(result.routingDecision); // 'QUICK_REVIEW'
 * ```
 */
export class ConfidenceV3Service {
  /**
   * 計算信心度
   *
   * @param validatedResult - 驗證後的提取結果
   * @param options - 計算選項
   * @returns 信心度計算結果
   */
  static calculate(
    validatedResult: ValidatedExtractionResult,
    options: ConfidenceCalculationOptionsV3 = {}
  ): ConfidenceServiceResultV3 {
    const startTime = Date.now();

    try {
      // 合併權重
      const weights: ConfidenceWeightsV3 = {
        ...DEFAULT_CONFIDENCE_WEIGHTS_V3,
        ...options.weights,
      };

      // 構建輸入
      const input = this.buildInput(validatedResult, options);

      // 計算各維度分數
      const dimensions = this.calculateDimensions(input, weights);

      // 計算總分
      const overallScore = dimensions.reduce(
        (sum, d) => sum + d.weightedScore,
        0
      );

      // 確定信心度等級
      const level = this.determineLevel(overallScore);

      // 生成路由決策
      const routingDecision = this.generateRoutingDecision(
        overallScore,
        validatedResult
      );

      const result: ConfidenceResultV3 = {
        overallScore: Math.round(overallScore * 100) / 100,
        level,
        dimensions,
        calculatedAt: new Date(),
      };

      return {
        success: true,
        result,
        routingDecision,
        processingTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '計算信心度時發生錯誤',
        processingTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * 構建計算輸入
   */
  private static buildInput(
    result: ValidatedExtractionResult,
    options: ConfidenceCalculationOptionsV3
  ): SimplifiedConfidenceInput {
    // 計算欄位完整性
    const requiredFieldsCount = REQUIRED_FIELDS.length;
    let filledRequiredFieldsCount = 0;

    for (const fieldKey of REQUIRED_FIELDS) {
      const field = result.standardFields[fieldKey as keyof typeof result.standardFields];
      if (field && field.value !== null && field.value !== '') {
        filledRequiredFieldsCount++;
      }
    }

    return {
      extractionConfidence: result.overallConfidence,
      issuerConfidence: result.issuerIdentification.confidence,
      formatConfidence: result.formatIdentification.confidence,
      fieldCompleteness: {
        requiredFieldsCount,
        filledRequiredFieldsCount,
      },
      historicalAccuracy:
        options.historicalAccuracy ?? DEFAULT_HISTORICAL_ACCURACY,
    };
  }

  /**
   * 計算各維度分數
   */
  private static calculateDimensions(
    input: SimplifiedConfidenceInput,
    weights: ConfidenceWeightsV3
  ): DimensionScoreV3[] {
    const dimensions: DimensionScoreV3[] = [];

    // 1. EXTRACTION 維度
    const extractionScore = input.extractionConfidence;
    dimensions.push({
      dimension: 'EXTRACTION' as ConfidenceDimensionV3,
      rawScore: extractionScore,
      weightedScore: extractionScore * weights['EXTRACTION' as ConfidenceDimensionV3],
      weight: weights['EXTRACTION' as ConfidenceDimensionV3],
    });

    // 2. ISSUER_IDENTIFICATION 維度
    const issuerScore = input.issuerConfidence;
    dimensions.push({
      dimension: 'ISSUER_IDENTIFICATION' as ConfidenceDimensionV3,
      rawScore: issuerScore,
      weightedScore: issuerScore * weights['ISSUER_IDENTIFICATION' as ConfidenceDimensionV3],
      weight: weights['ISSUER_IDENTIFICATION' as ConfidenceDimensionV3],
    });

    // 3. FORMAT_MATCHING 維度
    const formatScore = input.formatConfidence;
    dimensions.push({
      dimension: 'FORMAT_MATCHING' as ConfidenceDimensionV3,
      rawScore: formatScore,
      weightedScore: formatScore * weights['FORMAT_MATCHING' as ConfidenceDimensionV3],
      weight: weights['FORMAT_MATCHING' as ConfidenceDimensionV3],
    });

    // 4. FIELD_COMPLETENESS 維度
    const fieldCompletenessScore =
      (input.fieldCompleteness.filledRequiredFieldsCount /
        input.fieldCompleteness.requiredFieldsCount) *
      100;
    dimensions.push({
      dimension: 'FIELD_COMPLETENESS' as ConfidenceDimensionV3,
      rawScore: fieldCompletenessScore,
      weightedScore: fieldCompletenessScore * weights['FIELD_COMPLETENESS' as ConfidenceDimensionV3],
      weight: weights['FIELD_COMPLETENESS' as ConfidenceDimensionV3],
    });

    // 5. HISTORICAL_ACCURACY 維度
    const historicalScore = input.historicalAccuracy ?? DEFAULT_HISTORICAL_ACCURACY;
    dimensions.push({
      dimension: 'HISTORICAL_ACCURACY' as ConfidenceDimensionV3,
      rawScore: historicalScore,
      weightedScore: historicalScore * weights['HISTORICAL_ACCURACY' as ConfidenceDimensionV3],
      weight: weights['HISTORICAL_ACCURACY' as ConfidenceDimensionV3],
    });

    return dimensions;
  }

  /**
   * 確定信心度等級
   */
  private static determineLevel(score: number): ConfidenceLevelEnum {
    if (score >= ROUTING_THRESHOLDS_V3.AUTO_APPROVE) {
      return ConfidenceLevelEnum.HIGH;
    } else if (score >= ROUTING_THRESHOLDS_V3.QUICK_REVIEW) {
      return ConfidenceLevelEnum.MEDIUM;
    } else {
      return ConfidenceLevelEnum.LOW;
    }
  }

  /**
   * 生成路由決策
   */
  private static generateRoutingDecision(
    score: number,
    result: ValidatedExtractionResult
  ): RoutingDecisionV3 {
    // 基於分數的基本路由
    let decision: 'AUTO_APPROVE' | 'QUICK_REVIEW' | 'FULL_REVIEW';

    if (score >= ROUTING_THRESHOLDS_V3.AUTO_APPROVE) {
      decision = 'AUTO_APPROVE';
    } else if (score >= ROUTING_THRESHOLDS_V3.QUICK_REVIEW) {
      decision = 'QUICK_REVIEW';
    } else {
      decision = 'FULL_REVIEW';
    }

    // 額外檢查：如果有缺失的必填欄位，降級路由
    if (result.validation.missingRequiredFields.length > 0) {
      if (decision === 'AUTO_APPROVE') {
        decision = 'QUICK_REVIEW';
      }
    }

    // 額外檢查：如果是新公司或新格式，降級路由
    if (result.jitCreated?.company || result.jitCreated?.format) {
      if (decision === 'AUTO_APPROVE') {
        decision = 'QUICK_REVIEW';
      }
    }

    // 額外檢查：如果有需要分類的項目，可能需要審核
    const itemsNeedingClassification =
      result.lineItems.filter((item) => item.needsClassification).length +
      (result.extraCharges?.filter((charge) => charge.needsClassification).length || 0);

    if (itemsNeedingClassification > 3 && decision === 'AUTO_APPROVE') {
      decision = 'QUICK_REVIEW';
    }

    // 構建決策理由
    const reasons: string[] = [];
    if (score >= ROUTING_THRESHOLDS_V3.AUTO_APPROVE) {
      reasons.push('整體信心度達到自動批准閾值');
    } else if (score >= ROUTING_THRESHOLDS_V3.QUICK_REVIEW) {
      reasons.push('整體信心度達到快速審核閾值');
    } else {
      reasons.push('整體信心度低於快速審核閾值');
    }

    if (result.validation.missingRequiredFields.length > 0) {
      reasons.push(`缺失 ${result.validation.missingRequiredFields.length} 個必填欄位`);
    }

    if (result.jitCreated?.company) {
      reasons.push('識別到新公司');
    }

    if (result.jitCreated?.format) {
      reasons.push('識別到新文件格式');
    }

    if (itemsNeedingClassification > 0) {
      reasons.push(`${itemsNeedingClassification} 個項目需要人工分類`);
    }

    return {
      decision,
      score: Math.round(score * 100) / 100,
      threshold: ROUTING_THRESHOLDS_V3[decision],
      reasons,
    };
  }

  /**
   * 快速計算（不包含詳細維度）
   */
  static quickCalculate(
    extractionConfidence: number,
    issuerConfidence: number,
    formatConfidence: number,
    fieldCompleteness: number,
    historicalAccuracy: number = DEFAULT_HISTORICAL_ACCURACY
  ): number {
    const weights = DEFAULT_CONFIDENCE_WEIGHTS_V3;

    return (
      extractionConfidence * weights['EXTRACTION' as ConfidenceDimensionV3] +
      issuerConfidence * weights['ISSUER_IDENTIFICATION' as ConfidenceDimensionV3] +
      formatConfidence * weights['FORMAT_MATCHING' as ConfidenceDimensionV3] +
      fieldCompleteness * weights['FIELD_COMPLETENESS' as ConfidenceDimensionV3] +
      historicalAccuracy * weights['HISTORICAL_ACCURACY' as ConfidenceDimensionV3]
    );
  }

  /**
   * 獲取路由閾值
   */
  static getRoutingThresholds(): typeof ROUTING_THRESHOLDS_V3 {
    return ROUTING_THRESHOLDS_V3;
  }

  /**
   * 獲取預設權重
   */
  static getDefaultWeights(): ConfidenceWeightsV3 {
    return { ...DEFAULT_CONFIDENCE_WEIGHTS_V3 };
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * 計算 V3 信心度
 */
export function calculateConfidenceV3(
  validatedResult: ValidatedExtractionResult,
  options?: ConfidenceCalculationOptionsV3
): ConfidenceServiceResultV3 {
  return ConfidenceV3Service.calculate(validatedResult, options);
}

/**
 * 快速計算信心度分數
 */
export function quickCalculateConfidenceV3(
  extractionConfidence: number,
  issuerConfidence: number,
  formatConfidence: number,
  fieldCompleteness: number,
  historicalAccuracy?: number
): number {
  return ConfidenceV3Service.quickCalculate(
    extractionConfidence,
    issuerConfidence,
    formatConfidence,
    fieldCompleteness,
    historicalAccuracy
  );
}

/**
 * 根據分數獲取路由決策
 */
export function getRoutingDecisionV3(score: number): 'AUTO_APPROVE' | 'QUICK_REVIEW' | 'FULL_REVIEW' {
  if (score >= ROUTING_THRESHOLDS_V3.AUTO_APPROVE) {
    return 'AUTO_APPROVE';
  } else if (score >= ROUTING_THRESHOLDS_V3.QUICK_REVIEW) {
    return 'QUICK_REVIEW';
  } else {
    return 'FULL_REVIEW';
  }
}
