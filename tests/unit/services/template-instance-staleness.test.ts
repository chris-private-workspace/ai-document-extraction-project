/**
 * @fileoverview CHANGE-106 模版實例行過期標記單元測試
 * @description
 *   驗證 getRows 對每行計算 staleSources：來源文件的 processingEndedAt 晚於
 *   行的 updatedAt 才視為過期；processingEndedAt 為 null（從未重新處理完成）
 *   或早於行更新時間則不標記，避免假陽性噪音（CHANGE-106 驗收標準）。
 *
 *   Fixture 取自 Azure DEV 實測：CEVA_RCIM250325_17865.PDF 於 2026-07-21
 *   重新處理，instance row 停留在 2026-07-14 的快照。
 *
 * @module tests/unit/services/template-instance-staleness.test
 * @since CHANGE-106
 * @lastModified 2026-07-22
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
  },
}))

import { prisma } from '@/lib/prisma'
import { templateInstanceService } from '@/services/template-instance.service'

const ROW_UPDATED_AT = new Date('2026-07-14T07:36:00Z')

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    templateInstanceId: 'inst-1',
    rowKey: 'RCIM250325',
    rowIndex: 0,
    sourceDocumentIds: ['doc-1'],
    fieldValues: { thc: 2885 },
    validationErrors: null,
    transformDiagnostics: null,
    status: 'VALID',
    createdAt: new Date('2026-07-14T07:36:00Z'),
    updatedAt: ROW_UPDATED_AT,
    ...overrides,
  }
}

describe('CHANGE-106: getRows 來源過期標記', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.templateInstanceRow.count).mockResolvedValue(1)
  })

  it('來源文件在行產生後完成重新處理 → staleSources 含該文件與處理時間', async () => {
    vi.mocked(prisma.templateInstanceRow.findMany).mockResolvedValue([makeRow()] as never)
    vi.mocked(prisma.document.findMany).mockResolvedValue([
      {
        id: 'doc-1',
        fileName: 'CEVA_RCIM250325_17865.PDF',
        processingEndedAt: new Date('2026-07-21T10:00:00Z'),
      },
    ] as never)

    const { rows } = await templateInstanceService.getRows('inst-1')

    expect(rows[0].staleSources).toEqual([
      {
        id: 'doc-1',
        fileName: 'CEVA_RCIM250325_17865.PDF',
        processedAt: '2026-07-21T10:00:00.000Z',
      },
    ])
  })

  it('來源文件處理時間早於行更新時間 → 不標記（避免噪音）', async () => {
    vi.mocked(prisma.templateInstanceRow.findMany).mockResolvedValue([makeRow()] as never)
    vi.mocked(prisma.document.findMany).mockResolvedValue([
      {
        id: 'doc-1',
        fileName: 'CEVA_RCIM250325_17865.PDF',
        processingEndedAt: new Date('2026-07-10T00:00:00Z'),
      },
    ] as never)

    const { rows } = await templateInstanceService.getRows('inst-1')

    expect(rows[0].staleSources).toEqual([])
  })

  it('processingEndedAt 為 null → 不標記（不以 updatedAt 判斷，避免假陽性）', async () => {
    vi.mocked(prisma.templateInstanceRow.findMany).mockResolvedValue([makeRow()] as never)
    vi.mocked(prisma.document.findMany).mockResolvedValue([
      { id: 'doc-1', fileName: 'a.pdf', processingEndedAt: null },
    ] as never)

    const { rows } = await templateInstanceService.getRows('inst-1')

    expect(rows[0].staleSources).toEqual([])
  })

  it('多來源文件僅列出真正更新過的那幾份', async () => {
    vi.mocked(prisma.templateInstanceRow.findMany).mockResolvedValue([
      makeRow({ sourceDocumentIds: ['doc-1', 'doc-2'] }),
    ] as never)
    vi.mocked(prisma.document.findMany).mockResolvedValue([
      { id: 'doc-1', fileName: 'old.pdf', processingEndedAt: new Date('2026-07-01T00:00:00Z') },
      { id: 'doc-2', fileName: 'new.pdf', processingEndedAt: new Date('2026-07-21T00:00:00Z') },
    ] as never)

    const { rows } = await templateInstanceService.getRows('inst-1')

    expect(rows[0].staleSources).toHaveLength(1)
    expect(rows[0].staleSources?.[0].fileName).toBe('new.pdf')
  })

  it('無來源文件的行 → staleSources 為空且不查詢 documents', async () => {
    vi.mocked(prisma.templateInstanceRow.findMany).mockResolvedValue([
      makeRow({ sourceDocumentIds: [] }),
    ] as never)

    const { rows } = await templateInstanceService.getRows('inst-1')

    expect(rows[0].staleSources).toEqual([])
    expect(prisma.document.findMany).not.toHaveBeenCalled()
  })
})
