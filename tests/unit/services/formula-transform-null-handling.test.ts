/**
 * @fileoverview FIX-157 FORMULA 全缺值處理單元測試
 * @description
 *   驗證 FormulaTransform 在「公式引用的變數全部缺值」時回傳 undefined，
 *   而非算出 0。呼叫端（template-matching-engine 的 transformFields）只在結果
 *   不是 undefined 時才寫入欄位，因此這使 FORMULA 與 DIRECT 行為一致 ——
 *   「這張發票沒有這筆費用」留空，不會顯示成「這筆費用是 0」。
 *
 *   同時鎖住既有行為不得回歸：只要任一變數有值，其餘缺值仍視為 0 參與計算。
 *
 *   Fixture 取自 2026-08-03 本機實測：RIL_RCIM250313_22084（空運發票）的
 *   `thc ← {sea_thc_hongkong_asia} + {thc} + {sea_thc}` 三個來源全為 null，
 *   舊行為寫入 `thc: 0`，讀起來像「THC 收費零元」，但空運發票不存在 THC。
 *
 * @module tests/unit/services/formula-transform-null-handling.test
 * @since FIX-157
 * @lastModified 2026-08-03
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { FormulaTransform } from '@/services/transform/formula.transform'
import { DirectTransform } from '@/services/transform/direct.transform'
import type { TransformContext } from '@/services/transform/types'

/** 建立轉換上下文；row 即整行來源資料 */
function ctx(row: Record<string, unknown>): TransformContext {
  return {
    row,
    sourceField: 'unused',
    targetField: 'unused',
  } as TransformContext
}

describe('FormulaTransform — 全缺值處理（FIX-157）', () => {
  let transform: FormulaTransform

  beforeEach(() => {
    transform = new FormulaTransform()
  })

  describe('全部變數缺值時回傳 undefined', () => {
    it('should return undefined when every referenced variable is null', async () => {
      // RIL 空運發票的真實情境：三個 THC 來源全為 null
      const result = await transform.execute(
        null,
        { formula: '{sea_thc_hongkong_asia} + {thc} + {sea_thc}' },
        ctx({ sea_thc_hongkong_asia: null, thc: null, sea_thc: null })
      )

      expect(result).toBeUndefined()
    })

    it('should return undefined when every referenced variable is absent from row', async () => {
      const result = await transform.execute(
        null,
        { formula: '{a} + {b}' },
        ctx({ unrelated: 123 })
      )

      expect(result).toBeUndefined()
    })

    it('should return undefined when variables are non-numeric strings', async () => {
      const result = await transform.execute(
        null,
        { formula: '{a} + {b}' },
        ctx({ a: 'N/A', b: '' })
      )

      expect(result).toBeUndefined()
    })
  })

  describe('任一變數有值時維持原行為（不得回歸）', () => {
    it('should treat missing values as 0 when at least one variable has a value', async () => {
      const result = await transform.execute(
        null,
        { formula: '{a} + {b}' },
        ctx({ a: 100, b: null })
      )

      expect(result).toBe(100)
    })

    it('should sum all values when every variable has a value', async () => {
      // Nippon 的真實規則：handling_at_origin ← seal_charge + handling_charge + container_seal_fee
      const result = await transform.execute(
        null,
        { formula: '{seal_charge} + {handling_charge} + {container_seal_fee}' },
        ctx({ seal_charge: null, handling_charge: 100, container_seal_fee: 440 })
      )

      expect(result).toBe(540)
    })

    it('should compute when a variable is legitimately zero', async () => {
      // 0 是有效值，代表「這筆費用確實是 0」，不同於缺值
      const result = await transform.execute(
        null,
        { formula: '{a} + {b}' },
        ctx({ a: 0, b: null })
      )

      expect(result).toBe(0)
    })

    it('should accept numeric strings as values', async () => {
      const result = await transform.execute(
        null,
        { formula: '{a} + {b}' },
        ctx({ a: '250.5', b: null })
      )

      expect(result).toBe(250.5)
    })

    it('should still evaluate a constant-only formula', async () => {
      const result = await transform.execute(null, { formula: '10 + 5' }, ctx({}))

      expect(result).toBe(15)
    })
  })

  describe('與 DIRECT 的行為一致性', () => {
    it('should return undefined just like DIRECT does for an absent source', async () => {
      const direct = new DirectTransform()
      const row = { a: null, b: null }

      const directResult = await direct.execute(
        row['missing_key' as keyof typeof row],
        null,
        ctx(row)
      )
      const formulaResult = await transform.execute(
        null,
        { formula: '{a} + {b}' },
        ctx(row)
      )

      // 兩者都是 undefined，呼叫端因此都不會寫入該欄位
      expect(directResult).toBeUndefined()
      expect(formulaResult).toBeUndefined()
    })
  })
})
