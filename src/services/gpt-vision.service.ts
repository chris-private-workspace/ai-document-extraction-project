/**
 * @fileoverview GPT-5.2 Vision 處理服務
 * @description
 *   使用 Azure OpenAI GPT-5.2 模型處理圖片和掃描 PDF：
 *   - 圖片轉 Base64 編碼
 *   - GPT-5.2 Vision API 調用
 *   - 發票內容提取和結構化
 *   - 文件發行者識別 (Story 0.8)
 *   - 文件格式識別 (Story 0.9)
 *   - CHANGE-001: 分類專用模式 (classifyDocument)
 *   - Story 0-11: 優化版 Prompt 與版本管理
 *   - Story 14-4: 動態 Prompt 整合（HybridPromptProvider）
 *
 * @module src/services/gpt-vision
 * @since Epic 0 - Story 0.2
 * @lastModified 2026-01-03
 *
 * @features
 *   - 支援 JPG、PNG、TIFF、PDF 圖片
 *   - 結構化發票數據提取
 *   - 文件發行者識別
 *   - 文件格式識別與特徵提取
 *   - 錯誤處理和重試
 *   - CHANGE-001: classifyDocument() 輕量分類模式
 *   - Story 0-11: 5 步驟結構化 Prompt（Region/Extract/Exclude/Examples/Verify）
 *   - Story 0-11: Prompt 版本管理（V1 Legacy / V2 Optimized）
 *   - Story 0-11: ExcludedItem 追蹤（被排除項目記錄）
 *   - Story 14-4: 動態 Prompt 支援（Feature Flag 驅動）
 *   - Story 14-4: 自動降級機制（動態失敗時使用靜態 Prompt）
 *   - Story 14-4: Prompt 度量追蹤
 *
 * @dependencies
 *   - Azure OpenAI Service
 *   - pdf-to-img（PDF 轉圖片）
 *   - src/lib/prompts - 提示詞模組
 *   - src/services/hybrid-prompt-provider.service.ts - 動態 Prompt 提供者
 *
 * @related
 *   - src/services/batch-processor.service.ts - 批量處理執行器
 *   - src/services/processing-router.service.ts - 處理路由服務
 *   - src/lib/prompts/extraction-prompt.ts - 原始提示詞定義
 *   - src/lib/prompts/optimized-extraction-prompt.ts - 優化版提示詞（Story 0-11）
 *   - src/services/hybrid-prompt-provider.service.ts - 混合 Prompt 提供者
 *   - claudedocs/4-changes/feature-changes/CHANGE-001-native-pdf-dual-processing.md
 */

import { AzureOpenAI } from 'openai'
import { resolveDeploymentNameByKey } from '@/lib/constants/llm-models'
import { LLM_STAGE_KEYS } from '@/lib/constants/llm-stages'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  // Story 0-11: 優化版 Prompt 導入
  getActiveExtractionPrompt,
  getPromptByVersion,
  isPromptVersionExists,
  getActivePromptVersion,
  type ExcludedItem,
  type OptimizedExtractionMetadata,
} from '@/lib/prompts'
import type {
  DocumentType,
  DocumentSubtype,
  DocumentFormatFeatures,
} from '@/types/document-format'

// Story 14-4: 動態 Prompt 整合導入
import { PromptType } from '@/types/prompt-config'
import {
  createHybridPromptProvider,
  createStaticOnlyProvider,
  type HybridPromptProvider,
} from './hybrid-prompt-provider.service'
import type { PromptResult, PromptSource } from './prompt-provider.interface'
import { shouldUseDynamicPrompt, getFeatureFlags } from '@/config/feature-flags'
import { callGatewayByModelKey } from '@/services/llm'
import { getGlobalPromptMetricsCollector } from '@/lib/metrics'

// PDF 轉圖片依賴 - 使用動態導入避免 webpack 問題
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pdfToImg: any = null

/**
 * 動態載入 pdf-to-img 模組
 */
async function loadPdfToImg() {
  if (!pdfToImg) {
    const pdfModule = await import('pdf-to-img')
    pdfToImg = pdfModule.pdf
  }
  return pdfToImg
}

// ============================================================
// Types
// ============================================================

/**
 * 發行者識別方法 - Story 0.8
 */
export type IssuerIdentificationMethod =
  | 'LOGO'
  | 'HEADER'
  | 'LETTERHEAD'
  | 'FOOTER'
  | 'AI_INFERENCE'

/**
 * 文件發行者資訊 - Story 0.8
 */
export interface DocumentIssuerInfo {
  /** 發行公司名稱（從 Logo/標題識別） */
  name: string
  /** 識別方法 */
  identificationMethod: IssuerIdentificationMethod
  /** 識別信心度 (0-100) */
  confidence: number
  /** 原始文字 */
  rawText?: string
}

/**
 * 文件格式資訊 - Story 0.9
 */
export interface DocumentFormatInfo {
  /** 文件類型 */
  documentType: DocumentType
  /** 文件子類型 */
  documentSubtype: DocumentSubtype
  /** 格式識別信心度 (0-100) */
  formatConfidence: number
  /** 格式特徵 */
  formatFeatures?: DocumentFormatFeatures
}

