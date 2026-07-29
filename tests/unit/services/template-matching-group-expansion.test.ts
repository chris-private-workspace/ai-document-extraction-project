/**
 * @fileoverview CHANGE-113 階段二：模板層分組展開單元測試
 * @description
 *   驗證 `GROUP` 模式把「一份發票對應多個 shipment」的文件展開成多列，且每一列的
 *   費用欄位、`li_*` 展平值與 `_ref_number` 都替換成**該組**的值。
 *
 *   **這些測試存在的理由**：規劃初稿以為「只把 lineItems 換成該組子集」就夠，
 *   實際查閱 DHL 設定後發現不成立 —— 現行映射規則是 `DIRECT` + field definition
 *   key，取值來自文件層級的回填結果，換 lineItems 對它完全無效（只有 `AGGREGATE`
 *   型映射會受影響）。案例 3、4 就是釘住這兩個容易復發的缺口：
 *     - 每列必須拿到自己的費用金額，而非整份發票的加總
 *     - 「本組沒有、他組才有」的費用欄位不得殘留文件層級的值
 *
 *   Fixture 取自使用者 2026-07-29 回報的 DHL 實例（invoice HKGR008328699，
 *   一份發票含 RCIM-25-0111 與 RCIM-25-0113 兩個 shipment）。
 *
 * @module tests/unit/services/template-matching-group-expansion.test
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-29
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    referenceNumber: { findMany: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import {
  TemplateMatchingEngineService,
  normalizeReferenceToken,
} from '@/services/template-matching-engine.service'
import type { LineItemMode } from '@/types/data-template'
import type { TemplateRowUnit } from '@/types/template-matching-engine'

type LoadedDocumentLike = {
  id: string
  mappedFields: Record<string, unknown>
  lineItems?: TemplateRowUnit['lineItems']
  extraCharges?: TemplateRowUnit['extraCharges']
  lineItemGroups?: Array<{
    groupKey: string
    fields: Record<string, { value: string | number | null; confidence: number }>
    lineItems: Array<{ description: string; classifiedAs?: string; amount: number; confidence: number }>
    sourceRefs?: string[]
  }>
}

type BuildRowUnitsFn = (
  documents: LoadedDocumentLike[],
  lineItemMode: LineItemMode,
  rowKeyField: string
) => Promise<TemplateRowUnit[]>

/** 費用欄位值（Stage 3 回填後的形狀） */
function charge(value: number) {
  return { value, confidence: 95 }
}

/**
 * DHL 實例：一份發票、兩個 shipment
 *
 * 文件層級的費用欄位是**整份發票的加總**（247.50 + 2310.00 = 2557.50），
 * 各組則各自持有自己的金額。
 */
function dhlDocument(): LoadedDocumentLike {
  return {
    id: 'doc-dhl-28699',
    mappedFields: {
      invoice_number: 'HKGR008328699',
      currency: 'HKD',
      express_worldwide_nondoc: 2557.5,
      fuel_surcharge: 722.5,
      li_Freight_total: 2557.5,
      li_Freight_count: 2,
      _ref_number: 'RCIM250111', // 檔名匹配只認得到第一個 shipment
      _ref_type: 'SHIPMENT',
    },
    lineItems: [
      { description: 'EXPRESS WORLDWIDE nondoc', classifiedAs: 'Freight', amount: 247.5, confidence: 96 },
      { description: 'FUEL SURCHARGE', classifiedAs: 'Fuel Surcharge', amount: 69.92, confidence: 96 },
      { description: 'EXPRESS WORLDWIDE nondoc', classifiedAs: 'Freight', amount: 2310, confidence: 96 },
      { description: 'FUEL SURCHARGE', classifiedAs: 'Fuel Surcharge', amount: 652.58, confidence: 96 },
    ],
    lineItemGroups: [
      {
        groupKey: 'RCIM-25-0111',
        fields: {
          express_worldwide_nondoc: charge(247.5),
          fuel_surcharge: charge(69.92),
        },
        lineItems: [
          { description: 'EXPRESS WORLDWIDE nondoc', classifiedAs: 'Freight', amount: 247.5, confidence: 96 },
          { description: 'FUEL SURCHARGE', classifiedAs: 'Fuel Surcharge', amount: 69.92, confidence: 96 },
        ],
        sourceRefs: ['8365573366'],
      },
      {
        groupKey: 'RCIM-25-0113',
        fields: {
          express_worldwide_nondoc: charge(2310),
          fuel_surcharge: charge(652.58),
        },
        lineItems: [
          { description: 'EXPRESS WORLDWIDE nondoc', classifiedAs: 'Freight', amount: 2310, confidence: 96 },
          { description: 'FUEL SURCHARGE', classifiedAs: 'Fuel Surcharge', amount: 652.58, confidence: 96 },
        ],
      },
    ],
  }
}

