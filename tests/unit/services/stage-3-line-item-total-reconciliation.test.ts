/**
 * @fileoverview FIX-147 行項合計對帳單元測試
 * @description
 *   驗證 `reconcileLineItemTotal` 偵測 Stage 3 漏行 / 重複計列的行為。
 *
 *   **這個閘存在的理由**：Stage 3 對「被換行截斷的費用描述」會錯拼。實測同一份
 *   CEVA 發票（`CEVA_RCIM260069_37388.pdf`）三次處理得到 5 / 4 / 5 筆行項目 ——
 *   其中一次整筆 470.06 HKD 消失，而 `total_amount` 三次都正確讀到 14,579.50。
 *   系統同時握有正確總額與短少的明細卻從不相比，那次因此以信心度 98 /
 *   `AUTO_APPROVE` 走完全程，無任何警示。
 *
 *   分類錯誤靠人眼還看得出來；金額憑空消失、帳面卻「正常」，看不出來。
 *   本測試以該筆真實資料的形狀為主案例，釘住這條防線。
 *
 *   **`checked: false` 與 `mismatch: false` 是不同的狀態**：前者代表無從對帳
 *   （沒有行項目、或沒有總額欄位），後者代表對過了且相符。把前者當成後者無害，
 *   但把前者當成「不符」會讓所有無明細的發票被誤判降級 —— 測試涵蓋這個分界。
 *
 * @module tests/unit/services/stage-3-line-item-total-reconciliation.test
 * @since FIX-147
 * @lastModified 2026-07-30
 */
import { describe, it, expect } from 'vitest'
import { reconcileLineItemTotal } from '@/services/extraction-v3/stages/stage-3-extraction.service'
import type { FieldValue, LineItemV3 } from '@/types/extraction-v3.types'

/** 建立行項目（對帳只看 amount，其餘欄位給最小值） */
function item(amount: number, description = 'CHARGE'): LineItemV3 {
  return { description, amount, confidence: 95 }
}

/** 建立欄位值 */
function field(value: string | number | null): FieldValue {
  return { value, confidence: 98 }
}

/** CEVA_RCIM260069_37388.pdf 的真實五行（合計 14,579.50，與發票 TOTAL 相符） */
const CEVA_FULL: LineItemV3[] = [
  item(8681.96, 'BASIC FREIGHT CHARGE'),
  item(3078.15, 'DESTINATION HANDLING - 3 TEU'),
  item(1751.99, 'DESTINATION THC - TERMINAL HANDLING CHARGE'),
  item(470.06, 'DESTINATION HANDLING - 1 20GP'),
  item(597.34, 'DELIVERY ORDER FEE'),
]

/** 03:30 那次的實際輸出：470.06 整筆消失，只剩四行 */
const CEVA_MISSING_ROW: LineItemV3[] = [
  item(8681.96, 'BASIC FREIGHT CHARGE'),
  item(3078.15, 'DESTINATION HANDLING - 3 TEU'),
  item(1751.99, 'DESTINATION THC - TERMINAL HANDLING CHARGE'),
  item(597.34, 'DELIVERY ORDER FEE'),
]

const CEVA_TOTAL = field(14579.5)

