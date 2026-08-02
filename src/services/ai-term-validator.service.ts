/**
 * @fileoverview AI 術語驗證服務
 * @description
 *   使用 Azure OpenAI GPT-5.2 進行智能術語分類和驗證：
 *   - 批次處理術語驗證（50-100 術語/批次）
 *   - 區分有效費用術語 vs 無效地址/名稱術語
 *   - 成本追蹤和統計
 *   - 快取機制減少 API 呼叫
 *   - Fallback 機制保障服務可用性
 *
 * @module src/services/ai-term-validator
 * @author Development Team
 * @since Epic 0 - Story 0-10 (AI 術語驗證服務)
 * @lastModified 2025-01-01
 *
 * @features
 *   - AC1: GPT-5.2 批次術語分類（50-100/batch）
 *   - AC2: 七種術語類別分類
 *   - AC3: 每批次成本追蹤
 *   - AC4: Fallback 機制（isAddressLikeTerm）
 *   - AC5: 成本統計查詢 API
 *
 * @dependencies
 *   - Azure OpenAI Service (GPT-5.2)
 *   - src/services/term-aggregation.service.ts - Fallback 函數
 *   - src/services/ai-cost.service.ts - 成本追蹤
 *   - src/types/term-validation.ts - 類型定義
 *
 * @related
 *   - src/services/batch-term-aggregation.service.ts - 批次術語聚合
 *   - src/services/hierarchical-term-aggregation.service.ts - 階層式術語聚合
 *   - docs/04-implementation/tech-specs/epic-00-historical-data/tech-spec-story-0-10.md
 */

import { AzureOpenAI } from 'openai'
import { resolveDeploymentNameByKey } from '@/lib/constants/llm-models'
import { LLM_STAGE_KEYS } from '@/lib/constants/llm-stages'
import { prisma } from '@/lib/prisma'
import { callGatewayByModelKey } from '@/services/llm'
import { isAddressLikeTerm } from '@/services/term-aggregation.service'
import {
  TermCategory,
  isValidTermCategory,
  parseTermCategory,
  type TermValidationResult,
  type TermValidationConfig,
  type TermValidationCostRecord,
  type TermValidationStats,
  type TermValidationCostQuery,
  type GPTValidationResponse,
  DEFAULT_VALIDATION_CONFIG,
} from '@/types/term-validation'

// ============================================================================
// Constants
// ============================================================================

/**
 * Azure OpenAI 配置
 */
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || ''
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || ''
/**
 * FIX-137：原為 `process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.2'` —— 兩層都壞：
 * 變數名少了 `_NAME`（其餘服務讀 `AZURE_OPENAI_DEPLOYMENT_NAME`，補設也讀不到），
 * fallback 的 `gpt-5.2` deployment 又已於 CHANGE-102 移除。改走白名單解析。
 */
const DEFAULT_MODEL_KEY = 'gpt-5.6-luna'
const AZURE_OPENAI_DEPLOYMENT = resolveDeploymentNameByKey(DEFAULT_MODEL_KEY)
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview'

/**
 * GPT-5.2 定價（Azure OpenAI）
 * @see https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/
 * @note 使用與 gpt-vision.service.ts 相同的模型，定價待確認
 */
const GPT52_PRICING = {
  inputTokens: 0.000005, // $5 per 1M input tokens (placeholder, adjust when pricing available)
  outputTokens: 0.000015, // $15 per 1M output tokens (placeholder, adjust when pricing available)
}

/**
 * 快取 TTL（毫秒）- 1 小時
 */
const CACHE_TTL_MS = 60 * 60 * 1000

/**
 * 術語驗證提示詞
 */
