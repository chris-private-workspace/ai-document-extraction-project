/**
 * @fileoverview Stage 1 - 公司識別服務
 * @description
 *   使用 GPT-5-nano 識別文件發行公司：
 *   - 輸入：文件圖片 + 已知公司列表
 *   - 模型：GPT-5-nano（成本低、速度快）
 *   - 輸出：companyId, companyName, confidence, isNewCompany
 *
 *   CHANGE-026：整合 PromptConfig 可配置化
 *   - 優先使用 PromptConfig 表的自定義配置
 *   - 支援變數替換（${knownCompanies}, ${currentDate} 等）
 *   - 無配置時回退到硬編碼 Prompt
 *
 * @module src/services/extraction-v3/stages/stage-1-company.service
 * @since CHANGE-024 - Three-Stage Extraction Architecture
 * @lastModified 2026-06-16
 *
 *   FIX-057：強化公司配對（resolveCompanyId）
 *   - 後備配對加入 nameVariants 精確比對 + 公司名正規化比對（移除 LTD./標點）
 *   - 解決「DB 存短名 vs 發票印法定全名」無法配對、每份文件 JIT 增生重複公司的問題
 *
 *   FIX-077：公司識別飄移 / JIT 增生重複公司（FIX-057 後續強化）
 *   - 強化 normalizeCompanyName：移除括號地區詞 (HK)/(Hong Kong)、取「/ 別名」前主名、移除業務描述詞 OPERATIONS
 *   - resolveCompanyId 在 JIT 前加入 findDuplicateCompany 重複防護（查所有狀態 + 保守相似度）
 *   - 解決同一張發票多次上傳因 GPT 輸出寫法飄移而每次新建重複公司的問題
 *
 * @features
 *   - 公司識別方法：LOGO / HEADER / ADDRESS / TAX_ID / LLM_INFERRED
 *   - 支援已知公司列表匹配
 *   - 低解析度圖片模式以降低成本
 *   - 完整的 AI 詳情記錄
 *   - CHANGE-026: PromptConfig 可配置化支援
 *
 * @dependencies
 *   - UnifiedGptExtractionService - GPT 調用服務
 *   - PrismaClient - 公司 ID 解析
 *   - PromptAssemblyService - 載入 PromptConfig
 *
 * @related
 *   - src/types/extraction-v3.types.ts - Stage1CompanyResult 類型
 *   - src/services/extraction-v3/unified-gpt-extraction.service.ts
 *   - src/services/extraction-v3/prompt-assembly.service.ts - Prompt 組裝服務
 */

import { PrismaClient } from '@prisma/client';
import type {
  Stage1CompanyResult,
  StageAiDetails,
  KnownCompanyForPrompt,
  CompanyIdentificationMethod,
} from '@/types/extraction-v3.types';
import { GptCallerService, type GptCallResult } from './gpt-caller.service';
// CHANGE-026: PromptConfig 整合
import { loadStage1PromptConfig, type StagePromptConfig } from '../prompt-assembly.service';
import {
  replaceVariables,
  buildStage1VariableContext,
  type VariableContext,
} from '../utils/variable-replacer';
// FIX-077: 公司名相似度（沿用既有 similarity 工具，避免新增依賴）
import { levenshteinSimilarity } from '@/services/similarity';

// ============================================================================
// Constants
// ============================================================================

/**
 * FIX-077: 公司名正規化後的相似度配對門檻
 * @description
 *   用於 JIT 前重複防護的保守門檻；值越高越嚴格（避免誤併不同公司）。
 *   0.85 表示正規化字串需高度相近才視為同一公司。
 */
const COMPANY_NAME_SIMILARITY_THRESHOLD = 0.85;

// ============================================================================
// Types
// ============================================================================

/**
 * Stage 1 輸入參數
 */
export interface Stage1Input {
  /** Base64 編碼的圖片陣列 */
  imageBase64Array: string[];
  /** 已知公司列表（用於 Prompt 提示） */
  knownCompanies: KnownCompanyForPrompt[];
  /** 選項 */
  options?: Stage1Options;

  // CHANGE-026: PromptConfig 載入參數
  /** 檔案名稱（用於變數替換） */
  fileName?: string;
  /** 公司 ID（用於載入 COMPANY/FORMAT 範圍配置） */
  companyId?: string;
  /** 格式 ID（用於載入 FORMAT 範圍配置） */
  formatId?: string;
}

