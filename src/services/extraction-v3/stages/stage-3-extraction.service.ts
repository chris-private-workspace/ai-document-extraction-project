/**
 * @fileoverview Stage 3 - 欄位提取服務
 * @description
 *   使用 GPT-5.2 進行精準欄位提取：
 *   - 輸入：文件圖片 + Stage 1&2 結果 + 完整配置
 *   - 配置組裝：PromptConfig + FieldMappingConfig + MappingRule
 *   - 模型：GPT-5.2（高精度、複雜任務）
 *   - 輸出：standardFields, lineItems, customFields (CHANGE-045: extraCharges removed)
 *
 *   CHANGE-026：整合 PromptConfig 可配置化
 *   - 支援變數替換（${universalMappings}, ${companyMappings} 等）
 *   - 保留現有分層配置載入邏輯
 *
 * @module src/services/extraction-v3/stages/stage-3-extraction.service
 * @since CHANGE-024 - Three-Stage Extraction Architecture
 * @lastModified 2026-02-24
 *
 * @features
 *   - 分層 PromptConfig 載入：FORMAT > COMPANY > GLOBAL
 *   - 術語映射整合：Tier 1 (通用) + Tier 2 (公司特定)
 *   - JSON Schema 強制結構化輸出
 *   - 完整的配置來源追蹤
 *   - 高解析度圖片模式（auto/high）
 *   - CHANGE-026: PromptConfig 變數替換支援
 *
 * @dependencies
 *   - UnifiedGptExtractionService - GPT 調用服務
 *   - PrismaClient - 配置查詢
 *
 * @related
 *   - src/types/extraction-v3.types.ts - Stage3ExtractionResult 類型
 *   - src/services/extraction-v3/stages/stage-1-company.service.ts
 *   - src/services/extraction-v3/stages/stage-2-format.service.ts
 *   - src/services/extraction-v3/prompt-assembly.service.ts - Prompt 組裝服務
 */

import { PrismaClient } from '@prisma/client';
import type {
  Stage1CompanyResult,
  Stage2FormatResult,
  Stage3ExtractionResult,
  Stage3ConfigUsed,
  StageAiDetails,
  StandardFieldsV3,
  LineItemV3,
  ExtraChargeV3,
  FieldValue,
  FieldDefinition,
  PromptConfigScope,
  FieldDefinitionEntry,
} from '@/types/extraction-v3.types';
import { toFieldDefinition } from '@/types/extraction-v3.types';
import {
  INVOICE_FIELDS,
  findFieldByAlias,
  type InvoiceFieldDefinition,
} from '@/types/invoice-fields';
import {
  GptCallerService,
  type GptCallResult,
  type ImageDetailMode,
} from './gpt-caller.service';
// CHANGE-026: 變數替換支援
import {
  replaceVariables,
  buildStage3VariableContext,
  extractVariableNames,
  type VariableContext,
} from '../utils/variable-replacer';
// CHANGE-046: classifiedAs 正規化
// CHANGE-094: 費用標籤對照（確定性回填）
import {
  normalizeClassifiedAs,
  matchLabel,
  type LabelMatchKind,
} from '../utils/classify-normalizer';

// ============================================================================
// Types
// ============================================================================

/**
 * Stage 3 輸入參數
 */
export interface Stage3Input {
  /** Base64 編碼的圖片陣列 */
  imageBase64Array: string[];
  /** Stage 1 公司識別結果 */
  stage1Result: Stage1CompanyResult;
  /** Stage 2 格式識別結果 */
  stage2Result: Stage2FormatResult;
  /** 選項 */
  options?: Stage3Options;

  // CHANGE-026: PromptConfig 變數替換參數
  /** 檔案名稱（用於變數替換） */
  fileName?: string;

  // CHANGE-042 Phase 3: Feedback recording
  /** 文件 ID（用於記錄 FieldExtractionFeedback） */
  documentId?: string;
}

/**
 * Stage 3 選項
 */
export interface Stage3Options {
  /** 圖片詳情模式（預設 auto） */
  imageDetailMode?: 'auto' | 'low' | 'high';
}

/**
 * 完整提取配置
 */
interface ExtractionConfig {
  // Prompt 配置
  promptConfigScope: PromptConfigScope;
  promptConfigId?: string;
  systemPrompt: string;
  userPromptTemplate: string;

  // 欄位映射配置
  fieldMappingConfigId?: string;
  standardFields: FieldDefinition[];
  customFields: FieldDefinition[];

  // CHANGE-042: 動態欄位定義
  fieldDefinitions: FieldDefinitionEntry[];
  fieldDefinitionSetId?: string;

  // 術語映射（三層映射系統）
  universalMappings: Record<string, string>;
  companyMappings: Record<string, string>;
  universalMappingsCount: number;
  companyMappingsCount: number;

  // 輸出 Schema
  outputSchema: Record<string, unknown>;

  // 其他配置
  imageDetailMode: 'auto' | 'low' | 'high';
}

/**
 * GPT 提取響應結構
 */
interface GptExtractionResponse {
  standardFields: StandardFieldsV3;
  customFields?: Record<string, FieldValue>;
  /** CHANGE-042: 動態欄位（所有欄位統一為 Record） */
  fields?: Record<string, FieldValue>;
  lineItems: LineItemV3[];
  extraCharges?: ExtraChargeV3[];
  overallConfidence: number;
}

// ============================================================================
// Service Class
// ============================================================================

/**
 * Stage 3 欄位提取服務
 * @description 使用 GPT-5.2 進行精準欄位提取，基於 Stage 1&2 結果查詢配置
 * @since CHANGE-024
 */
