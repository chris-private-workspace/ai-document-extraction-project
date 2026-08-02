/**
 * @fileoverview AI API 使用成本服務
 * @description
 *   提供 AI API 使用量與成本追蹤功能：
 *   - 成本摘要計算與快取
 *   - 趨勢數據分析
 *   - 每日明細查詢
 *   - 異常檢測（標準差 2 倍閾值）
 *
 * @module src/services/ai-cost.service
 * @since Epic 7 - Story 7.6 (AI API 使用成本顯示)
 * @lastModified 2025-12-19
 *
 * @features
 *   - AC1: 儀表板顯示當月 AI API 使用成本
 *   - AC2: 成本趨勢圖表（日/週/月）
 *   - AC3: 各 Provider 成本分佈
 *   - AC4: 成本異常警示
 *   - AC5: 詳細使用記錄查詢
 *
 * @dependencies
 *   - @/lib/prisma - 資料庫客戶端
 *   - @/middlewares/city-filter - 城市過濾
 *   - @/types/ai-cost - 類型定義
 */

import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { CityFilterContext } from '@/middlewares/city-filter'
import type {
  ApiProviderType,
  AiCostSummary,
  ProviderCost,
  AiCostTrend,
  TrendDataPoint,
  DailyDetail,
  ApiUsageRecord,
  AnomalyDetectionResult,
  Anomaly,
  AnomalySeverity,
  AiCostSummaryParams,
  AiCostTrendParams,
  DailyDetailParams,
  AnomalyDetectionParams
} from '@/types/ai-cost'

// ============================================================
// Constants
// ============================================================

/**
 * 快取 TTL（毫秒）- 5 分鐘
 */
const CACHE_TTL_MS = 5 * 60 * 1000

/**
 * 異常檢測閾值（標準差倍數）
 */
const ANOMALY_STD_DEV_MULTIPLIER = 2

/**
 * 高錯誤率閾值（百分比）
 */
const HIGH_ERROR_RATE_THRESHOLD = 10

/**
 * 響應時間異常閾值（毫秒）
 */
const SLOW_RESPONSE_THRESHOLD_MS = 5000

/**
 * 預設計價配置（當無動態配置時使用）
 */
const DEFAULT_PRICING: Record<ApiProviderType, Record<string, { perCall?: number; perInputToken?: number; perOutputToken?: number }>> = {
  AZURE_DOC_INTELLIGENCE: {
    'ocr-extract': { perCall: 0.001 },
    'default': { perCall: 0.001 }
  },
  OPENAI: {
    'gpt-5.2': { perInputToken: 0.00000175, perOutputToken: 0.000014 },
    'gpt-4o': { perInputToken: 0.000005, perOutputToken: 0.000015 },
    'gpt-4o-mini': { perInputToken: 0.00000015, perOutputToken: 0.0000006 },
    'embedding': { perInputToken: 0.00000002 },
    'default': { perInputToken: 0.00000175, perOutputToken: 0.000014 }
  },
  AZURE_OPENAI: {
    // CHANGE-115: 現行唯一使用的模型。官方定價 $0.20 / $1.20 per 1M token
    //   （short context；long context 為 $0.40 / $1.80）。此表結構只支援單一價格，
    //   採 short context —— 發票文件多不觸及 long context 門檻。
    //   cached input（$0.02）亦無對應欄位，未計入。
    'gpt-5.6-luna': { perInputToken: 0.0000002, perOutputToken: 0.0000012 },
    'gpt-5.2': { perInputToken: 0.00000175, perOutputToken: 0.000014 },
    'gpt-4o': { perInputToken: 0.000005, perOutputToken: 0.000015 },
    'gpt-4o-mini': { perInputToken: 0.00000015, perOutputToken: 0.0000006 },
    // ⚠️ 5.4 系列從未列入此表，一直落到 default（＝gpt-5.2 的價格）而高估成本。
    //   CHANGE-115 後 5.4 已不再使用，故不補列；default 維持原值不動。
    'default': { perInputToken: 0.00000175, perOutputToken: 0.000014 }
  }
}

// ============================================================
// Simple Memory Cache
// ============================================================

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

/**
 * 簡單內存快取
 */
class SimpleCache {
  private cache = new Map<string, CacheEntry<unknown>>()

  get<T>(key: string): T | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return null
    }
    return entry.data as T
  }

  set<T>(key: string, data: T, ttlMs: number = CACHE_TTL_MS): void {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + ttlMs
    })
  }

  delete(key: string): void {
    this.cache.delete(key)
  }

  clear(): void {
    this.cache.clear()
  }
}