/**
 * Stage 1 選項
 */
export interface Stage1Options {
  /** 是否自動創建公司（預設 true） */
  autoCreateCompany?: boolean;
  /** 城市代碼（用於 JIT 創建公司） */
  cityCode?: string;
}

/**
 * GPT 公司識別響應結構
 */
interface GptCompanyIdentificationResponse {
  companyName: string;
  identificationMethod: CompanyIdentificationMethod;
  confidence: number;
  matchedKnownCompany: string | null;
}

// ============================================================================
// Service Class
// ============================================================================

/**
 * Stage 1 公司識別服務
 * @description 使用 GPT-5-nano 識別文件發行公司
 * @since CHANGE-024
 */
export class Stage1CompanyService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * 執行公司識別
   * @param input Stage 1 輸入參數
   * @returns Stage 1 結果
   */
  async execute(input: Stage1Input): Promise<Stage1CompanyResult> {
    const startTime = Date.now();
    let promptConfigUsed: StagePromptConfig | null = null;

    try {
      // CHANGE-026: 嘗試載入自定義 PromptConfig
      const customConfig = await this.loadCustomPromptConfig(input);

      // 組裝 Prompt（自定義配置優先，否則使用硬編碼）
      let prompt: { system: string; user: string };

      if (customConfig) {
        // 使用自定義配置 + 變數替換
        promptConfigUsed = customConfig;
        const variableContext = this.buildVariableContextForConfig(input);
        prompt = {
          system: replaceVariables(customConfig.systemPrompt, variableContext),
          user: replaceVariables(customConfig.userPromptTemplate, variableContext),
        };
        console.log(
          `[Stage1] Using custom PromptConfig (scope: ${customConfig.scope}, version: ${customConfig.version})`
        );
      } else {
        // 回退到硬編碼（現有邏輯）
        prompt = this.buildCompanyIdentificationPrompt(input.knownCompanies);
        console.log('[Stage1] Using default hardcoded prompt (no custom config found)');
      }

      // 調用 GPT-5-nano
      const gptResult = await this.callGptNano(prompt, input.imageBase64Array);

      // 解析結果
      const parsed = this.parseCompanyResult(gptResult.response);

      // 解析公司 ID（從資料庫匹配或 JIT 創建）
      const resolved = await this.resolveCompanyId(parsed, input.options);

      return {
        stageName: 'STAGE_1_COMPANY_IDENTIFICATION',
        success: true,
        durationMs: Date.now() - startTime,
        companyId: resolved.companyId,
        companyName: resolved.companyName,
        identificationMethod: parsed.identificationMethod,
        confidence: parsed.confidence,
        isNewCompany: resolved.isNewCompany,
        aiDetails: this.buildAiDetails(gptResult, prompt, Date.now() - startTime),
        // CHANGE-026: 記錄使用的配置來源
        promptConfigUsed: promptConfigUsed
          ? { scope: promptConfigUsed.scope, version: promptConfigUsed.version }
          : undefined,
      };
    } catch (error) {
      return {
        stageName: 'STAGE_1_COMPANY_IDENTIFICATION',
        success: false,
        durationMs: Date.now() - startTime,
        companyName: '',
        identificationMethod: 'LLM_INFERRED',
        confidence: 0,
        isNewCompany: false,
        aiDetails: this.buildEmptyAiDetails(),
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * CHANGE-026: 載入自定義 PromptConfig
   * @description 按優先級 (FORMAT > COMPANY > GLOBAL) 載入 Stage 1 配置
   */
  private async loadCustomPromptConfig(
    input: Stage1Input
  ): Promise<StagePromptConfig | null> {
    try {
      return await loadStage1PromptConfig({
        companyId: input.companyId,
        formatId: input.formatId,
      });
    } catch (error) {
      console.warn('[Stage1] Failed to load PromptConfig, using default:', error);
      return null;
    }
  }

  /**
   * CHANGE-026: 構建變數上下文（用於自定義配置）
   */
  private buildVariableContextForConfig(input: Stage1Input): VariableContext {
    return buildStage1VariableContext({
      knownCompanies: input.knownCompanies,
      fileName: input.fileName,
      pageCount: input.imageBase64Array.length,
    });
  }

  /**
   * 組裝公司識別 Prompt
   * @param knownCompanies 已知公司列表
   * @returns System 和 User Prompt
   */
  private buildCompanyIdentificationPrompt(
    knownCompanies: KnownCompanyForPrompt[]
  ): { system: string; user: string } {
    const companyList =
      knownCompanies.length > 0
        ? knownCompanies
            .map(
              (c) =>
                `- ${c.name}${c.aliases?.length ? ` (Aliases: ${c.aliases.join(', ')})` : ''}`
            )
            .join('\n')
        : '(No known companies - identify from document)';

    return {
      system: `You are an invoice issuer identification specialist.
Your task is to identify the company that issued this invoice.

Known companies:
${companyList}

Identification methods (in priority order):
1. LOGO - Company logo on the document
2. HEADER - Company name in header/letterhead
3. ADDRESS - Company address information
4. TAX_ID - Tax identification number

Response format (JSON):
{
  "companyName": "string - identified company name",
  "identificationMethod": "LOGO" | "HEADER" | "ADDRESS" | "TAX_ID",
  "confidence": number (0-100),
  "matchedKnownCompany": "string | null - if matched to known company"
}`,
      user: 'Identify the issuing company from this invoice image.',
    };
  }

  /**
   * 調用 GPT-5-nano
   * @description 使用 GptCallerService 調用 GPT-5-nano 進行公司識別
   */
  private async callGptNano(
    prompt: { system: string; user: string },
    images: string[]
  ): Promise<{
    response: string;
    tokenUsage: { input: number; output: number; total: number };
    model: string;
  }> {
    const result: GptCallResult = await GptCallerService.callNano(
      prompt.system,
      prompt.user,
      images
    );

    if (!result.success) {
      throw new Error(result.error || 'GPT-5-nano 調用失敗');
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
   *   2. 提取 JSON 塊（處理 markdown 代碼塊或額外文字）
   *   3. 嘗試從 documentIssuer 嵌套結構提取
   */
  private parseCompanyResult(
    response: string
  ): GptCompanyIdentificationResponse {
    // 嘗試直接解析
    try {
      const parsed = JSON.parse(response);
      return this.extractCompanyFromParsed(parsed);
    } catch {
      // 嘗試提取 JSON 塊（處理 markdown ```json ... ``` 或額外文字）
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return this.extractCompanyFromParsed(parsed);
        } catch {
          // 繼續拋出錯誤
        }
      }

      console.error('[Stage1] Failed to parse GPT response:', response.substring(0, 500));
      throw new Error('Failed to parse GPT company identification response');
    }
  }

  /**
   * 從解析後的物件提取公司資訊
   *
   * @description 支援多種響應結構：
   *   - 直接結構: { companyName, confidence, ... }
   *   - 嵌套結構: { documentIssuer: { name, confidence, ... } }
   */
  private extractCompanyFromParsed(parsed: unknown): GptCompanyIdentificationResponse {
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid parsed response');
    }

    const obj = parsed as Record<string, unknown>;

    // 檢查是否為嵌套的 documentIssuer 結構
    if (obj.documentIssuer && typeof obj.documentIssuer === 'object') {
      const issuer = obj.documentIssuer as Record<string, unknown>;
      return {
        companyName: String(issuer.name || issuer.companyName || ''),
        identificationMethod: this.parseIdentificationMethod(issuer.identificationMethod),
        confidence: Number(issuer.confidence) || 0,
        matchedKnownCompany: (issuer.matchedKnownCompany as string) || null,
      };
    }

    // 直接結構
    return {
      companyName: String(obj.companyName || ''),
      identificationMethod: this.parseIdentificationMethod(obj.identificationMethod),
      confidence: Number(obj.confidence) || 0,
      matchedKnownCompany: (obj.matchedKnownCompany as string) || null,
    };
  }

  /**
   * 解析並驗證識別方法
   */
  private parseIdentificationMethod(value: unknown): CompanyIdentificationMethod {
    const validMethods: CompanyIdentificationMethod[] = [
      'LOGO',
      'HEADER',
      'ADDRESS',
      'TAX_ID',
      'LLM_INFERRED',
    ];

    const strValue = String(value || '').toUpperCase();

    if (validMethods.includes(strValue as CompanyIdentificationMethod)) {
      return strValue as CompanyIdentificationMethod;
    }

    // 預設返回 LLM_INFERRED
    return 'LLM_INFERRED';
  }

  /**
   * 解析公司 ID（從資料庫匹配或 JIT 創建）
   */
  private async resolveCompanyId(
    parsed: GptCompanyIdentificationResponse,
    options?: Stage1Options
  ): Promise<{
    companyId?: string;
    companyName: string;
    isNewCompany: boolean;
  }> {
    // 1. 嘗試匹配已知公司
    if (parsed.matchedKnownCompany) {
      const company = await this.prisma.company.findFirst({
        where: {
          OR: [
            { name: parsed.matchedKnownCompany },
            { nameVariants: { has: parsed.matchedKnownCompany } },
          ],
          status: 'ACTIVE',
        },
        select: { id: true, name: true },
      });

      if (company) {
        return {
          companyId: company.id,
          companyName: company.name,
          isNewCompany: false,
        };
      }
    }

    // 2. 後備配對（FIX-057：強化以涵蓋「DB 短名 vs 發票法定全名」）
    if (parsed.companyName) {
      const candidate = parsed.companyName;

      // 2a. DB 層 OR 條件：精確變體 / 大小寫不敏感相等 / 公司名包含發票名
      const dbMatch = await this.prisma.company.findFirst({
        where: {
          status: 'ACTIVE',
          OR: [
            { nameVariants: { has: candidate } },
            { name: { equals: candidate, mode: 'insensitive' } },
            { name: { contains: candidate, mode: 'insensitive' } },
          ],
        },
        select: { id: true, name: true },
      });

      if (dbMatch) {
        return {
          companyId: dbMatch.id,
          companyName: dbMatch.name,
          isNewCompany: false,
        };
      }

      // 2b. 正規化配對：移除公司後綴（LTD./LIMITED/CO. 等）與標點後，
      //     以 name 及 nameVariants 與發票名做正規化相等比對
      //     （例：「Fairate Express」↔「FAIRATE EXPRESS LTD.」皆正規化為「fairate express」）
      const normCandidate = this.normalizeCompanyName(candidate);
      if (normCandidate) {
        const activeCompanies = await this.prisma.company.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true, name: true, nameVariants: true },
        });

        const matched = activeCompanies.find((c) =>
          [c.name, ...(c.nameVariants ?? [])].some(
            (n) => this.normalizeCompanyName(n) === normCandidate
          )
        );

        if (matched) {
          return {
            companyId: matched.id,
            companyName: matched.name,
            isNewCompany: false,
          };
        }
      }
    }

    // 3. 如果允許自動創建，則 JIT 創建公司
    if (options?.autoCreateCompany !== false && parsed.companyName) {
      // FIX-077: JIT 前重複防護 — 以正規化/相似度檢查「所有狀態」的既有公司，
      //          避免公司識別飄移（GPT 對同公司每次輸出不同寫法）時重複增生公司主檔
      const duplicate = await this.findDuplicateCompany(parsed.companyName);
      if (duplicate) {
        console.log(
          `[Stage1] FIX-077 防重複：配對到既有公司 "${duplicate.name}" ← GPT 輸出 "${parsed.companyName}"，略過 JIT 建立`
        );
        return {
          companyId: duplicate.id,
          companyName: duplicate.name,
          isNewCompany: false,
        };
      }

      const newCompany = await this.jitCreateCompany(
        parsed.companyName,
        options?.cityCode
      );
      return {
        companyId: newCompany.id,
        companyName: newCompany.name,
        isNewCompany: true,
      };
    }

    return {
      companyId: undefined,
      companyName: parsed.companyName,
      isNewCompany: true,
    };
  }

  /**
   * FIX-057 / FIX-077：公司名稱正規化（用於配對比對）
   * @description
   *   將公司名統一為可比對的正規化字串，使同公司的不同寫法正規化後相等。處理步驟：
   *   1. 轉小寫。
   *   2. FIX-077：取「/ 別名」前的主名（例：「... Limited / DHL Express」→「... Limited」）。
   *   3. FIX-077：移除括號及其內容（例：「(HK)」「(Hong Kong)」等地區詞）。
   *   4. 移除常見公司後綴（LTD / LIMITED / CO / COMPANY / INC / CORP / LLC / PTE / GMBH / SA / BV / AG / NV）
   *      及 FIX-077 新增的業務描述詞 OPERATIONS。
   *   5. 非字母數字轉空格、壓縮空白。
   *
   *   例：「DHL Express」「DHL EXPRESS (HK) LIMITED」「DHL Express (Hong Kong) Limited / DHL Express」
   *   「DHL EXPRESS (HK) OPERATIONS LTD.」四種寫法皆正規化為「dhl express」。
   * @param name 原始公司名稱
   * @returns 正規化後的字串（可能為空字串）
   */
  private normalizeCompanyName(name: string): string {
    if (!name) return '';

    let normalized = name.toLowerCase();

    // FIX-077: 取「/ 別名」前的主名
    if (normalized.includes('/')) {
      normalized = normalized.split('/')[0];
    }

    // FIX-077: 移除括號及其內容（地區詞 (HK)/(Hong Kong) 等）
    normalized = normalized.replace(/\([^)]*\)/g, ' ');

    return normalized
      .replace(
        // FIX-077: 後綴清單加入業務描述詞 operations
        /\b(ltd|limited|co|company|inc|incorporated|corp|corporation|llc|pte|gmbh|sa|bv|ag|nv|operations)\b\.?/g,
        ' '
      )
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  /**
   * FIX-077：JIT 前重複公司偵測
   * @description
   *   在 JIT 建立新公司前，以強化後的正規化名稱對「所有狀態」的既有公司做比對，補足
   *   resolveCompanyId Step 2b 僅查 ACTIVE 的缺口，並 catch GPT 對同公司輸出的細微寫法差異：
   *   1. 正規化後精確相等（含 PENDING / INACTIVE 的既有公司）。
   *   2. 正規化字串的保守相似度（沿用既有 levenshteinSimilarity，門檻
   *      COMPANY_NAME_SIMILARITY_THRESHOLD）。
   *   找到既有公司即回傳，避免公司主檔被重複記錄污染。
   * @param candidate GPT 輸出的公司名稱
   * @returns 既有公司 { id, name }，或 null（確為新公司）
   */
  private async findDuplicateCompany(
    candidate: string
  ): Promise<{ id: string; name: string } | null> {
    const normCandidate = this.normalizeCompanyName(candidate);
    if (!normCandidate) return null;

    const companies = await this.prisma.company.findMany({
      select: { id: true, name: true, nameVariants: true },
    });

    for (const company of companies) {
      const normNames = [company.name, ...(company.nameVariants ?? [])]
        .map((n) => this.normalizeCompanyName(n))
        .filter(Boolean);

      // 1. 正規化精確相等
      if (normNames.includes(normCandidate)) {
        return { id: company.id, name: company.name };
      }

      // 2. 保守相似度配對
      if (
        normNames.some(
          (n) =>
            levenshteinSimilarity(n, normCandidate) >= COMPANY_NAME_SIMILARITY_THRESHOLD
        )
      ) {
        return { id: company.id, name: company.name };
      }
    }

    return null;
  }

  /**
   * JIT 創建公司
   * @description Just-in-Time 創建新公司記錄
   */
  private async jitCreateCompany(
    companyName: string,
    _cityCode?: string // cityCode 保留參數但不使用（Company 沒有 city 關聯）
  ): Promise<{ id: string; name: string }> {
    // 查找系統用戶作為創建者
    // 優先嘗試多種可能的 system 用戶 email 格式
    const systemUser = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: { contains: 'system', mode: 'insensitive' } },
          { name: { equals: 'System', mode: 'insensitive' } },
        ],
      },
      select: { id: true },
    });

    // 如果找不到 system 用戶，拋出錯誤（不能使用無效的 ID）
    if (!systemUser) {
      throw new Error(
        'System user not found. Please ensure a system user exists in the database.'
      );
    }

    // Note: Company model 沒有 cityId 欄位，只需創建基本公司記錄
    const newCompany = await this.prisma.company.create({
      data: {
        name: companyName,
        displayName: companyName, // 顯示名稱與名稱相同
        status: 'ACTIVE',
        source: 'AUTO_CREATED', // 自動建立（AI 識別）
        priority: 0, // 預設優先級
        nameVariants: [],
        identificationPatterns: [],
        createdById: systemUser.id, // 系統創建
        // cityCode 用於 Document 記錄，非 Company
      },
      select: {
        id: true,
        name: true,
      },
    });

    return newCompany;
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
      stage: 'STAGE_1',
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
      stage: 'STAGE_1',
      model: '',
      prompt: '',
      response: '',
      tokenUsage: { input: 0, output: 0, total: 0 },
      durationMs: 0,
    };
  }
}