/**
 * Story 0-11 + Story 14-4 + Story 16.5: 處理選項
 * @description 控制 Prompt 版本、結果包含選項和動態 Prompt 設置
 */
export interface ProcessingOptions {
  /** Prompt 版本號（如 '1.0.0', '2.0.0'）- Story 0-11 */
  promptVersion?: string
  /** 是否包含排除項列表（預設 true）- Story 0-11 */
  includeExcludedItems?: boolean
  /** Story 14-4: 公司 ID（用於動態 Prompt 解析） */
  companyId?: string
  /** Story 14-4: 文件格式 ID（用於動態 Prompt 解析） */
  documentFormatId?: string
  /** Story 14-4: 文件 ID（用於追蹤） */
  documentId?: string
  /** Story 14-4: 是否強制使用靜態 Prompt（覆蓋 Feature Flag） */
  forceStaticPrompt?: boolean
  /** Story 16.5: 識別規則 Prompt（由 identification-rules-prompt-builder 生成） */
  identificationRulesPrompt?: string
}

/**
 * 提取的術語項目
 */
export interface ExtractedTerm {
  /** 原始術語 */
  term: string
  /** 正規化術語 */
  normalizedTerm: string
  /** 建議分類 */
  suggestedCategory: string
  /** 分類信心度 (0-100) */
  confidence: number
}

/**
 * 發票提取結果
 */
export interface InvoiceExtractionResult {
  /** 提取成功 */
  success: boolean
  /** 信心度 (0-1) */
  confidence: number
  /** 發票數據 */
  invoiceData?: {
    invoiceNumber?: string
    invoiceDate?: string
    dueDate?: string
    vendor?: {
      name?: string
      address?: string
      taxId?: string
    }
    buyer?: {
      name?: string
      address?: string
    }
    lineItems?: Array<{
      description?: string
      quantity?: number
      unitPrice?: number
      amount?: number
    }>
    subtotal?: number
    taxAmount?: number
    totalAmount?: number
    currency?: string
  }
  /** Story 0.8: 文件發行者識別結果 */
  documentIssuer?: DocumentIssuerInfo
  /** Story 0.9: 文件格式識別結果 */
  documentFormat?: DocumentFormatInfo
  /** Story 0.9: 提取的術語列表 */
  extractedTerms?: ExtractedTerm[]
  /** Story 0-11: 被排除的項目列表（用於調試和分析） */
  excludedItems?: ExcludedItem[]
  /** Story 0-11: 提取元數據 */
  extractionMetadata?: OptimizedExtractionMetadata
  /** 原始文字（OCR 結果） */
  rawText?: string
  /** 處理的頁數 */
  pageCount: number
  /** 錯誤信息（如果有） */
  error?: string
}

/**
 * GPT Vision 配置
 */
export interface GPTVisionConfig {
  /** Azure OpenAI Endpoint */
  endpoint?: string
  /** API Key */
  apiKey?: string
  /** 部署名稱 */
  deploymentName?: string
  /** 模型版本 */
  apiVersion?: string
  /** 最大 Token 數 */
  maxTokens?: number
}

/**
 * CHANGE-001: 分類結果（輕量模式）
 * @description 僅包含分類資訊，不含完整發票數據
 */
export interface ClassificationResult {
  /** 分類成功 */
  success: boolean
  /** 文件發行者識別結果 */
  documentIssuer?: DocumentIssuerInfo
  /** 文件格式識別結果 */
  documentFormat?: DocumentFormatInfo
  /** 處理的頁數 */
  pageCount: number
  /** 錯誤信息（如果有） */
  error?: string
}

// ============================================================
// Constants & Singleton Instances
// ============================================================

/**
 * Story 14-4: 全域 HybridPromptProvider 實例（懶加載）
 * @description
 *   用於動態/靜態 Prompt 切換的全域提供者。
 *   首次調用時自動初始化，支援度量收集。
 */
let globalPromptProvider: HybridPromptProvider | null = null

/**
 * Story 14-4: 獲取或創建全域 Prompt 提供者
 *
 * @description
 *   懶加載模式創建 HybridPromptProvider。
 *   當 Feature Flag 啟用動態 Prompt 時，會嘗試創建帶有 PromptResolver 的提供者；
 *   否則返回僅靜態模式的提供者。
 *
 * @returns HybridPromptProvider 實例
 */
function getPromptProvider(): HybridPromptProvider {
  if (!globalPromptProvider) {
    // 檢查是否需要動態 Prompt
    const featureFlags = getFeatureFlags()

    if (featureFlags.dynamicPromptEnabled) {
      // 創建帶度量收集的混合提供者
      // 注意：這裡傳入 null 作為 dynamicResolver，因為需要異步創建
      // 實際的動態解析會在 getPrompt 調用時處理
      globalPromptProvider = createHybridPromptProvider(null, {
        enableMetrics: true,
        enableDebugLogging: process.env.NODE_ENV === 'development',
        dynamicResolutionTimeoutMs: 5000,
      })

      // 設置度量收集器
      globalPromptProvider.setMetricsCollector(getGlobalPromptMetricsCollector())

      console.log('[GPT Vision] Initialized HybridPromptProvider with metrics collector')
    } else {
      // 僅靜態模式
      globalPromptProvider = createStaticOnlyProvider()
      console.log('[GPT Vision] Initialized static-only PromptProvider')
    }
  }

  return globalPromptProvider
}