const summaryCache = new SimpleCache()

// ============================================================
// Helper Functions
// ============================================================

/**
 * 產生快取鍵
 */
function generateCacheKey(prefix: string, params: Record<string, unknown>): string {
  const sortedParams = Object.keys(params).sort().map(k => `${k}:${JSON.stringify(params[k])}`).join('|')
  return `${prefix}:${sortedParams}`
}

/**
 * 計算標準差
 */
function calculateStandardDeviation(values: number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2))
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length
  return Math.sqrt(variance)
}

/**
 * 計算平均值
 */
function calculateMean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

/**
 * 根據期間計算日期範圍
 */
function getDateRange(days: number = 30): { startDate: Date; endDate: Date } {
  const endDate = new Date()
  endDate.setHours(23, 59, 59, 999)
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - days)
  startDate.setHours(0, 0, 0, 0)
  return { startDate, endDate }
}

/**
 * 格式化日期為 YYYY-MM-DD
 */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0]
}

/**
 * 判斷異常嚴重程度
 */
function determineSeverity(deviationPercentage: number): AnomalySeverity {
  const absDeviation = Math.abs(deviationPercentage)
  if (absDeviation >= 200) return 'critical'
  if (absDeviation >= 100) return 'high'
  if (absDeviation >= 50) return 'medium'
  return 'low'
}

// ============================================================
// AiCostService Class
// ============================================================

/**
 * AI 成本服務
 *
 * @description
 *   提供 AI API 使用量與成本的完整追蹤功能
 */
export class AiCostService {
  /**
   * 取得成本摘要
   *
   * @param params - 查詢參數
   * @param cityFilter - 城市過濾上下文
   * @returns 成本摘要
   */
  async getCostSummary(
    params: AiCostSummaryParams,
    cityFilter: CityFilterContext
  ): Promise<AiCostSummary> {
    const { startDate, endDate } = params.startDate && params.endDate
      ? { startDate: new Date(params.startDate), endDate: new Date(params.endDate) }
      : getDateRange(30)

    // 檢查快取
    const cacheKey = generateCacheKey('cost-summary', {
      cityCodes: params.cityCodes || cityFilter.cityCodes,
      startDate: formatDate(startDate),
      endDate: formatDate(endDate)
    })

    if (!params.forceRefresh) {
      const cached = summaryCache.get<AiCostSummary>(cacheKey)
      if (cached) return cached
    }

    // 建立城市過濾條件
    const cityCodes = params.cityCodes || cityFilter.cityCodes

    // 查詢當前期間數據
    const usageLogs = await prisma.apiUsageLog.findMany({
      where: {
        createdAt: {
          gte: startDate,
          lte: endDate
        },
        ...(cityCodes.length > 0 ? { cityCode: { in: cityCodes } } : {})
      },
      select: {
        provider: true,
        operation: true,
        tokensInput: true,
        tokensOutput: true,
        estimatedCost: true,
        success: true,
        createdAt: true
      }
    })

    // 計算各 Provider 統計
    const providerStats = new Map<ApiProviderType, {
      totalCalls: number
      successCalls: number
      failedCalls: number
      totalInputTokens: number
      totalOutputTokens: number
      totalCost: number
    }>()

    for (const log of usageLogs) {
      const provider = log.provider as ApiProviderType
      const stats = providerStats.get(provider) || {
        totalCalls: 0,
        successCalls: 0,
        failedCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0
      }

      stats.totalCalls++
      if (log.success) {
        stats.successCalls++
      } else {
        stats.failedCalls++
      }
      stats.totalInputTokens += log.tokensInput || 0
      stats.totalOutputTokens += log.tokensOutput || 0
      stats.totalCost += Number(log.estimatedCost)

      providerStats.set(provider, stats)
    }

    // 建立 Provider 細分數據
    const providerBreakdown: ProviderCost[] = []
    let totalCost = 0
    let totalCalls = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalSuccessCalls = 0

    for (const [provider, stats] of providerStats) {
      totalCost += stats.totalCost
      totalCalls += stats.totalCalls
      totalInputTokens += stats.totalInputTokens
      totalOutputTokens += stats.totalOutputTokens
      totalSuccessCalls += stats.successCalls

      providerBreakdown.push({
        provider,
        totalCalls: stats.totalCalls,
        successCalls: stats.successCalls,
        failedCalls: stats.failedCalls,
        totalInputTokens: stats.totalInputTokens,
        totalOutputTokens: stats.totalOutputTokens,
        totalCost: stats.totalCost,
        averageCostPerCall: stats.totalCalls > 0 ? stats.totalCost / stats.totalCalls : 0,
        successRate: stats.totalCalls > 0 ? (stats.successCalls / stats.totalCalls) * 100 : 100
      })
    }

    // 計算上期數據（用於比較）
    const periodDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
    const prevEndDate = new Date(startDate)
    prevEndDate.setDate(prevEndDate.getDate() - 1)
    const prevStartDate = new Date(prevEndDate)
    prevStartDate.setDate(prevStartDate.getDate() - periodDays)

    const prevLogs = await prisma.apiUsageLog.findMany({
      where: {
        createdAt: {
          gte: prevStartDate,
          lte: prevEndDate
        },
        ...(cityCodes.length > 0 ? { cityCode: { in: cityCodes } } : {})
      },
      select: {
        estimatedCost: true
      }
    })

    const prevTotalCost = prevLogs.reduce((sum, log) => sum + Number(log.estimatedCost), 0)
    const prevTotalCalls = prevLogs.length

    // 計算變化百分比
    const costChangePercentage = prevTotalCost > 0
      ? ((totalCost - prevTotalCost) / prevTotalCost) * 100
      : null
    const callsChangePercentage = prevTotalCalls > 0
      ? ((totalCalls - prevTotalCalls) / prevTotalCalls) * 100
      : null

    const summary: AiCostSummary = {
      periodStart: formatDate(startDate),
      periodEnd: formatDate(endDate),
      totalCost,
      totalCalls,
      totalInputTokens,
      totalOutputTokens,
      overallSuccessRate: totalCalls > 0 ? (totalSuccessCalls / totalCalls) * 100 : 100,
      providerBreakdown,
      costChangePercentage,
      callsChangePercentage
    }

    // 存入快取
    summaryCache.set(cacheKey, summary)

    return summary
  }

