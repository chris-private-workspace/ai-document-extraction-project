/**
 * @fileoverview CHANGE-103 組件 3（學習迴路）單元測試
 * @description
 *   驗證 Stage1CompanyService.resolveCompanyId 精確匹配命中後的 nameVariants 學習行為：
 *   - 正向：Step 2b 正規化相等命中 → 學習 GPT 原印法
 *   - 去重：原印法已等於既有 name → 不重複學習
 *   - 零誤併安全閘：Step 2a「name contains」不精確子集命中 → 匹配成立但不學習
 *   - 容錯：學習回寫失敗不影響已成立的匹配
 *
 * @module tests/unit/services/stage-1-company-learn-variant.test
 * @since CHANGE-103
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

describe('CHANGE-103 組件 3：Stage 1 學習迴路（nameVariants 回寫）', () => {
  let findFirst: ReturnType<typeof vi.fn>
  let findMany: ReturnType<typeof vi.fn>
  let update: ReturnType<typeof vi.fn>
  let resolve: ResolveFn

  beforeEach(() => {
    findFirst = vi.fn()
    findMany = vi.fn()
    update = vi.fn().mockResolvedValue({})
    const prisma = {
      company: { findFirst, findMany, update, create: vi.fn() },
      user: { findFirst: vi.fn() },
    } as unknown as PrismaClient
    const service = new Stage1CompanyService(prisma)
    resolve = (
      service as unknown as { resolveCompanyId: ResolveFn }
    ).resolveCompanyId.bind(service)
  })

  it('Step 2b 正規化相等命中時，應把 GPT 原印法學進 nameVariants', async () => {
    findFirst.mockResolvedValue(null) // Step 2a 未命中
    findMany.mockResolvedValue([
      { id: 'c1', name: 'CEVA Logistics', nameVariants: [] },
    ]) // Step 2b 來源

    const result = await resolve(makeParsed('CEVA LOGISTICS (HONG KONG) LTD'))

    expect(result.companyId).toBe('c1')
    expect(result.isNewCompany).toBe(false)
    expect(update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { nameVariants: { push: 'CEVA LOGISTICS (HONG KONG) LTD' } },
    })
  })

  it('原印法已等於既有 name 時，不重複學習', async () => {
    findFirst.mockResolvedValue({
      id: 'c1',
      name: 'CEVA LOGISTICS (HONG KONG) LTD',
      nameVariants: [],
    })

    const result = await resolve(makeParsed('CEVA LOGISTICS (HONG KONG) LTD'))

    expect(result.companyId).toBe('c1')
    expect(update).not.toHaveBeenCalled()
  })

  it('Step 2a「name contains」不精確命中但正規化不等時，匹配成立但不學習（零誤併安全閘）', async () => {
    // candidate="CEVA" 靠 name contains 命中，但 normalize("CEVA")="ceva" ≠ "ceva logistics"
    findFirst.mockResolvedValue({
      id: 'c1',
      name: 'CEVA LOGISTICS (HONG KONG) LTD',
      nameVariants: [],
    })

    const result = await resolve(makeParsed('CEVA'))

    expect(result.companyId).toBe('c1') // 匹配仍成立
    expect(update).not.toHaveBeenCalled() // 但不學不精確印法 → 零誤併
  })

  it('學習回寫失敗時，不影響已成立的匹配', async () => {
    findFirst.mockResolvedValue(null)
    findMany.mockResolvedValue([
      { id: 'c1', name: 'CEVA Logistics', nameVariants: [] },
    ])
    update.mockRejectedValue(new Error('db down'))

    const result = await resolve(makeParsed('CEVA LOGISTICS (HONG KONG) LTD'))

    expect(result.companyId).toBe('c1')
    expect(result.isNewCompany).toBe(false)
  })
})
