/**
 * @fileoverview CHANGE-103 Phase 2（組件 2 token-set + 組件 4 灰帶 PENDING）單元測試
 * @description
 *   驗證 Stage1CompanyService.resolveCompanyId Step 3（JIT 前重複防護）的分層行為：
 *   - GRAY：core 為子集關係（多出專有 token）→ 建 PENDING + 填 suspectedDuplicateOfId + 不動既有
 *   - AUTO：core 集合相等（額外 generic 詞差異被吸收）→ 配到既有、不建新公司
 *   - DHL 迴歸（FIX-077）：四寫法仍配到同一既有公司（Step 2b 正規化相等 / token-set AUTO），零回歸
 *
 * @module tests/unit/services/stage-1-company-tokenset-gray.test
 * @since CHANGE-103 Phase 2
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { Stage1CompanyService } from '@/services/extraction-v3/stages/stage-1-company.service'

// resolveCompanyId 的最小 parsed 形狀（GptCompanyIdentificationResponse 未 export）
interface ParsedLike {
  companyName: string
  identificationMethod: 'HEADER'
  confidence: number
  matchedKnownCompany: string | null
}
type ResolveFn = (
  parsed: ParsedLike,
  options?: { autoCreateCompany?: boolean; cityCode?: string }
) => Promise<{ companyId?: string; companyName: string; isNewCompany: boolean }>

function makeParsed(
  companyName: string,
  matchedKnownCompany: string | null = null
): ParsedLike {
  return { companyName, identificationMethod: 'HEADER', confidence: 90, matchedKnownCompany }
}

describe('CHANGE-103 Phase 2：Stage 1 token-set 分層配對 + 灰帶 PENDING', () => {
  let findFirst: ReturnType<typeof vi.fn>
  let findMany: ReturnType<typeof vi.fn>
  let update: ReturnType<typeof vi.fn>
  let create: ReturnType<typeof vi.fn>
  let userFindFirst: ReturnType<typeof vi.fn>
  let resolve: ResolveFn

  beforeEach(() => {
    findFirst = vi.fn()
    findMany = vi.fn()
    update = vi.fn().mockResolvedValue({})
    create = vi.fn()
    userFindFirst = vi.fn().mockResolvedValue({ id: 'sys-user' })
    const prisma = {
      company: { findFirst, findMany, update, create },
      user: { findFirst: userFindFirst },
    } as unknown as PrismaClient
    const service = new Stage1CompanyService(prisma)
    resolve = (
      service as unknown as { resolveCompanyId: ResolveFn }
    ).resolveCompanyId.bind(service)
  })

  it('灰帶 candidate（多出專有 token）→ 建 PENDING + 填 suspectedDuplicateOfId + 不動既有', async () => {
    // norm("CEVA Logistics (RICHASIA) PACIFIC OPERATIONS LIMITED") = "ceva logistics pacific"
    // 既有 "CEVA Logistics" = "ceva logistics" → core {ceva,logistics} ⊂ {ceva,logistics,pacific} → GRAY
    findFirst.mockResolvedValue(null) // Step 2a 未命中
    findMany.mockResolvedValue([
      { id: 'ceva-master', name: 'CEVA Logistics', nameVariants: [] },
    ]) // Step 2b（正規化不等，未命中）+ findDuplicateCompany 來源
    create.mockResolvedValue({
      id: 'pending-1',
      name: 'CEVA Logistics (RICHASIA) PACIFIC OPERATIONS LIMITED',
    })

    const result = await resolve(
      makeParsed('CEVA Logistics (RICHASIA) PACIFIC OPERATIONS LIMITED'),
      { autoCreateCompany: true }
    )

    // 建立 PENDING 新公司，文件綁該 companyId
    expect(result.isNewCompany).toBe(true)
    expect(result.companyId).toBe('pending-1')
    // create 以 PENDING + 疑似重複標記寫入
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PENDING',
          suspectedDuplicateOfId: 'ceva-master',
        }),
      })
    )
    // 不動既有（無 nameVariants 學習回寫）
    expect(update).not.toHaveBeenCalled()
  })

  it('CHANGE-105：「… Office」（office 為區分詞）→ GRAY → 建 PENDING（不再 AUTO 併入）', async () => {
    // norm("CEVA Logistics Hong Kong Office") = "ceva logistics hong kong office"（Step 2b 正規化不等）
    // CHANGE-105 後 office 不再為 generic → core {ceva,logistics,office} ⊃ 既有 {ceva,logistics} → GRAY
    findFirst.mockResolvedValue(null) // Step 2a 未命中
    findMany.mockResolvedValue([
      { id: 'ceva-master', name: 'CEVA Logistics', nameVariants: [] },
    ])
    create.mockResolvedValue({
      id: 'pending-office',
      name: 'CEVA Logistics Hong Kong Office',
    })

    const result = await resolve(makeParsed('CEVA Logistics Hong Kong Office'), {
      autoCreateCompany: true,
    })

    // 灰帶 → 建 PENDING 新公司（不再自動併入既有）
    expect(result.isNewCompany).toBe(true)
    expect(result.companyId).toBe('pending-office')
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PENDING',
          suspectedDuplicateOfId: 'ceva-master',
        }),
      })
    )
    // 不動既有
    expect(update).not.toHaveBeenCalled()
  })

  it('DHL 迴歸（FIX-077 經典四寫法之一）：正規化相等 → Step 2b 配到既有，零回歸', async () => {
    // norm("DHL EXPRESS (HK) LIMITED") = "dhl express" == 既有 "DHL Express" → Step 2b 命中
    findFirst.mockResolvedValue(null) // Step 2a 未命中
    findMany.mockResolvedValue([
      { id: 'dhl-master', name: 'DHL Express', nameVariants: [] },
    ])

    const result = await resolve(makeParsed('DHL EXPRESS (HK) LIMITED'), {
      autoCreateCompany: true,
    })

    expect(result.isNewCompany).toBe(false)
    expect(result.companyId).toBe('dhl-master')
    // 配到既有 → 不建新公司
    expect(create).not.toHaveBeenCalled()
  })

  it('DHL 迴歸（token-set AUTO 路徑）：正規化不等但 core 相等 → findDuplicateCompany 配到既有', async () => {
    // norm("DHL Express Hong Kong") = "dhl express hong kong"（Step 2b 正規化不等、Levenshtein 亦低）
    // core {dhl,express}（hong/kong 仍為 generic 純地區詞）== 既有 core {dhl,express} → token-set AUTO
    // （CHANGE-105 只把 office/branch 改為區分詞，純地區詞照常吸收，此路徑零回歸）
    findFirst.mockResolvedValue(null) // Step 2a 未命中
    findMany.mockResolvedValue([
      { id: 'dhl-master', name: 'DHL Express', nameVariants: [] },
    ])

    const result = await resolve(makeParsed('DHL Express Hong Kong'), {
      autoCreateCompany: true,
    })

    expect(result.isNewCompany).toBe(false)
    expect(result.companyId).toBe('dhl-master')
    expect(create).not.toHaveBeenCalled()
  })

  it('全無 containment（不同公司）→ JIT 建 ACTIVE（非 PENDING、無 marker）', async () => {
    findFirst.mockResolvedValue(null) // Step 2a 未命中
    findMany.mockResolvedValue([
      { id: 'ceva-master', name: 'CEVA Logistics', nameVariants: [] },
    ])
    create.mockResolvedValue({ id: 'new-active', name: 'Kuehne Nagel' })

    const result = await resolve(makeParsed('Kuehne Nagel'), {
      autoCreateCompany: true,
    })

    expect(result.isNewCompany).toBe(true)
    expect(result.companyId).toBe('new-active')
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'ACTIVE' }),
      })
    )
    // ACTIVE 建立不掛 suspectedDuplicateOfId
    const createArg = create.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(createArg.data).not.toHaveProperty('suspectedDuplicateOfId')
  })
})