  /**
   * 取得成本趨勢數據
   *
   * @param params - 查詢參數
   * @param cityFilter - 城市過濾上下文
   * @returns 趨勢數據
   */
  async getCostTrend(
    params: AiCostTrendParams,
    cityFilter: CityFilterContext
  ): Promise<AiCostTrend> {
    const startDate = new Date(params.startDate)
    const endDate = new Date(params.endDate)
    const granularity = params.granularity || 'day'
    const cityCodes = params.cityCodes || cityFilter.cityCodes

    // 查詢數據
    const usageLogs = await prisma.apiUsageLog.findMany({
      where: {
        createdAt: {
          gte: startDate,
          lte: endDate
        },
        ...(cityCodes.length > 0 ? { cityCode: { in: cityCodes } } : {}),
        ...(params.providers?.length ? { provider: { in: params.providers } } : {})
      },
      select: {
        provider: true,
        estimatedCost: true,
        success: true,
        createdAt: true
      },
      orderBy: {
        createdAt: 'asc'
      }
    })

    // 按日期分組
    const dateGroups = new Map<string, {
      totalCost: number
      totalCalls: number
      successCalls: number
      failedCalls: number
      providerCosts: Map<ApiProviderType, { cost: number; calls: number }>
    }>()

    for (const log of usageLogs) {
      let dateKey: string
      const logDate = new Date(log.createdAt)

      switch (granularity) {
        case 'week':
          const weekStart = new Date(logDate)
          weekStart.setDate(weekStart.getDate() - weekStart.getDay())
          dateKey = formatDate(weekStart)
          break
        case 'month':
          dateKey = `${logDate.getFullYear()}-${String(logDate.getMonth() + 1).padStart(2, '0')}-01`
          break
        default:
          dateKey = formatDate(logDate)
      }

      const group = dateGroups.get(dateKey) || {
        totalCost: 0,
        totalCalls: 0,
        successCalls: 0,
        failedCalls: 0,
        providerCosts: new Map()
      }

      const cost = Number(log.estimatedCost)
      group.totalCost += cost
      group.totalCalls++
      if (log.success) {
        group.successCalls++
      } else {
        group.failedCalls++
      }

      const provider = log.provider as ApiProviderType
      const providerCost = group.providerCosts.get(provider) || { cost: 0, calls: 0 }
      providerCost.cost += cost
      providerCost.calls++
      group.providerCosts.set(provider, providerCost)

      dateGroups.set(dateKey, group)
    }

    // 轉換為數組
    const data: TrendDataPoint[] = []
    let periodTotal = 0
    let peakCost = 0
    let peakDate = ''

    for (const [date, group] of dateGroups) {
      periodTotal += group.totalCost
      if (group.totalCost > peakCost) {
        peakCost = group.totalCost
        peakDate = date
      }

      const providerCosts: TrendDataPoint['providerCosts'] = []
      for (const [provider, cost] of group.providerCosts) {
        providerCosts.push({
          provider,
          cost: cost.cost,
          calls: cost.calls
        })
      }

      data.push({
        date,
        totalCost: group.totalCost,
        totalCalls: group.totalCalls,
        successCalls: group.successCalls,
        failedCalls: group.failedCalls,
        providerCosts
      })
    }

    // 排序
    data.sort((a, b) => a.date.localeCompare(b.date))

    const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
    const averageDailyCost = totalDays > 0 ? periodTotal / totalDays : 0

    return {
      granularity,
      data,
      periodTotal,
      averageDailyCost,
      peakCost,
      peakDate
    }
  }

