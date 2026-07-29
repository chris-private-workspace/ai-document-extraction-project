/**
 * @fileoverview CHANGE-113 階段一：行項目分組鍵透傳單元測試
 * @description
 *   驗證 Stage3ExtractionService.convertRawLineItems 會保留 GPT 回傳的分組資訊
 *   （`groupKey` / `groupSourceRef`），供「一份發票對應多個 shipment」的場景使用。
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
import type { LineItemV3 } from '@/types/extraction-v3.types'

type ConvertFn = (rawItems: unknown[] | undefined) => LineItemV3[]

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
