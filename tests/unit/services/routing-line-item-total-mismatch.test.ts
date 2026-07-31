/**
 * @fileoverview FIX-147 行項合計不符 → 強制 FULL_REVIEW 單元測試
 * @description
 *   驗證對帳結果如何影響路由決策。
 *
 *   **為何與 Stage 失敗同級（覆蓋而非降一級）**：行項合計對不上代表明細本身不可信，
 *   信心度再高也不能自動放行。實測 CEVA 個案就是信心度 98、`AUTO_APPROVE`，卻漏掉
 *   一整筆 470.06 HKD —— 若只降一級到 `QUICK_REVIEW`，快速確認的人看到的仍是一份
 *   「看起來正常」的明細，差額不會自己浮現。
 *
 *   **`checked: false` 絕不可觸發降級**：無行項目或無總額欄位時無從對帳，
 *   若把它當成「不符」，所有無明細的發票都會被誤判進完整審核。這條分界由
 *   `mismatch: false` 的案例釘住。
 *
 *   **零回歸**：無對帳資訊（舊資料，欄位為 `undefined`）時路由結果必須與修復前
 *   完全相同 —— 本測試以 `AUTO_APPROVE` 案例確認。
 *
 * @module tests/unit/services/routing-line-item-total-mismatch.test
 * @since FIX-147
 * @lastModified 2026-07-30
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock Prisma：confidence 主流程不查 DB，但 import 鏈會帶到 prisma
vi.mock('@/lib/prisma', () => ({
  prisma: { stageModelAssignment: { findUnique: vi.fn() } },
}));

vi.mock('@/services/logging/logger.service', () => ({
  aiLogger: { warn: vi.fn().mockResolvedValue(undefined) },
}));

import {
  ConfidenceV3_1Service,
  type ConfidenceInputV3_1,
} from '@/services/extraction-v3/confidence-v3-1.service';
import type {
  ConfidenceWeightsV3_1,
  LineItemTotalReconciliation,
  Stage1CompanyResult,
  Stage2FormatResult,
  Stage3ExtractionResult,
} from '@/types/extraction-v3.types';

/** 讓 overallScore 完全由 stage1 confidence 決定（其餘維度權重為 0） */
const SINGLE_DIMENSION_WEIGHTS: Partial<ConfidenceWeightsV3_1> = {
  STAGE_1_COMPANY: 1,
  STAGE_2_FORMAT: 0,
  STAGE_3_EXTRACTION: 0,
  FIELD_COMPLETENESS: 0,
  CONFIG_SOURCE_BONUS: 0,
};

/** 建構輸入；`reconciliation` 為 undefined 代表舊資料（無對帳資訊） */
function input(
  score: number,
  reconciliation?: LineItemTotalReconciliation
): ConfidenceInputV3_1 {
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
      ...(reconciliation ? { lineItemTotalReconciliation: reconciliation } : {}),
    } as unknown as Stage3ExtractionResult,
    refMatchEnabled: false,
  };
}

function calc(score: number, reconciliation?: LineItemTotalReconciliation) {
  return ConfidenceV3_1Service.calculate(input(score, reconciliation), {
    weights: SINGLE_DIMENSION_WEIGHTS,
  });
}

/** CEVA 個案：4 行合計 14,109.44 vs 總額 14,579.50 */
const CEVA_MISMATCH: LineItemTotalReconciliation = {
  checked: true,
  mismatch: true,
  lineItemSum: 14109.44,
  documentTotal: 14579.5,
  totalSource: 'total_amount',
  difference: -470.06,
  tolerance: 0.05,
  lineItemCount: 4,
};

const CEVA_MATCH: LineItemTotalReconciliation = {
  checked: true,
  mismatch: false,
  lineItemSum: 14579.5,
  documentTotal: 14579.5,
  totalSource: 'total_amount',
  difference: 0,
  tolerance: 0.05,
  lineItemCount: 5,
};

const NOT_CHECKED: LineItemTotalReconciliation = {
  checked: false,
  mismatch: false,
  lineItemSum: 0,
  documentTotal: null,
  totalSource: null,
  difference: 0,
  tolerance: 0.05,
  lineItemCount: 0,
};

describe('FIX-147: 行項合計不符 → 強制 FULL_REVIEW', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('不符時覆蓋所有等級', () => {
    it('信心度 98（本可 AUTO_APPROVE）→ 強制 FULL_REVIEW', () => {
      const result = calc(98, CEVA_MISMATCH);

      expect(result.routingDecision.decision).toBe('FULL_REVIEW');
    });

    it('信心度 80（本為 QUICK_REVIEW）→ 強制 FULL_REVIEW', () => {
      expect(calc(80, CEVA_MISMATCH).routingDecision.decision).toBe(
        'FULL_REVIEW'
      );
    });

    it('reasons 帶出差額，供人工審核時判讀', () => {
      const reasons = calc(98, CEVA_MISMATCH).routingDecision.reasons.join('; ');

      expect(reasons).toContain('14109.44');
      expect(reasons).toContain('14579.5');
      expect(reasons).toContain('-470.06');
    });

    it('來源為 subtotal 時 reason 顯示「小計」而非「發票總額」', () => {
      const reasons = calc(98, {
        ...CEVA_MISMATCH,
        totalSource: 'subtotal',
      }).routingDecision.reasons.join('; ');

      expect(reasons).toContain('小計');
    });
  });

  describe('相符或無從對帳時不影響路由（零回歸）', () => {
    it('對帳相符 → 維持 AUTO_APPROVE', () => {
      expect(calc(98, CEVA_MATCH).routingDecision.decision).toBe(
        'AUTO_APPROVE'
      );
    });

    it('checked=false（無從對帳）→ 維持 AUTO_APPROVE', () => {
      expect(calc(98, NOT_CHECKED).routingDecision.decision).toBe(
        'AUTO_APPROVE'
      );
    });

    it('無對帳欄位（舊資料）→ 維持 AUTO_APPROVE', () => {
      expect(calc(98).routingDecision.decision).toBe('AUTO_APPROVE');
    });

    it('無對帳欄位時 reasons 不含對帳訊息', () => {
      const reasons = calc(98).routingDecision.reasons.join('; ');

      expect(reasons).not.toContain('行項合計');
    });

    it('相符時低信心度仍依分數走 FULL_REVIEW（原因不是對帳）', () => {
      const routing = calc(50, CEVA_MATCH).routingDecision;

      expect(routing.decision).toBe('FULL_REVIEW');
      expect(routing.reasons.join('; ')).not.toContain('行項合計');
    });
  });

  describe('簡化 API 不受影響', () => {
    it('getSmartReviewType 無行項資訊 → 不觸發對帳降級', () => {
      const result = ConfidenceV3_1Service.getSmartReviewType({
        overallConfidence: 98,
        isNewCompany: false,
        isNewFormat: false,
        configSource: 'COMPANY',
      });

      expect(result.reviewType).toBe('AUTO_APPROVE');
      expect(result.reason).not.toContain('行項合計');
    });
  });
});
