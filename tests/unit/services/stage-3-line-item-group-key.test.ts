/**
 * @fileoverview CHANGE-113：行項目分組鍵透傳與分組產生單元測試
 * @description
 *   階段一 —— 驗證 Stage3ExtractionService.convertRawLineItems 會保留 GPT 回傳的
 *   分組資訊（`groupKey` / `groupSourceRef`），供「一份發票對應多個 shipment」的場景使用。
 *
 *   階段二 —— 驗證 buildLineItemGroups 依 `groupKey` 切組後，對**組內**行項目單獨
 *   重跑確定性回填，讓每一組各自持有正確的費用欄位金額。
 *
 *   **這個測試存在的理由**：`convertRawLineItems` 是「逐欄位重建物件」的實作 ——
 *   任何未在其中明確列出的欄位都會被靜默丟棄。FIX-092 的 `referenceNumberMatch`
 *   就是這樣在主路徑上漏掉的（提取有跑、值卻永遠是 NULL），且因為不會拋錯、
 *   型別也不會報，問題直到使用者回報才被發現。此測試把透傳行為釘死，讓將來
 *   任何漏掉欄位的改動在 CI 就失敗。
 *
 *   Fixture 取自使用者 2026-07-29 回報的 DHL 實例（invoice HKGR008328699，
 *   一份發票含 RCIM-25-0111 與 RCIM-25-0113 兩個 shipment）。
 *
 * @module tests/unit/services/stage-3-line-item-group-key.test
 * @since CHANGE-113 階段一
 * @lastModified 2026-07-29
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { Stage3ExtractionService } from '@/services/extraction-v3/stages/stage-3-extraction.service'
import type {
  LineItemV3,
  LineItemGroupV3,
  FieldDefinitionEntry,
} from '@/types/extraction-v3.types'

type ConvertFn = (rawItems: unknown[] | undefined) => LineItemV3[]

type BuildGroupsFn = (
  lineItems: LineItemV3[],
  fieldDefinitions: FieldDefinitionEntry[]
) => LineItemGroupV3[] | undefined

/** 建立 lineItem 類費用欄位定義 */
function chargeDef(key: string, label: string): FieldDefinitionEntry {
  return {
    key,
    label,
    category: 'charges',
    dataType: 'currency',
    required: false,
    aliases: [],
    fieldType: 'lineItem',
  }
}

/** DHL 欄位定義（含階段二必須補上的燃油附加費欄位） */
const DHL_DEFS: FieldDefinitionEntry[] = [
  chargeDef('express_worldwide_nondoc', 'EXPRESS WORLDWIDE nondoc'),
  chargeDef('fuel_surcharge', 'FUEL SURCHARGE'),
]

/**
 * DHL 實例的 GPT 原始輸出（節錄）
 *
 * 第 2 頁橫向明細表的 4 筆費用，分屬兩個 shipment：
 *   RCIM-25-0111 (AWB 8365573366): 247.50 + 69.92 = 317.42
 *   RCIM-25-0113 (AWB 2407071774): 2310.00 + 652.58 = 2962.58
 */
const DHL_RAW_ITEMS: unknown[] = [
  {
    description: 'EXPRESS WORLDWIDE nondoc',
    category: 'Freight',
    amount: 247.5,
    confidence: 96,
    groupKey: 'RCIM-25-0111',
    groupSourceRef: '8365573366',
  },
  {
    description: 'FUEL SURCHARGE',
    category: 'Fuel Surcharge',
    amount: 69.92,
    confidence: 96,
    groupKey: 'RCIM-25-0111',
    groupSourceRef: '8365573366',
  },
  {
    description: 'EXPRESS WORLDWIDE nondoc',
    category: 'Freight',
    amount: 2310,
    confidence: 96,
    groupKey: 'RCIM-25-0113',
    groupSourceRef: '2407071774',
  },
  {
    description: 'FUEL SURCHARGE',
    category: 'Fuel Surcharge',
    amount: 652.58,
    confidence: 96,
    groupKey: 'RCIM-25-0113',
    groupSourceRef: '2407071774',
  },
]