/**
 * Story 14-4: 重置全域 Prompt 提供者
 * @description 主要用於測試環境
 */
export function resetPromptProvider(): void {
  globalPromptProvider = null
}

/**
 * Story 0-11: 獲取提取 Prompt（支援版本管理）
 *
 * @description
 *   根據指定版本或活動版本獲取對應的提取 Prompt。
 *   - 版本 1.0.0：原始 Legacy Prompt（基本發票提取）
 *   - 版本 2.0.0：優化版 Prompt（5 步驟結構：Region/Extract/Exclude/Examples/Verify）
 *
 * @param version - 可選的版本號
 * @returns 對應版本的 Prompt 內容
 */
const getExtractionPrompt = (version?: string): string => {
  if (version && isPromptVersionExists(version)) {
    console.log(`[GPT Vision] Using prompt version: ${version}`)
    return getPromptByVersion(version)
  }
  const activeVersion = getActivePromptVersion()
  console.log(`[GPT Vision] Using active prompt version: ${activeVersion.version}`)
  return activeVersion.prompt
}

// Story 0-11: 移除舊版 INVOICE_EXTRACTION_PROMPT 常數
// 現在使用 getExtractionPrompt(version?) 函數獲取版本管理的 Prompt
// @see src/lib/prompts/optimized-extraction-prompt.ts

/**
 * 本服務的預設模型 key（FIX-137）。
 * 原先硬編 `gpt-5.2`，但該 deployment 已於 CHANGE-102 移除 → env 未設即 404。
 * 需 vision + json schema 能力，故對應到白名單的 mini。
 */
const DEFAULT_MODEL_KEY = 'gpt-5.6-luna'

/**
 * 預設配置
 */
const DEFAULT_CONFIG: GPTVisionConfig = {
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  deploymentName: resolveDeploymentNameByKey(DEFAULT_MODEL_KEY),
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2025-03-01-preview',
  maxTokens: 4096,
}

/**
 * CHANGE-001: 分類專用提示詞
 * @description
 *   輕量級提示詞，只請求文件分類資訊：
 *   - documentIssuer: 發行者識別（LOGO/HEADER/LETTERHEAD/FOOTER）
 *   - documentFormat: 文件類型和子類型分類
 *   不請求完整發票數據，減少 token 使用和成本
 */
const CLASSIFICATION_ONLY_PROMPT = `You are an expert document classifier for freight and logistics invoices.
Analyze this document image and identify ONLY the following classification information.
Do NOT extract invoice data, line items, or amounts.

Output a JSON object with ONLY these two fields:

{
  "documentIssuer": {
    "name": "Company name that issued this document (from logo, header, or letterhead)",
    "identificationMethod": "LOGO" | "HEADER" | "LETTERHEAD" | "FOOTER" | "AI_INFERENCE",
    "confidence": 0-100,
    "rawText": "Raw text found (optional)"
  },
  "documentFormat": {
    "documentType": "INVOICE" | "DEBIT_NOTE" | "CREDIT_NOTE" | "STATEMENT" | "OTHER",
    "documentSubtype": "OCEAN" | "AIR" | "LAND" | "COURIER" | "WAREHOUSE" | "CUSTOMS" | "GENERAL",
    "formatConfidence": 0-100
  }
}

Rules:
1. For documentIssuer:
   - Look for company logos, letterhead, or prominent company names at top of document
   - Prefer LOGO > HEADER > LETTERHEAD > FOOTER > AI_INFERENCE as identification method
   - This is the company that ISSUED the document (freight forwarder/carrier), NOT the customer/buyer

2. For documentFormat:
   - INVOICE: Standard freight invoice with charges
   - DEBIT_NOTE: Additional charges or adjustments (DN)
   - CREDIT_NOTE: Refunds or credits (CN)
   - STATEMENT: Account statement or summary
   - OTHER: Cannot determine

3. For documentSubtype:
   - OCEAN: Sea freight, FCL, LCL, ocean shipping
   - AIR: Air freight, air cargo
   - LAND: Trucking, rail, land transport
   - COURIER: Express, courier services
   - WAREHOUSE: Storage, warehousing
   - CUSTOMS: Customs clearance, duties
   - GENERAL: General or mixed services

Return ONLY valid JSON, no additional text.`

// ============================================================
// Helper Functions
// ============================================================

/**
 * Story 14-4: 獲取動態或靜態 Prompt
 *
 * @description
 *   透過 HybridPromptProvider 獲取適當的 Prompt。
 *   根據 Feature Flag 和選項決定使用動態或靜態 Prompt。
 *   如果強制使用靜態 Prompt 或動態解析失敗，會自動降級。
 *
 * @param promptType - Prompt 類型（ISSUER_IDENTIFICATION, TERM_CLASSIFICATION 等）
 * @param options - 處理選項（公司 ID、文件格式 ID 等）
 * @returns Prompt 結果（包含 systemPrompt, userPrompt, source 等）
 */
