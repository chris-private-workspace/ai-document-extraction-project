/**
 * @fileoverview FIX-120 單元測試：resolveFormatId 空 formatName 的靜默任意匹配
 * @description
 *   驗證 Stage2FormatService.resolveFormatId 的模糊比對守衛：
 *   - 迴歸：formatName 為空字串（GPT 回傳 null）時不得執行 `contains: ''` 模糊比對
 *   - 迴歸：formatName 只有空白時同樣不得比對
 *   - 正向：formatName 有值時模糊比對維持原行為
 *   - 正向：matchedKnownFormat 精確命中優先於模糊比對
 *   - 決定性：兩種比對皆帶 orderBy，避免同名格式回傳順序不定
 *
 * @module tests/unit/services/stage-2-format-resolve-format-id.test
 * @since FIX-120
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { Stage2FormatService } from '@/services/extraction-v3/stages/stage-2-format.service'

// resolveFormatId 的最小 parsed 形狀（GptFormatIdentificationResponse 未 export）
interface ParsedLike {
  formatName: string
  confidence: number
  matchedKnownFormat: string | null
  formatCharacteristics: string[]
}
type ResolveFn = (
  parsed: ParsedLike,
  companyId?: string,
  options?: { autoCreateFormat?: boolean }
) => Promise<{ formatId?: string; formatName: string; isNewFormat: boolean }>

function makeParsed(formatName: string, matchedKnownFormat: string | null = null): ParsedLike {
  return { formatName, confidence: 90, matchedKnownFormat, formatCharacteristics: [] }
}

const COMPANY_ID = 'company-1'

describe('FIX-120：resolveFormatId 空 formatName 不得靜默匹配任意格式', () => {
  let findFirst: ReturnType<typeof vi.fn>
  let create: ReturnType<typeof vi.fn>
  let resolve: ResolveFn

  beforeEach(() => {
    findFirst = vi.fn()
    create = vi.fn()
    const prisma = {
      documentFormat: { findFirst, create },
    } as unknown as PrismaClient
    const service = new Stage2FormatService(prisma)
    resolve = (
      service as unknown as { resolveFormatId: ResolveFn }
    ).resolveFormatId.bind(service)
  })

  it('formatName 為空字串時，不得執行模糊比對（原本 contains: "" 條件恆真）', async () => {
    // GPT 回傳 {"formatName": null} → extractFormatFromParsed 轉成 ''
    const result = await resolve(makeParsed(''), COMPANY_ID, { autoCreateFormat: false })

    // 修復前：findFirst 被以 contains: '' 呼叫 → 回傳該公司任一格式
    expect(findFirst).not.toHaveBeenCalled()
    expect(result.formatId).toBeUndefined()
    expect(result.isNewFormat).toBe(true)
  })

  it('formatName 只有空白時，同樣不得執行模糊比對', async () => {
    const result = await resolve(makeParsed('   '), COMPANY_ID, { autoCreateFormat: false })

    expect(findFirst).not.toHaveBeenCalled()
    expect(result.formatId).toBeUndefined()
    expect(result.isNewFormat).toBe(true)
  })

  it('即使 DB 有格式，空 formatName 仍不得回傳任何 formatId', async () => {
    // 模擬修復前的危險情境：DB 有格式，contains: '' 會全部命中
    findFirst.mockResolvedValue({ id: 'fmt-arbitrary', name: '任意既有格式' })

    const result = await resolve(makeParsed(''), COMPANY_ID, { autoCreateFormat: false })

    expect(result.formatId).toBeUndefined()
    expect(result.isNewFormat).toBe(true)
  })

  it('formatName 有值時，模糊比對維持原行為', async () => {
    // matchedKnownFormat 為 null → 步驟 1 直接跳過，findFirst 只會被模糊比對呼叫一次
    findFirst.mockResolvedValue({ id: 'fmt-1', name: 'CEVA 表格式 Invoice' })

    const result = await resolve(makeParsed('表格式'), COMPANY_ID, { autoCreateFormat: false })

    expect(result.formatId).toBe('fmt-1')
    expect(result.isNewFormat).toBe(false)
    expect(findFirst).toHaveBeenCalledTimes(1)
    // 以 trim 後的字串比對，且帶決定性排序
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          name: { contains: '表格式', mode: 'insensitive' },
          companyId: COMPANY_ID,
        }),
        orderBy: { createdAt: 'asc' },
      })
    )
  })

  it('matchedKnownFormat 精確命中時優先回傳，且帶決定性排序', async () => {
    findFirst.mockResolvedValueOnce({ id: 'fmt-exact', name: 'CEVA 表格式 Invoice' })

    const result = await resolve(
      makeParsed('CEVA 表格式 Invoice', 'CEVA 表格式 Invoice'),
      COMPANY_ID,
      { autoCreateFormat: false }
    )

    expect(result.formatId).toBe('fmt-exact')
    expect(result.isNewFormat).toBe(false)
    expect(findFirst).toHaveBeenCalledTimes(1)
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: 'CEVA 表格式 Invoice', companyId: COMPANY_ID },
        orderBy: { createdAt: 'asc' },
      })
    )
  })

  it('無 companyId 時不查詢，直接視為新格式', async () => {
    const result = await resolve(makeParsed('某新版面'), undefined, { autoCreateFormat: false })

    expect(findFirst).not.toHaveBeenCalled()
    expect(result.formatId).toBeUndefined()
    expect(result.isNewFormat).toBe(true)
  })
})
