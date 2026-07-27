/**
 * @fileoverview CHANGE-109 同一發票更新版本偵測單元測試
 * @description
 *   驗證 getRows 對每行計算 newerVersions：與本行來源為同一張發票
 *   （同 companyId + 同 invoiceNumber）但處理時間較晚的**其他** document 記錄。
 *
 *   這補上 CHANGE-106 涵蓋不到的情境 —— 重新上傳會產生**新的** document 記錄，
 *   舊 row 的來源文件本身沒變，故 processingEndedAt 比對不會亮。
 *
 *   Fixture 取自 Azure DEV 實測：CEVA_RCIM250325_17865.PDF 有 15 筆獨立 document
 *   記錄、invoice_number 皆為 F260017865；7/14 的實例指向 714ac520（7/14 07:28 處理完成），
 *   而 7c3e3981（7/21）與 d534a63f（7/23）是更晚的另外兩筆。
 *
 * @module tests/unit/services/template-instance-newer-version.test
 * @since CHANGE-109
 * @lastModified 2026-07-27
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    templateInstanceRow: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    document: {
      findMany: vi.fn(),
    },
    extractionResult: {
      findMany: vi.fn(),
    },
  },
}))

import { prisma } from '@/lib/prisma'
import { templateInstanceService } from '@/services/template-instance.service'

const ROW_UPDATED_AT = new Date('2026-07-14T07:36:04Z')
const COMPANY = 'company-ceva'
const INVOICE = 'F260017865'

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    templateInstanceId: 'inst-1',
    rowKey: 'RCIM250325',
    rowIndex: 0,
    sourceDocumentIds: ['doc-714ac520'],
    fieldValues: { thc: 2885 },
    validationErrors: null,
    transformDiagnostics: null,
    status: 'VALID',
    createdAt: ROW_UPDATED_AT,
    updatedAt: ROW_UPDATED_AT,
    ...overrides,
  }
}

/** 本行的來源文件：7/14 處理完成（早於 row.updatedAt → 本身不算 stale） */
function sourceDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-714ac520',
    fileName: 'CEVA_RCIM250325_17865.PDF',
    processingEndedAt: new Date('2026-07-14T07:28:30Z'),
    extractionResult: { companyId: COMPANY, invoiceNumber: INVOICE },
    ...overrides,
  }
}

/** 同一發票的候選更新版本 */
function candidate(overrides: Record<string, unknown> = {}) {
  return {
    documentId: 'doc-7c3e3981',
    companyId: COMPANY,
    invoiceNumber: INVOICE,
    document: {
      fileName: 'CEVA_RCIM250325_17865.PDF',
      processingEndedAt: new Date('2026-07-21T10:19:19Z'),
    },
    ...overrides,
  }
}