const TERM_VALIDATION_PROMPT = `You are an expert freight invoice analyst. Your task is to classify invoice line item descriptions into categories.

## Categories:
**VALID (should be kept):**
- FREIGHT_CHARGE: Main shipping/transportation fees (e.g., "Ocean Freight", "Air Freight", "Trucking Fee")
- SURCHARGE: Additional fees (e.g., "Fuel Surcharge", "Peak Season Surcharge", "BAF")
- SERVICE_FEE: Service-related fees (e.g., "Documentation Fee", "Handling Fee", "Customs Clearance")
- DUTY_TAX: Customs duties and taxes (e.g., "Import Duty", "VAT", "GST")

**INVALID (should be filtered out):**
- ADDRESS: Physical addresses or address components (e.g., "123 Main Street", "Floor 5", "Building A")
- PERSON_NAME: Personal names (e.g., "John Smith", "KATHY LAM")
- COMPANY_NAME: Company/organization names (e.g., "ABC Logistics Ltd", "DHL Express")
- BUILDING_NAME: Building or facility names (e.g., "Tower 1", "Industrial Park")
- AIRPORT_CODE: Airport/city codes (e.g., "HKG", "SIN", "BKK")
- REFERENCE: Reference numbers or IDs (e.g., "REF: 12345", "AWB: 999-12345678")
- OTHER: Any other non-charge content

## Rules:
1. Focus on the SEMANTIC meaning, not just keywords
2. If uncertain, prefer INVALID to avoid noise in the system
3. Provide confidence score (0-100) based on certainty
4. Brief reasoning for each classification

## Input:
Classify the following terms:
{TERMS}

## Output Format (JSON):
{
  "classifications": [
    {
      "term": "original term",
      "category": "CATEGORY_NAME",
      "confidence": 85,
      "reasoning": "Brief explanation"
    }
  ],
  "totalProcessed": number
}`

// ============================================================================
// Simple Memory Cache
// ============================================================================

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

/**
 * 簡單內存快取
 */
class TermValidationCache {
  private cache = new Map<string, CacheEntry<TermValidationResult>>()

  /**
   * 產生快取鍵
   */
  private generateKey(term: string): string {
    return term.toUpperCase().trim()
  }

  /**
   * 取得快取項目
   */
  get(term: string): TermValidationResult | null {
    const key = this.generateKey(term)
    const entry = this.cache.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return null
    }
    return entry.data
  }

  /**
   * 設定快取項目
   */
  set(term: string, result: TermValidationResult, ttlMs: number = CACHE_TTL_MS): void {
    const key = this.generateKey(term)
    this.cache.set(key, {
      data: result,
      expiresAt: Date.now() + ttlMs,
    })
  }

  /**
   * 批次取得快取項目
   */
  getMany(terms: string[]): Map<string, TermValidationResult> {
    const results = new Map<string, TermValidationResult>()
    for (const term of terms) {
      const cached = this.get(term)
      if (cached) {
        results.set(term, cached)
      }
    }
    return results
  }

  /**
   * 批次設定快取項目
   */
  setMany(results: TermValidationResult[], ttlMs: number = CACHE_TTL_MS): void {
    for (const result of results) {
      this.set(result.term, result, ttlMs)
    }
  }

  /**
   * 清除快取
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * 取得快取大小
   */
  size(): number {
    return this.cache.size
  }
}

const validationCache = new TermValidationCache()

// ============================================================================
// Cost Tracking Storage
// ============================================================================

/**
 * 內存成本記錄（在沒有資料庫表時使用）
 */
const costRecords: TermValidationCostRecord[] = []

// ============================================================================
// AI Term Validator Service
// ============================================================================

/**
 * AI 術語驗證服務
 *
 * @description
 *   使用 GPT-5.2 進行智能術語分類，區分有效費用術語和無效內容。
 *   提供批次處理、快取、成本追蹤和 fallback 機制。
 */
export class AiTermValidatorService {
  private client: AzureOpenAI | null = null
  private config: TermValidationConfig

  constructor(config: Partial<TermValidationConfig> = {}) {
    this.config = { ...DEFAULT_VALIDATION_CONFIG, ...config }
    this.initializeClient()
  }