async function getPromptForType(
  promptType: PromptType,
  options?: ProcessingOptions
): Promise<PromptResult> {
  const provider = getPromptProvider()

  // 如果強制使用靜態 Prompt，直接使用靜態提供者
  if (options?.forceStaticPrompt) {
    const staticProvider = createStaticOnlyProvider()
    return staticProvider.getPrompt({
      promptType,
      companyId: options?.companyId,
      documentFormatId: options?.documentFormatId,
      documentId: options?.documentId,
    })
  }

  // 使用混合提供者
  return provider.getPrompt({
    promptType,
    companyId: options?.companyId,
    documentFormatId: options?.documentFormatId,
    documentId: options?.documentId,
  })
}

/**
 * Story 14-4 + Story 16.5: 獲取分類 Prompt（ISSUER_IDENTIFICATION）
 *
 * @description
 *   專門用於 classifyDocument 的 Prompt 獲取。
 *   優先使用動態 Prompt，失敗時降級到靜態 CLASSIFICATION_ONLY_PROMPT。
 *   Story 16.5: 支援注入識別規則 Prompt。
 *
 * @param options - 處理選項
 * @returns Prompt 內容和來源資訊
 */
async function getClassificationPrompt(options?: ProcessingOptions): Promise<{
  prompt: string
  source: PromptSource
}> {
  try {
    const result = await getPromptForType(PromptType.ISSUER_IDENTIFICATION, options)

    // 合併 systemPrompt 和 userPrompt
    let combinedPrompt = result.systemPrompt
      ? `${result.systemPrompt}\n\n${result.userPrompt}`
      : result.userPrompt

    // Story 16.5: 注入識別規則 Prompt
    if (options?.identificationRulesPrompt) {
      combinedPrompt = `${combinedPrompt}\n\n${options.identificationRulesPrompt}`
      console.log(`[GPT Vision] Classification prompt injected with identification rules`)
    }

    console.log(`[GPT Vision] Classification using ${result.source} prompt`)

    return {
      prompt: combinedPrompt,
      source: result.source,
    }
  } catch (error) {
    // 降級到靜態分類 Prompt
    console.warn(
      `[GPT Vision] Failed to get dynamic classification prompt, using static: ${(error as Error).message}`
    )

    // Story 16.5: 即使降級到靜態 Prompt，也注入識別規則
    let fallbackPrompt = CLASSIFICATION_ONLY_PROMPT
    if (options?.identificationRulesPrompt) {
      fallbackPrompt = `${fallbackPrompt}\n\n${options.identificationRulesPrompt}`
      console.log(`[GPT Vision] Fallback prompt injected with identification rules`)
    }

    return {
      prompt: fallbackPrompt,
      source: 'fallback',
    }
  }
}

/**
 * Story 14-4: 獲取提取 Prompt（FIELD_EXTRACTION）
 *
 * @description
 *   專門用於 processSingleImage 的 Prompt 獲取。
 *   支援版本管理（Story 0-11）和動態 Prompt（Story 14-4）。
 *
 * @param options - 處理選項（包含 promptVersion）
 * @returns Prompt 內容和來源資訊
 */
async function getExtractionPromptWithSource(options?: ProcessingOptions): Promise<{
  prompt: string
  source: PromptSource
}> {
  // 如果指定了版本，使用版本管理的靜態 Prompt（Story 0-11 行為）
  if (options?.promptVersion) {
    console.log(`[GPT Vision] Using specified prompt version: ${options.promptVersion}`)
    return {
      prompt: getExtractionPrompt(options.promptVersion),
      source: 'static',
    }
  }

  // 嘗試使用動態 Prompt（Story 14-4）
  if (shouldUseDynamicPrompt(PromptType.FIELD_EXTRACTION)) {
    try {
      const result = await getPromptForType(PromptType.FIELD_EXTRACTION, options)

      const combinedPrompt = result.systemPrompt
        ? `${result.systemPrompt}\n\n${result.userPrompt}`
        : result.userPrompt

      console.log(`[GPT Vision] Extraction using ${result.source} prompt`)

      return {
        prompt: combinedPrompt,
        source: result.source,
      }
    } catch (error) {
      console.warn(
        `[GPT Vision] Failed to get dynamic extraction prompt, using static: ${(error as Error).message}`
      )
    }
  }

  // 降級到靜態 Prompt（Story 0-11 版本管理）
  return {
    prompt: getExtractionPrompt(),
    source: 'static',
  }
}

/**
 * 將文件轉換為 Base64
 *
 * @param filePath - 文件路徑
 * @returns Base64 編碼的圖片
 */
export async function fileToBase64(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath)
  return buffer.toString('base64')
}

/**
 * 獲取圖片的 MIME 類型
 *
 * @param filePath - 文件路徑
 * @returns MIME 類型
 */
export function getMimeType(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop()
  const mimeTypes: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    tiff: 'image/tiff',
    tif: 'image/tiff',
  }
  return mimeTypes[ext || ''] || 'image/jpeg'
}

/**
 * 檢查文件是否為 PDF
 *
 * @param filePath - 文件路徑
 * @returns 是否為 PDF 文件
 */
