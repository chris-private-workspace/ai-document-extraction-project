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
 * @lastModified 2026-07-16
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
 *   CHANGE-103（組件 3：學習迴路）：精確匹配成功時把 GPT 原印法回寫 nameVariants
 *   - resolveCompanyId 的 Step 1 / 2a / 2b 命中後呼叫 learnNameVariant
 *   - 零誤併安全閘：僅當原印法正規化後等於既有 name/nameVariants 之一才學習
 *     （即該印法本就被系統判為同一公司，不建立任何新的匹配關係）
 *   - 讓 nameVariants 隨使用累積各種印法，下次同印法在 Step 1/2a 直接精確命中，
 *     逐步消除「同公司不同印法」重複增生（FIX-057/077 之外的治本方向）
 *
 *   CHANGE-103 Phase 2（組件 2 token-set + 組件 4 灰帶 PENDING）：
 *   - findDuplicateCompany 在既有「正規化精確相等 + Levenshtein」（EXACT）之後，新增 token-set
 *     分層 pass（classifyCompanyMatch，D1 保守）：core 集合相等 → AUTO（配到既有）；core 為子集
 *     關係（某方多出專有 token，如 +pacific / +ricon）→ GRAY（灰帶）。
 *   - resolveCompanyId Step 3：EXACT/AUTO 配到既有（isNewCompany:false）；GRAY 呼叫
 *     jitCreateCompany 建 status=PENDING + suspectedDuplicateOfId 標記，不自動併、不進 ACTIVE
 *     候選，文件仍綁該 companyId（可繼續提取），待人工審核（組件 4）。
 *   - 真正解 CEVA 那種「無括號多 token」分裂，同時把誤併風險降到最低（保守：只有 core 相等才自動配）。
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
import { LlmModelConfigService } from '@/services/llm-model-config.service';
// CHANGE-026: PromptConfig 整合
import { loadStage1PromptConfig, type StagePromptConfig } from '../prompt-assembly.service';
import {
  replaceVariables,
  buildStage1VariableContext,
  type VariableContext,
} from '../utils/variable-replacer';
// FIX-077: 公司名相似度（沿用既有 similarity 工具，避免新增依賴）
// CHANGE-103 Phase 2 組件 2: token-set 分層配對（AUTO / GRAY / NONE）
import { levenshteinSimilarity, classifyCompanyMatch } from '@/services/similarity';

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

/**
 * CHANGE-103 Phase 2：JIT 前重複偵測的分層結果
 * @description
 *   - `EXACT`：正規化精確相等 / 保守 Levenshtein 命中（原 FIX-077 行為）。
 *   - `AUTO` ：token-set core 集合相等（額外 generic 地區/結構詞差異被吸收）。
 *   - `GRAY` ：token-set core 為子集關係（某方多出專有 token）→ 灰帶，建 PENDING 人工審核。
 *   EXACT / AUTO 對呼叫端行為相同（配到既有公司）；GRAY 讓呼叫端建 PENDING。
 */
type DuplicateMatchTier = 'EXACT' | 'AUTO' | 'GRAY';

