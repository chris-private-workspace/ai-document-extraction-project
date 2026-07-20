/**
 * @fileoverview Stage 2 - 格式識別服務
 * @description
 *   使用 GPT-5-nano 識別文件格式：
 *   - 輸入：文件圖片 + Stage 1 公司識別結果
 *   - 配置決策：公司特定 → 統一格式 → LLM 推斷
 *   - 模型：GPT-5-nano（成本低、速度快）
 *   - 輸出：formatId, formatName, confidence, isNewFormat, configSource
 *
 *   CHANGE-026：整合 PromptConfig 可配置化
 *   - 優先使用 PromptConfig 表的自定義配置
 *   - 支援變數替換（${knownFormats}, ${companyName} 等）
 *   - 無配置時回退到硬編碼 Prompt
 *
 * @module src/services/extraction-v3/stages/stage-2-format.service
 * @since CHANGE-024 - Three-Stage Extraction Architecture
 * @lastModified 2026-05-31
 *
 *   FIX-058：jitCreateFormat 改為 find-or-create（先查唯一鍵
 *   (companyId, documentType, documentSubtype)），避免同公司第 2+ 份文件
 *   重複建立 (INVOICE, GENERAL) 格式撞唯一約束導致 OCR_FAILED
 *
 * @features
 *   - 分層配置查詢：公司特定 → 統一格式 → LLM 推斷
 *   - 配置來源追蹤（COMPANY_SPECIFIC / UNIVERSAL / LLM_INFERRED）
 *   - 低解析度圖片模式以降低成本
 *   - 完整的 AI 詳情記錄
 *   - CHANGE-026: PromptConfig 可配置化支援
 *
 * @dependencies
 *   - UnifiedGptExtractionService - GPT 調用服務
 *   - PrismaClient - 格式配置查詢
 *   - PromptAssemblyService - 載入 PromptConfig
 *
 * @related
 *   - src/types/extraction-v3.types.ts - Stage2FormatResult 類型
 *   - src/services/extraction-v3/stages/stage-1-company.service.ts
 *   - src/services/extraction-v3/prompt-assembly.service.ts - Prompt 組裝服務
 */

import { PrismaClient } from '@prisma/client';
import type {
  Stage1CompanyResult,
  Stage2FormatResult,
  StageAiDetails,
  FormatPatternForPrompt,
  FormatConfigSource,
} from '@/types/extraction-v3.types';
import { GptCallerService, type GptCallResult } from './gpt-caller.service';
import { LlmModelConfigService } from '@/services/llm-model-config.service';
// CHANGE-026: PromptConfig 整合
import { loadStage2PromptConfig, type StagePromptConfig } from '../prompt-assembly.service';
import {
  replaceVariables,
  buildStage2VariableContext,
  type VariableContext,
} from '../utils/variable-replacer';

// ============================================================================
// Types
// ============================================================================

/**
 * Stage 2 輸入參數
 */
export interface Stage2Input {
  /** Base64 編碼的圖片陣列 */
  imageBase64Array: string[];
  /** Stage 1 公司識別結果 */
  stage1Result: Stage1CompanyResult;
  /** 選項 */
  options?: Stage2Options;

  // CHANGE-026: PromptConfig 載入參數
  /** 檔案名稱（用於變數替換） */
  fileName?: string;
  /** 格式 ID（用於載入 FORMAT 範圍配置） */
  formatId?: string;
}

/**
 * Stage 2 選項
 */
export interface Stage2Options {
  /** 是否自動創建格式（預設 true） */
  autoCreateFormat?: boolean;
}

/**
 * 格式配置載入結果
 */
interface FormatConfigLoadResult {
  /** 配置來源 */
  source: FormatConfigSource;
  /** 格式模式列表 */
  formats: FormatPatternForPrompt[];
  /** 使用的配置 ID */
  usedConfigId?: string;
  /** 該公司的格式配置數量 */
  companyFormatCount?: number;
}

/**
 * GPT 格式識別響應結構
 */
