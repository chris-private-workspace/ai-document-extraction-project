/**
 * @fileoverview FIX-128 來源欄位 key 解析與未知 key 判定單元測試
 * @description
 *   測試案例取自 Azure DEV 實測的死 key（SBS INTERNATIONAL / Toll 的
 *   template field mapping 公式，2026-07-22 查證）。
 *
 * @module tests/unit/lib/template-mapping-source-keys.test
 * @since FIX-128
 * @lastModified 2026-07-22
 */
import { describe, it, expect } from 'vitest'
import {
  extractFormulaKeys,
  collectRuleSourceKeys,
  findUnknownRuleSourceKeys,
  isSyntheticSourceKey,
} from '@/lib/template-mapping-source-keys'

describe('FIX-128: extractFormulaKeys', () => {
  it('應抽取公式中的所有變數並去重', () => {
    expect(
      extractFormulaKeys('{air_delivery_charge_dest_charge} + {drayage} + {dryage_charge}')
    ).toEqual(['air_delivery_charge_dest_charge', 'drayage', 'dryage_charge'])
    expect(extractFormulaKeys('{a} + {b} * {a}')).toEqual(['a', 'b'])
  })

  it('無變數或空公式應回空陣列', () => {
    expect(extractFormulaKeys('1 + 2')).toEqual([])
    expect(extractFormulaKeys('')).toEqual([])
  })
})

describe('FIX-128: collectRuleSourceKeys', () => {
  it('FORMULA 取公式變數，不取 sourceField', () => {
    expect(
      collectRuleSourceKeys({
        transformType: 'FORMULA',
        sourceField: 'thc',
        transformParams: { formula: '{terminal_handling_charge_origin} + {thc}' },
      })
    ).toEqual(['terminal_handling_charge_origin', 'thc'])
  })

  it('DIRECT 取 sourceField（TOLL 實測死 key）', () => {
    // terminal_fees_at_origin ← terminal_handling_charges_origin [DIRECT]（複數，實際 key 為單數）
    expect(
      collectRuleSourceKeys({
        transformType: 'DIRECT',
        sourceField: 'terminal_handling_charges_origin',
      })
    ).toEqual(['terminal_handling_charges_origin'])
  })

  it('AGGREGATE 讀 lineItems 而非 row，應回空', () => {
    expect(
      collectRuleSourceKeys({ transformType: 'AGGREGATE', sourceField: 'THC' })
    ).toEqual([])
  })
})

describe('FIX-128: findUnknownRuleSourceKeys', () => {
  const SBS_KNOWN = new Set([
    'air_delivery_order_dest',
    'air_delivery_charge_dest',
    'air_pick_up_charge_origin',
    'air_pick_up_charge',
    'shipment_number',
  ])

  it('SBS 實測：delivery 公式三項全部未知', () => {
    const unknown = findUnknownRuleSourceKeys(
      {
        transformType: 'FORMULA',
        sourceField: 'delivery',
        transformParams: {
          formula: '{air_delivery_charge_dest_charge} + {drayage} + {dryage_charge}',
        },
      },
      SBS_KNOWN
    )
    expect(unknown).toEqual([
      'air_delivery_charge_dest_charge',
      'drayage',
      'dryage_charge',
    ])
  })

  it('SBS 實測：pick_up 公式僅拼錯項未知，存在的 key 不誤報', () => {
    const unknown = findUnknownRuleSourceKeys(
      {
        transformType: 'FORMULA',
        sourceField: 'pick_up_fee_at_origin',
        transformParams: {
          formula: '{air_pick_up_charge_original_charge} + {air_pick_up_charge}',
        },
      },
      SBS_KNOWN
    )
    expect(unknown).toEqual(['air_pick_up_charge_original_charge'])
  })

  it('合法公式（所有 key 都存在）不產生警示', () => {
    expect(
      findUnknownRuleSourceKeys(
        {
          transformType: 'FORMULA',
          sourceField: 'x',
          transformParams: { formula: '{air_delivery_order_dest} + {air_pick_up_charge}' },
        },
        SBS_KNOWN
      )
    ).toEqual([])
  })

  it('li_* / _ref_* 動態合成欄位應豁免', () => {
    expect(
      findUnknownRuleSourceKeys(
        {
          transformType: 'FORMULA',
          sourceField: 'x',
          transformParams: { formula: '{li_Freight Charges_total} + {unknown_key}' },
        },
        SBS_KNOWN
      )
      // li_ 前綴豁免；注意含空格的 li_ key 不符合變數格式，本就不會被抽取
    ).toEqual(['unknown_key'])
    expect(
      findUnknownRuleSourceKeys(
        { transformType: 'DIRECT', sourceField: '_ref_SHIPMENT' },
        SBS_KNOWN
      )
    ).toEqual([])
  })
})

describe('FIX-128: isSyntheticSourceKey', () => {
  it('li_ 與 _ref_ 前綴為合成欄位', () => {
    expect(isSyntheticSourceKey('li_thc_total')).toBe(true)
    expect(isSyntheticSourceKey('_ref_number')).toBe(true)
    expect(isSyntheticSourceKey('thc')).toBe(false)
    expect(isSyntheticSourceKey('delivery_order_fee')).toBe(false)
  })
})
