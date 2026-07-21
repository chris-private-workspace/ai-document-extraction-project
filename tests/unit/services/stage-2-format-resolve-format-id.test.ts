/**
 * @fileoverview FIX-120 / FIX-123 單元測試：resolveFormatId 的名稱比對行為
 * @description
 *   FIX-120（靜默任意匹配防呆）：
 *   - 迴歸：formatName 為空字串（GPT 回傳 null）時不得執行 `contains: ''` 模糊比對
 *   - 迴歸：formatName 只有空白時同樣不得比對
 *   - 正向：formatName 有值時模糊比對維持原行為
 *   - 正向：matchedKnownFormat 精確命中優先於模糊比對
 *   - 決定性：兩種比對皆帶 orderBy，避免同名格式回傳順序不定
 *
 *   FIX-123（名稱比對容錯）：
 *   - 正向：matchedKnownFormat 夾帶 keywords 後綴時，剝除後綴後仍能命中
 *   - 正向：GPT 字串包含 DB 名稱（前綴語形態）時，以反向包含命中
 *   - 防呆：兩段新比對的候選命中多筆時一律不匹配，不可靜默取任一筆
 *
 * @module tests/unit/services/stage-2-format-resolve-format-id.test
 * @since FIX-120
 * @lastModified 2026-07-21
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
  let findMany: ReturnType<typeof vi.fn>
  let create: ReturnType<typeof vi.fn>
  let resolve: ResolveFn

  beforeEach(() => {
    findFirst = vi.fn()
    // FIX-123 新增的兩段比對走 findMany；預設回空陣列以維持原有斷言
    findMany = vi.fn().mockResolvedValue([])
    create = vi.fn()
    const prisma = {
      documentFormat: { findFirst, findMany, create },
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

describe('FIX-123：resolveFormatId 名稱比對容錯（後綴剝離 + 反向包含）', () => {
  let findFirst: ReturnType<typeof vi.fn>
  let findMany: ReturnType<typeof vi.fn>
  let resolve: ResolveFn

  beforeEach(() => {
    // 完全相等（步驟 1）與既有模糊比對（步驟 4）一律落空，以隔離新增的步驟 2、3
    findFirst = vi.fn().mockResolvedValue(null)
    findMany = vi.fn().mockResolvedValue([])
    const prisma = {
      documentFormat: { findFirst, findMany, create: vi.fn() },
    } as unknown as PrismaClient
    const service = new Stage2FormatService(prisma)
    resolve = (
      service as unknown as { resolveFormatId: ResolveFn }
    ).resolveFormatId.bind(service)
  })

  it('matchedKnownFormat 夾帶 keywords 後綴時，剝除後綴後仍能命中（BUG-1）', async () => {
    const dbName = 'Nippon Express（NEX）Original Invoice 標準貨運發票模板'
    // GPT 把 `- 名稱: 關鍵字1, 關鍵字2, …` 整行逐字複製了下來
    const gptValue = `${dbName}: 左上角有公司 Logo 與英文信頭, 中央偏上以粗體標題顯示 ORIGINAL INVOICE`
    findMany.mockResolvedValue([{ id: 'fmt-nex', name: dbName }])

    const result = await resolve(makeParsed(gptValue, gptValue), COMPANY_ID, {
      autoCreateFormat: false,
    })

    expect(result.formatId).toBe('fmt-nex')
    expect(result.isNewFormat).toBe(false)
    expect(result.formatName).toBe(dbName)
    // 以剝除後綴的名稱做完全相等，並以 take: 2 偵測是否命中多筆
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: dbName, companyId: COMPANY_ID },
        orderBy: { createdAt: 'asc' },
        take: 2,
      })
    )
  })

  it('GPT 字串帶說明前綴時，以反向包含命中（BUG-2）', async () => {
    const dbName = 'Nippon Express（NEX）Original Invoice 標準貨運發票模板'
    // 實測形態：DB 名稱完整出現在 formatName 裡，matchedKnownFormat 卻是空的
    const gptValue = `Nippon Express Logistics 貨運發票（Original Invoice）已知模板：${dbName}`
    findMany.mockResolvedValue([{ id: 'fmt-nex', name: dbName }])

    const result = await resolve(makeParsed(gptValue), COMPANY_ID, { autoCreateFormat: false })

    expect(result.formatId).toBe('fmt-nex')
    expect(result.isNewFormat).toBe(false)
    // 反向包含需撈出該公司全部格式後於應用層比對
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: COMPANY_ID } })
    )
  })

  it('剝除後綴後命中多筆時不匹配，往下走（維持 FIX-120 防呆）', async () => {
    const dbName = '同名格式'
    findMany.mockResolvedValue([
      { id: 'fmt-a', name: dbName },
      { id: 'fmt-b', name: dbName },
    ])

    const result = await resolve(
      makeParsed(`${dbName}: 關鍵字`, `${dbName}: 關鍵字`),
      COMPANY_ID,
      { autoCreateFormat: false }
    )

    expect(result.formatId).toBeUndefined()
    expect(result.isNewFormat).toBe(true)
  })

  it('反向包含命中多筆時不匹配，往下走', async () => {
    findMany.mockResolvedValue([
      { id: 'fmt-a', name: 'Invoice' },
      { id: 'fmt-b', name: '發票' },
    ])

    const result = await resolve(makeParsed('Invoice 與發票混合版面'), COMPANY_ID, {
      autoCreateFormat: false,
    })

    expect(result.formatId).toBeUndefined()
    expect(result.isNewFormat).toBe(true)
  })

  it('無 companyId 時，兩段新比對皆不查詢', async () => {
    const result = await resolve(makeParsed('某版面: 關鍵字', '某版面: 關鍵字'), undefined, {
      autoCreateFormat: false,
    })

    expect(findMany).not.toHaveBeenCalled()
    expect(result.formatId).toBeUndefined()
    expect(result.isNewFormat).toBe(true)
  })
})

describe('FIX-124：jitCreateFormat 撞唯一鍵時不得沿用任意既有格式', () => {
  let findFirst: ReturnType<typeof vi.fn>
  let findMany: ReturnType<typeof vi.fn>
  let create: ReturnType<typeof vi.fn>
  let resolve: ResolveFn

  beforeEach(() => {
    findFirst = vi.fn().mockResolvedValue(null)
    findMany = vi.fn().mockResolvedValue([])
    create = vi.fn()
    const prisma = {
      documentFormat: { findFirst, findMany, create },
    } as unknown as PrismaClient
    const service = new Stage2FormatService(prisma)
    resolve = (
      service as unknown as { resolveFormatId: ResolveFn }
    ).resolveFormatId.bind(service)
  })

  it('公司已有 INVOICE/GENERAL 格式時，不得沿用該格式的 id', async () => {
    // GPT 明說「非已知格式」→ 前四段比對全部落空，落入 JIT 分支
    const gptName = 'CEVA Logistics 清關型 Invoice（非已知格式）'
    findMany.mockResolvedValue([{ id: 'fmt-layout-a', name: '版面 A' }])
    // 只有 jitCreateFormat 的唯一鍵查詢（帶 documentType）才回傳既有格式
    findFirst.mockImplementation(async (args: { where?: { documentType?: string } }) =>
      args?.where?.documentType ? { id: 'fmt-layout-a', name: '版面 A' } : null
    )

    const result = await resolve(makeParsed(gptName), COMPANY_ID)

    // 修復前：formatId 會是 'fmt-layout-a'（與文件版面無關的既有格式）
    expect(result.formatId).toBeUndefined()
    expect(result.isNewFormat).toBe(true)
    // 名稱維持 GPT 給的新名稱，而非既有格式的名稱
    expect(result.formatName).toBe(gptName)
    // 撞唯一鍵時不得嘗試 create（否則回歸 FIX-058 的唯一約束崩潰）
    expect(create).not.toHaveBeenCalled()
  })

  it('公司尚無任何格式時，JIT 仍正常建立新格式', async () => {
    create.mockResolvedValue({ id: 'fmt-new', name: '全新版面' })

    const result = await resolve(makeParsed('全新版面'), COMPANY_ID)

    expect(create).toHaveBeenCalledTimes(1)
    expect(result.formatId).toBe('fmt-new')
    expect(result.isNewFormat).toBe(true)
  })
})
