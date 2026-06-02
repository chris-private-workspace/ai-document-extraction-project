/**
 * @fileoverview FIX-059 單元測試：月度成本報表成本來源修正
 * @description
 *   驗證 monthly-cost-report.service 的成本聚合邏輯：
 *   - getCityStats：volume 來自 documents、AI 成本來自 api_usage_logs（無記錄時為 0）
 *   - getDailyTrend：每日成本來自 api_usage_logs.estimated_cost，依日期正確合併
 *   修正前兩段 $queryRaw 誤讀不存在的 documents.ai_cost 欄位，執行期會拋
 *   `column "ai_cost" does not exist`。
 *
 * @module tests/unit/services/monthly-cost-report.test
 * @since FIX-059
 *
 * @remarks
 *   專案目前未安裝測試 runner（package.json 無 test script、無 vitest binary）。
 *   本檔依循 .claude/rules/testing.md 的 vitest 慣例撰寫，待 runner 落地後即可執行。
 *   當前以 scripts/verify-fix-059-monthly-cost-sql.ts（ts-node 可執行）做 SQL 層煙霧測試。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock Prisma：僅需 getCityStats / getDailyTrend 用到的方法
vi.mock('@/lib/prisma', () => ({
  prisma: {
    document: { groupBy: vi.fn() },
    apiUsageLog: { groupBy: vi.fn() },
    $queryRaw: vi.fn(),
  },
}))

// Mock Azure Blob（service 模組頂層 import，但本測試不觸發報表檔案生成）
vi.mock('@/lib/azure-blob', () => ({
  uploadBufferToBlob: vi.fn(),
  generateSignedUrl: vi.fn(),
}))

import { prisma } from '@/lib/prisma'
import { MonthlyCostReportService } from '@/services/monthly-cost-report.service'

interface CityStats {
  cityCode: string
  volume: number
  aiCost: number
  laborCost: number
  totalCost: number
}

interface DailyTrendItem {
  date: string
  volume: number
  cost: number
}

describe('FIX-059: MonthlyCostReportService 成本來源修正', () => {
  let service: MonthlyCostReportService
  const startDate = new Date('2026-05-01T00:00:00.000Z')
  const endDate = new Date('2026-05-31T23:59:59.999Z')

  beforeEach(() => {
    service = MonthlyCostReportService.getInstance()
    vi.clearAllMocks()
  })

  describe('getCityStats', () => {
    it('應從 api_usage_logs 聚合 AI 成本，並與 documents 的 volume 依城市合併', async () => {
      // Arrange：HKG 有成本，SIN 無對應成本記錄
      vi.mocked(prisma.document.groupBy).mockResolvedValue([
        { cityCode: 'HKG', _count: 10 },
        { cityCode: 'SIN', _count: 4 },
      ] as never)
      vi.mocked(prisma.apiUsageLog.groupBy).mockResolvedValue([
        { cityCode: 'HKG', _sum: { estimatedCost: 2.5 } },
      ] as never)

      // Act
      const result: CityStats[] = await (
        service as unknown as {
          getCityStats: (s: Date, e: Date) => Promise<CityStats[]>
        }
      ).getCityStats(startDate, endDate)

      // Assert
      const hkg = result.find((r) => r.cityCode === 'HKG')!
      const sin = result.find((r) => r.cityCode === 'SIN')!

      expect(hkg.volume).toBe(10)
      expect(hkg.aiCost).toBe(2.5)
      // 無對應成本記錄的城市成本應為 0（而非沿用上一城市或報錯）
      expect(sin.volume).toBe(4)
      expect(sin.aiCost).toBe(0)

      // totalCost 內部一致性：aiCost + laborCost
      expect(hkg.totalCost).toBeCloseTo(hkg.aiCost + hkg.laborCost, 10)
      expect(sin.totalCost).toBeCloseTo(sin.aiCost + sin.laborCost, 10)

      // 不得再查詢 documents 的成本欄位（成本來源必為 apiUsageLog）
      expect(prisma.apiUsageLog.groupBy).toHaveBeenCalledTimes(1)
      expect(prisma.document.groupBy).toHaveBeenCalledTimes(1)
    })

    it('Decimal 成本以 Number 正規化，且 _sum 為 null 時視為 0', async () => {
      vi.mocked(prisma.document.groupBy).mockResolvedValue([
        { cityCode: 'TPE', _count: 7 },
      ] as never)
      vi.mocked(prisma.apiUsageLog.groupBy).mockResolvedValue([
        { cityCode: 'TPE', _sum: { estimatedCost: null } },
      ] as never)

      const result: CityStats[] = await (
        service as unknown as {
          getCityStats: (s: Date, e: Date) => Promise<CityStats[]>
        }
      ).getCityStats(startDate, endDate)

      expect(result[0].aiCost).toBe(0)
    })
  })

  describe('getDailyTrend', () => {
    it('每日成本來自 api_usage_logs，依日期與 documents 的 volume 合併、無成本日為 0 且排序', async () => {
      // Arrange：$queryRaw 第一次回 volume（documents），第二次回 cost（api_usage_logs）
      const day1 = new Date('2026-05-02T00:00:00.000Z')
      const day2 = new Date('2026-05-01T00:00:00.000Z')
      vi.mocked(prisma.$queryRaw)
        .mockResolvedValueOnce([
          // $queryRaw 對 COUNT(*)::bigint 回傳 JS BigInt（避免 bigint 字面值以相容 tsconfig target）
          { date: day1, volume: BigInt(5) },
          { date: day2, volume: BigInt(3) },
        ] as never)
        .mockResolvedValueOnce([{ date: day2, cost: 1.25 }] as never)

      // Act
      const result: DailyTrendItem[] = await (
        service as unknown as {
          getDailyTrend: (s: Date, e: Date) => Promise<DailyTrendItem[]>
        }
      ).getDailyTrend(startDate, endDate)

      // Assert：依日期升冪排序
      expect(result.map((r) => r.date)).toEqual(['2026-05-01', '2026-05-02'])

      const d1 = result.find((r) => r.date === '2026-05-01')!
      const d2 = result.find((r) => r.date === '2026-05-02')!

      expect(d1.volume).toBe(3)
      expect(d1.cost).toBe(1.25)
      // 有 volume 但無成本記錄的日期 → 成本 0
      expect(d2.volume).toBe(5)
      expect(d2.cost).toBe(0)

      // 兩次 $queryRaw：documents（volume）+ api_usage_logs（cost）
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2)
    })
  })
})
