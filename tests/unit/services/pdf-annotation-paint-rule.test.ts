/**
 * @fileoverview CHANGE-113 階段一 A：PDF 註解補畫判定規則單元測試
 * @description
 *   驗證 needsAnnotationPaint 的判定：只有「沒有 appearance stream 且註解框直立」
 *   的 FreeText 才需要本流程補畫。
 *
 *   **這個規則為何存在**：使用者以 PDF 註解在文件上補充系統無法從原始內容得知的
 *   資訊（DHL 發票標註每一列對應哪個 shipment）。pdfjs 對 FreeText 一律水平排版，
 *   直立框代表原編輯器用了旋轉排版，pdfjs 排不進去而把文字裁掉 —— 只畫出邊框、
 *   內容消失，OCR 與視覺辨識都取不到。
 *
 *   **為何不能一律補畫**：橫向框 pdfjs 畫得出來。對它們補畫會疊字，反而蓋掉本來
 *   清楚的內容 —— 2026-07-29 實測時真的發生過（RHIM/25/0202 被疊到難以辨認）。
 *
 *   fixture 全數取自 2026-07-29 三份真實 DHL 文件的實測值。
 *
 * @module tests/unit/services/pdf-annotation-paint-rule.test
 * @since CHANGE-113 階段一 A
 * @lastModified 2026-07-29
 */
import { describe, it, expect } from 'vitest'
import { needsAnnotationPaint } from '@/services/extraction-v3/utils/pdf-converter'

describe('CHANGE-113 階段一 A: PDF 註解補畫判定', () => {
  describe('實測案例（三份真實 DHL 文件）', () => {
    it('DHL_RCIM250111：直立窄框且無 appearance → 需補畫', () => {
      // pdfjs 實際只畫出紅框、文字完全消失
      expect(
        needsAnnotationPaint({ hasAppearance: false, width: 18, height: 108 })
      ).toBe(true)
      expect(
        needsAnnotationPaint({ hasAppearance: false, width: 21, height: 97 })
      ).toBe(true)
    })

    it('DHL_RCIM250119 / RCIM250246：橫向框 → 不補畫（pdfjs 已正常渲染）', () => {
      const horizontalCases = [
        { width: 108, height: 18 }, // RCIM/25/0119
        { width: 72, height: 12 }, // RHIM/25/0097
        { width: 169, height: 49 }, // RCIM/25/0246
        { width: 121, height: 30 }, // RCEX-25-0479 PDI
        { width: 168, height: 49 }, // RCEX-25-0483
        { width: 72, height: 15 }, // RHIM/25/0202
      ]

      for (const box of horizontalCases) {
        expect(needsAnnotationPaint({ hasAppearance: false, ...box })).toBe(false)
      }
    })
  })

  describe('判定邊界', () => {
    it('有 appearance stream 一律不補畫，即使框是直立的', () => {
      expect(
        needsAnnotationPaint({ hasAppearance: true, width: 18, height: 108 })
      ).toBe(false)
    })

    it('近正方形留在「不補畫」側，避免破壞本來正確的畫面', () => {
      // 高寬比 1.2 是門檻，不含等於
      expect(needsAnnotationPaint({ hasAppearance: false, width: 100, height: 120 })).toBe(false)
      expect(needsAnnotationPaint({ hasAppearance: false, width: 100, height: 100 })).toBe(false)
      expect(needsAnnotationPaint({ hasAppearance: false, width: 100, height: 121 })).toBe(true)
    })

    it('零或負值尺寸不補畫（避免除以零與無意義的繪製）', () => {
      expect(needsAnnotationPaint({ hasAppearance: false, width: 0, height: 100 })).toBe(false)
      expect(needsAnnotationPaint({ hasAppearance: false, width: 100, height: 0 })).toBe(false)
      expect(needsAnnotationPaint({ hasAppearance: false, width: -5, height: 100 })).toBe(false)
    })
  })
})
