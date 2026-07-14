/**
 * @fileoverview FIX-108 確定性費用回填單元測試
 * @description
 *   驗證 Stage3ExtractionService.backfillLineItemCharges 的三項修正：
 *   - 修正 1：以原始 description 對照 field def（classifiedAs 僅作 fallback）
 *   - 修正 2：唯一命中時以程式加總覆蓋 GPT 填的錯值
 *   - 修正 3：僅清除「可證明由 classifiedAs 失真造成的誤填」，不誤傷其他來源
 *   以及 rollback 開關（STAGE3_DETERMINISTIC_BACKFILL=false → CHANGE-094 舊行為）
 *
 *   Fixture 取自 Azure DEV 實測資料（Nippon Express (HK)，NEX_RCIM250020_8925.pdf）
 *
 * @module tests/unit/services/stage-3-lineitem-backfill.test
 * @since FIX-108
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { Stage3ExtractionService } from '@/services/extraction-v3/stages/stage-3-extraction.service'
import type {
  FieldValue,
  FieldDefinitionEntry,
  LineItemV3,
} from '@/types/extraction-v3.types'

type BackfillFn = (
  fields: Record<string, FieldValue>,
  lineItems: LineItemV3[],
  fieldDefinitions: FieldDefinitionEntry[]
) => void

/** 建立 lineItem 類費用欄位定義 */
function chargeDef(
  key: string,
  label: string,
  aliases: string[] = []
): FieldDefinitionEntry {
  return {
    key,
    label,
    category: 'charges',
    dataType: 'currency',
    required: false,
    aliases,
    fieldType: 'lineItem',
  }
}

/** 建立 lineItem */
function lineItem(
  description: string,
  classifiedAs: string | undefined,
  amount: number
): LineItemV3 {
  return { description, classifiedAs, amount, confidence: 95 }
}

/** GPT 已填的欄位值 */
function gptValue(value: number): FieldValue {
  return { value, confidence: 90, source: 'gpt' }
}

/**
 * Nippon Express (HK) 欄位集（節錄實測的 lineItem 類定義，含 FIX-108 補上的 aliases）
 */
const NEHK_DEFS: FieldDefinitionEntry[] = [
  chargeDef('thc', 'THC', ['T.H.C', 'TERMINAL HANDLING CHARGE']),
  chargeDef('seal_charge', 'Seal Charge', ['SEAL CHARGE']),
  chargeDef('container_seal_fee', 'seal fee', [
    'CONTAINER SEAL FEE',
    'CONTAINER SEAL FEE - FCL',
  ]),
  chargeDef('bl_fee', 'B/L fee', ['B/L FEE', 'BL FEE']),
  chargeDef('nehk_bl_fee', 'NEHK B/L fee', [
    'NEHK B/L FEE',
    'NEHK B/L FEE - FCL',
    'NEHK BL FEE',
  ]),
  chargeDef('handling_charge', 'Handling Charge'),
  chargeDef('vgm_admin_charge', 'VGM admin charge', [
    'VGM ADMIN. CHARGE',
    'VGM ADMIN. CHARGE - FCL',
  ]),
]

/** Azure DEV 實測的 8 筆 lineItems（三次提取完全一致） */
const NEHK_LINE_ITEMS: LineItemV3[] = [
  lineItem('T.H.C.', 'Terminal Handling Charge', 1500),
  lineItem('T.H.C.', 'Terminal Handling Charge', 7200),
  lineItem('CONTAINER SEAL FEE - FCL', 'Seal Charge', 110),
  lineItem('CONTAINER SEAL FEE - FCL', 'Seal Charge', 330),
  lineItem('NEHK B/L FEE - FCL', 'B/l Fee', 680),
  lineItem('HANDLING CHARGE', 'Handling Charge', 100),
  lineItem('VGM ADMIN. CHARGE - FCL', 'Vgm Admin Charge', 234),
  lineItem('VGM ADMIN. CHARGE - FCL', 'Vgm Admin Charge', 702),
]