  /**
   * 取得每日明細
   *
   * @param params - 查詢參數
   * @param cityFilter - 城市過濾上下文
   * @returns 每日明細
   */
  async getDailyDetail(
    params: DailyDetailParams,
    cityFilter: CityFilterContext
  ): Promise<DailyDetail> {
    const targetDate = new Date(params.date)
    const startOfDay = new Date(targetDate)
    startOfDay.setHours(0, 0, 0, 0)
    const endOfDay = new Date(targetDate)
    endOfDay.setHours(23, 59, 59, 999)

    const cityCodes = params.cityCodes || cityFilter.cityCodes
    const page = params.page || 1
    const limit = params.limit || 50

    // 查詢條件
    const whereClause = {
      createdAt: {
        gte: startOfDay,
        lte: endOfDay
      },
      ...(cityCodes.length > 0 ? { cityCode: { in: cityCodes } } : {}),
      ...(params.providers?.length ? { provider: { in: params.providers } } : {}),
      ...(params.failedOnly ? { success: false } : {})
    }

    // 查詢總數
    const total = await prisma.apiUsageLog.count({ where: whereClause })

    // 查詢數據
    const logs = await prisma.apiUsageLog.findMany({
      where: whereClause,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: {
        createdAt: 'desc'
      }
    })

    // 計算當日摘要
    const allLogs = await prisma.apiUsageLog.findMany({
      where: {
        createdAt: {
          gte: startOfDay,
          lte: endOfDay
        },
        ...(cityCodes.length > 0 ? { cityCode: { in: cityCodes } } : {})
      },
      select: {
        estimatedCost: true,
        success: true
      }
    })

    const totalCost = allLogs.reduce((sum, log) => sum + Number(log.estimatedCost), 0)
    const successCount = allLogs.filter(log => log.success).length
    const successRate = allLogs.length > 0 ? (successCount / allLogs.length) * 100 : 100

    // 轉換記錄
    const records: ApiUsageRecord[] = logs.map(log => ({
      id: log.id,
      documentId: log.documentId,
      cityCode: log.cityCode,
      provider: log.provider as ApiProviderType,
      operation: log.operation,
      tokensInput: log.tokensInput,
      tokensOutput: log.tokensOutput,
      estimatedCost: Number(log.estimatedCost),
      responseTime: log.responseTime,
      success: log.success,
      errorMessage: log.errorMessage,
      createdAt: log.createdAt.toISOString()
    }))

    return {
      date: params.date,
      summary: {
        totalCost,
        totalCalls: allLogs.length,
        successRate
      },
      records,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    }
  }