interface GptFormatIdentificationResponse {
  formatName: string;
  confidence: number;
  matchedKnownFormat: string | null;
  formatCharacteristics: string[];
}

// ============================================================================
// Service Class
// ============================================================================

/**
 * Stage 2 格式識別服務
 * @description 使用 GPT-5-nano 識別文件格式，支援分層配置查詢
 * @since CHANGE-024
 */
export class Stage2FormatService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * 執行格式識別
   * @param input Stage 2 輸入參數
   * @returns Stage 2 結果
   */
  async execute(input: Stage2Input): Promise<Stage2FormatResult> {
    const startTime = Date.now();
    const { stage1Result } = input;
    let promptConfigUsed: StagePromptConfig | null = null;

    try {
      // 1. 根據公司查詢格式配置（分層決策）
      const formatConfig = await this.loadFormatConfig(stage1Result.companyId);

      // CHANGE-026: 嘗試載入自定義 PromptConfig
      const customConfig = await this.loadCustomPromptConfig(
        stage1Result.companyId,
        input.formatId
      );

      // 2. 組裝格式識別 Prompt
      let prompt: { system: string; user: string };

      if (customConfig) {
        // 使用自定義配置 + 變數替換
        promptConfigUsed = customConfig;
        const variableContext = this.buildVariableContextForConfig(input, formatConfig);
        prompt = {
          system: replaceVariables(customConfig.systemPrompt, variableContext),
          user: replaceVariables(customConfig.userPromptTemplate, variableContext),
        };
        console.log(
          `[Stage2] Using custom PromptConfig (scope: ${customConfig.scope}, version: ${customConfig.version})`
        );
      } else {
        // 回退到硬編碼（現有邏輯）
        prompt = this.buildFormatIdentificationPrompt(formatConfig);
        console.log('[Stage2] Using default hardcoded prompt (no custom config found)');
      }

      // 3. 調用 GPT-5-nano
      const gptResult = await this.callGptNano(prompt, input.imageBase64Array);

      // 4. 解析結果
      const parsed = this.parseFormatResult(gptResult.response);

      // 5. 解析格式 ID（從資料庫匹配或 JIT 創建）
      const resolved = await this.resolveFormatId(
        parsed,
        stage1Result.companyId,
        input.options
      );

      return {
        stageName: 'STAGE_2_FORMAT_IDENTIFICATION',
        success: true,
        durationMs: Date.now() - startTime,
        formatId: resolved.formatId,
        formatName: resolved.formatName,
        confidence: parsed.confidence,
        isNewFormat: resolved.isNewFormat,
        configSource: formatConfig.source,
        configUsed: {
          formatConfigId: formatConfig.usedConfigId,
          companyConfigCount: formatConfig.companyFormatCount,
        },
        aiDetails: this.buildAiDetails(gptResult, prompt, Date.now() - startTime),
        // CHANGE-026: 記錄使用的配置來源
        promptConfigUsed: promptConfigUsed
          ? { scope: promptConfigUsed.scope, version: promptConfigUsed.version }
          : undefined,
      };
    } catch (error) {
      return {
        stageName: 'STAGE_2_FORMAT_IDENTIFICATION',
        success: false,
        durationMs: Date.now() - startTime,
        formatName: '',
        confidence: 0,
        isNewFormat: false,
        configSource: 'LLM_INFERRED',
        aiDetails: this.buildEmptyAiDetails(),
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * CHANGE-026: 載入自定義 PromptConfig
   */
  private async loadCustomPromptConfig(
    companyId?: string,
    formatId?: string
  ): Promise<StagePromptConfig | null> {
    try {
      return await loadStage2PromptConfig({ companyId, formatId });
    } catch (error) {
      console.warn('[Stage2] Failed to load PromptConfig, using default:', error);
      return null;
    }
  }

  /**
   * CHANGE-026: 構建變數上下文（用於自定義配置）
   */
  private buildVariableContextForConfig(
    input: Stage2Input,
    formatConfig: FormatConfigLoadResult
  ): VariableContext {
    return buildStage2VariableContext({
      companyName: input.stage1Result.companyName,
      companyAliases: [], // 可從 DB 載入
      knownFormats: formatConfig.formats.map((f) => ({
        name: f.formatName,
        description: f.patterns?.join(', ') || null,
      })),
      fileName: input.fileName,
      pageCount: input.imageBase64Array.length,
    });
  }

  /**
   * 載入格式配置（核心分層決策流程）
   * @description 實現 CHANGE-024 的配置決策流程：
   *   1. 公司特定配置（優先）
   *   2. 統一格式配置（fallback）
   *   3. LLM 自行推斷（最後手段）
   */
  private async loadFormatConfig(
    companyId?: string
  ): Promise<FormatConfigLoadResult> {
    // 1. 嘗試載入公司特定格式配置
    if (companyId) {
      const companyFormats = await this.prisma.documentFormat.findMany({
        where: { companyId },
        select: {
          id: true,
          name: true,
          documentType: true,
          documentSubtype: true,
          features: true,
          commonTerms: true,
          identificationRules: true,
        },
      });

      if (companyFormats.length > 0) {
        return {
          source: 'COMPANY_SPECIFIC',
          formats: companyFormats.map((f) => this.toFormatPattern(f)),
          companyFormatCount: companyFormats.length,
        };
      }
    }

    // 2. 沒有公司特定配置 → 返回 LLM 推斷
    // 注意：DocumentFormat 的 companyId 是必填欄位，沒有「統一格式」的概念
    // 如果需要統一格式，應該從其他來源獲取

    // 3. 都沒有 → LLM 自行判斷
    return {
      source: 'LLM_INFERRED',
      formats: [],
    };
  }

  /**
   * 將資料庫格式轉換為 Prompt 用格式模式
   */
  private toFormatPattern(format: {
    id: string;
    name: string | null;
    documentType: unknown;
    documentSubtype: unknown;
    features: unknown;
    commonTerms: string[];
    identificationRules: unknown;
  }): FormatPatternForPrompt {
    const features = (format.features as { typicalFields?: string[] } | null)
      ?.typicalFields || [];
    const commonTerms = format.commonTerms || [];
    const rules = format.identificationRules as { keywords?: string[] } | null;

    return {
      formatId: format.id,
      formatName: format.name || `Format-${format.id.slice(0, 8)}`,
      patterns: rules?.keywords || features,
      keywords: commonTerms,
    };
  }

  /**
   * 組裝格式識別 Prompt
   */
  private buildFormatIdentificationPrompt(config: FormatConfigLoadResult): {
    system: string;
    user: string;
  } {
    const hasKnownFormats = config.formats.length > 0;

    const formatList = hasKnownFormats
      ? config.formats
          .map(
            (f) =>
              `- ${f.formatName}: ${f.patterns?.join(', ') || 'No patterns'}`
          )
          .join('\n')
      : '';

    return {
      system: `You are an invoice format identification specialist for freight and logistics documents.
Your task is to identify the format/template of this document by analyzing its visual layout and structure.

Key aspects to observe:
1. Overall layout: header position, table structure, footer information, page orientation
2. Line items arrangement: table format vs list format vs free-form text
3. Date and amount display formats (DD/MM/YYYY vs MM/DD/YYYY, decimal separators, thousand separators)
4. Distinctive elements: watermarks, logos placement, document numbering patterns, barcodes
5. Company branding: color schemes, fonts, specific section arrangements

${hasKnownFormats
  ? `Known formats (${config.source}):\n${formatList}\n\nFirst try to match against these known formats. If no match, describe the format characteristics for future identification.`
  : 'No known formats available. Describe the format characteristics in detail for future identification.'}

Response format (JSON):
{
  "formatName": "string - identified format name (e.g., 'DHL Standard Invoice', 'Maersk Freight Note')",
  "confidence": number (0-100),
  "matchedKnownFormat": "string | null - name of matched known format, null if new format",
  "formatCharacteristics": ["array of observed format characteristics, e.g., 'landscape table layout', 'logo at top-right', 'bank details in footer'"]
}`,
      user: `Analyze this document image and identify its format/template type.
Focus on the visual layout, table structure, and distinctive formatting elements rather than the content data.`,
    };
  }

  /**
   * 調用 GPT-5-nano
   * @description 使用 GptCallerService 調用 GPT-5-nano 進行格式識別
   */
  private async callGptNano(
    prompt: { system: string; user: string },
    images: string[]
  ): Promise<{
    response: string;
    tokenUsage: { input: number; output: number; total: number };
    model: string;
  }> {
    const modelKey = await LlmModelConfigService.getStageModel('stage2');
    const result: GptCallResult = await GptCallerService.callModel(
      modelKey,
      prompt.system,
      prompt.user,
      images
    );

    if (!result.success) {
      throw new Error(result.error || 'GPT-5-nano 調用失敗');
    }

    // 檢查響應是否為空（GPT-5-nano 可能將所有 token 用於 reasoning）
    if (!result.response || result.response.trim() === '') {
      throw new Error('GPT-5-nano 返回空響應（可能 maxTokens 不足）');
    }

    return {
      response: result.response,
      tokenUsage: result.tokenUsage,
      model: result.model,
    };
  }

  /**
   * 解析 GPT 響應
   *
   * @description
   *   嘗試多種方式解析 GPT 響應：
   *   1. 直接 JSON.parse
   *   2. 提取 markdown 代碼塊中的 JSON
   *   3. 提取任意 JSON 塊（處理額外文字）
   */
  private parseFormatResult(
    response: string
  ): GptFormatIdentificationResponse {
    // 1. 嘗試直接解析
    try {
      const parsed = JSON.parse(response) as GptFormatIdentificationResponse;
      return this.extractFormatFromParsed(parsed);
    } catch {
      // 繼續嘗試其他方法
    }

    // 2. 嘗試提取 markdown 代碼塊 ```json ... ```
    const markdownMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    if (markdownMatch) {
      try {
        const parsed = JSON.parse(markdownMatch[1]) as GptFormatIdentificationResponse;
        return this.extractFormatFromParsed(parsed);
      } catch {
        // 繼續嘗試其他方法
      }
    }

    // 3. 嘗試提取任意 JSON 塊（處理額外文字）
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as GptFormatIdentificationResponse;
        return this.extractFormatFromParsed(parsed);
      } catch {
        // 繼續拋出錯誤
      }
    }

    console.error('[Stage2] Failed to parse GPT response:', response.substring(0, 500));
    throw new Error(`Failed to parse GPT format identification response: ${response.substring(0, 200)}`);
  }

  /**
   * 從解析後的物件提取格式資訊
   */
  private extractFormatFromParsed(parsed: unknown): GptFormatIdentificationResponse {
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid parsed response');
    }

    const obj = parsed as Record<string, unknown>;

    return {
      formatName: String(obj.formatName || ''),
      confidence: Number(obj.confidence) || 0,
      matchedKnownFormat: (obj.matchedKnownFormat as string) || null,
      formatCharacteristics: (obj.formatCharacteristics as string[]) || [],
    };
  }

  /**
   * 解析格式 ID（從資料庫匹配或 JIT 創建）
   */
  private async resolveFormatId(
    parsed: GptFormatIdentificationResponse,
    companyId?: string,
    options?: Stage2Options
  ): Promise<{
    formatId?: string;
    formatName: string;
    isNewFormat: boolean;
  }> {
    // 1. 嘗試匹配已知格式（需要 companyId）
    // FIX-120: DocumentFormat 的唯一鍵是 (companyId, documentType, documentSubtype)，
    //          name 並非唯一，同公司可能有同名格式 → 加 orderBy 確保選擇具決定性。
    if (parsed.matchedKnownFormat && companyId) {
      const format = await this.prisma.documentFormat.findFirst({
        where: {
          name: parsed.matchedKnownFormat,
          companyId,
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true },
      });

      if (format) {
        return {
          formatId: format.id,
          formatName: format.name || parsed.matchedKnownFormat,
          isNewFormat: false,
        };
      }
    }

    // 2. 嘗試模糊匹配（需要 companyId 且 formatName 非空）
    //
    // FIX-120: 原本未檢查 parsed.formatName 是否為空即執行模糊比對。
    //   GPT 回傳 `"formatName": null` 時，extractFormatFromParsed 會轉成空字串（`String(null || '')`），
    //   而 `contains: ''` 對每一筆記錄都成立 —— 條件恆真，等同「撈該公司任一格式」。
    //   結果：GPT 明明什麼都沒匹配到，卻靜默回傳一個任意格式並標記 isNewFormat: false，
    //   在下游看起來與「成功匹配」無法區分。
    //   正確行為是讓它往下走（JIT 建立，或回傳 isNewFormat: true 且無 formatId）。
    const fuzzyTerm = parsed.formatName?.trim();
    if (companyId && fuzzyTerm) {
      const fuzzyMatch = await this.prisma.documentFormat.findFirst({
        where: {
          name: { contains: fuzzyTerm, mode: 'insensitive' },
          companyId,
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true },
      });

      if (fuzzyMatch) {
        return {
          formatId: fuzzyMatch.id,
          formatName: fuzzyMatch.name || fuzzyTerm,
          isNewFormat: false,
        };
      }
    }

    // 3. 如果允許自動創建，則 JIT 創建格式
    if (options?.autoCreateFormat !== false && parsed.formatName && companyId) {
      const newFormat = await this.jitCreateFormat(
        parsed.formatName,
        companyId,
        parsed.formatCharacteristics
      );
      return {
        formatId: newFormat.id,
        formatName: newFormat.name,
        isNewFormat: true,
      };
    }

    return {
      formatId: undefined,
      formatName: parsed.formatName,
      isNewFormat: true,
    };
  }

  /**
   * JIT 創建格式
   * @description Just-in-Time 創建新格式記錄
   */
  private async jitCreateFormat(
    formatName: string,
    companyId: string,
    characteristics: string[]
  ): Promise<{ id: string; name: string }> {
    const documentType = 'INVOICE' as const;
    const documentSubtype = 'GENERAL' as const; // 使用 GENERAL 作為預設子類型

    // FIX-058: 先以唯一鍵 (companyId, documentType, documentSubtype) 查找既有格式，
    //          避免重複 create 撞唯一約束（同公司同 type/subtype 的第 2+ 份文件）
    const existing = await this.prisma.documentFormat.findFirst({
      where: { companyId, documentType, documentSubtype },
      select: { id: true, name: true },
    });

    if (existing) {
      return {
        id: existing.id,
        name: existing.name || formatName,
      };
    }

    const newFormat = await this.prisma.documentFormat.create({
      data: {
        name: formatName,
        companyId,
        documentType,
        documentSubtype,
        commonTerms: [],
        identificationRules: {
          keywords: characteristics,
        },
        features: {
          typicalFields: [],
          formatCharacteristics: characteristics,
        },
      },
      select: {
        id: true,
        name: true,
      },
    });

    return {
      id: newFormat.id,
      name: newFormat.name || formatName,
    };
  }

  /**
   * 構建 AI 詳情
   */
  private buildAiDetails(
    gptResult: {
      response: string;
      tokenUsage: { input: number; output: number; total: number };
      model: string;
    },
    prompt: { system: string; user: string },
    durationMs: number
  ): StageAiDetails {
    // 組合完整 Prompt（System + User）
    const fullPrompt = `[SYSTEM]\n${prompt.system}\n\n[USER]\n${prompt.user}`;

    return {
      stage: 'STAGE_2',
      model: gptResult.model,
      prompt: fullPrompt,
      response: gptResult.response,
      tokenUsage: gptResult.tokenUsage,
      imageDetailMode: 'low',
      durationMs,
    };
  }

  /**
   * 構建空的 AI 詳情（用於錯誤情況）
   */
  private buildEmptyAiDetails(): StageAiDetails {
    return {
      stage: 'STAGE_2',
      model: '',
      prompt: '',
      response: '',
      tokenUsage: { input: 0, output: 0, total: 0 },
      durationMs: 0,
    };
  }
}
