/**
 * @fileoverview FIX-128 模版匹配引擎轉換診斷單元測試
 * @description
 *   驗證 transformFields 在轉換的同時收集「引用了 row 中不存在的來源 key」
 *   診斷，且不改變既有轉換行為（未知項仍靜默視為 0，計算照常完成）。
 *
 *   Fixture 取自 Azure DEV 實測（SBS INTERNATIONAL 的死 key 公式）。
 *
 * @module tests/unit/services/template-matching-engine-diagnostics.test
 * @since FIX-128
 * @lastModified 2026-07-22
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { TemplateMatchingEngineService } from '@/services/template-matching-engine.service'
import type { TemplateFieldMappingRule } from '@/types/template-field-mapping'

type TransformFieldsFn = (
  sourceFields: Record<string, unknown>,
  mappings: TemplateFieldMappingRule[],
  stage3Result?: unknown
) => Promise<{
  values: Record<string, unknown>
  unresolvedSourceKeys: Record<string, string[]>
}>

/** 建立映射規則 */
function rule(
  partial: Pick<TemplateFieldMappingRule, 'sourceField' | 'targetField' | 'transformType'> &
    Partial<TemplateFieldMappingRule>
): TemplateFieldMappingRule {
  return {
    id: `rule-${partial.targetField}`,
    isRequired: false,
    order: 0,
    ...partial,
  }
}

describe('FIX-128: transformFields 轉換診斷', () => {
  let transformFields: TransformFieldsFn

  beforeEach(() => {
    const service = new TemplateMatchingEngineService()
    transformFields = (
      service as unknown as { transformFields: TransformFieldsFn }
    ).transformFields.bind(service)
  })

  it('FORMULA 引用不存在的 key 應記錄診斷，且計算照常完成（未知項為 0）', async () => {
    // SBS 實測：delivery 公式第一項拼錯（多了 _charge）、後兩項該公司沒有
    const sourceFields = { air_delivery_charge_dest: 120.5, shipment_number: 'S001' }
    const mappings = [
      rule({
        sourceField: 'delivery',
        targetField: 'delivery',
        transformType: 'FORMULA',
        transformParams: {
          formula: '{air_delivery_charge_dest_charge} + {drayage} + {dryage_charge}',
        },
      }),
    ]

    const { values, unresolvedSourceKeys } = await transformFields(sourceFields, mappings)

    expect(values.delivery).toBe(0) // 三項全空 → 0（既有行為不變）
    expect(unresolvedSourceKeys).toEqual({
      delivery: ['air_delivery_charge_dest_charge', 'drayage', 'dryage_charge'],
    })
  })

  it('DIRECT 的 sourceField 不存在應記錄診斷（TOLL 實測情境）', async () => {
    const sourceFields = { terminal_handling_charge_origin: 4300 }
    const mappings = [
      rule({
        sourceField: 'terminal_handling_charges_origin', // 複數，實際 key 為單數
        targetField: 'terminal_fees_at_origin',
        transformType: 'DIRECT',
      }),
    ]

    const { values, unresolvedSourceKeys } = await transformFields(sourceFields, mappings)

    expect(values.terminal_fees_at_origin).toBeUndefined()
    expect(unresolvedSourceKeys).toEqual({
      terminal_fees_at_origin: ['terminal_handling_charges_origin'],
    })
  })

  it('合法規則（所有 key 都存在）不產生任何診斷', async () => {
    const sourceFields = { thc: 8700, docs_fee: 650, shipment_number: 'S001' }
    const mappings = [
      rule({ sourceField: 'shipment_number', targetField: 'shipment_no', transformType: 'DIRECT' }),
      rule({
        sourceField: 'thc',
        targetField: 'total_charges',
        transformType: 'FORMULA',
        transformParams: { formula: '{thc} + {docs_fee}' },
      }),
    ]

    const { values, unresolvedSourceKeys } = await transformFields(sourceFields, mappings)

    expect(values.shipment_no).toBe('S001')
    expect(values.total_charges).toBe(9350)
    expect(unresolvedSourceKeys).toEqual({})
  })

  it('li_* / _ref_* 動態合成欄位缺席不得記為診斷', async () => {
    const sourceFields = { thc: 100 } // 該文件無 lineItems 展平、無 ref match
    const mappings = [
      rule({ sourceField: '_ref_number', targetField: 'shipment_no', transformType: 'DIRECT' }),
      rule({
        sourceField: 'freight',
        targetField: 'freight',
        transformType: 'FORMULA',
        transformParams: { formula: '{li_freight_total} + {thc}' },
      }),
    ]

    const { unresolvedSourceKeys } = await transformFields(sourceFields, mappings)

    expect(unresolvedSourceKeys).toEqual({})
  })
})