export class Stage3ExtractionService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * 執行欄位提取
   * @param input Stage 3 輸入參數
   * @returns Stage 3 結果
   */
  async execute(input: Stage3Input): Promise<Stage3ExtractionResult> {
    const startTime = Date.now();
    const { stage1Result, stage2Result } = input;

    try {
      // 1. 基於 Stage 1&2 結果載入完整配置
      const config = await this.loadExtractionConfig(
        stage1Result.companyId,
        stage2Result.formatId
      );

      // CHANGE-026: 構建變數上下文
      const variableContext = this.buildVariableContextForConfig(input, config);

      // 2. 組裝完整的提取 Prompt（支援變數替換）
      const prompt = this.buildExtractionPrompt(config, variableContext);

      // 3. 調用 GPT-5.2（精準提取）
      // TODO: Phase 2 實現實際 GPT 調用
      const gptResult = await this.callGpt52(
        prompt,
        input.imageBase64Array,
        config.outputSchema,
        input.options?.imageDetailMode || config.imageDetailMode
      );

      // 4. CHANGE-042: 解析和驗證結果（傳入 fieldDefinitions 以支援動態映射）
      const parsed = this.parseExtractionResult(
        gptResult.response,
        config.fieldDefinitions
      );

      // 4b. CHANGE-094: 確定性回填 — 將 lineItem 費用補進對應 field def key
      //     消除 GPT 對「fields vs lineItems」判斷的非確定性（同文件不同次結果不同）。
      //     僅補空缺（GPT 已填值優先），歧義時跳過（寧可不填、不可填錯）。
      if (parsed.fields) {
        this.backfillLineItemCharges(
          parsed.fields,
          parsed.lineItems,
          config.fieldDefinitions
        );
      }

      // 計算 overallConfidence（優先使用動態 fields，fallback 到 standardFields）
      const overallConfidence = parsed.overallConfidence > 0
        ? parsed.overallConfidence
        : this.calculateOverallConfidence(parsed.standardFields, parsed.fields);

      // CHANGE-042 Phase 3: Fire-and-forget feedback recording
      if (config.fieldDefinitionSetId && input.documentId) {
        this.recordExtractionFeedback(
          config.fieldDefinitionSetId,
          input.documentId,
          config.fieldDefinitions,
          parsed.fields
        ).catch(() => {
          // Silently ignore feedback recording errors — must not block pipeline
        });
      }

      return {
        stageName: 'STAGE_3_FIELD_EXTRACTION',
        success: true,
        durationMs: Date.now() - startTime,
        standardFields: parsed.standardFields,
        customFields: parsed.customFields,
        fields: parsed.fields,
        lineItems: parsed.lineItems,
        extraCharges: parsed.extraCharges,
        overallConfidence,
        fieldDefinitionSetId: config.fieldDefinitionSetId,
        configUsed: {
          promptConfigScope: config.promptConfigScope,
          promptConfigId: config.promptConfigId,
          fieldMappingConfigId: config.fieldMappingConfigId,
          universalMappingsCount: config.universalMappingsCount,
          companyMappingsCount: config.companyMappingsCount,
        },
        tokenUsage: gptResult.tokenUsage,
        aiDetails: this.buildAiDetails(
          gptResult,
          prompt,
          input.options?.imageDetailMode || config.imageDetailMode,
          Date.now() - startTime
        ),
      };
    } catch (error) {
      return {
        stageName: 'STAGE_3_FIELD_EXTRACTION',
        success: false,
        durationMs: Date.now() - startTime,
        standardFields: this.buildEmptyStandardFields(),
        lineItems: [],
        overallConfidence: 0,
        configUsed: this.buildEmptyConfigUsed(),
        tokenUsage: { input: 0, output: 0, total: 0 },
        aiDetails: this.buildEmptyAiDetails(),
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 載入提取配置（完整配置組裝）
   * @description 基於 companyId 和 formatId 載入所有相關配置
   */
  private async loadExtractionConfig(
    companyId?: string,
    formatId?: string
  ): Promise<ExtractionConfig> {
    // 1. 載入 PromptConfig（優先級: FORMAT > COMPANY > GLOBAL）
    const promptConfig = await this.loadPromptConfigHierarchical(
      companyId,
      formatId
    );

    // 2. CHANGE-042: 載入 FieldDefinitionSet（取代舊的 loadFieldMappingConfig stub）
    const fieldDefSet = await this.loadFieldDefinitionSet(companyId, formatId);

    // 將 FieldDefinitionEntry[] 轉為 FieldDefinition[]（向下兼容 buildFieldsSection）
    const allFieldDefs = fieldDefSet.fields.map(toFieldDefinition);
    const standardFields = allFieldDefs.filter((f) => f.required);
    const customFields = allFieldDefs.filter((f) => !f.required);

    // 3. 術語映射（Tier 1 + Tier 2）— CHANGE-083: 已停用注入
    //    V3.1 GPT Vision 架構下，MappingRule 的 fieldName→fieldLabel 注入屬直譯冗餘
    //    （31 筆中 30 筆與 FieldDefinitionSet 重複，對 GPT 無資訊量）；唯一有效的
    //    Maersk 海運提單號別名已遷至 invoice-fields.ts tracking_number.aliases。
    //    loadTier1Mappings / loadTier2Mappings 保留為 @deprecated 供未來 Phase 2 重用。
    const universalMappings: Record<string, string> = {};
    const companyMappings: Record<string, string> = {};

    // 4. CHANGE-042 Phase 2: 動態生成 JSON Schema（基於 fieldDefinitions）
    const outputSchema = this.generateOutputSchema(fieldDefSet.fields);

    return {
      promptConfigScope: promptConfig.scope,
      promptConfigId: promptConfig.id,
      systemPrompt: promptConfig.systemPrompt,
      userPromptTemplate: promptConfig.userPromptTemplate,
      fieldMappingConfigId: fieldDefSet.id,
      standardFields,
      customFields,
      fieldDefinitions: fieldDefSet.fields,
      fieldDefinitionSetId: fieldDefSet.id,
      universalMappings,
      companyMappings,
      universalMappingsCount: Object.keys(universalMappings).length,
      companyMappingsCount: Object.keys(companyMappings).length,
      outputSchema,
      imageDetailMode: promptConfig.imageDetailMode || 'auto',
    };
  }

  /**
   * 分層載入 PromptConfig
   * @description 實現 FORMAT > COMPANY > GLOBAL 優先級
   */
  private async loadPromptConfigHierarchical(
    companyId?: string,
    formatId?: string
  ): Promise<{
    id?: string;
    scope: PromptConfigScope;
    systemPrompt: string;
    userPromptTemplate: string;
    imageDetailMode?: 'auto' | 'low' | 'high';
  }> {
    // FIX-043: 加入 promptType 過濾，避免載入 TERM_CLASSIFICATION 等非提取類型的 PromptConfig
    const extractionPromptTypes = ['STAGE_3_FIELD_EXTRACTION', 'FIELD_EXTRACTION'] as const;

    // 1. 嘗試 FORMAT 級配置
    if (formatId && companyId) {
      const formatConfig = await this.prisma.promptConfig.findFirst({
        where: {
          scope: 'FORMAT',
          documentFormatId: formatId,
          companyId,
          isActive: true,
          promptType: { in: [...extractionPromptTypes] },
        },
      });
      if (formatConfig) {
        return {
          id: formatConfig.id,
          scope: 'FORMAT',
          systemPrompt: formatConfig.systemPrompt || '',
          userPromptTemplate: formatConfig.userPromptTemplate || '',
          imageDetailMode: 'auto', // PromptConfig 沒有此欄位，使用預設值
        };
      }
    }

    // 2. 嘗試 COMPANY 級配置
    if (companyId) {
      const companyConfig = await this.prisma.promptConfig.findFirst({
        where: {
          scope: 'COMPANY',
          companyId,
          isActive: true,
          promptType: { in: [...extractionPromptTypes] },
        },
      });
      if (companyConfig) {
        return {
          id: companyConfig.id,
          scope: 'COMPANY',
          systemPrompt: companyConfig.systemPrompt || '',
          userPromptTemplate: companyConfig.userPromptTemplate || '',
          imageDetailMode: 'auto',
        };
      }
    }

    // 3. 使用 GLOBAL 級配置
    const globalConfig = await this.prisma.promptConfig.findFirst({
      where: {
        scope: 'GLOBAL',
        isActive: true,
        promptType: { in: [...extractionPromptTypes] },
      },
    });

    if (!globalConfig) {
      // 返回預設配置
      return {
        scope: 'GLOBAL',
        systemPrompt: this.getDefaultSystemPrompt(),
        userPromptTemplate: this.getDefaultUserPrompt(),
        imageDetailMode: 'auto',
      };
    }

    return {
      id: globalConfig.id,
      scope: 'GLOBAL',
      systemPrompt: globalConfig.systemPrompt || '',
      userPromptTemplate: globalConfig.userPromptTemplate || '',
      imageDetailMode: 'auto',
    };
  }

  /**
   * CHANGE-042: 從 DB 載入 FieldDefinitionSet（三層解析）
   * @description 查詢優先級: FORMAT > COMPANY > GLOBAL，合併後返回完整欄位定義
   */
  private async loadFieldDefinitionSet(
    companyId?: string,
    formatId?: string
  ): Promise<{
    id?: string;
    fields: FieldDefinitionEntry[];
  }> {
    // 1. 查 FORMAT scope (companyId + formatId)
    let formatSet: { id: string; fields: unknown } | null = null;
    if (companyId && formatId) {
      formatSet = await this.prisma.fieldDefinitionSet.findFirst({
        where: {
          scope: 'FORMAT',
          companyId,
          documentFormatId: formatId,
          isActive: true,
        },
        select: { id: true, fields: true },
      });
    }

    // 2. 查 COMPANY scope (companyId, formatId=null)
    let companySet: { id: string; fields: unknown } | null = null;
    if (companyId) {
      companySet = await this.prisma.fieldDefinitionSet.findFirst({
        where: {
          scope: 'COMPANY',
          companyId,
          documentFormatId: null,
          isActive: true,
        },
        select: { id: true, fields: true },
      });
    }

    // 3. 查 GLOBAL scope
    const globalSet = await this.prisma.fieldDefinitionSet.findFirst({
      where: {
        scope: 'GLOBAL',
        companyId: null,
        documentFormatId: null,
        isActive: true,
      },
      select: { id: true, fields: true },
    });

    // 4. 合併: GLOBAL 為基底 → COMPANY 覆蓋/追加 → FORMAT 覆蓋/追加
    const mergedFields = new Map<string, FieldDefinitionEntry>();

    const parseFields = (raw: unknown): FieldDefinitionEntry[] => {
      if (!raw || !Array.isArray(raw)) return [];
      return raw as FieldDefinitionEntry[];
    };

    // GLOBAL base
    if (globalSet) {
      for (const f of parseFields(globalSet.fields)) {
        mergedFields.set(f.key, f);
      }
    }

    // COMPANY override
    if (companySet) {
      for (const f of parseFields(companySet.fields)) {
        mergedFields.set(f.key, f);
      }
    }

    // FORMAT override
    if (formatSet) {
      for (const f of parseFields(formatSet.fields)) {
        mergedFields.set(f.key, f);
      }
    }

    // 5. 如果全部沒找到 → fallback 到 invoice-fields.ts 的 isRequired 欄位
    if (mergedFields.size === 0) {
      return {
        fields: this.getFallbackFieldDefinitions(),
      };
    }

    // 返回最具體的 set ID（FORMAT > COMPANY > GLOBAL）
    const setId = formatSet?.id || companySet?.id || globalSet?.id;

    return {
      id: setId,
      fields: Array.from(mergedFields.values()),
    };
  }

  /**
   * CHANGE-042: Fallback 欄位定義（從 invoice-fields.ts 生成）
   * @description 當 DB 中沒有任何 FieldDefinitionSet 時使用
   */
  private getFallbackFieldDefinitions(): FieldDefinitionEntry[] {
    return Object.values(INVOICE_FIELDS)
      .filter((f: InvoiceFieldDefinition) => f.isRequired)
      .map((f: InvoiceFieldDefinition): FieldDefinitionEntry => ({
        key: f.name,
        label: f.label,
        category: f.category,
        dataType: f.dataType === 'address' || f.dataType === 'phone' || f.dataType === 'email'
          || f.dataType === 'weight' || f.dataType === 'dimension'
          ? 'string'
          : f.dataType as 'string' | 'number' | 'date' | 'currency',
        required: f.isRequired,
        description: f.description,
        aliases: f.aliases,
      }));
  }

  /**
   * 載入 Tier 1 通用術語映射
   * @deprecated CHANGE-083: 已停用於 Stage 3 注入（fieldName→fieldLabel 屬直譯冗餘）。
   *   保留供未來 Phase 2 術語映射正規化重用。MappingRule 表與 /rules 頁面不受影響。
   * @description 載入沒有 companyId 的通用映射規則
   * TODO: Phase 2 - 實現完整的術語映射載入，可能需要額外的資料表
   */
  private async loadTier1Mappings(): Promise<Record<string, string>> {
    // MappingRule 模型使用 fieldName/fieldLabel 而非 originalTerm/standardTerm
    // 這裡載入通用規則（companyId 為 null 的規則）
    const mappings = await this.prisma.mappingRule.findMany({
      where: {
        companyId: null,
        isActive: true,
      },
      select: {
        fieldName: true,
        fieldLabel: true,
      },
    });

    // 將 fieldName -> fieldLabel 作為術語映射
    return Object.fromEntries(
      mappings.map((m) => [m.fieldName, m.fieldLabel])
    );
  }

  /**
   * 載入 Tier 2 公司特定術語映射
   * @deprecated CHANGE-083: 已停用於 Stage 3 注入（fieldName→fieldLabel 屬直譯冗餘）。
   *   保留供未來 Phase 2 術語映射正規化重用。MappingRule 表與 /rules 頁面不受影響。
   * @description 載入特定公司的映射規則覆蓋
   * TODO: Phase 2 - 實現完整的術語映射載入
   */
  private async loadTier2Mappings(
    companyId: string
  ): Promise<Record<string, string>> {
    const mappings = await this.prisma.mappingRule.findMany({
      where: {
        companyId,
        isActive: true,
      },
      select: {
        fieldName: true,
        fieldLabel: true,
      },
    });

    return Object.fromEntries(
      mappings.map((m) => [m.fieldName, m.fieldLabel])
    );
  }


  /**
   * CHANGE-042 Phase 2: 動態生成輸出 JSON Schema
   * @description 根據 FieldDefinitionEntry[] 動態生成 JSON Schema，
   *   用於 GPT response_format structured output
   */
  private generateOutputSchema(
    fieldDefinitions: FieldDefinitionEntry[]
  ): Record<string, unknown> {
    const fieldProperties: Record<string, unknown> = {};

    for (const def of fieldDefinitions) {
      fieldProperties[def.key] = {
        type: 'object',
        properties: {
          value: {
            type: this.mapDataTypeToJsonType(def.dataType),
            description: def.description || def.label,
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 100,
            description: `Extraction confidence for ${def.label}`,
          },
        },
        required: ['value', 'confidence'],
      };
    }

    return {
      type: 'object',
      properties: {
        fields: {
          type: 'object',
          properties: fieldProperties,
          description: 'All extracted fields as key-value pairs with confidence scores',
        },
        lineItems: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              category: { type: 'string' },
              quantity: { type: 'number' },
              unitPrice: { type: 'number' },
              amount: { type: 'number' },
              confidence: { type: 'number', minimum: 0, maximum: 100 },
            },
            required: ['description', 'amount'],
          },
          description: 'Line items with term classification',
        },
        // CHANGE-045: extraCharges removed — data already covered by lineItems and fields
        overallConfidence: {
          type: 'number',
          minimum: 0,
          maximum: 100,
          description: 'Overall extraction confidence (0-100)',
        },
      },
      required: ['fields', 'lineItems', 'overallConfidence'],
    };
  }

  /**
   * CHANGE-042 Phase 2: 資料類型映射為 JSON Schema 類型
   */
  private mapDataTypeToJsonType(dataType: string): string | string[] {
    switch (dataType) {
      case 'number':
      case 'currency':
        return ['number', 'null'];
      case 'date':
      case 'string':
      default:
        return ['string', 'null'];
    }
  }

  /**
   * CHANGE-026: 構建變數上下文（用於自定義配置）
   */
  private buildVariableContextForConfig(
    input: Stage3Input,
    config: ExtractionConfig
  ): VariableContext {
    return buildStage3VariableContext({
      companyName: input.stage1Result.companyName,
      documentFormatName: input.stage2Result.formatName,
      universalMappings: Object.entries(config.universalMappings).map(
        ([sourceTerm, targetCategory]) => ({ sourceTerm, targetCategory })
      ),
      companyMappings: Object.entries(config.companyMappings).map(
        ([sourceTerm, targetCategory]) => ({ sourceTerm, targetCategory })
      ),
      standardFields: config.standardFields.map((f) => f.key),
      customFields: config.customFields.map((f) => f.key),
      fieldSchema: JSON.stringify(config.outputSchema),
      fileName: input.fileName,
      pageCount: input.imageBase64Array.length,
    });
  }

  /**
   * 組裝完整的提取 Prompt
   * @description CHANGE-026: 支援變數替換
   */
  private buildExtractionPrompt(
    config: ExtractionConfig,
    variableContext?: VariableContext
  ): {
    system: string;
    user: string;
  } {
    // 構建術語映射部分
    const mappingsSection = this.buildMappingsSection(
      config.universalMappings,
      config.companyMappings
    );

    // 構建欄位定義部分
    const fieldsSection = this.buildFieldsSection(
      config.standardFields,
      config.customFields
    );

    // FIX-043: 保存原始 systemPrompt（變數替換前），用於判斷是否需注入 FieldDefinitionSet
    const rawSystemPrompt = config.systemPrompt || '';

    let systemPrompt =
      config.systemPrompt ||
      `You are an expert invoice data extraction specialist.
Extract all requested fields accurately from the provided invoice image.

${fieldsSection}

${mappingsSection}

Respond in valid JSON format matching the provided schema.`;

    let userPrompt =
      config.userPromptTemplate ||
      'Extract all invoice data from this image according to the field definitions.';

    // CHANGE-026: 執行變數替換（如果有自定義配置）
    if (config.promptConfigId && variableContext) {
      systemPrompt = replaceVariables(systemPrompt, variableContext);
      userPrompt = replaceVariables(userPrompt, variableContext);
      console.log(
        `[Stage3] Applied variable replacement for PromptConfig (scope: ${config.promptConfigScope})`
      );
    }

    // FIX-043: 自動注入 FieldDefinitionSet 欄位定義
    // 當 PromptConfig 提供自定義 systemPrompt 且未包含欄位變數時，
    // 自動追加 FieldDefinitionSet 的欄位定義段落
    if (
      rawSystemPrompt &&
      config.fieldDefinitions &&
      config.fieldDefinitions.length > 0 &&
      this.shouldInjectFieldDefinitions(rawSystemPrompt)
    ) {
      const fieldDefsSection = this.buildFieldDefinitionsSection(
        config.fieldDefinitions
      );
      if (fieldDefsSection) {
        systemPrompt = systemPrompt + '\n' + fieldDefsSection;
        console.log(
          `[Stage3] Injected ${config.fieldDefinitions.length} field definitions from FieldDefinitionSet`
        );
      }
    }

    return {
      system: systemPrompt,
      user: userPrompt,
    };
  }

  /**
   * 構建術語映射 Prompt 部分
   */
  private buildMappingsSection(
    universalMappings: Record<string, string>,
    companyMappings: Record<string, string>
  ): string {
    const sections: string[] = [];

    if (Object.keys(universalMappings).length > 0) {
      sections.push(
        `Universal Term Mappings (Tier 1):\n${Object.entries(universalMappings)
          .map(([from, to]) => `  "${from}" → "${to}"`)
          .join('\n')}`
      );
    }

    if (Object.keys(companyMappings).length > 0) {
      sections.push(
        `Company-Specific Mappings (Tier 2 - override Tier 1):\n${Object.entries(
          companyMappings
        )
          .map(([from, to]) => `  "${from}" → "${to}"`)
          .join('\n')}`
      );
    }

    return sections.length > 0
      ? `Term Classification Rules:\n${sections.join('\n\n')}`
      : '';
  }

  /**
   * 構建欄位定義 Prompt 部分
   */
  private buildFieldsSection(
    standardFields: FieldDefinition[],
    customFields: FieldDefinition[]
  ): string {
    const standardSection = standardFields
      .map(
        (f) =>
          `- ${f.key} (${f.type}${f.required ? ', required' : ''}): ${f.displayName}`
      )
      .join('\n');

    const customSection =
      customFields.length > 0
        ? customFields
            .map(
              (f) =>
                `- ${f.key} (${f.type}${f.required ? ', required' : ''}): ${f.displayName}`
            )
            .join('\n')
        : '';

    return `Standard Fields:\n${standardSection}${customSection ? `\n\nCustom Fields:\n${customSection}` : ''}`;
  }

  /**
   * FIX-043: 判斷是否需要自動注入 FieldDefinitionSet 欄位定義
   * @description 檢查原始 systemPrompt 是否已包含欄位相關變數（如 ${standardFields}、${fieldSchema}）。
   *              如已包含，說明用戶在 PromptConfig 模板中主動嵌入了欄位，無需重複注入。
   */
  private shouldInjectFieldDefinitions(rawSystemPrompt: string): boolean {
    const fieldRelatedVars = [
      'standardFields',
      'customFields',
      'fieldSchema',
      'fieldsSection',
    ];
    const existingVars = extractVariableNames(rawSystemPrompt);
    return !fieldRelatedVars.some((v) => existingVars.includes(v));
  }

  /**
   * FIX-043: 構建 FieldDefinitionSet 欄位定義注入段落
   * @description 當 PromptConfig 的自定義 systemPrompt 未包含欄位變數時，
   *              自動追加此段落以確保 FieldDefinitionSet 欄位被使用於提取。
   *              同時注入明確的 JSON 輸出格式指示，確保 GPT 輸出結構與
   *              ExtractionResult.fieldMappings 的儲存格式一致。
   */
  private buildFieldDefinitionsSection(
    fieldDefinitions: FieldDefinitionEntry[]
  ): string {
    if (!fieldDefinitions || fieldDefinitions.length === 0) return '';

    const requiredFields = fieldDefinitions.filter((f) => f.required);
    const optionalFields = fieldDefinitions.filter((f) => !f.required);

    const fieldKeys = fieldDefinitions.map((f) => f.key);

    // CHANGE-094: 費用明細欄位（fieldType === 'lineItem'）— 供 line item 回填指示
    const chargeFields = fieldDefinitions.filter(
      (f) => f.fieldType === 'lineItem'
    );

    // FIX-095: 標準發票基本欄位 — 必須與費用欄位一起放進 fields。
    //   否則當 GPT 採用 fields 格式輸出時不會提取這些欄位，導致 standardFields 全空、
    //   信心度的 FIELD_COMPLETENESS 維度被誤判為 0（本地/Azure 同文件信心度落差的根因）。
    //   key 對齊 buildStandardFieldsFromRecord 的查找鍵。
    const standardInvoiceFields: Array<{ key: string; label: string }> = [
      { key: 'invoice_number', label: '發票號碼 Invoice Number' },
      { key: 'invoice_date', label: '發票日期 Invoice Date (YYYY-MM-DD)' },
      { key: 'due_date', label: '到期日 Due Date (YYYY-MM-DD or null)' },
      { key: 'vendor_name', label: '供應商/發行公司名稱 Vendor / Issuer Name' },
      { key: 'customer_name', label: '買方名稱 Customer / Buyer Name' },
      { key: 'currency', label: '幣別 Currency (ISO 4217, e.g. USD/HKD/TWD)' },
      { key: 'subtotal', label: '小計 Subtotal' },
      { key: 'total_amount', label: '總金額 Total Amount' },
    ];

    const lines: string[] = [
      '\n--- Field Extraction Requirements ---',
      `Total fields to extract: ${fieldDefinitions.length}`,
    ];

    if (requiredFields.length > 0) {
      lines.push('\nRequired Fields (MUST extract):');
      for (const f of requiredFields) {
        const hints = f.extractionHints
          ? ` (Hints: ${f.extractionHints})`
          : '';
        const aliases =
          f.aliases && f.aliases.length > 0
            ? ` [Also known as: ${f.aliases.join(', ')}]`
            : '';
        lines.push(
          `  - ${f.label} (${f.key}, type: ${f.dataType})${aliases}${hints}`
        );
      }
    }

    if (optionalFields.length > 0) {
      lines.push('\nOptional Fields (extract if available):');
      for (const f of optionalFields) {
        const hints = f.extractionHints
          ? ` (Hints: ${f.extractionHints})`
          : '';
        const aliases =
          f.aliases && f.aliases.length > 0
            ? ` [Also known as: ${f.aliases.join(', ')}]`
            : '';
        lines.push(
          `  - ${f.label} (${f.key}, type: ${f.dataType})${aliases}${hints}`
        );
      }
    }

    // 注入明確的 JSON 輸出格式指示，與 ExtractionResult 儲存結構對齊
    lines.push('\n--- Required Output Format ---');
    lines.push(
      'You MUST respond with a JSON object in the following structure:'
    );
    lines.push('{');
    lines.push('  "fields": {');
    lines.push(
      `    // Use EXACTLY these keys: ${fieldKeys.slice(0, 5).join(', ')}${fieldKeys.length > 5 ? ', ...' : ''}`
    );
    lines.push('    "<field_key>": {');
    lines.push(
      '      "value": "<extracted_value or null if not found>",  // string, number, or null'
    );
    lines.push(
      '      "confidence": <0-100>  // 0 if not found, higher means more certain'
    );
    lines.push('    }');
    lines.push('  },');
    lines.push('  "lineItems": [');
    lines.push('    {');
    lines.push(
      '      "description": "<item description>",  // required'
    );
    lines.push(
      '      "category": "<charge category>",      // MUST use Title Case with spaces, e.g. "Terminal Handling Charge", "Freight Charges"'
    );
    lines.push('      "quantity": <number>,');
    lines.push('      "unitPrice": <number>,');
    lines.push(
      '      "amount": <number>,                   // required'
    );
    lines.push('      "confidence": <0-100>');
    lines.push('    }');
    lines.push('  ],');
    lines.push('  "overallConfidence": <0-100>');
    lines.push('}');
    lines.push('');
    lines.push('IMPORTANT:');
    lines.push(
      '- The "fields" object MUST contain ALL field keys listed above, even if the value is null.'
    );
    // FIX-095: 要求 fields 同時包含標準發票基本欄位（與費用欄位並存），
    //   讓 standardFields 能被填滿、FIELD_COMPLETENESS 正確計算。不影響 lineItems 提取。
    lines.push(
      '- The "fields" object MUST ALSO include these standard invoice fields (use EXACTLY these keys; set value to null only if truly absent from the document):'
    );
    for (const sf of standardInvoiceFields) {
      lines.push(`    - ${sf.key}: ${sf.label}`);
    }
    lines.push(
      '- Do NOT invent fields outside the charge field keys and the standard invoice fields listed above.'
    );
    lines.push(
      '- Each field value MUST be an object with "value" and "confidence" properties.'
    );

    // CHANGE-094: 強制 line item 費用回填指示（消除「fields vs lineItems」非確定性）
    if (chargeFields.length > 0) {
      lines.push(
        '- For EACH line item whose charge corresponds to one of the charge field keys below, you MUST ALSO put its amount into that key inside "fields" (and still keep the item in "lineItems"). Match by MEANING, not exact wording — e.g. "Documentation at Origin" → origin_document_processing_fee, "Handling and Processing at Origin" → origin_thc_terminal_handling_charge.'
      );
      lines.push(
        '- If multiple line items map to the same charge key, SUM their amounts into that key. This mapping MUST be consistent across runs of the same document.'
      );
      lines.push('\nCharge field keys (fill these from line items when applicable):');
      for (const f of chargeFields) {
        lines.push(`  - ${f.key}: ${f.label}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 調用 GPT-5.2
   * @description 使用 GptCallerService 調用 GPT-5.2 進行欄位提取
   * CHANGE-042 Phase 2: 傳遞 outputSchema 給 GptCallerService 以啟用 structured output
   */
  private async callGpt52(
    prompt: { system: string; user: string },
    images: string[],
    outputSchema: Record<string, unknown>,
    imageDetailMode: 'auto' | 'low' | 'high'
  ): Promise<{
    response: string;
    tokenUsage: { input: number; output: number; total: number };
    model: string;
  }> {
    const result: GptCallResult = await GptCallerService.callFull(
      prompt.system,
      prompt.user,
      images,
      imageDetailMode as ImageDetailMode,
      undefined, // config
      outputSchema // CHANGE-042 Phase 2: JSON Schema for structured output
    );

    if (!result.success) {
      throw new Error(result.error || 'GPT-5.2 調用失敗');
    }

    return {
      response: result.response,
      tokenUsage: result.tokenUsage,
      model: result.model,
    };
  }

  /**
   * CHANGE-042: 解析 GPT 響應（支援三種格式）
   * @description
   *   Case 1: 有 "fields" key（新格式） → 直接使用，同時生成 standardFields 向下兼容
   *   Case 2: 有 "standardFields" key（舊格式） → 展平為 fields Record
   *   Case 3: 原始格式（GPT 直接回傳 key-value） → 用 fieldDefinitions + aliases 動態查找
   */
  private parseExtractionResult(
    response: string,
    fieldDefinitions?: FieldDefinitionEntry[]
  ): GptExtractionResponse {
    try {
      let parsed = JSON.parse(response) as Record<string, unknown>;

      // FIX-093: 處理 GPT 偶發的 { success, confidence, invoiceData: {...} } 包裹格式
      //   （例見 HEX250526 雙發票 PDF）。此格式不符合下列三個 case 的預期，會導致
      //   fields 與 lineItems 雙雙解析成空、整份提取丟失。先攤平 invoiceData 為
      //   raw 格式，再交由 Case 3 動態映射處理（lineItems 無 category 時以
      //   description 補上，供 classifiedAs 正規化與費用回填對照）。
      if (
        parsed.invoiceData &&
        typeof parsed.invoiceData === 'object' &&
        !parsed.fields &&
        !parsed.standardFields
      ) {
        parsed = this.unwrapInvoiceDataFormat(parsed);
      }

      // Case 1: 新格式 — 有 "fields" key
      if (parsed.fields && typeof parsed.fields === 'object') {
        const fieldsRecord = parsed.fields as Record<string, unknown>;
        const fields: Record<string, FieldValue> = {};

        for (const [key, val] of Object.entries(fieldsRecord)) {
          if (val && typeof val === 'object' && 'value' in (val as Record<string, unknown>)) {
            fields[key] = val as FieldValue;
          } else {
            fields[key] = { value: val as string | number | null, confidence: 85 };
          }
        }

        // 從 fields 生成向下兼容的 standardFields
        const standardFields = this.buildStandardFieldsFromRecord(fields);
        // FIX-095: 防禦性容錯 — 若標準發票欄位未出現在 fields 內，
        //   嘗試從 GPT 回傳的頂層或 invoiceData 區塊補撈（僅補空缺，不碰 lineItems）。
        this.backfillStandardFieldsFromRaw(standardFields, parsed);

        return {
          standardFields,
          fields,
          lineItems: this.convertRawLineItems(
            (parsed.lineItems ?? parsed.line_items) as unknown[] | undefined
          ),
          extraCharges: parsed.extraCharges as ExtraChargeV3[] | undefined,
          overallConfidence: (parsed.overallConfidence as number) || 0,
        };
      }

      // Case 2: 舊格式 — 有 "standardFields" key
      if (parsed.standardFields) {
        const typedParsed = parsed as unknown as GptExtractionResponse;
        const standardFields =
          typedParsed.standardFields || this.buildEmptyStandardFields();

        // 展平 standardFields 為 fields Record
        const fields = this.flattenStandardFieldsToRecord(
          standardFields,
          typedParsed.customFields
        );

        return {
          standardFields,
          customFields: typedParsed.customFields,
          fields,
          lineItems: typedParsed.lineItems || [],
          extraCharges: typedParsed.extraCharges,
          overallConfidence: typedParsed.overallConfidence || 0,
        };
      }

      // Case 3: 原始格式 — 用 fieldDefinitions + aliases 動態映射
      return this.convertRawResponseDynamic(parsed, fieldDefinitions);
    } catch {
      throw new Error('Failed to parse GPT extraction response');
    }
  }

  /**
   * FIX-093: 攤平 GPT 的 invoiceData 包裹格式為 raw 結構
   *
   * @description
   *   GPT 偶發回傳 `{ success, confidence, invoiceData: { invoiceNumber, currency,
   *   totalAmount, lineItems: [...] } }`，與 stage-3 預期的頂層 `{ fields, lineItems }`
   *   不符，導致 {@link parseExtractionResult} 三個 case 全部落空、整份提取丟失。
   *
   *   本方法把 `invoiceData` 內的欄位提升到頂層（並補上 snake_case 別名，讓
   *   {@link convertRawResponseDynamic} 的 aliases 搜尋撈得到標準欄位），同時保留
   *   `lineItems`；當 lineItem 缺少 `category` 時以 `description` 補上，使後續
   *   `classifiedAs` 正規化與 CHANGE-094 費用回填有對照依據。
   *
   * @param parsed - 含 `invoiceData` 的原始解析結果
   * @returns 攤平後的 raw 物件（交由 Case 3 動態映射處理）
   * @since FIX-093
   */
  private unwrapInvoiceDataFormat(
    parsed: Record<string, unknown>
  ): Record<string, unknown> {
    const inv = parsed.invoiceData as Record<string, unknown>;
    const rawLineItems = (inv.lineItems ?? inv.line_items) as
      | Array<Record<string, unknown>>
      | undefined;
    const lineItems = Array.isArray(rawLineItems)
      ? rawLineItems.map((li) => ({
          ...li,
          // 無 category 時用 description 補上（供 classifiedAs 對照與費用回填）
          category: li.category ?? li.description,
        }))
      : [];

    const vendor = inv.vendor as Record<string, unknown> | undefined;

    return {
      ...inv,
      // snake_case 別名，讓 convertRawResponseDynamic 的 aliases 搜尋命中標準欄位
      invoice_number: inv.invoiceNumber ?? inv.invoice_number,
      invoice_date: inv.invoiceDate ?? inv.invoice_date,
      due_date: inv.dueDate ?? inv.due_date,
      total_amount: inv.totalAmount ?? inv.total_amount,
      subtotal: inv.subtotal,
      currency: inv.currency,
      vendor_name: vendor?.name ?? inv.vendorName,
      lineItems,
    };
  }

  /**
   * CHANGE-042: 動態映射原始 GPT 響應
   * @description 基於 fieldDefinitions + invoice-fields.ts aliases 進行智能匹配
   */
  private convertRawResponseDynamic(
    raw: Record<string, unknown>,
    fieldDefinitions?: FieldDefinitionEntry[]
  ): GptExtractionResponse {
    const DEFAULT_CONFIDENCE = 85;
    const fields: Record<string, FieldValue> = {};

    // 建立搜索清單: fieldDefinitions + invoice-fields.ts 全部欄位
    const searchEntries: Array<{
      key: string;
      aliases: string[];
    }> = [];

    // 從 fieldDefinitions 構建
    if (fieldDefinitions && fieldDefinitions.length > 0) {
      for (const def of fieldDefinitions) {
        const baseAliases = [
          def.key,
          this.toCamelCase(def.key),
          this.toPascalCase(def.key),
        ];
        // 加入 DB 定義的 aliases
        const dbAliases = def.aliases || [];
        // 加入 invoice-fields.ts 的 aliases
        const invoiceField = findFieldByAlias(def.key);
        const invoiceAliases = invoiceField?.aliases || [];

        searchEntries.push({
          key: def.key,
          aliases: [...new Set([...baseAliases, ...dbAliases, ...invoiceAliases])],
        });
      }
    } else {
      // Fallback: 使用 invoice-fields.ts 所有欄位
      for (const field of Object.values(INVOICE_FIELDS)) {
        const baseAliases = [
          field.name,
          this.toCamelCase(field.name),
          this.toPascalCase(field.name),
        ];
        searchEntries.push({
          key: field.name,
          aliases: [...new Set([...baseAliases, ...(field.aliases || [])])],
        });
      }
    }

    // 對每個欄位進行搜索
    for (const entry of searchEntries) {
      const value = this.findValueInRaw(raw, entry.aliases);
      if (value !== undefined) {
        fields[entry.key] =
          value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)
            ? (value as FieldValue)
            : { value: value as string | number | null, confidence: DEFAULT_CONFIDENCE };
      }
    }

    // 向下兼容 standardFields
    const standardFields = this.buildStandardFieldsFromRecord(fields);

    // 轉換 line items
    const lineItems = this.convertRawLineItems(
      (raw.lineItems ?? raw.line_items) as unknown[] | undefined
    );

    // 計算信心度
    const overallConfidence = this.calculateDynamicFieldsConfidence(fields);

    return {
      standardFields,
      fields,
      lineItems,
      extraCharges: raw.extraCharges as ExtraChargeV3[] | undefined,
      overallConfidence,
    };
  }

  /**
   * CHANGE-042: 在原始數據中搜索值
   */
  private findValueInRaw(
    raw: Record<string, unknown>,
    aliases: string[]
  ): unknown | undefined {
    for (const alias of aliases) {
      if (raw[alias] !== undefined && raw[alias] !== null) {
        return raw[alias];
      }
    }
    // 嵌套搜索（常見嵌套 key）
    const nestedKeys = ['invoice_metadata', 'seller', 'totals', 'header'];
    for (const nk of nestedKeys) {
      if (raw[nk] && typeof raw[nk] === 'object') {
        const nested = raw[nk] as Record<string, unknown>;
        for (const alias of aliases) {
          if (nested[alias] !== undefined && nested[alias] !== null) {
            return nested[alias];
          }
        }
      }
    }
    return undefined;
  }

  /**
   * CHANGE-042: snake_case → camelCase
   */
  private toCamelCase(str: string): string {
    return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  }

  /**
   * CHANGE-042: snake_case → PascalCase
   */
  private toPascalCase(str: string): string {
    const camel = this.toCamelCase(str);
    return camel.charAt(0).toUpperCase() + camel.slice(1);
  }

  /**
   * CHANGE-042: 從 fields Record 建構向下兼容的 StandardFieldsV3
   */
  private buildStandardFieldsFromRecord(
    fields: Record<string, FieldValue>
  ): StandardFieldsV3 {
    const emptyField: FieldValue = { value: null, confidence: 0 };
    return {
      invoiceNumber: fields['invoice_number'] || fields['invoiceNumber'] || emptyField,
      invoiceDate: fields['invoice_date'] || fields['invoiceDate'] || emptyField,
      dueDate: fields['due_date'] || fields['dueDate'],
      vendorName: fields['vendor_name'] || fields['vendorName']
        || fields['forwarder_name'] || fields['forwarderName'] || emptyField,
      customerName: fields['customer_name'] || fields['customerName']
        || fields['shipper_name'] || fields['shipperName'],
      totalAmount: fields['total_amount'] || fields['totalAmount'] || emptyField,
      subtotal: fields['subtotal'],
      currency: fields['currency'] || emptyField,
    };
  }

  /**
   * FIX-095: 防禦性容錯 — 當 GPT 採 `fields` 格式但標準發票欄位未放進 fields 時，
   *   嘗試從回傳的頂層（或 invoiceData 區塊，若同時存在）補撈標準必填欄位。
   *
   * @description
   *   僅補「目前為空」的標準欄位，不覆蓋已有值；**完全不涉及 lineItems**。
   *   注意：此為防禦補強。若 GPT 根本未提取基本欄位（如僅輸出費用 fields），
   *   此處無資料可補 — 真正的修復在 prompt 層（要求 GPT 一併提取基本欄位）。
   * @since FIX-095
   */
  private backfillStandardFieldsFromRaw(
    standardFields: StandardFieldsV3,
    parsed: Record<string, unknown>
  ): void {
    const inv = (parsed.invoiceData && typeof parsed.invoiceData === 'object'
      ? parsed.invoiceData
      : parsed) as Record<string, unknown>;
    const vendor = inv.vendor as Record<string, unknown> | undefined;

    const pick = (...candidates: unknown[]): FieldValue | undefined => {
      for (const c of candidates) {
        if (c !== undefined && c !== null && c !== '') {
          if (typeof c === 'object' && 'value' in (c as Record<string, unknown>)) {
            return c as FieldValue;
          }
          return { value: c as string | number, confidence: 85 };
        }
      }
      return undefined;
    };

    const isEmpty = (f?: FieldValue): boolean =>
      !f || f.value === null || f.value === '';

    if (isEmpty(standardFields.invoiceNumber)) {
      const v = pick(inv.invoiceNumber, inv.invoice_number);
      if (v) standardFields.invoiceNumber = v;
    }
    if (isEmpty(standardFields.invoiceDate)) {
      const v = pick(inv.invoiceDate, inv.invoice_date);
      if (v) standardFields.invoiceDate = v;
    }
    if (isEmpty(standardFields.vendorName)) {
      const v = pick(inv.vendorName, inv.vendor_name, vendor?.name);
      if (v) standardFields.vendorName = v;
    }
    if (isEmpty(standardFields.totalAmount)) {
      const v = pick(inv.totalAmount, inv.total_amount);
      if (v) standardFields.totalAmount = v;
    }
    if (isEmpty(standardFields.currency)) {
      const v = pick(inv.currency);
      if (v) standardFields.currency = v;
    }
  }

  /**
   * CHANGE-042: 展平 StandardFieldsV3 + customFields 為 fields Record
   */
  private flattenStandardFieldsToRecord(
    sf: StandardFieldsV3,
    customFields?: Record<string, FieldValue>
  ): Record<string, FieldValue> {
    const fields: Record<string, FieldValue> = {
      invoice_number: sf.invoiceNumber,
      invoice_date: sf.invoiceDate,
      vendor_name: sf.vendorName,
      total_amount: sf.totalAmount,
      currency: sf.currency,
    };
    if (sf.dueDate) fields['due_date'] = sf.dueDate;
    if (sf.customerName) fields['customer_name'] = sf.customerName;
    if (sf.subtotal) fields['subtotal'] = sf.subtotal;
    if (customFields) {
      for (const [k, v] of Object.entries(customFields)) {
        fields[k] = v;
      }
    }
    return fields;
  }

  /**
   * 轉換原始 line items
   */
  private convertRawLineItems(
    rawItems: unknown[] | undefined
  ): LineItemV3[] {
    if (!rawItems || !Array.isArray(rawItems)) {
      return [];
    }

    return rawItems.map((item, index) => {
      const rawItem = item as Record<string, unknown>;
      return {
        description: (rawItem.description as string) || '',
        classifiedAs: rawItem.category
          ? normalizeClassifiedAs(rawItem.category as string)
          : undefined,
        quantity: rawItem.quantity as number | undefined,
        unitPrice: (rawItem.unit_price ?? rawItem.unitPrice) as number | undefined,
        amount: (rawItem.amount as number) || 0,
        confidence: (rawItem.confidence as number) ?? 85,
        needsClassification: !rawItem.category,
      };
    });
  }

  /**
   * CHANGE-094: 確定性回填 lineItem 費用至對應 field definition key
   *
   * @description
   *   解決「費用提取非確定性」問題：GPT 對「該把費用填進 fields 的 field def key，
   *   還是只放 lineItems」判斷不穩定（同文件不同次提取結果不同），導致 Template
   *   Instance 費用映射時有時取不到值。
   *
   *   本步驟在解析後以**程式化、確定性**方式，將每個 lineItem 的金額補進對應的
   *   費用 field key（僅針對 `fieldType === 'lineItem'` 的欄位）。對照來源為
   *   lineItem 的 `classifiedAs` 對 field def 的 `label` + `aliases`：
   *   - 正規化後相等（exact）或詞邊界子字串（substring），見 {@link matchLabel}
   *   - **歧義保護**：若同一 classifiedAs 同時命中多個目標（如
   *     `"Terminal Handling Charge"` 同時是 origin 與 destination THC 的子字串），
   *     則跳過該筆，避免填錯。
   *   - **GPT 優先**：僅補空缺，GPT 已填的值不覆蓋（見 §設計決策 OQ#3）。
   *   - **多筆加總**：同一 key 對應多筆 lineItem 時金額加總（OQ#4）。
   *
   *   注意：CEVA 等 field def 的 `aliases` 多為空，第一版僅能命中 `label`
   *   精確 / 子字串；如 `"Documentation Fee"` → `origin_document_processing_fee`
   *   這類語意相同但詞不同者，需在 field def 補 `aliases` 才會命中。
   *
   * @param fields - 解析後的欄位 Record（會被就地修改）
   * @param lineItems - 解析後的行項目
   * @param fieldDefinitions - 當前 FieldDefinitionSet 的欄位定義
   * @since CHANGE-094
   */
  private backfillLineItemCharges(
    fields: Record<string, FieldValue>,
    lineItems: LineItemV3[],
    fieldDefinitions: FieldDefinitionEntry[]
  ): void {
    if (!lineItems?.length || !fieldDefinitions?.length) return;

    // 僅針對 lineItem 類費用欄位
    const chargeDefs = fieldDefinitions.filter((d) => d.fieldType === 'lineItem');
    if (chargeDefs.length === 0) return;

    // key → 待回填的累加金額（僅在 GPT 未填時生效）
    const pending = new Map<string, number>();

    for (const li of lineItems) {
      const candidate = li.classifiedAs;
      if (!candidate || typeof li.amount !== 'number') continue;

      // 對每個 charge def 判定對照種類（取最強：exact > substring）
      const exactKeys: string[] = [];
      const substringKeys: string[] = [];
      for (const def of chargeDefs) {
        const targets = [def.label, ...(def.aliases ?? [])];
        let best: LabelMatchKind = null;
        for (const target of targets) {
          const kind = matchLabel(candidate, target);
          if (kind === 'exact') {
            best = 'exact';
            break;
          }
          if (kind === 'substring') best = 'substring';
        }
        if (best === 'exact') exactKeys.push(def.key);
        else if (best === 'substring') substringKeys.push(def.key);
      }

      // 唯一性裁決：精確優先；歧義（多個命中）則跳過，不誤填
      let targetKey: string | null = null;
      if (exactKeys.length === 1) {
        targetKey = exactKeys[0];
      } else if (exactKeys.length === 0 && substringKeys.length === 1) {
        targetKey = substringKeys[0];
      }
      if (!targetKey) continue;

      // GPT 已填值優先：僅補空缺
      if (this.hasFieldValue(fields[targetKey])) continue;

      pending.set(targetKey, (pending.get(targetKey) ?? 0) + li.amount);
    }

    for (const [key, sum] of pending) {
      if (this.hasFieldValue(fields[key])) continue;
      fields[key] = {
        value: sum,
        confidence: 85,
        source: 'lineItem-backfill',
      };
    }
  }

  /**
   * CHANGE-094: 判定 FieldValue 是否已有有效值
   * @description GPT 填 null / 空字串 / 未填皆視為空缺（可被回填覆蓋）
   * @since CHANGE-094
   */
  private hasFieldValue(fv?: FieldValue): boolean {
    return (
      !!fv &&
      fv.value !== null &&
      fv.value !== undefined &&
      fv.value !== ''
    );
  }

  /**
   * 計算欄位的平均信心度（StandardFieldsV3 向下兼容版本）
   */
  private calculateFieldsConfidence(fields: StandardFieldsV3): number {
    const fieldList = [
      fields.invoiceNumber,
      fields.invoiceDate,
      fields.vendorName,
      fields.totalAmount,
      fields.currency,
    ];

    const validFields = fieldList.filter(
      (f) => f && f.value !== null && f.value !== '' && f.confidence > 0
    );

    if (validFields.length === 0) {
      return 0;
    }

    return Math.round(
      validFields.reduce((sum, f) => sum + f.confidence, 0) / validFields.length
    );
  }

  /**
   * CHANGE-042: 動態計算所有 fields 的平均信心度
   */
  private calculateDynamicFieldsConfidence(
    fields: Record<string, FieldValue>
  ): number {
    const allValues = Object.values(fields);
    const validFields = allValues.filter(
      (f) => f && f.value !== null && f.value !== '' && f.confidence > 0
    );

    if (validFields.length === 0) {
      const filledCount = allValues.filter(
        (f) => f && f.value !== null && f.value !== ''
      ).length;
      return filledCount > 0 ? 60 + (filledCount / Math.max(allValues.length, 1)) * 30 : 0;
    }

    return Math.round(
      validFields.reduce((sum, f) => sum + f.confidence, 0) / validFields.length
    );
  }

  /**
   * 構建空的標準欄位
   */
  private buildEmptyStandardFields(): StandardFieldsV3 {
    const emptyField: FieldValue = { value: null, confidence: 0 };
    return {
      invoiceNumber: emptyField,
      invoiceDate: emptyField,
      vendorName: emptyField,
      totalAmount: emptyField,
      currency: emptyField,
    };
  }

  /**
   * 構建空的配置使用詳情
   */
  private buildEmptyConfigUsed(): Stage3ConfigUsed {
    return {
      promptConfigScope: 'GLOBAL',
      universalMappingsCount: 0,
      companyMappingsCount: 0,
    };
  }

  /**
   * CHANGE-042: 計算整體信心度（支援動態 fields 或 standardFields）
   * @description 優先使用 fields Record 動態計算；fallback 到 standardFields
   */
  private calculateOverallConfidence(
    standardFields: StandardFieldsV3,
    dynamicFields?: Record<string, FieldValue>
  ): number {
    // 優先使用動態 fields
    if (dynamicFields && Object.keys(dynamicFields).length > 0) {
      return this.calculateDynamicFieldsConfidence(dynamicFields);
    }

    // Fallback: 從 standardFields 計算
    const fieldList = [
      standardFields.invoiceNumber,
      standardFields.invoiceDate,
      standardFields.vendorName,
      standardFields.totalAmount,
      standardFields.currency,
    ];

    const validFields = fieldList.filter(
      (f) => f && f.value !== null && f.value !== '' && f.confidence > 0
    );

    if (validFields.length === 0) {
      const filledCount = fieldList.filter((f) => f && f.value !== null && f.value !== '').length;
      return filledCount > 0 ? 60 + (filledCount / fieldList.length) * 30 : 0;
    }

    const avgConfidence =
      validFields.reduce((sum, f) => sum + f.confidence, 0) / validFields.length;

    return Math.round(avgConfidence * 100) / 100;
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
    imageDetailMode: 'auto' | 'low' | 'high',
    durationMs: number
  ): StageAiDetails {
    // 組合完整 Prompt（System + User）
    const fullPrompt = `[SYSTEM]\n${prompt.system}\n\n[USER]\n${prompt.user}`;

    return {
      stage: 'STAGE_3',
      model: gptResult.model,
      prompt: fullPrompt,
      response: gptResult.response,
      tokenUsage: gptResult.tokenUsage,
      imageDetailMode,
      durationMs,
    };
  }

  /**
   * 構建空的 AI 詳情
   */
  private buildEmptyAiDetails(): StageAiDetails {
    return {
      stage: 'STAGE_3',
      model: '',
      prompt: '',
      response: '',
      tokenUsage: { input: 0, output: 0, total: 0 },
      durationMs: 0,
    };
  }

  /**
   * 預設 System Prompt
   */
  private getDefaultSystemPrompt(): string {
    return `You are an expert invoice data extraction specialist.
Your task is to accurately extract all fields from the provided invoice image.
Classify line items and extra charges using the provided term mappings.
Respond in valid JSON format.`;
  }

  /**
   * 預設 User Prompt
   */
  private getDefaultUserPrompt(): string {
    return 'Extract all invoice data from this image.';
  }

  // ============================================================================
  // CHANGE-042 Phase 3: Feedback Recording
  // ============================================================================

  /**
   * CHANGE-042 Phase 3: 記錄提取回饋（fire-and-forget）
   * @description
   *   比對 fieldDefinitions（定義欄位）vs 提取結果，計算覆蓋率並寫入 DB。
   *   此方法不應阻塞主管線，呼叫端應以 `.catch()` 靜默忽略錯誤。
   */
  private async recordExtractionFeedback(
    fieldDefinitionSetId: string,
    documentId: string,
    fieldDefinitions: FieldDefinitionEntry[],
    extractedFields?: Record<string, FieldValue>
  ): Promise<void> {
    const definedKeys = fieldDefinitions.map((f) => f.key);
    const extractedKeys = extractedFields
      ? Object.keys(extractedFields).filter((k) => {
          const val = extractedFields[k];
          return val && val.value !== null && val.value !== '';
        })
      : [];

    const definedSet = new Set(definedKeys);
    const extractedSet = new Set(extractedKeys);

    const foundFields = definedKeys.filter((k) => extractedSet.has(k));
    const missingFields = definedKeys.filter((k) => !extractedSet.has(k));
    const unexpectedFields = extractedKeys.filter((k) => !definedSet.has(k));

    const coverageRate =
      definedKeys.length > 0
        ? Math.round((foundFields.length / definedKeys.length) * 10000) / 10000
        : 0;

    await this.prisma.fieldExtractionFeedback.create({
      data: {
        fieldDefinitionSetId,
        documentId,
        definedFields: definedKeys,
        foundFields,
        missingFields,
        unexpectedFields,
        definedCount: definedKeys.length,
        foundCount: foundFields.length,
        missingCount: missingFields.length,
        unexpectedCount: unexpectedFields.length,
        coverageRate,
      },
    });
  }

}