export function isPdfFile(filePath: string): boolean {
  const ext = filePath.toLowerCase().split('.').pop()
  return ext === 'pdf'
}

/**
 * 將 PDF 轉換為圖片 (PNG)
 *
 * @description
 *   使用 pdf-to-img 將 PDF 的每一頁轉換為 PNG 圖片。
 *   此庫專為 Node.js 設計，可正確處理掃描 PDF 中的嵌入圖片。
 *   圖片保存在臨時目錄中，需要在使用後清理。
 *
 * @param pdfPath - PDF 文件路徑
 * @returns 轉換後的圖片路徑數組和頁數
 */
export async function convertPdfToImages(pdfPath: string): Promise<{
  imagePaths: string[]
  pageCount: number
}> {
  const imagePaths: string[] = []
  const tempDir = path.join(os.tmpdir(), `pdf-images-${Date.now()}`)

  // 創建臨時目錄
  await fs.mkdir(tempDir, { recursive: true })

  try {
    // 載入 pdf-to-img 模組
    const pdf = await loadPdfToImg()

    console.log(`[GPT Vision] Converting PDF: ${path.basename(pdfPath)}`)

    // 轉換每一頁為圖片（只處理前 5 頁以避免過長處理時間）
    const maxPages = 5
    let pageNum = 0

    // pdf-to-img 使用 async iterator 模式
    for await (const image of await pdf(pdfPath, { scale: 2 })) {
      pageNum++

      if (pageNum > maxPages) {
        console.log(`[GPT Vision] Reached max pages limit (${maxPages}), skipping remaining pages`)
        break
      }

      // 保存圖片到臨時目錄
      const imagePath = path.join(tempDir, `page-${pageNum}.png`)
      await fs.writeFile(imagePath, image)
      imagePaths.push(imagePath)
    }

    console.log(`[GPT Vision] PDF converted: ${imagePaths.length} pages processed`)

    return {
      imagePaths,
      pageCount: pageNum,
    }
  } catch (error) {
    // 清理臨時目錄（如果有錯誤）
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // 忽略清理錯誤
    }
    throw error
  }
}

/**
 * 清理臨時圖片文件
 *
 * @param imagePaths - 圖片路徑數組
 */
export async function cleanupTempImages(imagePaths: string[]): Promise<void> {
  if (imagePaths.length === 0) return

  // 獲取父目錄（臨時目錄）
  const tempDir = path.dirname(imagePaths[0])

  try {
    await fs.rm(tempDir, { recursive: true, force: true })
    console.log(`[GPT Vision] Cleaned up temp directory: ${tempDir}`)
  } catch (error) {
    console.warn(`[GPT Vision] Failed to cleanup temp directory: ${tempDir}`, error)
  }
}

/**
 * 解析 GPT 回應中的 JSON
 *
 * @param content - GPT 回應內容
 * @returns 解析後的 JSON 對象
 */
function parseGPTResponse(content: string): Record<string, unknown> {
  // 嘗試直接解析
  try {
    return JSON.parse(content)
  } catch {
    // 嘗試提取 JSON 塊
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0])
    }
    throw new Error('Failed to parse GPT response as JSON')
  }
}

// ============================================================
// Core Functions
// ============================================================

/**
 * 創建 Azure OpenAI 客戶端
 *
 * @param config - 配置選項
 * @returns OpenAI 客戶端
 */
export function createClient(config: GPTVisionConfig = {}): AzureOpenAI {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config }

  if (!mergedConfig.endpoint || !mergedConfig.apiKey) {
    throw new Error('Azure OpenAI endpoint and API key are required')
  }

  return new AzureOpenAI({
    endpoint: mergedConfig.endpoint,
    apiKey: mergedConfig.apiKey,
    apiVersion: mergedConfig.apiVersion,
  })
}

/**
 * 使用 GPT-5.2 Vision 處理單張圖片
 *
 * @description
 *   將圖片發送到 GPT-5.2 Vision API 進行發票內容提取。
 *   此函數僅處理圖片文件，不處理 PDF。
 *
 *   Story 0-11: 支援 Prompt 版本管理和排除項追蹤
 *
 * @param imagePath - 圖片文件路徑
 * @param config - GPT Vision 配置選項
 * @param options - 處理選項（版本管理等）
 * @returns 提取結果（含排除項和元數據）
 */