describe('FIX-147: 行項合計對帳', () => {
  describe('真實個案（CEVA_RCIM260069_37388.pdf）', () => {
    it('漏掉 470.06 那一行 → 判定不符，差額 -470.06', () => {
      const result = reconcileLineItemTotal(
        { total_amount: CEVA_TOTAL },
        undefined,
        CEVA_MISSING_ROW
      )

      expect(result.checked).toBe(true)
      expect(result.mismatch).toBe(true)
      expect(result.lineItemSum).toBe(14109.44)
      expect(result.documentTotal).toBe(14579.5)
      expect(result.difference).toBe(-470.06)
      expect(result.totalSource).toBe('total_amount')
      expect(result.lineItemCount).toBe(4)
    })

    it('五行完整 → 相符，不觸發', () => {
      const result = reconcileLineItemTotal(
        { total_amount: CEVA_TOTAL },
        undefined,
        CEVA_FULL
      )

      expect(result.checked).toBe(true)
      expect(result.mismatch).toBe(false)
      expect(result.lineItemSum).toBe(14579.5)
      expect(result.difference).toBe(0)
    })
  })

  describe('容差（吸收逐行四捨五入誤差）', () => {
    it('3 行差 0.02 → 容差 0.05 內，不觸發', () => {
      const result = reconcileLineItemTotal(
        { total_amount: field(100.0) },
        undefined,
        [item(33.34), item(33.34), item(33.34)]
      )

      expect(result.tolerance).toBe(0.05)
      expect(result.difference).toBe(0.02)
      expect(result.mismatch).toBe(false)
    })

    it('行項數多時容差隨之放大（10 行 → 0.1）', () => {
      const result = reconcileLineItemTotal(
        { total_amount: field(100.0) },
        undefined,
        Array.from({ length: 10 }, () => item(10.008))
      )

      expect(result.tolerance).toBe(0.1)
      expect(result.difference).toBe(0.08)
      expect(result.mismatch).toBe(false)
    })

    it('差額剛好等於容差 → 不觸發（邊界為閉區間）', () => {
      const result = reconcileLineItemTotal(
        { total_amount: field(100.0) },
        undefined,
        [item(100.05)]
      )

      expect(result.tolerance).toBe(0.05)
      expect(result.difference).toBe(0.05)
      expect(result.mismatch).toBe(false)
    })

    it('差額略超容差 → 觸發', () => {
      const result = reconcileLineItemTotal(
        { total_amount: field(100.0) },
        undefined,
        [item(100.06)]
      )

      expect(result.mismatch).toBe(true)
    })
  })

  describe('雙向比較（多算與少算同樣要攔）', () => {
    it('行項合計大於總額（重複計列）→ 觸發，差額為正', () => {
      const result = reconcileLineItemTotal(
        { total_amount: field(100.0) },
        undefined,
        [item(60), item(60)]
      )

      expect(result.mismatch).toBe(true)
      expect(result.difference).toBe(20)
    })
  })

  describe('無從對帳 ≠ 對不上', () => {
    it('無行項目 → checked=false，不觸發', () => {
      const result = reconcileLineItemTotal(
        { total_amount: CEVA_TOTAL },
        undefined,
        []
      )

      expect(result.checked).toBe(false)
      expect(result.mismatch).toBe(false)
    })

    it('lineItems 為 undefined → checked=false，不報錯', () => {
      const result = reconcileLineItemTotal(
        { total_amount: CEVA_TOTAL },
        undefined,
        undefined
      )

      expect(result.checked).toBe(false)
      expect(result.mismatch).toBe(false)
    })

    it('total_amount 與 subtotal 皆缺 → checked=false，但仍回報行項合計', () => {
      const result = reconcileLineItemTotal({}, undefined, CEVA_FULL)

      expect(result.checked).toBe(false)
      expect(result.mismatch).toBe(false)
      expect(result.lineItemSum).toBe(14579.5)
      expect(result.documentTotal).toBeNull()
      expect(result.totalSource).toBeNull()
    })

    it('total_amount 的值為 null → 視為缺值，不可當成 0', () => {
      const result = reconcileLineItemTotal(
        { total_amount: field(null) },
        undefined,
        CEVA_FULL
      )

      expect(result.checked).toBe(false)
      expect(result.mismatch).toBe(false)
    })

    it('total_amount 是無法解析的字串 → 視為缺值，不可當成 0', () => {
      const result = reconcileLineItemTotal(
        { total_amount: field('N/A') },
        undefined,
        CEVA_FULL
      )

      expect(result.checked).toBe(false)
      expect(result.mismatch).toBe(false)
    })
  })

  describe('總額來源優先序', () => {
    it('total_amount 存在時優先於 subtotal', () => {
      const result = reconcileLineItemTotal(
        { total_amount: field(100), subtotal: field(90) },
        undefined,
        [item(100)]
      )

      expect(result.totalSource).toBe('total_amount')
      expect(result.mismatch).toBe(false)
    })

    it('缺 total_amount 時退到 subtotal', () => {
      const result = reconcileLineItemTotal(
        { subtotal: field(90) },
        undefined,
        [item(90)]
      )

      expect(result.totalSource).toBe('subtotal')
      expect(result.checked).toBe(true)
      expect(result.mismatch).toBe(false)
    })

    it('fields 缺 total 時退到 standardFields.totalAmount', () => {
      const result = reconcileLineItemTotal(
        {},
        { totalAmount: field(14579.5), subtotal: undefined },
        CEVA_FULL
      )

      expect(result.totalSource).toBe('total_amount')
      expect(result.checked).toBe(true)
      expect(result.mismatch).toBe(false)
    })

    it('fields 為 undefined 時仍能用 standardFields 對帳', () => {
      const result = reconcileLineItemTotal(
        undefined,
        { totalAmount: field(14579.5), subtotal: undefined },
        CEVA_MISSING_ROW
      )

      expect(result.checked).toBe(true)
      expect(result.mismatch).toBe(true)
      expect(result.difference).toBe(-470.06)
    })
  })

  describe('金額字串解析', () => {
    it('帶千分位與貨幣符號的字串可解析', () => {
      const result = reconcileLineItemTotal(
        { total_amount: field('HKD 14,579.50') },
        undefined,
        CEVA_FULL
      )

      expect(result.checked).toBe(true)
      expect(result.documentTotal).toBe(14579.5)
      expect(result.mismatch).toBe(false)
    })

    it('行項目金額為 undefined 時以 0 計入，不讓整筆對帳崩潰', () => {
      const broken = [item(100), { description: 'X', confidence: 90 } as LineItemV3]
      const result = reconcileLineItemTotal(
        { total_amount: field(100) },
        undefined,
        broken
      )

      expect(result.checked).toBe(true)
      expect(result.lineItemSum).toBe(100)
      expect(result.mismatch).toBe(false)
    })
  })
})
