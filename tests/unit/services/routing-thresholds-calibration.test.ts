/**
 * @fileoverview per-model 信心度路由閾值校準單元測試（Epic 23 - Story 23.3 P1）
 * @description
 *   驗證 D9-a/D9-b/D9-c 三個落點（全程 mock，無 DB）：
 *   - **resolver**（`LlmModelConfigService.getRoutingThresholds`）：per-model → per-provider →
 *     null 的 fallback 鏈各層命中；格式不合法（型別錯／值域倒置）視為未設定並落下一層。
 *   - **confidence**（`ConfidenceV3_1Service.calculate`）：`options.thresholds` 覆蓋生效；
 *     Partial 語意（只覆蓋單一欄位時另一欄位沿用全域）。
 *   - **行為零變回歸**：未傳 `thresholds` 時邊界（90 / 89.9 / 70 / 69.9）與現行 90/70 完全一致。
 *
 *   測試以 `options.weights` 將 STAGE_1_COMPANY 權重設為 1、其餘為 0，
 *   使 `overallScore` 精確等於 stage1 的 confidence，藉此測邊界值。
 *
 * @module tests/unit/services/routing-thresholds-calibration.test
 * @since Epic 23 - Story 23.3 P1
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock Prisma：resolver 只查 stageModelAssignment
vi.mock('@/lib/prisma', () => ({
  prisma: { stageModelAssignment: { findUnique: vi.fn() } },
}));

// Mock logger：不合法設定會 warn，避免測試寫入真實日誌管道
vi.mock('@/services/logging/logger.service', () => ({
  aiLogger: { warn: vi.fn().mockResolvedValue(undefined) },
}));

import { prisma } from '@/lib/prisma';
import { LlmModelConfigService } from '@/services/llm-model-config.service';
import {
  ConfidenceV3_1Service,
  type ConfidenceInputV3_1,
} from '@/services/extraction-v3/confidence-v3-1.service';
import { ConfidenceLevelEnum } from '@/types/confidence';
import type {
  ConfidenceWeightsV3_1,
  Stage1CompanyResult,
  Stage2FormatResult,
  Stage3ExtractionResult,
} from '@/types/extraction-v3.types';

// ============================================================================
// Fixtures
// ============================================================================

/** 建構 stageModelAssignment.findUnique 的回傳（僅含 resolver 讀取的欄位） */
function assignment(opts: {
  modelThresholds?: unknown;
  providerExtraConfig?: unknown;
  modelEnabled?: boolean;
  providerEnabled?: boolean;
}) {
  return {
    llmModel: {
      id: 'model-1',
      routingThresholds: opts.modelThresholds ?? null,
      isEnabled: opts.modelEnabled ?? true,
      provider: {
        id: 'provider-1',
        isEnabled: opts.providerEnabled ?? true,
        extraConfig: opts.providerExtraConfig ?? null,
      },
    },
  };
}

/** 只保留 confidence 實際讀取的欄位；其餘欄位與本測試無關 */
function inputWithScore(score: number): ConfidenceInputV3_1 {
  return {
    stage1Result: {
      success: true,
      confidence: score,
      isNewCompany: false,
    } as unknown as Stage1CompanyResult,
    stage2Result: {
      success: true,
      confidence: 0,
      isNewFormat: false,
      configSource: 'COMPANY_SPECIFIC',
    } as unknown as Stage2FormatResult,
    stage3Result: {
      success: true,
      overallConfidence: 0,
      standardFields: {},
      lineItems: [],
    } as unknown as Stage3ExtractionResult,
    refMatchEnabled: false,
  };
}

/** 讓 overallScore 完全由 stage1 confidence 決定（其餘維度權重為 0） */
const SINGLE_DIMENSION_WEIGHTS: Partial<ConfidenceWeightsV3_1> = {
  STAGE_1_COMPANY: 1,
  STAGE_2_FORMAT: 0,
  STAGE_3_EXTRACTION: 0,
  FIELD_COMPLETENESS: 0,
  CONFIG_SOURCE_BONUS: 0,
};

/** 以指定分數與（可選）閾值覆蓋執行計算 */
function calcWithScore(
  score: number,
  thresholds?: { autoApprove?: number; quickReview?: number }
) {
  return ConfidenceV3_1Service.calculate(inputWithScore(score), {
    weights: SINGLE_DIMENSION_WEIGHTS,
    ...(thresholds ? { thresholds } : {}),
  });
}

// ============================================================================
// D9-b: resolver fallback 鏈
// ============================================================================