describe('CHANGE-113 階段一: 行項目分組鍵透傳', () => {
  let convert: ConvertFn

  beforeEach(() => {
    const service = new Stage3ExtractionService({} as unknown as PrismaClient)
    convert = (
      service as unknown as { convertRawLineItems: ConvertFn }
    ).convertRawLineItems.bind(service)
  })

  it('應保留 DHL 多 shipment 發票的分組鍵與原生單號', () => {
    const result = convert(DHL_RAW_ITEMS)

    expect(result).toHaveLength(4)
    expect(result.map((li) => li.groupKey)).toEqual([
      'RCIM-25-0111',
      'RCIM-25-0111',
      'RCIM-25-0113',
      'RCIM-25-0113',
    ])
    expect(result.map((li) => li.groupSourceRef)).toEqual([
      '8365573366',
      '8365573366',
      '2407071774',
      '2407071774',
    ])
  })

  it('應讓分組後的金額與文件上的小計一致', () => {
    const result = convert(DHL_RAW_ITEMS)

    const sumOf = (groupKey: string) =>
      result
        .filter((li) => li.groupKey === groupKey)
        .reduce((sum, li) => sum + li.amount, 0)

    // 文件上印的兩個小計
    expect(sumOf('RCIM-25-0111')).toBeCloseTo(317.42, 2)
    expect(sumOf('RCIM-25-0113')).toBeCloseTo(2962.58, 2)
  })

  it('應接受 snake_case 變體（GPT 未必照 schema 的 key 命名回傳）', () => {
    const result = convert([
      {
        description: 'EXPRESS WORLDWIDE nondoc',
        amount: 247.5,
        group_key: 'RCIM-25-0111',
        group_source_ref: '8365573366',
      },
    ])

    expect(result[0].groupKey).toBe('RCIM-25-0111')
    expect(result[0].groupSourceRef).toBe('8365573366')
  })

  it('應將空字串與純空白收斂為 undefined，避免產生空的分組', () => {
    const result = convert([
      { description: 'A', amount: 10, groupKey: '', groupSourceRef: '   ' },
      { description: 'B', amount: 20, groupKey: '  ', groupSourceRef: '' },
    ])

    expect(result[0].groupKey).toBeUndefined()
    expect(result[0].groupSourceRef).toBeUndefined()
    expect(result[1].groupKey).toBeUndefined()
    expect(result[1].groupSourceRef).toBeUndefined()
  })

  it('應去除分組鍵前後空白（人工補註常帶多餘空格）', () => {
    const result = convert([
      { description: 'A', amount: 10, groupKey: '  RCIM-25-0111  ' },
    ])

    expect(result[0].groupKey).toBe('RCIM-25-0111')
  })

  it('一般單一 shipment 發票不應被影響（分組欄位為 undefined）', () => {
    const result = convert([
      { description: 'OCEAN FREIGHT', category: 'Ocean Freight', amount: 1500, confidence: 95 },
    ])

    expect(result[0].groupKey).toBeUndefined()
    expect(result[0].groupSourceRef).toBeUndefined()
  })

  it('既有欄位的轉換行為不應因新增分組欄位而改變', () => {
    const result = convert([
      {
        description: 'T.H.C.',
        category: 'Terminal Handling Charge',
        quantity: 2,
        unit_price: 3600,
        amount: 7200,
        confidence: 92,
      },
    ])

    expect(result[0]).toMatchObject({
      description: 'T.H.C.',
      classifiedAs: 'Terminal Handling Charge',
      quantity: 2,
      unitPrice: 3600,
      amount: 7200,
      confidence: 92,
      needsClassification: false,
    })
  })
})

