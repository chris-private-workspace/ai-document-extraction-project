/**
 * @fileoverview FIX-108 確定性費用回填單元測試
 * @description
 *   驗證 Stage3ExtractionService.backfillLineItemCharges 的三項修正：
 *   - 修正 1：以原始 description 對照 field def（classifiedAs 僅作 fallback）
 *   - 修正 2：唯一命中時以程式加總覆蓋 GPT 填的錯值
 *   - 修正 3：僅清除「可證明由 classifiedAs 失真造成的誤填」，不誤傷其他來源
 *   以及 rollback 開關（STAGE3_DETERMINISTIC_BACKFILL=false → CHANGE-094 舊行為）
 *
 *   FIX-127 追加：金額指紋去重 —— GPT 把同一筆費用另填到相近欄位時，該欄位與已認領
 *   金額相同，留著會被 template mapping 的加總公式重複計入。
 *
 *   FIX-126 追加：比對強化 —— 單複數歸一（方案 A）+ 方向詞必要條件（方案 C）+
 *   非對稱子字串（僅允許文件文字 ⊇ 定義名稱），修正實務費用名稱變體大量落空。
 *
 *   Fixture 取自 Azure DEV 實測資料（Nippon Express (HK)、RICOH INTERNATIONAL
 *   LOGISTICS、Toll Global Forwarder）
 *
 * @module tests/unit/services/stage-3-lineitem-backfill.test
 * @since FIX-108
 * @lastModified 2026-07-22
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

describe('FIX-127: 同一筆費用落入兩個欄位的金額指紋去重', () => {
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

  it('GPT 另填的欄位與已認領金額相同時應清除（RIL THC 實測情境）', () => {
    // RIL_RCIM250015_14409.pdf：文件上只有一筆 (SEA) THC (DEST) 325.42，
    // 但 GPT 另把它填進 thc，回填則認領到 sea_thc → 公式 {thc}+{sea_thc} 得 650.84
    const defs = [
      chargeDef('sea_thc', '(Sea) THC'),
      chargeDef('thc', 'THC'),
      chargeDef('handling', 'Handling'),
    ]
    const items = [
      lineItem('(SEA) THC (DEST)', '(sea) Thc', 325.42),
      lineItem('HANDLING CHARGE', 'Handling', 57.48),
    ]
    const fields: Record<string, FieldValue> = { thc: gptValue(325.42) }

    backfill(fields, items, defs)

    expect(fields.sea_thc.value).toBe(325.42) // classifiedAs exact 命中
    expect(fields.sea_thc.source).toBe('lineItem-backfill')
    expect(fields.thc.value).toBeNull() // 重複記錄被清除
    expect(fields.thc.source).toBe('duplicate-amount-cleared')
  })

  it('文件上不存在的費用被 GPT 填入且金額與已認領者相同時應清除（TOLL Docs fee 實測情境）', () => {
    // TOLL_RCIM240349_58326.PDF：文件上沒有 document fee，只有 Delivery Order Fee 50.82。
    // GPT 誤填 document_fee_destination，公式 {document_fee_destination}+
    // {delivery_order_fee_destination} 得 101.64
    const defs = [
      chargeDef('delivery_order_fee_destination', 'Delivery Order Fee - Destination'),
      chargeDef('document_fee_destination', 'Document Fee - Destination'),
    ]
    const items = [
      lineItem('Delivery Order Fee - Destination', 'Delivery Order Fee Destination', 50.82),
    ]
    const fields: Record<string, FieldValue> = {
      document_fee_destination: gptValue(50.82),
    }

    backfill(fields, items, defs)

    expect(fields.delivery_order_fee_destination.value).toBe(50.82)
    expect(fields.document_fee_destination.value).toBeNull()
  })

  it('金額與任何已認領費用都不同時必須保留（summary 區的獨立費用）', () => {
    const defs = [
      chargeDef('sea_thc', '(Sea) THC'),
      chargeDef('fuel_surcharge', 'Fuel Surcharge'),
    ]
    const items = [lineItem('(SEA) THC (DEST)', '(sea) Thc', 325.42)]
    const fields: Record<string, FieldValue> = { fuel_surcharge: gptValue(5000) }

    backfill(fields, items, defs)

    expect(fields.fuel_surcharge.value).toBe(5000)
  })

  it('浮點加總尾差應視為同一筆金額', () => {
    // 兩行加總得 982.4000000000001（實測 template instance 出現過此類尾差）
    const defs = [
      chargeDef('handling_for_rlchk', 'Handling (For RLCHK)'),
      chargeDef('handling', 'Handling'),
    ]
    const items = [
      lineItem('HANDLING (FOR RLCHK)', 'Handling For Rlchk', 982.1),
      lineItem('HANDLING (FOR RLCHK)', 'Handling For Rlchk', 0.3000000000000001),
    ]
    const fields: Record<string, FieldValue> = { handling: gptValue(982.4) }

    backfill(fields, items, defs)

    expect(fields.handling_for_rlchk.value).toBeCloseTo(982.4, 5)
    expect(fields.handling.value).toBeNull() // 尾差不影響判定
  })

  it('字串型金額（含千分位）也應參與去重判定', () => {
    const defs = [
      chargeDef('sea_thc', '(Sea) THC'),
      chargeDef('thc', 'THC'),
    ]
    const items = [lineItem('(SEA) THC (DEST)', '(sea) Thc', 1325.42)]
    const fields: Record<string, FieldValue> = {
      thc: { value: '1,325.42', confidence: 90, source: 'gpt' },
    }

    backfill(fields, items, defs)

    expect(fields.thc.value).toBeNull()
  })

  it('零額不納入指紋，值為 0 的欄位不得被清除', () => {
    const defs = [
      chargeDef('sea_thc', '(Sea) THC'),
      chargeDef('handling', 'Handling'),
    ]
    const items = [lineItem('(SEA) THC (DEST)', '(sea) Thc', 0)]
    const fields: Record<string, FieldValue> = { handling: gptValue(0) }

    backfill(fields, items, defs)

    expect(fields.handling.value).toBe(0)
  })

  it('STAGE3_DETERMINISTIC_BACKFILL=false 時不執行去重（rollback）', () => {
    vi.stubEnv('STAGE3_DETERMINISTIC_BACKFILL', 'false')

    const defs = [
      chargeDef('sea_thc', '(Sea) THC'),
      chargeDef('thc', 'THC'),
    ]
    const items = [lineItem('(SEA) THC (DEST)', '(sea) Thc', 325.42)]
    const fields: Record<string, FieldValue> = { thc: gptValue(325.42) }

    backfill(fields, items, defs)

    expect(fields.thc.value).toBe(325.42) // 舊行為：不清除
  })
})

describe('FIX-126: 費用名稱比對強化（單複數 + 方向必要條件 + 非對稱子字串）', () => {
  let backfill: BackfillFn

  beforeEach(() => {
    const service = new Stage3ExtractionService({} as unknown as PrismaClient)
    backfill = (
      service as unknown as { backfillLineItemCharges: BackfillFn }
    ).backfillLineItemCharges.bind(service)
  })

  /** TOLL 實測欄位（節錄，方向成對 + aliases 全空） */
  const TOLL_THC_DEFS = [
    chargeDef('terminal_handling_charge_origin', 'Terminal Handling Charge - Origin'),
    chargeDef(
      'terminal_handling_charge_destination',
      'Terminal Handling Charge - Destination'
    ),
  ]

  it('模式 1：複數 + 計價後綴的 description 應命中同方向定義（TOLL THC 實測）', () => {
    // TOLL_RHIM260048_79294.PDF：修正前 fields 完全沒有 terminal_handling_charge_origin
    const items = [
      lineItem(
        'Terminal Handling Charges - Origin - 4 40HC Container(s) @ THB 4300.00/Container',
        'Terminal Handling Charge',
        17200
      ),
    ]
    const fields: Record<string, FieldValue> = {}

    backfill(fields, items, TOLL_THC_DEFS)

    expect(fields.terminal_handling_charge_origin.value).toBe(17200)
    expect(fields.terminal_handling_charge_origin.source).toBe('lineItem-backfill')
    expect(fields.terminal_handling_charge_destination).toBeUndefined()
  })

  it('模式 4：無方向的 classifiedAs 不得認領有方向的欄位（明確定義為不填）', () => {
    // classifiedAs 被 GPT 去掉方向後綴 → 修正前是歧義放棄，修正後同樣不填
    const items = [
      lineItem('THC CHARGE', 'Terminal Handling Charge', 4300),
    ]
    const fields: Record<string, FieldValue> = {
      terminal_handling_charge_origin: gptValue(4300),
    }

    backfill(fields, items, TOLL_THC_DEFS)

    // 不填：destination 未被填；不清：GPT 已填的 origin 保留（無認領佐證）
    expect(fields.terminal_handling_charge_destination).toBeUndefined()
    expect(fields.terminal_handling_charge_origin.value).toBe(4300)
  })

  it('模式 5：較泛的費用名不得被較具體的定義名稱認領', () => {
    // 修正前 HANDLING CHARGE 子字串誤命中 Terminal handling charge
    const defs = [chargeDef('terminal_handling_charge', 'Terminal handling charge')]
    const items = [lineItem('HANDLING CHARGE', 'Handling Charge', 100)]
    const fields: Record<string, FieldValue> = {}

    backfill(fields, items, defs)

    expect(fields.terminal_handling_charge).toBeUndefined()
  })

  it('方向衝突防護：無方向 alias 不得讓反向的文件文字跨方向認領', () => {
    // FIX-130 將補的無方向 alias（如 TERMINAL HANDLING CHARGE）不可成為跨方向漏洞
    const defs = [
      chargeDef('thc_origin', 'THC - Origin', ['TERMINAL HANDLING CHARGE']),
    ]
    const items = [
      lineItem('TERMINAL HANDLING CHARGES - DESTINATION', 'Terminal Handling Charge', 8700),
    ]
    const fields: Record<string, FieldValue> = {}

    backfill(fields, items, defs)

    expect(fields.thc_origin).toBeUndefined()
  })

  it('FIX-130 aliases 與非對稱子字串協同：帶後綴的 description 命中 alias', () => {
    const defs = [
      chargeDef('document_fee_destination', 'Document Fee - Destination', [
        'Documentation Fee - Destination',
      ]),
      chargeDef('document_fee', 'Document Fee'),
    ]
    // TOLL_RHIM260062_51857.PDF 實測明細行（修正前因 Base Rate 後綴而落空）
    const items = [
      lineItem(
        'Documentation Fee - Destination - Base Rate HKD 650.00',
        'Document Fee',
        650
      ),
    ]
    const fields: Record<string, FieldValue> = {}

    backfill(fields, items, defs)

    expect(fields.document_fee_destination.value).toBe(650)
    expect(fields.document_fee).toBeUndefined()
  })

  it('迴歸：Nippon Express (HK) 既有 aliases 行為完全不變', () => {
    const fields: Record<string, FieldValue> = { thc: gptValue(2400) }

    backfill(fields, NEHK_LINE_ITEMS, NEHK_DEFS)

    expect(fields.thc.value).toBe(8700) // T.H.C. alias exact，1500 + 7200
    expect(fields.nehk_bl_fee.value).toBe(680)
    expect(fields.vgm_admin_charge.value).toBe(936)
  })
})