describe('CHANGE-109: getRows 同一發票更新版本偵測', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.templateInstanceRow.count).mockResolvedValue(1)
    vi.mocked(prisma.extractionResult.findMany).mockResolvedValue([] as never)
  })

  it('同公司同發票號且處理時間較晚 → newerVersions 含該文件', async () => {
    vi.mocked(prisma.templateInstanceRow.findMany).mockResolvedValue([makeRow()] as never)
    vi.mocked(prisma.document.findMany).mockResolvedValue([sourceDoc()] as never)
    vi.mocked(prisma.extractionResult.findMany).mockResolvedValue([candidate()] as never)

    const { rows } = await templateInstanceService.getRows('inst-1')

    expect(rows[0].newerVersions).toEqual([
      {
        id: 'doc-7c3e3981',
        fileName: 'CEVA_RCIM250325_17865.PDF',
        processedAt: '2026-07-21T10:19:19.000Z',
        invoiceNumber: INVOICE,
        supersedesDocumentId: 'doc-714ac520',
      },
    ])
    // 本行的來源文件自己沒被重新處理 → CHANGE-106 的訊號不應誤亮
    expect(rows[0].staleSources).toEqual([])
  })

  it('候選處理時間早於本行更新時間 → 不標記', async () => {
    vi.mocked(prisma.templateInstanceRow.findMany).mockResolvedValue([makeRow()] as never)
    vi.mocked(prisma.document.findMany).mockResolvedValue([sourceDoc()] as never)
    vi.mocked(prisma.extractionResult.findMany).mockResolvedValue([
      candidate({
        documentId: 'doc-older',
        document: {
          fileName: 'older.pdf',
          processingEndedAt: new Date('2026-07-08T00:00:00Z'),
        },
      }),
    ] as never)

    const { rows } = await templateInstanceService.getRows('inst-1')

    expect(rows[0].newerVersions).toEqual([])
  })

  it('發票號相同但公司不同 → 不標記（嚴格判定，不做 merged_into_id 歸一）', async () => {
    vi.mocked(prisma.templateInstanceRow.findMany).mockResolvedValue([makeRow()] as never)
    vi.mocked(prisma.document.findMany).mockResolvedValue([sourceDoc()] as never)
    vi.mocked(prisma.extractionResult.findMany).mockResolvedValue([
      candidate({ documentId: 'doc-other-company', companyId: 'company-other' }),
    ] as never)

    const { rows } = await templateInstanceService.getRows('inst-1')

    expect(rows[0].newerVersions).toEqual([])
  })

  it('來源文件無 invoiceNumber → 不查候選、不標記', async () => {
    vi.mocked(prisma.templateInstanceRow.findMany).mockResolvedValue([makeRow()] as never)
    vi.mocked(prisma.document.findMany).mockResolvedValue([
      sourceDoc({ extractionResult: { companyId: COMPANY, invoiceNumber: null } }),
    ] as never)

    const { rows } = await templateInstanceService.getRows('inst-1')

    expect(rows[0].newerVersions).toEqual([])
    expect(prisma.extractionResult.findMany).not.toHaveBeenCalled()
  })

  it('來源文件無提取結果（extractionResult 為 null）→ 不查候選、不標記', async () => {
    vi.mocked(prisma.templateInstanceRow.findMany).mockResolvedValue([makeRow()] as never)
    vi.mocked(prisma.document.findMany).mockResolvedValue([
      sourceDoc({ extractionResult: null }),
    ] as never)

    const { rows } = await templateInstanceService.getRows('inst-1')

    expect(rows[0].newerVersions).toEqual([])
    expect(prisma.extractionResult.findMany).not.toHaveBeenCalled()
  })

  it('本行兩份來源同屬一張發票 → 同一候選只列一次（去重）', async () => {
    vi.mocked(prisma.templateInstanceRow.findMany).mockResolvedValue([
      makeRow({ sourceDocumentIds: ['doc-714ac520', 'doc-dacbe2d7'] }),
    ] as never)
    vi.mocked(prisma.document.findMany).mockResolvedValue([
      sourceDoc(),
      sourceDoc({ id: 'doc-dacbe2d7', fileName: 'CEVA_RCIM250325_17865.PDF' }),
    ] as never)
    vi.mocked(prisma.extractionResult.findMany).mockResolvedValue([candidate()] as never)

    const { rows } = await templateInstanceService.getRows('inst-1')

    expect(rows[0].newerVersions).toHaveLength(1)
    expect(rows[0].newerVersions?.[0].id).toBe('doc-7c3e3981')
  })

  it('多個候選依處理時間新到舊排序', async () => {
    vi.mocked(prisma.templateInstanceRow.findMany).mockResolvedValue([makeRow()] as never)
    vi.mocked(prisma.document.findMany).mockResolvedValue([sourceDoc()] as never)
    vi.mocked(prisma.extractionResult.findMany).mockResolvedValue([
      candidate(),
      candidate({
        documentId: 'doc-d534a63f',
        document: {
          fileName: 'CEVA_RCIM250325_17865 (newest).PDF',
          processingEndedAt: new Date('2026-07-23T04:23:03Z'),
        },
      }),
    ] as never)

    const { rows } = await templateInstanceService.getRows('inst-1')

    expect(rows[0].newerVersions?.map((v) => v.id)).toEqual(['doc-d534a63f', 'doc-7c3e3981'])
  })

  it('兩種訊號可並存：來源被重新處理 + 同發票另有更新文件', async () => {
    vi.mocked(prisma.templateInstanceRow.findMany).mockResolvedValue([makeRow()] as never)
    // 來源文件自己也在本行產生後被重新處理 → staleSources 應亮
    vi.mocked(prisma.document.findMany).mockResolvedValue([
      sourceDoc({ processingEndedAt: new Date('2026-07-20T00:00:00Z') }),
    ] as never)
    vi.mocked(prisma.extractionResult.findMany).mockResolvedValue([candidate()] as never)

    const { rows } = await templateInstanceService.getRows('inst-1')

    expect(rows[0].staleSources).toHaveLength(1)
    expect(rows[0].newerVersions).toHaveLength(1)
  })

  it('候選查詢排除本行自己的來源文件（避免自我推薦）', async () => {
    vi.mocked(prisma.templateInstanceRow.findMany).mockResolvedValue([makeRow()] as never)
    vi.mocked(prisma.document.findMany).mockResolvedValue([sourceDoc()] as never)

    await templateInstanceService.getRows('inst-1')

    expect(prisma.extractionResult.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ companyId: COMPANY, invoiceNumber: INVOICE }],
          documentId: { notIn: ['doc-714ac520'] },
        }),
      })
    )
  })

  it('無來源文件的行 → 不查 documents 也不查候選', async () => {
    vi.mocked(prisma.templateInstanceRow.findMany).mockResolvedValue([
      makeRow({ sourceDocumentIds: [] }),
    ] as never)

    const { rows } = await templateInstanceService.getRows('inst-1')

    expect(rows[0].newerVersions).toEqual([])
    expect(prisma.document.findMany).not.toHaveBeenCalled()
    expect(prisma.extractionResult.findMany).not.toHaveBeenCalled()
  })
})