/** 一般單一 shipment 發票（無分組） */
function plainDocument(): LoadedDocumentLike {
  return {
    id: 'doc-plain',
    mappedFields: {
      shipment_no: 'S001',
      ocean_freight: 1500,
      li_Ocean_Freight_total: 1500,
    },
    lineItems: [
      { description: 'OCEAN FREIGHT', classifiedAs: 'Ocean Freight', amount: 1500, confidence: 95 },
    ],
  }
}

describe('CHANGE-113 階段二: 模板層分組展開', () => {
  let buildRowUnits: BuildRowUnitsFn

  beforeEach(() => {
    vi.clearAllMocks()
    // 預設：兩個分組鍵都對得到參考編號主檔
    vi.mocked(prisma.referenceNumber.findMany).mockResolvedValue([
      { number: 'RCIM250111', type: 'SHIPMENT' },
      { number: 'RCIM250113', type: 'SHIPMENT' },
    ] as never)

    const service = new TemplateMatchingEngineService()
    buildRowUnits = (
      service as unknown as { buildRowUnits: BuildRowUnitsFn }
    ).buildRowUnits.bind(service)
  })

  describe('回歸：既有行為不得改變', () => {
    it('PIVOT 模式下即使文件有分組，仍維持一份文件一列', async () => {
      const units = await buildRowUnits([dhlDocument()], 'PIVOT', 'shipment_no')

      expect(units).toHaveLength(1)
      expect(units[0].documentId).toBe('doc-dhl-28699')
      expect(units[0].sourceFields.express_worldwide_nondoc).toBe(2557.5)
      expect(units[0].lineItems).toHaveLength(4)
      // 未展開時不應查主檔
      expect(prisma.referenceNumber.findMany).not.toHaveBeenCalled()
    })

    it('GROUP 模式下沒有分組的一般發票維持一份文件一列', async () => {
      const units = await buildRowUnits([plainDocument()], 'GROUP', 'shipment_no')

      expect(units).toHaveLength(1)
      expect(units[0].rowKey).toBe('S001')
      expect(units[0].sourceFields.ocean_freight).toBe(1500)
    })

    it('rowKey 欄位為空時仍產生唯一 key（不得讓多份文件併成一列）', async () => {
      const doc = plainDocument()
      delete doc.mappedFields.shipment_no

      const units = await buildRowUnits([doc], 'PIVOT', 'shipment_no')

      expect(units[0].rowKey).toMatch(/^auto_/)
    })
  })

  describe('GROUP 模式展開', () => {
    it('一份兩個 shipment 的發票應展開成兩列', async () => {
      const units = await buildRowUnits([dhlDocument()], 'GROUP', 'shipment_no')

      expect(units).toHaveLength(2)
      expect(units.map((unit) => unit.documentId)).toEqual([
        'doc-dhl-28699',
        'doc-dhl-28699',
      ])
    })

    it('每列的 _ref_number 與 rowKey 應為該組對到主檔的標準號碼（驗收 10）', async () => {
      const units = await buildRowUnits([dhlDocument()], 'GROUP', 'shipment_no')

      // 分組鍵 RCIM-25-0111 → 主檔 RCIM250111（人工補註的連字號格式被正規化吸收）
      expect(units.map((unit) => unit.rowKey)).toEqual(['RCIM250111', 'RCIM250113'])
      expect(units.map((unit) => unit.sourceFields._ref_number)).toEqual([
        'RCIM250111',
        'RCIM250113',
      ])
      // 既有映射規則 _ref_number → shipment_number 因此自動變成每列各自的號碼
      expect(units[1].sourceFields._ref_number).not.toBe(
        dhlDocument().mappedFields._ref_number
      )
    })

    it('每列的費用欄位應為該組金額，而非整份發票的加總（驗收 11）', async () => {
      const units = await buildRowUnits([dhlDocument()], 'GROUP', 'shipment_no')

      expect(units[0].sourceFields.express_worldwide_nondoc).toBe(247.5)
      expect(units[0].sourceFields.fuel_surcharge).toBe(69.92)
      expect(units[1].sourceFields.express_worldwide_nondoc).toBe(2310)
      expect(units[1].sourceFields.fuel_surcharge).toBe(652.58)

      // 文件上印的兩個小計
      const sumOf = (unit: TemplateRowUnit) =>
        (unit.sourceFields.express_worldwide_nondoc as number) +
        (unit.sourceFields.fuel_surcharge as number)
      expect(sumOf(units[0])).toBeCloseTo(317.42, 2)
      expect(sumOf(units[1])).toBeCloseTo(2962.58, 2)
    })

    it('li_* 展平值應對組內行項目重算（供 AGGREGATE 型映射）', async () => {
      const units = await buildRowUnits([dhlDocument()], 'GROUP', 'shipment_no')

      expect(units[0].sourceFields.li_Freight_total).toBe(247.5)
      expect(units[0].sourceFields.li_Freight_count).toBe(1)
      expect(units[1].sourceFields.li_Freight_total).toBe(2310)
    })

    it('lineItems context 應只含該組的行項目', async () => {
      const units = await buildRowUnits([dhlDocument()], 'GROUP', 'shipment_no')

      expect(units[0].lineItems).toHaveLength(2)
      expect(units[0].lineItems?.map((item) => item.amount)).toEqual([247.5, 69.92])
      expect(units[1].lineItems?.map((item) => item.amount)).toEqual([2310, 652.58])
    })

    it('發票層級欄位應原樣帶入每一列', async () => {
      const units = await buildRowUnits([dhlDocument()], 'GROUP', 'shipment_no')

      for (const unit of units) {
        expect(unit.sourceFields.invoice_number).toBe('HKGR008328699')
        expect(unit.sourceFields.currency).toBe('HKD')
      }
    })

    it('本組沒有、他組才有的費用欄位不得殘留文件層級的加總', async () => {
      const doc = dhlDocument()
      // 組 1 沒有燃油附加費（只有組 2 有），文件層級則有 722.50 的加總
      delete doc.lineItemGroups![0].fields.fuel_surcharge

      const units = await buildRowUnits([doc], 'GROUP', 'shipment_no')

      // 若殘留就會變成 722.50 —— 一筆完全不屬於這個 shipment 的金額
      expect(units[0].sourceFields.fuel_surcharge).toBeUndefined()
      expect(units[1].sourceFields.fuel_surcharge).toBe(652.58)
    })

    it('分組鍵對不到主檔時應保留原始分組鍵作 rowKey（列不得消失或互相覆蓋）', async () => {
      vi.mocked(prisma.referenceNumber.findMany).mockResolvedValue([] as never)

      const units = await buildRowUnits([dhlDocument()], 'GROUP', 'shipment_no')

      expect(units).toHaveLength(2)
      expect(units.map((unit) => unit.rowKey)).toEqual(['RCIM-25-0111', 'RCIM-25-0113'])
      expect(new Set(units.map((unit) => unit.rowKey)).size).toBe(2)
    })

    it('多份文件應一次查完主檔（不得逐組查詢）', async () => {
      await buildRowUnits([dhlDocument(), dhlDocument()], 'GROUP', 'shipment_no')

      expect(prisma.referenceNumber.findMany).toHaveBeenCalledTimes(1)
    })
  })
})

describe('CHANGE-113 階段二: normalizeReferenceToken', () => {
  it('應把人工補註的各種格式收斂成主檔格式', () => {
    // 實測到的四種變體（四位標註者各寫各的）
    expect(normalizeReferenceToken('RCIM-25-0111')).toBe('RCIM250111')
    expect(normalizeReferenceToken('RCIM/25/0246')).toBe('RCIM250246')
    expect(normalizeReferenceToken('RHIM/25/0202\r')).toBe('RHIM250202')
    expect(normalizeReferenceToken('  RCIM-25-0113  ')).toBe('RCIM250113')
  })

  it('應轉為大寫（主檔一律大寫）', () => {
    expect(normalizeReferenceToken('rcim-25-0111')).toBe('RCIM250111')
  })

  it('空字串與純符號應收斂為空（不得產生無意義的查詢 token）', () => {
    expect(normalizeReferenceToken('')).toBe('')
    expect(normalizeReferenceToken('---')).toBe('')
  })
})