describe('FIX-108: Stage 3 確定性費用回填', () => {
  let backfill: BackfillFn

  beforeEach(() => {
    const service = new Stage3ExtractionService({} as unknown as PrismaClient)
    backfill = (
      service as unknown as { backfillLineItemCharges: BackfillFn }
    ).backfillLineItemCharges.bind(service)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('應以 description 對照並加總，覆蓋 GPT 填的錯值（NEHK 實測情境）', () => {
    // GPT 的實測錯誤輸出：thc 心算錯、seal_charge 被 classifiedAs 誤導、bl_fee 誤填
    const fields: Record<string, FieldValue> = {
      thc: gptValue(2400),
      seal_charge: gptValue(440),
      container_seal_fee: gptValue(220),
      bl_fee: gptValue(680),
      handling_charge: gptValue(100),
      vgm_admin_charge: gptValue(936),
    }

    backfill(fields, NEHK_LINE_ITEMS, NEHK_DEFS)

    expect(fields.thc.value).toBe(8700) // 1500 + 7200，覆蓋 GPT 的 2400
    expect(fields.container_seal_fee.value).toBe(440) // 110 + 330，覆蓋 GPT 的 220
    expect(fields.nehk_bl_fee.value).toBe(680) // description 命中
    expect(fields.handling_charge.value).toBe(100)
    expect(fields.vgm_admin_charge.value).toBe(936) // 234 + 702
    // 修正 3：classifiedAs 失真造成的誤填被清除
    expect(fields.seal_charge.value).toBeNull()
    expect(fields.bl_fee.value).toBeNull()
  })

  it('未被任何 lineItem 的 classifiedAs 命中的欄位（值來自 lineItems 以外）不得被清空', () => {
    const defs = [...NEHK_DEFS, chargeDef('fuel_surcharge', 'Fuel Surcharge')]
    const fields: Record<string, FieldValue> = {
      // 發票 summary 區抽到、lineItems 中無對應行
      fuel_surcharge: gptValue(5000),
    }

    backfill(fields, NEHK_LINE_ITEMS, defs)

    expect(fields.fuel_surcharge.value).toBe(5000)
  })

  it('description 未命中時應退回 classifiedAs 對照（向後相容 CHANGE-094）', () => {
    // aliases 為空、label 與發票用語不同 → description 無法命中，只有 classifiedAs 命中
    const defs = [chargeDef('terminal_handling', 'Terminal Handling Charge')]
    const items = [lineItem('T.H.C.', 'Terminal Handling Charge', 1500)]
    const fields: Record<string, FieldValue> = {}

    backfill(fields, items, defs)

    expect(fields.terminal_handling.value).toBe(1500)
    expect(fields.terminal_handling.source).toBe('lineItem-backfill')
  })

  it('candidate 同時命中多個定義（歧義）時應跳過，不填也不清空', () => {
    const defs = [
      chargeDef('origin_thc', 'Origin Terminal Handling Charge'),
      chargeDef('dest_thc', 'Destination Terminal Handling Charge'),
    ]
    // 'Terminal Handling Charge' 是兩個 label 的子字串 → 歧義
    const items = [lineItem('Terminal Handling Charge', 'Terminal Handling Charge', 900)]
    const fields: Record<string, FieldValue> = { origin_thc: gptValue(900) }

    backfill(fields, items, defs)

    expect(fields.origin_thc.value).toBe(900) // 未被覆蓋
    expect(fields.dest_thc).toBeUndefined() // 未被填入
  })

  it('非 lineItem 類欄位不受影響', () => {
    const defs: FieldDefinitionEntry[] = [
      ...NEHK_DEFS,
      {
        key: 'invoice_number',
        label: 'Invoice Number',
        category: 'basic',
        dataType: 'string',
        required: true,
        fieldType: 'standard',
      },
    ]
    const fields: Record<string, FieldValue> = {
      invoice_number: { value: '25NEH-HJT-E8925', confidence: 98, source: 'gpt' },
    }

    backfill(fields, NEHK_LINE_ITEMS, defs)

    expect(fields.invoice_number.value).toBe('25NEH-HJT-E8925')
  })

  it('STAGE3_DETERMINISTIC_BACKFILL=false 時應回到 CHANGE-094 舊行為（rollback）', () => {
    vi.stubEnv('STAGE3_DETERMINISTIC_BACKFILL', 'false')

    const fields: Record<string, FieldValue> = {
      thc: gptValue(2400),
      seal_charge: gptValue(440),
      bl_fee: gptValue(680),
    }

    backfill(fields, NEHK_LINE_ITEMS, NEHK_DEFS)

    // 舊行為：GPT 已填值優先，不覆蓋、不清除
    expect(fields.thc.value).toBe(2400)
    expect(fields.seal_charge.value).toBe(440)
    expect(fields.bl_fee.value).toBe(680)
  })
})