describe('CHANGE-113 階段二: 分組產生與組層級費用回填', () => {
  let convert: ConvertFn
  let buildGroups: BuildGroupsFn

  beforeEach(() => {
    const service = new Stage3ExtractionService({} as unknown as PrismaClient)
    convert = (
      service as unknown as { convertRawLineItems: ConvertFn }
    ).convertRawLineItems.bind(service)
    buildGroups = (
      service as unknown as { buildLineItemGroups: BuildGroupsFn }
    ).buildLineItemGroups.bind(service)
  })

  it('應依 groupKey 切成兩組，並保持在文件中出現的順序', () => {
    const groups = buildGroups(convert(DHL_RAW_ITEMS), DHL_DEFS)

    expect(groups).toHaveLength(2)
    expect(groups?.map((group) => group.groupKey)).toEqual([
      'RCIM-25-0111',
      'RCIM-25-0113',
    ])
    expect(groups?.map((group) => group.lineItems.length)).toEqual([2, 2])
  })

  it('每組的費用欄位應只含該組金額（模板層每列據此取值）', () => {
    const groups = buildGroups(convert(DHL_RAW_ITEMS), DHL_DEFS)

    expect(groups?.[0].fields.express_worldwide_nondoc?.value).toBe(247.5)
    expect(groups?.[0].fields.fuel_surcharge?.value).toBe(69.92)
    expect(groups?.[1].fields.express_worldwide_nondoc?.value).toBe(2310)
    expect(groups?.[1].fields.fuel_surcharge?.value).toBe(652.58)
  })

  it('組內費用加總應等於文件上印的小計', () => {
    const groups = buildGroups(convert(DHL_RAW_ITEMS), DHL_DEFS)

    const sumOf = (group: LineItemGroupV3) =>
      Object.values(group.fields).reduce(
        (sum, field) => sum + (typeof field.value === 'number' ? field.value : 0),
        0
      )

    expect(sumOf(groups![0])).toBeCloseTo(317.42, 2)
    expect(sumOf(groups![1])).toBeCloseTo(2962.58, 2)
  })

  it('應收錄該組的原生單號供人工核對（但不用於分組）', () => {
    const groups = buildGroups(convert(DHL_RAW_ITEMS), DHL_DEFS)

    expect(groups?.[0].sourceRefs).toEqual(['8365573366'])
    expect(groups?.[1].sourceRefs).toEqual(['2407071774'])
  })

  it('一般發票（無 groupKey）不應產生分組 —— 模板層據此維持一份文件一列', () => {
    const lineItems = convert([
      { description: 'OCEAN FREIGHT', category: 'Ocean Freight', amount: 1500, confidence: 95 },
    ])

    expect(buildGroups(lineItems, DHL_DEFS)).toBeUndefined()
  })

  it('groupSourceRef 讀到不同值不得影響分組結果', () => {
    // 實測：同一份文件連跑三次，AWB 讀出三個不同的值（六次僅一次正確）。
    // 分組只看 groupKey，因此結果必須與 AWB 無關。
    const withWrongRefs = DHL_RAW_ITEMS.map((item) => ({
      ...(item as Record<string, unknown>),
      groupSourceRef: '88557336', // 錯誤且全部相同的 AWB
    }))

    const groups = buildGroups(convert(withWrongRefs), DHL_DEFS)

    expect(groups).toHaveLength(2)
    expect(groups?.[0].fields.express_worldwide_nondoc?.value).toBe(247.5)
    expect(groups?.[1].fields.express_worldwide_nondoc?.value).toBe(2310)
  })

  it('僅部分行項目帶 groupKey 時，未標記者不歸入任何組（不得憑空產生一列）', () => {
    const lineItems = convert([
      ...DHL_RAW_ITEMS,
      { description: 'ADMIN FEE', category: 'Admin Fee', amount: 50, confidence: 90 },
    ])

    const groups = buildGroups(lineItems, DHL_DEFS)

    expect(groups).toHaveLength(2)
    const groupedCount = groups!.reduce((sum, group) => sum + group.lineItems.length, 0)
    expect(groupedCount).toBe(4) // 第 5 筆未標記，不屬於任何組
  })
})