  /**
   * 執行異常檢測
   *
   * @param params - 查詢參數
   * @param cityFilter - 城市過濾上下文
   * @returns 異常檢測結果
   */
  async detectAnomalies(
    params: AnomalyDetectionParams,
    cityFilter: CityFilterContext
  ): Promise<AnomalyDetectionResult> {
    const days = params.days || 7
    const { startDate, endDate } = getDateRange(days)
    const cityCodes = params.cityCodes || cityFilter.cityCodes

    // 查詢歷史數據（30 天）用於計算基準
    const { startDate: historyStart } = getDateRange(30)

    const historicalLogs = await prisma.apiUsageLog.findMany({
      where: {
        createdAt: {
          gte: historyStart,
          lte: endDate
        },
        ...(cityCodes.length > 0 ? { cityCode: { in: cityCodes } } : {})
      },
      select: {
        provider: true,
        estimatedCost: true,
        success: true,
        responseTime: true,
        createdAt: true
      },
      orderBy: {
        createdAt: 'asc'
      }
    })

    // 按日期分組計算每日統計
    const dailyStats = new Map<string, {
      totalCost: number
      totalCalls: number
      failedCalls: number
      avgResponseTime: number
      responseTimes: number[]
    }>()

    for (const log of historicalLogs) {
      const dateKey = formatDate(new Date(log.createdAt))
      const stats = dailyStats.get(dateKey) || {
        totalCost: 0,
        totalCalls: 0,
        failedCalls: 0,
        avgResponseTime: 0,
        responseTimes: []
      }

      stats.totalCost += Number(log.estimatedCost)
      stats.totalCalls++
      if (!log.success) stats.failedCalls++
      if (log.responseTime) stats.responseTimes.push(log.responseTime)

      dailyStats.set(dateKey, stats)
    }

    // 計算基準（平均值和標準差）
    const dailyCosts = Array.from(dailyStats.values()).map(s => s.totalCost)
    const dailyCalls = Array.from(dailyStats.values()).map(s => s.totalCalls)
    const dailyErrorRates = Array.from(dailyStats.values()).map(s =>
      s.totalCalls > 0 ? (s.failedCalls / s.totalCalls) * 100 : 0
    )

    const costMean = calculateMean(dailyCosts)
    const costStdDev = calculateStandardDeviation(dailyCosts)
    const callsMean = calculateMean(dailyCalls)
    const callsStdDev = calculateStandardDeviation(dailyCalls)
    const errorRateMean = calculateMean(dailyErrorRates)

    // 檢測異常
    const anomalies: Anomaly[] = []
    let anomalyId = 0

    // 只檢測最近 N 天
    const recentDates = Array.from(dailyStats.keys())
      .filter(date => new Date(date) >= startDate)
      .sort()

    for (const date of recentDates) {
      const stats = dailyStats.get(date)!

      // 成本突增檢測
      if (stats.totalCost > costMean + ANOMALY_STD_DEV_MULTIPLIER * costStdDev && costStdDev > 0) {
        const deviation = ((stats.totalCost - costMean) / costMean) * 100
        const severity = determineSeverity(deviation)

        if (!params.minSeverity || severityOrder(severity) >= severityOrder(params.minSeverity)) {
          anomalies.push({
            id: `anomaly-${++anomalyId}`,
            type: 'cost_spike',
            severity,
            date,
            provider: null,
            description: `日成本 $${stats.totalCost.toFixed(4)} 超過正常範圍（基準值 $${costMean.toFixed(4)}）`,
            currentValue: stats.totalCost,
            baselineValue: costMean,
            deviationPercentage: deviation,
            acknowledged: false,
            acknowledgedBy: null,
            acknowledgedAt: null
          })
        }
      }

      // 異常呼叫量檢測
      if (stats.totalCalls > callsMean + ANOMALY_STD_DEV_MULTIPLIER * callsStdDev && callsStdDev > 0) {
        const deviation = ((stats.totalCalls - callsMean) / callsMean) * 100
        const severity = determineSeverity(deviation)

        if (!params.minSeverity || severityOrder(severity) >= severityOrder(params.minSeverity)) {
          anomalies.push({
            id: `anomaly-${++anomalyId}`,
            type: 'unusual_volume',
            severity,
            date,
            provider: null,
            description: `日呼叫量 ${stats.totalCalls} 次超過正常範圍（基準值 ${Math.round(callsMean)} 次）`,
            currentValue: stats.totalCalls,
            baselineValue: callsMean,
            deviationPercentage: deviation,
            acknowledged: false,
            acknowledgedBy: null,
            acknowledgedAt: null
          })
        }
      }

      // 高錯誤率檢測
      const errorRate = stats.totalCalls > 0 ? (stats.failedCalls / stats.totalCalls) * 100 : 0
      if (errorRate > HIGH_ERROR_RATE_THRESHOLD) {
        const deviation = errorRate - errorRateMean
        const severity = errorRate > 50 ? 'critical' : errorRate > 30 ? 'high' : errorRate > 20 ? 'medium' : 'low'

        if (!params.minSeverity || severityOrder(severity) >= severityOrder(params.minSeverity)) {
          anomalies.push({
            id: `anomaly-${++anomalyId}`,
            type: 'high_error_rate',
            severity,
            date,
            provider: null,
            description: `日錯誤率 ${errorRate.toFixed(1)}% 超過閾值（${HIGH_ERROR_RATE_THRESHOLD}%）`,
            currentValue: errorRate,
            baselineValue: HIGH_ERROR_RATE_THRESHOLD,
            deviationPercentage: deviation,
            acknowledged: false,
            acknowledgedBy: null,
            acknowledgedAt: null
          })
        }
      }

      // 響應時間異常檢測
      if (stats.responseTimes.length > 0) {
        const avgResponseTime = calculateMean(stats.responseTimes)
        if (avgResponseTime > SLOW_RESPONSE_THRESHOLD_MS) {
          const deviation = ((avgResponseTime - SLOW_RESPONSE_THRESHOLD_MS) / SLOW_RESPONSE_THRESHOLD_MS) * 100
          const severity = avgResponseTime > 15000 ? 'critical' : avgResponseTime > 10000 ? 'high' : 'medium'

          if (!params.minSeverity || severityOrder(severity) >= severityOrder(params.minSeverity)) {
            anomalies.push({
              id: `anomaly-${++anomalyId}`,
              type: 'slow_response',
              severity,
              date,
              provider: null,
              description: `平均響應時間 ${Math.round(avgResponseTime)}ms 超過閾值（${SLOW_RESPONSE_THRESHOLD_MS}ms）`,
              currentValue: avgResponseTime,
              baselineValue: SLOW_RESPONSE_THRESHOLD_MS,
              deviationPercentage: deviation,
              acknowledged: false,
              acknowledgedBy: null,
              acknowledgedAt: null
            })
          }
        }
      }
    }

    // 過濾已確認的異常（如果不需要）
    const filteredAnomalies = params.includeAcknowledged
      ? anomalies
      : anomalies.filter(a => !a.acknowledged)

    // 統計各嚴重程度數量
    const severityCounts = {
      low: filteredAnomalies.filter(a => a.severity === 'low').length,
      medium: filteredAnomalies.filter(a => a.severity === 'medium').length,
      high: filteredAnomalies.filter(a => a.severity === 'high').length,
      critical: filteredAnomalies.filter(a => a.severity === 'critical').length
    }

    return {
      periodStart: formatDate(startDate),
      periodEnd: formatDate(endDate),
      anomalies: filteredAnomalies,
      severityCounts
    }
  }