describe('LlmModelConfigService.getRoutingThresholds（D9-b fallback 鏈）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return per-model thresholds when configured on the model', async () => {
    vi.mocked(prisma.stageModelAssignment.findUnique).mockResolvedValue(
      assignment({ modelThresholds: { autoApprove: 95, quickReview: 80 } }) as never
    );

    await expect(LlmModelConfigService.getRoutingThresholds('stage3')).resolves.toEqual({
      autoApprove: 95,
      quickReview: 80,
    });
  });

  it('should fall back to per-provider thresholds when the model has none', async () => {
    vi.mocked(prisma.stageModelAssignment.findUnique).mockResolvedValue(
      assignment({
        modelThresholds: null,
        providerExtraConfig: { routingThresholds: { autoApprove: 88, quickReview: 66 } },
      }) as never
    );

    await expect(LlmModelConfigService.getRoutingThresholds('stage3')).resolves.toEqual({
      autoApprove: 88,
      quickReview: 66,
    });
  });

  it('should return null when neither model nor provider is calibrated (global default applies)', async () => {
    vi.mocked(prisma.stageModelAssignment.findUnique).mockResolvedValue(
      assignment({}) as never
    );

    await expect(
      LlmModelConfigService.getRoutingThresholds('stage3')
    ).resolves.toBeNull();
  });

  it('should skip malformed per-model thresholds and use the provider layer', async () => {
    // quickReview > autoApprove（倒置）→ 視為設定錯誤
    vi.mocked(prisma.stageModelAssignment.findUnique).mockResolvedValue(
      assignment({
        modelThresholds: { autoApprove: 60, quickReview: 90 },
        providerExtraConfig: { routingThresholds: { autoApprove: 92, quickReview: 75 } },
      }) as never
    );

    await expect(LlmModelConfigService.getRoutingThresholds('stage3')).resolves.toEqual({
      autoApprove: 92,
      quickReview: 75,
    });
  });

  it('should return null when both layers are malformed', async () => {
    vi.mocked(prisma.stageModelAssignment.findUnique).mockResolvedValue(
      assignment({
        modelThresholds: { autoApprove: '95', quickReview: 80 }, // 型別錯
        providerExtraConfig: { routingThresholds: { autoApprove: 120, quickReview: 70 } }, // 超界
      }) as never
    );

    await expect(
      LlmModelConfigService.getRoutingThresholds('stage3')
    ).resolves.toBeNull();
  });

  it('should return null when the stage has no assignment', async () => {
    vi.mocked(prisma.stageModelAssignment.findUnique).mockResolvedValue(null as never);

    await expect(
      LlmModelConfigService.getRoutingThresholds('stage3')
    ).resolves.toBeNull();
  });

  it('should ignore thresholds of a disabled model or disabled provider', async () => {
    vi.mocked(prisma.stageModelAssignment.findUnique).mockResolvedValue(
      assignment({
        modelThresholds: { autoApprove: 95, quickReview: 80 },
        modelEnabled: false,
      }) as never
    );
    await expect(
      LlmModelConfigService.getRoutingThresholds('stage3')
    ).resolves.toBeNull();

    vi.mocked(prisma.stageModelAssignment.findUnique).mockResolvedValue(
      assignment({
        modelThresholds: { autoApprove: 95, quickReview: 80 },
        providerEnabled: false,
      }) as never
    );
    await expect(
      LlmModelConfigService.getRoutingThresholds('stage3')
    ).resolves.toBeNull();
  });
});

// ============================================================================
// 行為零變回歸：未傳 thresholds 時維持 90/70
// ============================================================================

describe('ConfidenceV3_1Service.calculate（未傳 thresholds → 行為零變）', () => {
  it.each([
    [90, ConfidenceLevelEnum.HIGH, 'AUTO_APPROVE'],
    [89.9, ConfidenceLevelEnum.MEDIUM, 'QUICK_REVIEW'],
    [70, ConfidenceLevelEnum.MEDIUM, 'QUICK_REVIEW'],
    [69.9, ConfidenceLevelEnum.LOW, 'FULL_REVIEW'],
  ])('should route score %s to %s / %s using the global 90/70', (score, level, decision) => {
    const r = calcWithScore(score as number);

    expect(r.success).toBe(true);
    expect(r.result?.overallScore).toBe(score);
    expect(r.result?.level).toBe(level);
    expect(r.routingDecision?.decision).toBe(decision);
  });
});

// ============================================================================
// D9-c: options.thresholds 覆蓋
// ============================================================================

describe('ConfidenceV3_1Service.calculate（D9-c per-model 閾值覆蓋）', () => {
  it('should apply the overridden autoApprove bound', () => {
    // 92 分在全域 90/70 下是 AUTO_APPROVE，在 95/80 下降為 QUICK_REVIEW
    const overridden = calcWithScore(92, { autoApprove: 95, quickReview: 80 });
    expect(overridden.result?.level).toBe(ConfidenceLevelEnum.MEDIUM);
    expect(overridden.routingDecision?.decision).toBe('QUICK_REVIEW');

    const globalDefault = calcWithScore(92);
    expect(globalDefault.routingDecision?.decision).toBe('AUTO_APPROVE');
  });

  it('should apply the overridden quickReview bound', () => {
    // 75 分在全域 90/70 下是 QUICK_REVIEW，在 95/80 下降為 FULL_REVIEW
    const r = calcWithScore(75, { autoApprove: 95, quickReview: 80 });
    expect(r.result?.level).toBe(ConfidenceLevelEnum.LOW);
    expect(r.routingDecision?.decision).toBe('FULL_REVIEW');
  });

  it('should report the effective threshold in the routing decision', () => {
    const r = calcWithScore(96, { autoApprove: 95, quickReview: 80 });
    expect(r.routingDecision?.decision).toBe('AUTO_APPROVE');
    expect(r.routingDecision?.threshold).toBe(95);
  });

  it('should keep the global bound for fields not overridden (Partial semantics)', () => {
    // 只覆蓋 autoApprove → quickReview 仍為全域 70
    const r = calcWithScore(75, { autoApprove: 95 });
    expect(r.result?.level).toBe(ConfidenceLevelEnum.MEDIUM);
    expect(r.routingDecision?.decision).toBe('QUICK_REVIEW');
    expect(r.routingDecision?.threshold).toBe(70);
  });
});
