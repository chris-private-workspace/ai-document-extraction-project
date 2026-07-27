/**
 * @fileoverview FIX-125 單元測試：公司合併的處理知識類關聯轉移
 * @description
 *   驗證 transferCompanyKnowledge 的三項核心行為：
 *   - 正向：無衝突時 6 類關聯的 companyId 都改指向目標公司
 *   - 防呆：唯一鍵衝突時**不轉移**、記入 skipped，不得猜測改值（同 FIX-120/124 原則）
 *   - 連動：FORMAT scope 的配置若其 documentFormat 未能轉移，配置一併跳過，
 *     避免配置轉到新公司卻指向留在舊公司的格式
 *
 * @module tests/unit/services/company-merge-transfer.test
 * @since FIX-125
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { transferCompanyKnowledge } from '@/services/company-merge-transfer.service'

/** 單一 model 的最小 mock（findMany / findFirst / update） */
function makeModelMock() {
  return {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({}),
  }
}

type TxMock = ReturnType<typeof makeTx>

function makeTx() {
  return {
    documentFormat: makeModelMock(),
    fieldDefinitionSet: makeModelMock(),
    templateFieldMapping: makeModelMock(),
    promptConfig: makeModelMock(),
    pipelineConfig: makeModelMock(),
    fieldMappingConfig: makeModelMock(),
  }
}

const SOURCE = 'company-source'
const TARGET = 'company-target'

const FORMAT_A = {
  id: 'fmt-a',
  name: '版面 A',
  documentType: 'INVOICE',
  documentSubtype: 'GENERAL',
}

describe('FIX-125：transferCompanyKnowledge', () => {
  let tx: TxMock

  beforeEach(() => {
    tx = makeTx()
  })

  const run = (sourceIds: string[] = [SOURCE]) =>
    transferCompanyKnowledge(tx as unknown as Prisma.TransactionClient, sourceIds, TARGET)

  it('無衝突時，documentFormat 的 companyId 改指向目標公司', async () => {
    tx.documentFormat.findMany.mockResolvedValue([FORMAT_A])

    const report = await run()

    expect(tx.documentFormat.update).toHaveBeenCalledWith({
      where: { id: 'fmt-a' },
      data: { companyId: TARGET },
    })
    expect(report.transferred.documentFormats).toBe(1)
    expect(report.skipped).toHaveLength(0)
  })

  it('唯一鍵衝突時不轉移，改記入 skipped（不得猜測改 subtype）', async () => {
    tx.documentFormat.findMany.mockResolvedValue([FORMAT_A])
    // 目標公司已有同 (documentType, documentSubtype) 的格式
    tx.documentFormat.findFirst.mockResolvedValue({ id: 'fmt-existing', name: '目標既有版面' })

    const report = await run()

    expect(tx.documentFormat.update).not.toHaveBeenCalled()
    expect(report.transferred.documentFormats).toBe(0)
    expect(report.skipped).toHaveLength(1)
    expect(report.skipped[0]).toMatchObject({
      relation: 'documentFormats',
      recordId: 'fmt-a',
      label: '版面 A',
    })
    // 原因需指出衝突對象，供人工收尾
    expect(report.skipped[0].reason).toContain('目標既有版面')
  })

  it('FORMAT scope 配置在其格式未轉移時一併跳過', async () => {
    tx.documentFormat.findMany.mockResolvedValue([FORMAT_A])
    tx.documentFormat.findFirst.mockResolvedValue({ id: 'fmt-existing', name: '目標既有版面' })
    // 指向那個未能轉移的格式
    tx.fieldDefinitionSet.findMany.mockResolvedValue([
      { id: 'fds-1', name: '費用欄位集', scope: 'FORMAT', documentFormatId: 'fmt-a' },
    ])

    const report = await run()

    expect(tx.fieldDefinitionSet.update).not.toHaveBeenCalled()
    expect(report.transferred.fieldDefinitionSets).toBe(0)
    const fdsSkip = report.skipped.find((s) => s.relation === 'fieldDefinitionSets')
    expect(fdsSkip?.recordId).toBe('fds-1')
    expect(fdsSkip?.reason).toContain('documentFormat')
  })

  it('COMPANY scope 配置（documentFormatId 為 null）不受格式跳過影響', async () => {
    tx.documentFormat.findMany.mockResolvedValue([FORMAT_A])
    tx.documentFormat.findFirst.mockResolvedValue({ id: 'fmt-existing', name: '目標既有版面' })
    tx.fieldDefinitionSet.findMany.mockResolvedValue([
      { id: 'fds-company', name: '公司層欄位集', scope: 'COMPANY', documentFormatId: null },
    ])

    const report = await run()

    expect(tx.fieldDefinitionSet.update).toHaveBeenCalledWith({
      where: { id: 'fds-company' },
      data: { companyId: TARGET },
    })
    expect(report.transferred.fieldDefinitionSets).toBe(1)
  })

  it('六類關聯皆會被處理，且各自帶唯一鍵守門', async () => {
    tx.promptConfig.findMany.mockResolvedValue([
      {
        id: 'pc-1',
        name: 'Stage 3 公司配置',
        promptType: 'STAGE_3_FIELD_EXTRACTION',
        scope: 'COMPANY',
        documentFormatId: null,
      },
    ])
    tx.pipelineConfig.findMany.mockResolvedValue([
      { id: 'pl-1', scope: 'COMPANY', regionId: null, documentFormatId: null },
    ])
    tx.fieldMappingConfig.findMany.mockResolvedValue([
      { id: 'fmc-1', name: '映射配置', scope: 'COMPANY', documentFormatId: null },
    ])
    tx.templateFieldMapping.findMany.mockResolvedValue([
      { id: 'tfm-1', scope: 'COMPANY', dataTemplateId: 'tpl-1', documentFormatId: null },
    ])

    const report = await run()

    expect(report.transferred).toEqual({
      documentFormats: 0,
      fieldDefinitionSets: 0,
      templateFieldMappings: 1,
      promptConfigs: 1,
      pipelineConfigs: 1,
      fieldMappingConfigs: 1,
    })
    // 每一類都查過目標是否已有相同唯一鍵組合
    expect(tx.promptConfig.findFirst).toHaveBeenCalled()
    expect(tx.pipelineConfig.findFirst).toHaveBeenCalled()
    expect(tx.fieldMappingConfig.findFirst).toHaveBeenCalled()
    expect(tx.templateFieldMapping.findFirst).toHaveBeenCalled()
  })

  it('sourceIds 為空時不做任何查詢', async () => {
    const report = await run([])

    expect(tx.documentFormat.findMany).not.toHaveBeenCalled()
    expect(report.transferred).toEqual({})
    expect(report.skipped).toHaveLength(0)
  })
})