  /**
   * 初始化 Azure OpenAI 客戶端
   */
  private initializeClient(): void {
    if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY) {
      console.warn('[AiTermValidator] Azure OpenAI credentials not configured. Will use fallback mode.')
      return
    }

    try {
      this.client = new AzureOpenAI({
        endpoint: AZURE_OPENAI_ENDPOINT,
        apiKey: AZURE_OPENAI_API_KEY,
        apiVersion: AZURE_OPENAI_API_VERSION,
      })
    } catch (error) {
      console.error('[AiTermValidator] Failed to initialize Azure OpenAI client:', error)
    }
  }

  /**
   * 驗證單一術語
   *
   * @param term - 要驗證的術語
   * @param batchId - 可選的批次 ID
   * @returns 驗證結果
   */
  async validateTerm(term: string, batchId?: string): Promise<TermValidationResult> {
    const results = await this.validateTerms([term], batchId)
    return results[0]
  }

  /**
   * 批次驗證術語
   *
   * @param terms - 要驗證的術語列表
   * @param batchId - 可選的批次 ID
   * @returns 驗證結果列表
   */
  async validateTerms(terms: string[], batchId?: string): Promise<TermValidationResult[]> {
    if (!terms || terms.length === 0) {
      return []
    }

    // 去重並過濾空值
    const uniqueTerms = [...new Set(terms.filter((t) => t && t.trim()))]

    // 檢查快取
    const cachedResults = this.config.cacheEnabled
      ? validationCache.getMany(uniqueTerms)
      : new Map<string, TermValidationResult>()

    // 找出未快取的術語
    const uncachedTerms = uniqueTerms.filter((t) => !cachedResults.has(t))

    // 如果所有術語都已快取，直接返回
    if (uncachedTerms.length === 0) {
      return this.buildResultsFromCache(uniqueTerms, cachedResults)
    }

    // 如果 AI 服務不可用或未啟用，使用 fallback
    if (!this.config.enabled || !this.client) {
      const fallbackResults = this.validateWithFallback(uncachedTerms)
      if (this.config.cacheEnabled) {
        validationCache.setMany(fallbackResults, this.config.cacheTTL * 1000)
      }
      return this.mergeResults(uniqueTerms, cachedResults, fallbackResults)
    }

    // 分批處理未快取的術語
    const allResults: TermValidationResult[] = []
    const batches = this.splitIntoBatches(uncachedTerms, this.config.batchSize)

    for (const batch of batches) {
      try {
        const batchResults = await this.processBatch(batch, batchId)
        allResults.push(...batchResults)
      } catch (error) {
        console.error('[AiTermValidator] Batch processing failed, using fallback:', error)
        // Fallback for failed batch
        const fallbackResults = this.validateWithFallback(batch)
        allResults.push(...fallbackResults)
      }
    }

    // 快取結果
    if (this.config.cacheEnabled) {
      validationCache.setMany(allResults, this.config.cacheTTL * 1000)
    }

    return this.mergeResults(uniqueTerms, cachedResults, allResults)
  }

  /**
   * 處理單一批次
   */
  private async processBatch(
    terms: string[],
    batchId?: string
  ): Promise<TermValidationResult[]> {
    const startTime = Date.now()
    let inputTokens = 0
    let outputTokens = 0
    let errorMessage: string | undefined

    try {
      // 建立提示詞
      const termsText = terms.map((t, i) => `${i + 1}. "${t}"`).join('\n')
      const prompt = TERM_VALIDATION_PROMPT.replace('{TERMS}', termsText)

      const systemInstruction =
        'You are an expert freight invoice analyst. Respond only with valid JSON.'

      // Epic 23 Story 23.4 Phase 1（呼叫點 #4）：flag 開啟且 modelKey 已播種時經 gateway；
      // 回 null 即落到下方既有直接 Azure 呼叫，行為零變。失敗時橋接拋出 →
      // 由 validateTerms 的 catch 退回 rule-based 判斷（tech-spec §3.7 明列須保留的業務降級）。
      const viaGateway = await callGatewayByModelKey({
        modelKey: DEFAULT_MODEL_KEY,
        stageKey: LLM_STAGE_KEYS.TERM_VALIDATION,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: prompt },
        ],
        output: { mode: 'json' }, // 對應既有 response_format: json_object
        temperature: 0.1,
        maxOutputTokens: 4096,
      })

      let content: string | null | undefined
      let usage = { input: 0, output: 0 }

      if (viaGateway) {
        content = viaGateway.content
        usage = { input: viaGateway.usage.input, output: viaGateway.usage.output }
      } else {
        // 呼叫 GPT-5.2
        const response = await this.client!.chat.completions.create({
          model: AZURE_OPENAI_DEPLOYMENT,
          messages: [
            {
              role: 'system',
              content: systemInstruction,
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.1,
          max_tokens: 4096,
          response_format: { type: 'json_object' },
        })

        content = response.choices[0]?.message?.content
        usage = {
          input: response.usage?.prompt_tokens || 0,
          output: response.usage?.completion_tokens || 0,
        }
      }

      // 解析回應
      if (!content) {
        throw new Error('Empty response from GPT-5.2')
      }

      const parsed = JSON.parse(content) as GPTValidationResponse
      // 保持原順序：token 計數在「空回應檢查」之後才寫入，失敗成本記錄維持記 0
      inputTokens = usage.input
      outputTokens = usage.output

      // 轉換結果
      const results = this.convertGPTResponse(terms, parsed)

      // 記錄成本
      this.recordCost({
        batchId,
        termCount: terms.length,
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - startTime,
        success: true,
      })

      return results
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[AiTermValidator] GPT-5.2 call failed:', errorMessage)

      // 記錄失敗成本
      this.recordCost({
        batchId,
        termCount: terms.length,
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - startTime,
        success: false,
        errorMessage,
      })

      // 使用 fallback
      if (this.config.fallbackEnabled) {
        return this.validateWithFallback(terms)
      }

      throw error
    }
  }

  /**
   * 轉換 GPT 回應為驗證結果
   */
  private convertGPTResponse(
    originalTerms: string[],
    response: GPTValidationResponse
  ): TermValidationResult[] {
    const classificationMap = new Map(
      response.classifications.map((c) => [c.term.toUpperCase().trim(), c])
    )

    return originalTerms.map((term) => {
      const upperTerm = term.toUpperCase().trim()
      const classification = classificationMap.get(upperTerm)

      if (classification) {
        const category = parseTermCategory(classification.category) || TermCategory.OTHER
        return {
          term,
          isValid: isValidTermCategory(category),
          category,
          confidence: classification.confidence,
          source: 'AI' as const,
          reasoning: classification.reasoning,
        }
      }

      // 如果 GPT 沒有返回此術語的結果，使用 fallback
      return this.validateSingleWithFallback(term)
    })
  }

  /**
   * 使用 fallback 驗證術語（基於 isAddressLikeTerm）
   */
  private validateWithFallback(terms: string[]): TermValidationResult[] {
    return terms.map((term) => this.validateSingleWithFallback(term))
  }

  /**
   * 使用 fallback 驗證單一術語
   */
  private validateSingleWithFallback(term: string): TermValidationResult {
    const isAddress = isAddressLikeTerm(term)
    return {
      term,
      isValid: !isAddress,
      category: isAddress ? TermCategory.ADDRESS : TermCategory.FREIGHT_CHARGE,
      confidence: 60, // Fallback 信心度較低
      source: 'FALLBACK' as const,
      reasoning: isAddress
        ? 'Detected as address-like term by rule-based fallback'
        : 'Assumed as valid freight charge by rule-based fallback',
    }
  }

  /**
   * 從快取建立結果
   */
  private buildResultsFromCache(
    terms: string[],
    cache: Map<string, TermValidationResult>
  ): TermValidationResult[] {
    return terms.map((term) => {
      const cached = cache.get(term)
      if (cached) {
        return { ...cached, source: 'CACHED' as const }
      }
      return this.validateSingleWithFallback(term)
    })
  }

  /**
   * 合併快取結果和新結果
   */
  private mergeResults(
    terms: string[],
    cachedResults: Map<string, TermValidationResult>,
    newResults: TermValidationResult[]
  ): TermValidationResult[] {
    const newResultsMap = new Map(newResults.map((r) => [r.term, r]))

    return terms.map((term) => {
      const cached = cachedResults.get(term)
      if (cached) {
        return { ...cached, source: 'CACHED' as const }
      }
      return newResultsMap.get(term) || this.validateSingleWithFallback(term)
    })
  }

  /**
   * 分割術語為批次
   */
  private splitIntoBatches(terms: string[], batchSize: number): string[][] {
    const batches: string[][] = []
    for (let i = 0; i < terms.length; i += batchSize) {
      batches.push(terms.slice(i, i + batchSize))
    }
    return batches
  }

  /**
   * 記錄驗證成本
   */
  private recordCost(data: {
    batchId?: string
    termCount: number
    inputTokens: number
    outputTokens: number
    latencyMs: number
    success: boolean
    errorMessage?: string
  }): void {
    const totalTokens = data.inputTokens + data.outputTokens
    const estimatedCost =
      data.inputTokens * GPT52_PRICING.inputTokens +
      data.outputTokens * GPT52_PRICING.outputTokens

    const record: TermValidationCostRecord = {
      id: `tv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      batchId: data.batchId,
      timestamp: new Date(),
      termCount: data.termCount,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      totalTokens,
      estimatedCost,
      latencyMs: data.latencyMs,
      success: data.success,
      errorMessage: data.errorMessage,
    }

    // 添加到內存記錄
    costRecords.push(record)

    // 限制記錄數量（保留最近 1000 筆）
    if (costRecords.length > 1000) {
      costRecords.splice(0, costRecords.length - 1000)
    }

    // 記錄到 API 使用日誌（如果資料庫可用）
    this.logToDatabase(record).catch((err) => {
      console.warn('[AiTermValidator] Failed to log cost to database:', err)
    })
  }

  /**
   * 將成本記錄到資料庫
   */
  private async logToDatabase(record: TermValidationCostRecord): Promise<void> {
    try {
      await prisma.apiUsageLog.create({
        data: {
          provider: 'AZURE_OPENAI',
          operation: 'term-validation',
          tokensInput: record.inputTokens,
          tokensOutput: record.outputTokens,
          estimatedCost: record.estimatedCost,
          responseTime: record.latencyMs,
          success: record.success,
          errorMessage: record.errorMessage,
          cityCode: 'SYSTEM', // 系統級操作
          metadata: {
            batchId: record.batchId,
            termCount: record.termCount,
          },
        },
      })
    } catch (error) {
      // 忽略資料庫錯誤，不影響主要功能
      console.debug('[AiTermValidator] Database logging failed:', error)
    }
  }

  /**
   * 取得驗證統計
   */
  async getValidationStats(query: TermValidationCostQuery = {}): Promise<TermValidationStats> {
    const now = new Date()
    const startDate = query.startDate || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const endDate = query.endDate || now

    // 過濾記錄
    let filteredRecords = costRecords.filter(
      (r) => r.timestamp >= startDate && r.timestamp <= endDate
    )

    if (query.batchId) {
      filteredRecords = filteredRecords.filter((r) => r.batchId === query.batchId)
    }

    // 計算統計
    const totalValidations = filteredRecords.length
    const successfulValidations = filteredRecords.filter((r) => r.success)
    const totalTermsProcessed = filteredRecords.reduce((sum, r) => sum + r.termCount, 0)
    const totalTokensUsed = filteredRecords.reduce((sum, r) => sum + r.totalTokens, 0)
    const totalCost = filteredRecords.reduce((sum, r) => sum + r.estimatedCost, 0)
    const totalLatency = filteredRecords.reduce((sum, r) => sum + r.latencyMs, 0)

    // 類別統計（需要從快取或資料庫取得，這裡簡化處理）
    const categoryBreakdown: Record<TermCategory, number> = {
      [TermCategory.FREIGHT_CHARGE]: 0,
      [TermCategory.SURCHARGE]: 0,
      [TermCategory.SERVICE_FEE]: 0,
      [TermCategory.DUTY_TAX]: 0,
      [TermCategory.ADDRESS]: 0,
      [TermCategory.PERSON_NAME]: 0,
      [TermCategory.COMPANY_NAME]: 0,
      [TermCategory.BUILDING_NAME]: 0,
      [TermCategory.AIRPORT_CODE]: 0,
      [TermCategory.REFERENCE]: 0,
      [TermCategory.OTHER]: 0,
    }

    return {
      periodStart: startDate,
      periodEnd: endDate,
      totalValidations,
      totalTermsProcessed,
      validTermsCount: 0, // 需要額外追蹤
      invalidTermsCount: 0, // 需要額外追蹤
      totalTokensUsed,
      totalCost,
      avgCostPerBatch: totalValidations > 0 ? totalCost / totalValidations : 0,
      avgCostPerTerm: totalTermsProcessed > 0 ? totalCost / totalTermsProcessed : 0,
      successRate: totalValidations > 0 ? (successfulValidations.length / totalValidations) * 100 : 100,
      avgLatencyMs: totalValidations > 0 ? totalLatency / totalValidations : 0,
      categoryBreakdown,
    }
  }

  /**
   * 取得成本記錄
   */
  getCostRecords(query: TermValidationCostQuery = {}): TermValidationCostRecord[] {
    let records = [...costRecords]

    if (query.startDate) {
      records = records.filter((r) => r.timestamp >= query.startDate!)
    }
    if (query.endDate) {
      records = records.filter((r) => r.timestamp <= query.endDate!)
    }
    if (query.batchId) {
      records = records.filter((r) => r.batchId === query.batchId)
    }

    // 排序（最新在前）
    records.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

    // 分頁
    const offset = query.offset || 0
    const limit = query.limit || 100

    return records.slice(offset, offset + limit)
  }

  /**
   * 過濾有效術語
   *
   * @param terms - 要過濾的術語列表
   * @param batchId - 可選的批次 ID
   * @returns 只包含有效術語的列表
   */
  async filterValidTerms(terms: string[], batchId?: string): Promise<string[]> {
    const results = await this.validateTerms(terms, batchId)
    return results.filter((r) => r.isValid).map((r) => r.term)
  }

  /**
   * 過濾無效術語
   *
   * @param terms - 要過濾的術語列表
   * @param batchId - 可選的批次 ID
   * @returns 只包含無效術語的列表
   */
  async filterInvalidTerms(terms: string[], batchId?: string): Promise<string[]> {
    const results = await this.validateTerms(terms, batchId)
    return results.filter((r) => !r.isValid).map((r) => r.term)
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<TermValidationConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * 取得當前配置
   */
  getConfig(): TermValidationConfig {
    return { ...this.config }
  }

  /**
   * 清除快取
   */
  clearCache(): void {
    validationCache.clear()
  }

  /**
   * 取得快取統計
   */
  getCacheStats(): { size: number; enabled: boolean; ttl: number } {
    return {
      size: validationCache.size(),
      enabled: this.config.cacheEnabled,
      ttl: this.config.cacheTTL,
    }
  }

  /**
   * 檢查服務是否可用
   */
  isAvailable(): boolean {
    return this.config.enabled && this.client !== null
  }
}

// ============================================================================
// Export Singleton Instance
// ============================================================================

export const aiTermValidator = new AiTermValidatorService()