  /**
   * 記錄 API 使用
   *
   * @param data - 使用記錄數據
   * @returns 建立的記錄
   */
  async logUsage(data: {
    documentId?: string
    cityCode: string
    provider: ApiProviderType
    operation: string
    tokensInput?: number
    tokensOutput?: number
    responseTime?: number
    success: boolean
    errorMessage?: string
    metadata?: Record<string, unknown>
  }) {
    // 計算預估成本
    const pricing = DEFAULT_PRICING[data.provider]
    const operationPricing = pricing[data.operation] || pricing['default']

    let estimatedCost = 0
    if (operationPricing.perCall) {
      estimatedCost = operationPricing.perCall
    }
    if (operationPricing.perInputToken && data.tokensInput) {
      estimatedCost += operationPricing.perInputToken * data.tokensInput
    }
    if (operationPricing.perOutputToken && data.tokensOutput) {
      estimatedCost += operationPricing.perOutputToken * data.tokensOutput
    }

    return prisma.apiUsageLog.create({
      data: {
        documentId: data.documentId,
        cityCode: data.cityCode,
        provider: data.provider,
        operation: data.operation,
        tokensInput: data.tokensInput,
        tokensOutput: data.tokensOutput,
        estimatedCost,
        responseTime: data.responseTime,
        success: data.success,
        errorMessage: data.errorMessage,
        metadata: data.metadata as Prisma.InputJsonValue | undefined
      }
    })
  }

  /**
   * 清除快取
   */
  clearCache(): void {
    summaryCache.clear()
  }
}

/**
 * 嚴重程度排序值
 */
function severityOrder(severity: AnomalySeverity): number {
  const order: Record<AnomalySeverity, number> = {
    low: 1,
    medium: 2,
    high: 3,
    critical: 4
  }
  return order[severity]
}

// ============================================================
// Export Singleton Instance
// ============================================================

export const aiCostService = new AiCostService()