async function processSingleImage(
  imagePath: string,
  config: GPTVisionConfig,
  options?: ProcessingOptions
): Promise<InvoiceExtractionResult> {
  // 讀取並編碼圖片
  const imageBase64 = await fileToBase64(imagePath)
  const mimeType = getMimeType(imagePath)

  // 創建客戶端
  const client = createClient(config)

  // Story 14-4: 使用動態 Prompt（如果啟用）或降級到靜態 Prompt
  const { prompt: extractionPrompt, source: promptSource } = await getExtractionPromptWithSource(options)
  console.log(`[GPT Vision] processSingleImage using ${promptSource} prompt`)

  const defaultDeployment = resolveDeploymentNameByKey(DEFAULT_MODEL_KEY)
  const deploymentName = config.deploymentName || defaultDeployment

  // Epic 23 Story 23.4 Phase 1（呼叫點 #2a）：flag 開啟且 modelKey 已播種時經 gateway；
  // 回 null（flag 關 / 未播種 / deployment 被呼叫端覆蓋）即落到下方既有直接呼叫，行為零變。
  const viaGateway =
    deploymentName === defaultDeployment
      ? await callGatewayByModelKey({
          modelKey: DEFAULT_MODEL_KEY,
          stageKey: LLM_STAGE_KEYS.VISION_EXTRACTION,
          // 刻意維持「單一 user、無 system」的既有擺法（tech-spec §3.5 G7）
          messages: [{ role: 'user', content: extractionPrompt }],
          images: [
            {
              data: `data:${mimeType};base64,${imageBase64}`,
              mediaType: mimeType,
              detail: 'high',
            },
          ],
          output: { mode: 'text' }, // 既有呼叫不帶 response_format
          maxOutputTokens: config.maxTokens,
        })
      : null

  let content: string | null | undefined

  if (viaGateway) {
    content = viaGateway.content
  } else {
    // 調用 API
    const response = await client.chat.completions.create({
      model: deploymentName,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: extractionPrompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`,
                detail: 'high',
              },
            },
          ],
        },
      ],
      max_completion_tokens: config.maxTokens,
    })

    content = response.choices[0]?.message?.content
  }

  // 解析回應
  if (!content) {
    throw new Error('Empty response from GPT-5.2 Vision')
  }

  // Story 0-11: 解析完整回應（含排除項和元數據）
  const parsedResponse = parseGPTResponseWithMetadata(content, options)

  return {
    success: true,
    confidence: parsedResponse.confidence,
    invoiceData: parsedResponse.invoiceData as InvoiceExtractionResult['invoiceData'],
    pageCount: 1,
    excludedItems: parsedResponse.excludedItems,
    extractionMetadata: parsedResponse.extractionMetadata,
  }
}

/**
 * 解析 GPT 回應並提取元數據（Story 0-11）
 *
 * @description
 *   從 GPT-5.2 Vision 回應中解析發票數據、排除項和元數據。
 *   支援優化版 Prompt 的新輸出格式。
 *
 * @param content - GPT 回應內容
 * @param options - 處理選項
 * @returns 解析後的結果
 */
function parseGPTResponseWithMetadata(
  content: string,
  options?: ProcessingOptions
): {
  invoiceData: Record<string, unknown>
  confidence: number
  excludedItems?: ExcludedItem[]
  extractionMetadata?: OptimizedExtractionMetadata
} {
  // 基本解析
  const invoiceData = parseGPTResponse(content)

  // 嘗試解析完整 JSON（包含 metadata 和 excludedItems）
  try {
    // 提取 JSON 部分
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const fullResponse = JSON.parse(jsonMatch[0])

      // 提取信心度
      let confidence = 0.9 // 預設值
      if (fullResponse.invoiceMetadata?.extractionConfidence) {
        confidence = fullResponse.invoiceMetadata.extractionConfidence
      }

      // 提取排除項（如果啟用）
      let excludedItems: ExcludedItem[] | undefined
      if (options?.includeExcludedItems !== false && fullResponse.excludedItems) {
        const parsedExcludedItems: ExcludedItem[] = fullResponse.excludedItems.map(
          (item: { text: string; reason: string; region?: string }) => ({
            text: item.text,
            reason: item.reason,
            region: (item.region || 'unknown') as 'header' | 'lineItems' | 'footer' | 'unknown',
          })
        )
        excludedItems = parsedExcludedItems
        console.log(`[GPT Vision] Excluded ${parsedExcludedItems.length} items from extraction`)
      }

      // 構建元數據
      const extractionMetadata: OptimizedExtractionMetadata = {
        regionsIdentified: fullResponse.invoiceMetadata?.regionsIdentified || [],
        lineItemsTableFound: fullResponse.invoiceMetadata?.lineItemsTableFound ?? true,
        extractionConfidence: confidence,
        promptVersion: getActivePromptVersion().version,
        excludedItems,
      }

      return {
        invoiceData,
        confidence,
        excludedItems,
        extractionMetadata,
      }
    }
  } catch (_parseError) {
    // Story 0-11: 捕獲解析錯誤但不使用（使用 _ 前綴標記）
    console.warn('[GPT Vision] Could not parse full metadata, using basic extraction')
  }

  // 回退到基本解析結果
  return {
    invoiceData,
    confidence: 0.9,
  }
}

/**
 * 使用 GPT-5.2 Vision 處理圖片或 PDF
 *
 * @description
 *   將圖片或 PDF 發送到 GPT-5.2 Vision API 進行發票內容提取。
 *   如果是 PDF 文件，會先轉換為圖片再處理。
 *
 *   Story 0-11: 支援 Prompt 版本管理和排除項追蹤
 *
 * @param imagePath - 圖片或 PDF 文件路徑
 * @param config - GPT Vision 配置選項
 * @param options - 處理選項（版本管理、排除項等）
 * @returns 提取結果（含排除項和元數據）
 *
 * @example
 * ```typescript
 * // 使用預設活動版本
 * const result = await processImageWithVision('/path/to/invoice.jpg')
 *
 * // 使用指定 Prompt 版本
 * const result = await processImageWithVision('/path/to/invoice.jpg', {}, {
 *   promptVersion: '2.0.0',
 *   includeExcludedItems: true
 * })
 *
 * if (result.success) {
 *   console.log(result.invoiceData)
 *   console.log('Excluded items:', result.excludedItems)
 * }
 * ```
 */
export async function processImageWithVision(
  imagePath: string,
  config: GPTVisionConfig = {},
  options?: ProcessingOptions
): Promise<InvoiceExtractionResult> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config }
  let tempImagePaths: string[] = []

  try {
    // 檢查配置
    if (!mergedConfig.endpoint || !mergedConfig.apiKey) {
      // 如果沒有配置，返回模擬結果
      console.warn('GPT Vision: Azure OpenAI not configured, using mock response')
      return createMockResult(imagePath)
    }

    // 檢查是否為 PDF 文件
    if (isPdfFile(imagePath)) {
      console.log(`[GPT Vision] Detected PDF file, converting to images: ${path.basename(imagePath)}`)

      // 將 PDF 轉換為圖片
      const { imagePaths, pageCount } = await convertPdfToImages(imagePath)
      tempImagePaths = imagePaths

      if (imagePaths.length === 0) {
        throw new Error('Failed to extract images from PDF')
      }

      console.log(`[GPT Vision] Processing first page of ${pageCount} pages`)

      // 處理第一頁（通常包含主要發票資訊）- Story 0-11: 傳遞 options
      const result = await processSingleImage(imagePaths[0], mergedConfig, options)
      result.pageCount = pageCount

      return result
    }

    // 直接處理圖片文件 - Story 0-11: 傳遞 options
    return await processSingleImage(imagePath, mergedConfig, options)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('GPT Vision processing error:', errorMessage)

    return {
      success: false,
      confidence: 0,
      pageCount: 0,
      error: errorMessage,
    }
  } finally {
    // 清理臨時圖片文件
    if (tempImagePaths.length > 0) {
      await cleanupTempImages(tempImagePaths)
    }
  }
}

/**
 * 創建模擬結果（用於測試）
 *
 * @param imagePath - 圖片路徑
 * @returns 模擬的提取結果
 */
function createMockResult(imagePath: string): InvoiceExtractionResult {
  return {
    success: true,
    confidence: 0.85,
    invoiceData: {
      invoiceNumber: `INV-${Date.now().toString(36).toUpperCase()}`,
      invoiceDate: new Date().toISOString().split('T')[0],
      vendor: {
        name: 'Sample Freight Forwarder Ltd.',
        address: '123 Shipping Lane, Hong Kong',
      },
      lineItems: [
        {
          description: 'Ocean Freight - FCL 40HC',
          quantity: 1,
          unitPrice: 2500,
          amount: 2500,
        },
        {
          description: 'Terminal Handling Charge',
          quantity: 1,
          unitPrice: 150,
          amount: 150,
        },
      ],
      subtotal: 2650,
      taxAmount: 0,
      totalAmount: 2650,
      currency: 'USD',
    },
    pageCount: 1,
    rawText: `[Mock OCR: ${imagePath}]`,
  }
}

/**
 * 處理多頁圖片
 *
 * @description
 *   處理多頁 PDF 轉換出的圖片集合。
 *
 * @param imagePaths - 圖片路徑數組
 * @param config - 配置選項
 * @returns 合併的提取結果
 */
export async function processMultipleImages(
  imagePaths: string[],
  config: GPTVisionConfig = {}
): Promise<InvoiceExtractionResult> {
  if (imagePaths.length === 0) {
    return {
      success: false,
      confidence: 0,
      pageCount: 0,
      error: 'No images to process',
    }
  }

  // 處理第一頁（通常包含主要發票資訊）
  const result = await processImageWithVision(imagePaths[0], config)

  // 更新頁數
  result.pageCount = imagePaths.length

  return result
}

/**
 * CHANGE-001: 文件分類（輕量模式）
 *
 * @description
 *   僅執行文件分類，不提取完整發票數據。
 *   用於 Native PDF 雙重處理的第一階段：
 *   - 識別 documentIssuer（LOGO/HEADER/LETTERHEAD/FOOTER）
 *   - 識別 documentFormat（Invoice/DN/CN + Ocean/Air/Land）
 *
 *   此方法比 processImageWithVision 成本更低（~$0.01/頁 vs ~$0.03/頁），
 *   因為只請求分類資訊，不請求完整發票數據。
 *
 * @param filePath - 文件路徑（支援 PDF 和圖片）
 * @param config - 配置選項
 * @returns 分類結果
 *
 * @example
 * ```typescript
 * const result = await classifyDocument('/path/to/invoice.pdf')
 * if (result.success) {
 *   console.log('Issuer:', result.documentIssuer?.name)
 *   console.log('Type:', result.documentFormat?.documentType)
 * }
 * ```
 */
export async function classifyDocument(
  filePath: string,
  config: GPTVisionConfig = {},
  options?: ProcessingOptions
): Promise<ClassificationResult> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config }
  // 使用較少的 tokens 因為只需要分類
  mergedConfig.maxTokens = 1024
  let tempImagePaths: string[] = []

  try {
    // 檢查配置
    if (!mergedConfig.endpoint || !mergedConfig.apiKey) {
      console.warn('[GPT Vision] Azure OpenAI not configured, using mock classification')
      return createMockClassificationResult()
    }

    let imagePath = filePath

    // 檢查是否為 PDF 文件
    if (isPdfFile(filePath)) {
      console.log(`[GPT Vision] Classification: Converting PDF to image: ${path.basename(filePath)}`)

      // 將 PDF 轉換為圖片（只處理第一頁用於分類）
      const { imagePaths, pageCount } = await convertPdfToImages(filePath)
      tempImagePaths = imagePaths

      if (imagePaths.length === 0) {
        throw new Error('Failed to extract images from PDF for classification')
      }

      console.log(`[GPT Vision] Classification: Using first page of ${pageCount} pages`)
      imagePath = imagePaths[0]
    }

    // 讀取並編碼圖片
    const imageBase64 = await fileToBase64(imagePath)
    const mimeType = getMimeType(imagePath)

    // 創建客戶端
    const client = createClient(mergedConfig)

    // Story 14-4: 使用動態 Prompt（如果啟用）或降級到靜態 Prompt
    const { prompt: classificationPrompt, source: promptSource } = await getClassificationPrompt(options)
    console.log(`[GPT Vision] Classification: Using ${promptSource} prompt for document classification`)

    const defaultDeployment = resolveDeploymentNameByKey(DEFAULT_MODEL_KEY)
    const deploymentName = mergedConfig.deploymentName || defaultDeployment

    // Epic 23 Story 23.4 Phase 1（呼叫點 #2b）：flag 開啟且 modelKey 已播種時經 gateway；
    // 回 null（flag 關 / 未播種 / deployment 被呼叫端覆蓋）即落到下方既有直接呼叫，行為零變。
    const viaGateway =
      deploymentName === defaultDeployment
        ? await callGatewayByModelKey({
            modelKey: DEFAULT_MODEL_KEY,
            stageKey: LLM_STAGE_KEYS.VISION_CLASSIFICATION,
            // 刻意維持「單一 user、無 system」的既有擺法（tech-spec §3.5 G7）
            messages: [{ role: 'user', content: classificationPrompt }],
            images: [
              {
                data: `data:${mimeType};base64,${imageBase64}`,
                mediaType: mimeType,
                detail: 'low', // 使用 low detail 減少成本
              },
            ],
            output: { mode: 'text' }, // 既有呼叫不帶 response_format
            maxOutputTokens: mergedConfig.maxTokens,
          })
        : null

    let content: string | null | undefined

    if (viaGateway) {
      content = viaGateway.content
    } else {
      // 調用 API（使用分類專用提示詞）
      const response = await client.chat.completions.create({
        model: deploymentName,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: classificationPrompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${imageBase64}`,
                  detail: 'low', // 使用 low detail 減少成本
                },
              },
            ],
          },
        ],
        max_completion_tokens: mergedConfig.maxTokens,
      })

      content = response.choices[0]?.message?.content
    }

    // 解析回應
    if (!content) {
      throw new Error('Empty response from GPT Vision for classification')
    }

    const classificationData = parseGPTResponse(content) as {
      documentIssuer?: DocumentIssuerInfo
      documentFormat?: DocumentFormatInfo
    }

    console.log(`[GPT Vision] Classification successful: ${classificationData.documentIssuer?.name || 'Unknown'} - ${classificationData.documentFormat?.documentType || 'Unknown'}`)

    return {
      success: true,
      documentIssuer: classificationData.documentIssuer,
      documentFormat: classificationData.documentFormat,
      pageCount: tempImagePaths.length > 0 ? tempImagePaths.length : 1,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('[GPT Vision] Classification error:', errorMessage)

    return {
      success: false,
      pageCount: 0,
      error: errorMessage,
    }
  } finally {
    // 清理臨時圖片文件
    if (tempImagePaths.length > 0) {
      await cleanupTempImages(tempImagePaths)
    }
  }
}

/**
 * CHANGE-001: 創建模擬分類結果（用於測試）
 *
 * @returns 模擬的分類結果
 */
function createMockClassificationResult(): ClassificationResult {
  return {
    success: true,
    documentIssuer: {
      name: 'Sample Freight Forwarder Ltd.',
      identificationMethod: 'HEADER',
      confidence: 85,
      rawText: 'SAMPLE FREIGHT FORWARDER LTD.',
    },
    documentFormat: {
      documentType: 'INVOICE' as DocumentType,
      documentSubtype: 'OCEAN' as DocumentSubtype,
      formatConfidence: 90,
    },
    pageCount: 1,
  }
}

/**
 * 驗證 Azure OpenAI 配置
 *
 * @returns 配置是否有效
 */
export function validateConfig(): {
  valid: boolean
  missing: string[]
} {
  const missing: string[] = []

  if (!process.env.AZURE_OPENAI_ENDPOINT) {
    missing.push('AZURE_OPENAI_ENDPOINT')
  }
  if (!process.env.AZURE_OPENAI_API_KEY) {
    missing.push('AZURE_OPENAI_API_KEY')
  }

  return {
    valid: missing.length === 0,
    missing,
  }
}