interface DuplicateCompanyMatch {
  tier: DuplicateMatchTier;
  company: { id: string; name: string };
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
Your task is to identify the single company that ISSUED this invoice (the issuer/from party),
typically a logistics company or freight forwarder shown in the logo/letterhead.
Never pick the customer/buyer (Bill To / Consignee / recipient).

Known companies:
${companyList}

Rules:
- Multi-entity groups: a large logistics group may show several related legal entities on the
  same document (e.g. "XXX (HONG KONG) LIMITED" vs "XXX (REGION) PACIFIC OPERATIONS LIMITED").
  Pick ONLY the one legal entity that actually issued this invoice, based on the logo/letterhead/
  invoice header; do not blend, merge or rewrite words from different entities into a new name.
- Use the full legal name exactly as printed (keep region words in parentheses and suffixes like
  LIMITED/LTD); do not abbreviate, translate or invent.
- If the issuer matches one of the known companies above, set matchedKnownCompany to that exact
  known-company name; otherwise null.
- If several similar related entities are hard to tell apart, lower the confidence.

Identification methods (in priority order):
1. LOGO - Company logo on the document
2. HEADER - Company name in header/letterhead
3. ADDRESS - Company address information
4. TAX_ID - Tax identification number

Response format (JSON):
{
  "companyName": "string - full legal name of the issuing company",
  "identificationMethod": "LOGO" | "HEADER" | "ADDRESS" | "TAX_ID",
  "confidence": number (0-100),
  "matchedKnownCompany": "string | null - exact known-company name if matched"
}`,
      user: 'Identify the single issuing company (not the customer / Bill To) from this invoice image.',
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
    const modelKey = await LlmModelConfigService.getStageModel('stage1');
    const result: GptCallResult = await GptCallerService.callModel(
      modelKey,
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
        // CHANGE-103 Phase 2: 決定性 tie-break —— 重複公司並存時穩定選最早建立者，
        //   消除原 findFirst 無 orderBy 的非確定（跨環境 DB 列順序不同 → 同輸入選到不同公司）
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, nameVariants: true },
      });

      if (company) {
        // CHANGE-103 組件 3：學習 GPT 這次的原印法（安全閘保護，零誤併）
        await this.learnNameVariant(company, parsed.companyName);
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
        // CHANGE-103 Phase 2: 決定性 tie-break（`contains` 子字串可命中多筆時尤其重要）
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, nameVariants: true },
      });

      if (dbMatch) {
        // CHANGE-103 組件 3：學習 GPT 原印法。安全閘會擋掉「name contains」的不精確
        // 子集命中（例：candidate="CEVA" 命中 "CEVA LOGISTICS ..." 但正規化不等 → 不學）
        await this.learnNameVariant(dbMatch, candidate);
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
          // CHANGE-103 Phase 2: 決定性順序，使後續 .find() 首個正規化命中穩定
          orderBy: { createdAt: 'asc' },
          select: { id: true, name: true, nameVariants: true },
        });

        const matched = activeCompanies.find((c) =>
          [c.name, ...(c.nameVariants ?? [])].some(
            (n) => this.normalizeCompanyName(n) === normCandidate
          )
        );

        if (matched) {
          // CHANGE-103 組件 3：學習 GPT 原印法（此處必為正規化相等命中，安全閘必過）
          await this.learnNameVariant(matched, candidate);
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
      // FIX-077 + CHANGE-103 Phase 2: JIT 前重複防護（分層）
      //   - EXACT / AUTO：配到既有公司（正規化相等 / Levenshtein / token-set core 相等）
      //   - GRAY：token-set 子集關係（某方多出專有 token）→ 建 PENDING + 掛疑似重複標記，
      //           不自動併、不進 ACTIVE 已知候選，文件仍綁該 companyId（可繼續提取），待人工審核（組件 4）
      const duplicate = await this.findDuplicateCompany(parsed.companyName);

      if (duplicate && duplicate.tier !== 'GRAY') {
        console.log(
          `[Stage1] FIX-077/CHANGE-103 防重複（${duplicate.tier}）：配對到既有公司 "${duplicate.company.name}" ← GPT 輸出 "${parsed.companyName}"，略過 JIT 建立`
        );
        return {
          companyId: duplicate.company.id,
          companyName: duplicate.company.name,
          isNewCompany: false,
        };
      }

      if (duplicate && duplicate.tier === 'GRAY') {
        // CHANGE-103 Phase 2 組件 4：灰帶 → 建 PENDING（非 ACTIVE）+ 掛疑似重複標記
        const pendingCompany = await this.jitCreateCompany(
          parsed.companyName,
          options?.cityCode,
          { status: 'PENDING', suspectedDuplicateOfId: duplicate.company.id }
        );
        console.log(
          `[Stage1] CHANGE-103 Phase 2 灰帶：建立 PENDING 公司 "${pendingCompany.name}"（疑似重複於 "${duplicate.company.name}" / ${duplicate.company.id}），待人工審核`
        );
        return {
          companyId: pendingCompany.id,
          companyName: pendingCompany.name,
          isNewCompany: true,
        };
      }

      // 無任何命中 → 現行 JIT 建 ACTIVE
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
   * CHANGE-103 組件 3：學習迴路 — 精確匹配成功時把 GPT 原印法回寫 nameVariants
   * @description
   *   在 resolveCompanyId 的精確匹配（Step 1 / 2a / 2b）命中後呼叫，將 GPT 這次輸出
   *   的公司名原印法累積進匹配公司的 nameVariants，使下次同印法能在 Step 1 / 2a 直接
   *   精確命中，逐步吸收「同公司不同印法」而消除重複增生。
   *
   *   零誤併安全閘（本方法零誤併的技術保證）：
   *   僅當 rawName 正規化後等於該公司 name / nameVariants 任一者的正規化值時才學習。
   *   由於「正規化相等」本就是系統判定同一公司的條件（見 resolveCompanyId Step 2b），
   *   回寫只是把既有的精確匹配快取為變體，不建立任何新的匹配關係，故不引入誤併風險。
   *   此安全閘亦會擋掉 Step 2a「name contains」的不精確子集命中。
   *
   *   非致命：回寫失敗僅記警告，不影響已成立的匹配結果。
   *
   * @param match 已匹配公司（需含 id / name / nameVariants）
   * @param rawName GPT 這次輸出的公司名稱原印法
   */
  private async learnNameVariant(
    match: { id: string; name: string; nameVariants?: string[] },
    rawName: string
  ): Promise<void> {
    const raw = rawName?.trim();
    if (!raw) return;

    const existing = [match.name, ...(match.nameVariants ?? [])];

    // 去重：原印法（不分大小寫）已存在於 name / nameVariants → 無需學習
    if (existing.some((n) => n.toLowerCase() === raw.toLowerCase())) return;

    // 零誤併安全閘：正規化後須與既有某名稱相等，才視為同一公司的新印法
    const normRaw = this.normalizeCompanyName(raw);
    if (!normRaw) return;
    const isSameCompany = existing.some(
      (n) => this.normalizeCompanyName(n) === normRaw
    );
    if (!isSameCompany) return;

    try {
      await this.prisma.company.update({
        where: { id: match.id },
        data: { nameVariants: { push: raw } },
      });
      console.log(
        `[Stage1] CHANGE-103 學習變體：公司 "${match.name}" ← 新印法 "${raw}"`
      );
    } catch (error) {
      console.warn(
        '[Stage1] CHANGE-103 學習變體失敗（不影響匹配）：',
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * FIX-077 + CHANGE-103 Phase 2：JIT 前重複公司偵測（分層）
   * @description
   *   在 JIT 建立新公司前，對「所有狀態」的既有公司做比對，補足 resolveCompanyId Step 2b
   *   僅查 ACTIVE 的缺口，並 catch GPT 對同公司輸出的細微寫法差異。分兩段掃描（皆依
   *   `createdAt asc`，多筆重複並存時穩定選最早建立者）：
   *
   *   Pass 1（EXACT，最高優先，首個命中即回）— 原 FIX-077 行為：
   *   1. 正規化後精確相等（含 PENDING / INACTIVE 的既有公司）。
   *   2. 正規化字串的保守相似度（levenshteinSimilarity ≥ COMPANY_NAME_SIMILARITY_THRESHOLD）。
   *
   *   Pass 2（token-set，CHANGE-103 Phase 2 組件 2）— EXACT 全無命中後才判斷 core 集合關係
   *   （classifyCompanyMatch，D1 保守）。**AUTO 優先於 GRAY**：全程掃描，命中 AUTO 立即回；
   *   全程無 AUTO 才回第一個 GRAY。
   *   - AUTO：core 集合相等（額外 generic 詞差異被吸收）→ 視為既有公司。
   *   - GRAY：core 為子集關係（某方多出專有 token，如 +pacific / +ricon）→ 灰帶，呼叫端建 PENDING。
   *
   * @param candidate GPT 輸出的公司名稱
   * @returns 分層命中 { tier, company }，或 null（確為全新公司）
   */
  private async findDuplicateCompany(
    candidate: string
  ): Promise<DuplicateCompanyMatch | null> {
    const normCandidate = this.normalizeCompanyName(candidate);
    if (!normCandidate) return null;

    const companies = await this.prisma.company.findMany({
      // CHANGE-103 Phase 2: 決定性順序，使重複偵測（findDuplicateCompany）首個命中穩定
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, nameVariants: true },
    });

    // Pass 1（EXACT，最高優先）：正規化精確相等 + 保守 Levenshtein，首個命中即回
    for (const company of companies) {
      const normNames = [company.name, ...(company.nameVariants ?? [])]
        .map((n) => this.normalizeCompanyName(n))
        .filter(Boolean);

      // 1. 正規化精確相等
      if (normNames.includes(normCandidate)) {
        return { tier: 'EXACT', company: { id: company.id, name: company.name } };
      }

      // 2. 保守相似度配對
      if (
        normNames.some(
          (n) =>
            levenshteinSimilarity(n, normCandidate) >= COMPANY_NAME_SIMILARITY_THRESHOLD
        )
      ) {
        return { tier: 'EXACT', company: { id: company.id, name: company.name } };
      }
    }

    // Pass 2（token-set）：EXACT 全無命中後，判斷 core 集合關係。
    //   AUTO 優先於 GRAY —— 全程掃描（createdAt 序），命中 AUTO 立即回；全程無 AUTO 才回第一個 GRAY。
    let firstGray: { id: string; name: string } | null = null;
    for (const company of companies) {
      for (const name of [company.name, ...(company.nameVariants ?? [])]) {
        const tier = classifyCompanyMatch(
          normCandidate,
          this.normalizeCompanyName(name)
        );
        if (tier === 'AUTO') {
          return { tier: 'AUTO', company: { id: company.id, name: company.name } };
        }
        if (tier === 'GRAY' && !firstGray) {
          firstGray = { id: company.id, name: company.name };
        }
      }
    }

    if (firstGray) {
      return { tier: 'GRAY', company: firstGray };
    }

    return null;
  }

  /**
   * JIT 創建公司
   * @description
   *   Just-in-Time 創建新公司記錄。預設建 ACTIVE（現行行為）；CHANGE-103 Phase 2 組件 4
   *   於灰帶命中時傳 `opts.status='PENDING'` + `opts.suspectedDuplicateOfId`，建 PENDING
   *   並掛「疑似重複於 X」標記（不進 ACTIVE 已知候選、待人工審核）。
   * @param companyName 公司名稱
   * @param _cityCode 城市代碼（保留參數但不使用，Company 沒有 city 關聯）
   * @param opts 可選：status（預設 ACTIVE）、suspectedDuplicateOfId（灰帶疑似目標公司 id）
   */
  private async jitCreateCompany(
    companyName: string,
    _cityCode?: string, // cityCode 保留參數但不使用（Company 沒有 city 關聯）
    opts?: { status?: 'ACTIVE' | 'PENDING'; suspectedDuplicateOfId?: string }
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
        status: opts?.status ?? 'ACTIVE', // CHANGE-103 Phase 2 組件 4：灰帶傳 PENDING
        source: 'AUTO_CREATED', // 自動建立（AI 識別）
        priority: 0, // 預設優先級
        nameVariants: [],
        identificationPatterns: [],
        createdById: systemUser.id, // 系統創建
        // CHANGE-103 Phase 2 組件 4：灰帶建立時掛「疑似重複於 X」標記（純加 nullable，向後相容）
        ...(opts?.suspectedDuplicateOfId
          ? { suspectedDuplicateOfId: opts.suspectedDuplicateOfId }
          : {}),
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
