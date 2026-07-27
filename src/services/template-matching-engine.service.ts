/**
 * @fileoverview 模版匹配引擎服務
 * @description
 *   提供核心的模版匹配功能，負責將 Document.mappedFields 轉換並填入 TemplateInstance
 *   支援批量處理、事務一致性、同 rowKey 多文件合併
 *
 * @module src/services/template-matching-engine
 * @since Epic 19 - Story 19.3
 * @lastModified 2026-02-25 (CHANGE-047: inject _ref_* synthetic fields from referenceNumberMatch)
 *
 * @features
 *   - 映射規則解析（FORMAT > COMPANY > GLOBAL 優先級）
 *   - 欄位轉換（DIRECT、FORMULA、LOOKUP 等）
 *   - 批量處理與事務一致性
 *   - 同 rowKey 多文件合併
 *   - 數據驗證與錯誤記錄
 *   - 處理進度回調
 *
 * @dependencies
 *   - prisma - 資料庫操作
 *   - template-field-mapping.service.ts - 映射規則解析
 *   - template-instance.service.ts - 實例管理
 *   - transform/ - 欄位轉換器
 */

import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { templateFieldMappingService } from './template-field-mapping.service';
import { templateInstanceService } from './template-instance.service';
import { TransformExecutor } from './transform';
// FIX-128: 未知來源 key 診斷
import { findUnknownRuleSourceKeys } from '@/lib/template-mapping-source-keys';
import type {
  MatchDocumentsParams,
  MatchResult,
  RowResult,
  UpsertRowParams,
  PreviewMatchParams,
  PreviewMatchResult,
  PreviewRowResult,
  ValidateMappingParams,
  ValidateMappingResult,
  MatchingErrorCode,
} from '@/types/template-matching-engine';
import { MatchingEngineError } from '@/types/template-matching-engine';
import type { TemplateFieldMappingRule, ResolvedMappingConfig } from '@/types/template-field-mapping';
import type { DataTemplateField } from '@/types/data-template';
import { EDITABLE_STATUSES } from '@/types/template-instance';
import type { TemplateInstanceStatus, ValidationResult } from '@/types/template-instance';

// ============================================================================
// Constants
// ============================================================================

/** 預設批量處理大小 */
const DEFAULT_BATCH_SIZE = 100;

/** 預設 rowKey 欄位 */
const DEFAULT_ROW_KEY_FIELD = 'shipment_no';

// ============================================================================
// Service Class
// ============================================================================

/**
 * 模版匹配引擎服務類
 * @description
 *   負責執行 Document → TemplateInstance 的匹配和轉換
 */
export class TemplateMatchingEngineService {
  /**
   * 轉換執行器
   */
  private transformExecutor: TransformExecutor;

  /**
   * 建構子
   */
  constructor() {
    this.transformExecutor = new TransformExecutor();
  }

  // --------------------------------------------------------------------------
  // Main Entry Methods
  // --------------------------------------------------------------------------

  /**
   * 執行文件到模版的匹配
   *
   * @description
   *   主要入口方法，執行以下流程：
   *   1. 獲取 TemplateInstance 和 DataTemplate
   *   2. 解析映射規則
   *   3. 載入 Documents
   *   4. 分批處理並創建/更新 TemplateInstanceRow
   *   5. 更新實例統計
   *
   * @param params - 匹配參數
   * @returns 匹配結果
   * @throws MatchingEngineError
   */
  async matchDocuments(params: MatchDocumentsParams): Promise<MatchResult> {
    const { documentIds, templateInstanceId, options = {} } = params;

    // 1. 獲取 TemplateInstance
    const instance = await prisma.templateInstance.findUnique({
      where: { id: templateInstanceId },
      include: {
        dataTemplate: true,
      },
    });

    if (!instance) {
      throw new MatchingEngineError(
        '模版實例不存在',
        'INSTANCE_NOT_FOUND' as MatchingErrorCode,
        { templateInstanceId }
      );
    }

    // 檢查實例狀態
    if (!EDITABLE_STATUSES.includes(instance.status as TemplateInstanceStatus)) {
      throw new MatchingEngineError(
        `實例狀態為 ${instance.status}，不允許添加數據`,
        'INVALID_INSTANCE_STATUS' as MatchingErrorCode,
        { status: instance.status }
      );
    }

    const template = instance.dataTemplate;
    const templateFields = template.fields as unknown as DataTemplateField[];

    // 2. 解析映射規則
    const mappingConfig = await templateFieldMappingService.resolveMapping({
      dataTemplateId: template.id,
      companyId: options.companyId,
      documentFormatId: options.formatId,
    });

    // 2.1 檢查映射配置是否為空
    if (mappingConfig.mappings.length === 0) {
      throw new MatchingEngineError(
        '找不到映射配置，請先為此模板建立 Template Field Mapping（至少需要 GLOBAL 級別配置）',
        'MAPPING_NOT_FOUND' as MatchingErrorCode,
        { dataTemplateId: template.id, resolvedFrom: mappingConfig.resolvedFrom }
      );
    }

    // 3. 載入 Documents
    const documents = await this.loadDocuments(documentIds);

    // 4. 分批處理
    const results: RowResult[] = [];
    const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
    const batches = this.createBatches(documents, batchSize);
    const totalBatches = batches.length;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchResults = await this.processBatch(
        batch,
        instance,
        templateFields,
        mappingConfig,
        options
      );
      results.push(...batchResults);

      // 進度回調
      if (options.onProgress) {
        const processed = Math.min((i + 1) * batchSize, documents.length);
        options.onProgress({
          processed,
          total: documents.length,
          currentBatch: i + 1,
          totalBatches,
          percentage: Math.round((processed / documents.length) * 100),
        });
      }
    }

    // 5. 更新統計
    await templateInstanceService.updateStatistics(templateInstanceId);

    // 統計結果
    const validRows = results.filter((r) => r.status === 'VALID').length;
    const invalidRows = results.filter((r) => r.status === 'INVALID').length;
    const errorRows = results.filter((r) => r.status === 'ERROR').length;

    return {
      instanceId: templateInstanceId,
      totalDocuments: documents.length,
      totalRows: results.length,
      validRows,
      invalidRows,
      errorRows,
      results,
    };
  }

  /**
   * 預覽匹配結果
   *
   * @description
   *   不實際創建數據，僅返回轉換和驗證結果
   *
   * @param params - 預覽參數
   * @returns 預覽結果
   */
  async previewMatch(params: PreviewMatchParams): Promise<PreviewMatchResult> {
    const {
      documentIds,
      dataTemplateId,
      companyId,
      formatId,
      rowKeyField = DEFAULT_ROW_KEY_FIELD,
    } = params;

    // 獲取模版
    const template = await prisma.dataTemplate.findUnique({
      where: { id: dataTemplateId },
    });

    if (!template) {
      throw new MatchingEngineError(
        '數據模版不存在',
        'TEMPLATE_NOT_FOUND' as MatchingErrorCode,
        { dataTemplateId }
      );
    }

    const templateFields = template.fields as unknown as DataTemplateField[];

    // 解析映射規則
    const mappingConfig = await templateFieldMappingService.resolveMapping({
      dataTemplateId,
      companyId,
      documentFormatId: formatId,
    });

    // 檢查映射配置是否為空
    if (mappingConfig.mappings.length === 0) {
      throw new MatchingEngineError(
        '找不到映射配置，請先為此模板建立 Template Field Mapping（至少需要 GLOBAL 級別配置）',
        'MAPPING_NOT_FOUND' as MatchingErrorCode,
        { dataTemplateId, resolvedFrom: mappingConfig.resolvedFrom }
      );
    }

    // 載入文件
    const documents = await this.loadDocuments(documentIds);

    // 預覽每個文件
    const rows: PreviewRowResult[] = [];
    let validCount = 0;
    let invalidCount = 0;

    for (const doc of documents) {
      const mappedFields = doc.mappedFields as Record<string, unknown> || {};

      // 提取 rowKey
      const rowKey = this.extractRowKey(mappedFields, rowKeyField);

      // 轉換欄位
      const { values: transformResult, unresolvedSourceKeys } =
        await this.transformFields(mappedFields, mappingConfig.mappings);

      // 驗證
      const validation = templateInstanceService.validateRowData(transformResult, templateFields);

      rows.push({
        documentId: doc.id,
        rowKey,
        fieldValues: transformResult,
        validation,
        ...(Object.keys(unresolvedSourceKeys).length > 0
          ? { unresolvedSourceKeys }
          : {}),
      });

      if (validation.isValid) {
        validCount++;
      } else {
        invalidCount++;
      }
    }

    return {
      dataTemplateId,
      mappingSources: mappingConfig.resolvedFrom,
      rows,
      summary: {
        totalDocuments: documents.length,
        validRows: validCount,
        invalidRows: invalidCount,
      },
    };
  }

  /**
   * 驗證映射配置
   *
   * @description
   *   檢查映射配置是否完整，是否覆蓋所有必填欄位
   *
   * @param params - 驗證參數
   * @returns 驗證結果
   */
  async validateMapping(params: ValidateMappingParams): Promise<ValidateMappingResult> {
    const { dataTemplateId, companyId, formatId } = params;

    // 獲取模版
    const template = await prisma.dataTemplate.findUnique({
      where: { id: dataTemplateId },
    });

    if (!template) {
      throw new MatchingEngineError(
        '數據模版不存在',
        'TEMPLATE_NOT_FOUND' as MatchingErrorCode,
        { dataTemplateId }
      );
    }

    const templateFields = template.fields as unknown as DataTemplateField[];
    const requiredFields = templateFields
      .filter((f) => f.isRequired)
      .map((f) => f.name);

    // 解析映射規則
    const mappingConfig = await templateFieldMappingService.resolveMapping({
      dataTemplateId,
      companyId,
      documentFormatId: formatId,
    });

    // 驗證轉換參數
    const validationResults = this.transformExecutor.validateMappings(mappingConfig.mappings);
    const errors = validationResults
      .filter((r) => !r.isValid)
      .map((r) => ({ targetField: r.targetField, error: r.error || '驗證失敗' }));

    // 檢查必填欄位覆蓋
    const targetFields = mappingConfig.mappings.map((m) => m.targetField);
    const missingRequiredFields = requiredFields.filter((f) => !targetFields.includes(f));

    return {
      isValid: errors.length === 0 && missingRequiredFields.length === 0,
      sources: mappingConfig.resolvedFrom,
      ruleCount: mappingConfig.mappings.length,
      targetFields,
      missingRequiredFields,
      errors,
    };
  }

  // --------------------------------------------------------------------------
  // Private Methods - Batch Processing
  // --------------------------------------------------------------------------

  /**
   * 處理單批文件
   *
   * @description
   *   使用事務確保批次內的一致性
   *   單行失敗不影響其他行
   */
  private async processBatch(
    documents: Array<{ id: string; mappedFields: unknown; stage3Result?: unknown }>,
    instance: { id: string; dataTemplateId: string },
    templateFields: DataTemplateField[],
    mappingConfig: ResolvedMappingConfig,
    options: { rowKeyField?: string; skipValidation?: boolean }
  ): Promise<RowResult[]> {
    const rowKeyField = options.rowKeyField || DEFAULT_ROW_KEY_FIELD;

    return prisma.$transaction(async (tx) => {
      const results: RowResult[] = [];

      // FIX-132: 交易前查一次目前最大 rowIndex，之後以記憶體計數器遞增，
      // 取代每份文件各查一次 findFirst（縮短交易佔用連線的時間，緩解連線池壓力）。
      const maxRow = await tx.templateInstanceRow.findFirst({
        where: { templateInstanceId: instance.id },
        orderBy: { rowIndex: 'desc' },
        select: { rowIndex: true },
      });
      let nextRowIndex = (maxRow?.rowIndex ?? -1) + 1;

      for (const doc of documents) {
        try {
          const mappedFields = doc.mappedFields as Record<string, unknown> || {};

          // 提取 rowKey
          const rowKey = this.extractRowKey(mappedFields, rowKeyField);

          // 轉換欄位（含 AGGREGATE 所需的 lineItems context）
          const { values: transformedFields, unresolvedSourceKeys } =
            await this.transformFields(
              mappedFields,
              mappingConfig.mappings,
              doc.stage3Result
            );

          // 驗證
          let validation: ValidationResult = { isValid: true };
          if (!options.skipValidation) {
            validation = templateInstanceService.validateRowData(transformedFields, templateFields);
          }

          // 創建或更新行（FIX-132: 傳入預分配的 rowIndex，新建列時消耗並遞增）
          const { row, created } = await this.upsertRow(tx, {
            instanceId: instance.id,
            rowKey,
            documentId: doc.id,
            fieldValues: transformedFields,
            validation,
            unresolvedSourceKeys,
            rowIndex: nextRowIndex,
          });
          if (created) nextRowIndex++;

          results.push({
            documentId: doc.id,
            rowId: row.id,
            rowKey,
            status: validation.isValid ? 'VALID' : 'INVALID',
            errors: validation.errors,
            ...(Object.keys(unresolvedSourceKeys).length > 0
              ? { unresolvedSourceKeys }
              : {}),
          });
        } catch (error) {
          results.push({
            documentId: doc.id,
            rowId: null,
            rowKey: null,
            status: 'ERROR',
            errors: {
              _system: error instanceof Error ? error.message : '處理失敗',
            },
          });
        }
      }

      return results;
    });
  }

  // --------------------------------------------------------------------------
  // Private Methods - Transformation
  // --------------------------------------------------------------------------

  /**
   * 轉換欄位值
   *
   * @description
   *   根據映射規則將源欄位轉換為目標欄位。
   *
   *   FIX-128：同時收集轉換診斷 —— 規則引用了 row 中不存在的來源 key
   *   （拼錯 / 欄位定義缺失）時，該項在公式中被靜默視為 0，這裡把
   *   未解析的 key 記錄為 `unresolvedSourceKeys[targetField]`，供
   *   儲存與介面顯示，讓設定者能察覺「欄位永遠空白」的原因。
   *   `li_*` / `_ref_*` 為動態合成欄位（依文件內容產生），缺席不代表
   *   拼錯，一律豁免。
   *
   * @lastModified FIX-128 (2026-07-22)
   */
  private async transformFields(
    sourceFields: Record<string, unknown>,
    mappings: TemplateFieldMappingRule[],
    stage3Result?: unknown
  ): Promise<{
    values: Record<string, unknown>;
    unresolvedSourceKeys: Record<string, string[]>;
  }> {
    const result: Record<string, unknown> = {};
    const unresolvedSourceKeys: Record<string, string[]> = {};
    const knownRowKeys = new Set(Object.keys(sourceFields));

    // CHANGE-043 Phase 2: 從 stage3Result 提取 lineItems/extraCharges 供 AGGREGATE 使用
    const s3 = (stage3Result && typeof stage3Result === 'object') ? stage3Result as {
      lineItems?: Array<{ description: string; classifiedAs?: string; amount: number; quantity?: number; unitPrice?: number }>;
      extraCharges?: Array<{ description: string; classifiedAs?: string; amount: number }>;
    } : undefined;

    // 按 order 排序
    const sortedMappings = [...mappings].sort((a, b) => a.order - b.order);

    for (const mapping of sortedMappings) {
      const sourceValue = sourceFields[mapping.sourceField];

      // FIX-128: 記錄引用了 row 中不存在的來源 key（li_* / _ref_* 豁免）
      const unresolved = findUnknownRuleSourceKeys(mapping, knownRowKeys);
      if (unresolved.length > 0) {
        unresolvedSourceKeys[mapping.targetField] = unresolved;
      }

      try {
        const transformedValue = await this.transformExecutor.execute(
          sourceValue,
          mapping.transformType,
          mapping.transformParams ?? null,
          {
            row: sourceFields,
            sourceField: mapping.sourceField,
            targetField: mapping.targetField,
            lineItems: s3?.lineItems,
            extraCharges: s3?.extraCharges,
          }
        );

        // 只有當轉換結果不是 undefined 時才設定
        if (transformedValue !== undefined) {
          result[mapping.targetField] = transformedValue;
        }
      } catch {
        // 轉換失敗時，使用原始值或跳過
        if (sourceValue !== undefined) {
          result[mapping.targetField] = sourceValue;
        }
      }
    }

    return { values: result, unresolvedSourceKeys };
  }

  // --------------------------------------------------------------------------
  // Private Methods - Row Management
  // --------------------------------------------------------------------------

  /**
   * 創建或更新行
   *
   * @description
   *   同 rowKey 的多個文件會合併到同一行
   *   合併策略：新值覆蓋空值，追加 documentId
   *
   * @returns `{ row, created }` —— `created` 為 true 表示建立了新列
   *   （processBatch 依此遞增 rowIndex 計數器，FIX-132）
   */
  private async upsertRow(
    tx: Prisma.TransactionClient,
    params: UpsertRowParams
  ) {
    // 查找現有行
    const existing = await tx.templateInstanceRow.findUnique({
      where: {
        templateInstanceId_rowKey: {
          templateInstanceId: params.instanceId,
          rowKey: params.rowKey,
        },
      },
    });

    // FIX-128: 診斷反映最近一次處理；無診斷時清空（規則修好後不殘留舊警告）
    const diagnostics =
      params.unresolvedSourceKeys &&
      Object.keys(params.unresolvedSourceKeys).length > 0
        ? (params.unresolvedSourceKeys as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull;

    if (existing) {
      // 合併欄位值
      const mergedValues = this.mergeFieldValues(
        existing.fieldValues as Record<string, unknown>,
        params.fieldValues
      );

      // 合併 documentIds
      const mergedDocIds = [...new Set([
        ...existing.sourceDocumentIds,
        params.documentId,
      ])];

      const row = await tx.templateInstanceRow.update({
        where: { id: existing.id },
        data: {
          fieldValues: mergedValues as Prisma.InputJsonValue,
          sourceDocumentIds: mergedDocIds,
          validationErrors: params.validation.errors
            ? (params.validation.errors as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          transformDiagnostics: diagnostics,
          status: params.validation.isValid ? 'VALID' : 'INVALID',
        },
      });
      return { row, created: false };
    } else {
      // FIX-132: rowIndex 由 processBatch 於交易前統一分配（不再每列各查一次 findFirst）
      const row = await tx.templateInstanceRow.create({
        data: {
          templateInstanceId: params.instanceId,
          rowKey: params.rowKey,
          rowIndex: params.rowIndex,
          sourceDocumentIds: [params.documentId],
          fieldValues: params.fieldValues as Prisma.InputJsonValue,
          validationErrors: params.validation.errors
            ? (params.validation.errors as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          transformDiagnostics: diagnostics,
          status: params.validation.isValid ? 'VALID' : 'INVALID',
        },
      });
      return { row, created: true };
    }
  }

  /**
   * 合併欄位值
   *
   * @description
   *   策略：新值覆蓋空值，已有值保持不變
   */
  private mergeFieldValues(
    existing: Record<string, unknown>,
    newValues: Record<string, unknown>
  ): Record<string, unknown> {
    const result = { ...existing };

    for (const [key, value] of Object.entries(newValues)) {
      // 只有當現有值為空時才覆蓋
      if (
        result[key] === undefined ||
        result[key] === null ||
        result[key] === ''
      ) {
        result[key] = value;
      }
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // Private Methods - Utilities
  // --------------------------------------------------------------------------

  /**
   * 載入文件及其提取結果
   *
   * @description
   *   從 Document 及其關聯的 ExtractionResult 載入 fieldMappings
   */
  private async loadDocuments(
    documentIds: string[]
  ): Promise<Array<{ id: string; mappedFields: Record<string, unknown>; stage3Result?: unknown }>> {
    const documents = await prisma.document.findMany({
      where: { id: { in: documentIds } },
      select: {
        id: true,
        extractionResult: {
          select: {
            fieldMappings: true,
            stage3Result: true,
            referenceNumberMatch: true, // CHANGE-047: 載入 Pipeline 匹配的 Reference Number
          },
        },
      },
    });

    // 檢查是否所有文件都存在
    const foundIds = new Set(documents.map((d) => d.id));
    const missingIds = documentIds.filter((id) => !foundIds.has(id));

    if (missingIds.length > 0) {
      throw new MatchingEngineError(
        `找不到文件: ${missingIds.join(', ')}`,
        'DOCUMENT_NOT_FOUND' as MatchingErrorCode,
        { missingIds }
      );
    }

    // 轉換為所需格式（含 lineItem 展平 + 保留 stage3Result 供 AGGREGATE 使用）
    return documents.map((doc) => {
      const mappedFields = this.extractMappedFields(
        doc.extractionResult?.fieldMappings,
        doc.extractionResult?.stage3Result
      );

      // CHANGE-047: 注入 Pipeline 匹配的 Reference Number 為合成來源欄位
      this.injectRefNumberFields(mappedFields, doc.extractionResult?.referenceNumberMatch);

      return {
        id: doc.id,
        mappedFields,
        stage3Result: doc.extractionResult?.stage3Result ?? undefined,
      };
    });
  }

  /**
   * 從 fieldMappings JSON 提取欄位值，並展平 lineItems 為 li_* pseudo-fields
   *
   * @description
   *   ExtractionResult.fieldMappings 結構為:
   *   {
   *     [fieldName]: {
   *       value: string | null,
   *       rawValue: string | null,
   *       confidence: number,
   *       ...
   *     }
   *   }
   *   我們需要提取 value 來進行轉換。
   *
   *   若 stage3Result 包含 lineItems/extraCharges，按 classifiedAs 聚合展平為：
   *   - li_{CLASSIFIED_AS}_total: 金額合計
   *   - li_{CLASSIFIED_AS}_count: 筆數
   *
   * @since CHANGE-043 Phase 1
   */
  private extractMappedFields(
    fieldMappings: unknown,
    stage3Result?: unknown
  ): Record<string, unknown> {
    if (!fieldMappings || typeof fieldMappings !== 'object') {
      return {};
    }

    const result: Record<string, unknown> = {};
    const mappings = fieldMappings as Record<string, { value?: unknown; rawValue?: unknown }>;

    for (const [key, fieldData] of Object.entries(mappings)) {
      if (fieldData && typeof fieldData === 'object') {
        // 優先使用 value，否則使用 rawValue
        result[key] = fieldData.value ?? fieldData.rawValue ?? null;
      }
    }

    // CHANGE-043: 展平 lineItems + extraCharges 為 li_* pseudo-fields
    if (stage3Result && typeof stage3Result === 'object') {
      const s3 = stage3Result as {
        lineItems?: Array<{ classifiedAs?: string; amount?: number }>;
        extraCharges?: Array<{ classifiedAs?: string; amount?: number }>;
      };

      // 合併 lineItems 和 extraCharges（對用戶而言都是費用項）
      const allItems = [
        ...(s3.lineItems || []),
        ...(s3.extraCharges || []),
      ];

      if (allItems.length > 0) {
        // 按 classifiedAs 分組聚合
        const aggregated = new Map<string, { total: number; count: number }>();

        for (const item of allItems) {
          const key = item.classifiedAs || 'UNCLASSIFIED';
          const existing = aggregated.get(key) || { total: 0, count: 0 };
          aggregated.set(key, {
            total: existing.total + (item.amount || 0),
            count: existing.count + 1,
          });
        }

        // 展平為 li_* pseudo-fields
        for (const [classifiedAs, agg] of aggregated) {
          result[`li_${classifiedAs}_total`] = agg.total;
          result[`li_${classifiedAs}_count`] = agg.count;
        }
      }
    }

    return result;
  }

  /**
   * 注入 Pipeline 匹配的 Reference Number 為合成來源欄位
   *
   * @description
   *   從 ExtractionResult.referenceNumberMatch 中提取匹配結果，
   *   注入到 mappedFields 中作為合成來源欄位（以 _ref_ 前綴區分）。
   *   用戶可透過 DIRECT 映射規則將其映射到 DataTemplate 的目標欄位。
   *
   *   注入欄位：
   *   - `_ref_number`: 主要匹配的 referenceNumber（第一筆最高信心度）
   *   - `_ref_type`: 主要匹配的類型（如 SHIPMENT、HAWB）
   *   - `_ref_{TYPE}`: 按類型分別注入（如 _ref_SHIPMENT、_ref_HAWB）
   *
   * @since CHANGE-047
   */
  private injectRefNumberFields(
    mappedFields: Record<string, unknown>,
    referenceNumberMatch: unknown
  ): void {
    if (!referenceNumberMatch || typeof referenceNumberMatch !== 'object') {
      return;
    }

    const refMatch = referenceNumberMatch as {
      matches?: Array<{
        referenceNumber: string;
        type: string;
        confidence: number;
      }>;
    };

    if (!refMatch.matches || refMatch.matches.length === 0) {
      return;
    }

    // 主要匹配（第一筆最高信心度）
    mappedFields['_ref_number'] = refMatch.matches[0].referenceNumber;
    mappedFields['_ref_type'] = refMatch.matches[0].type;

    // 按類型注入（如 _ref_SHIPMENT、_ref_HAWB）
    for (const match of refMatch.matches) {
      mappedFields[`_ref_${match.type}`] = match.referenceNumber;
    }
  }

  /**
   * 提取 rowKey
   */
  private extractRowKey(
    fields: Record<string, unknown>,
    rowKeyField: string
  ): string {
    const value = fields[rowKeyField];

    if (value === undefined || value === null || value === '') {
      // 如果沒有指定的 rowKey，使用時間戳生成唯一 key
      return `auto_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    return String(value);
  }

  /**
   * 將陣列分割成批次
   */
  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }
}

// ============================================================================
// Service Instance Export
// ============================================================================

/**
 * 模版匹配引擎服務單例
 */
export const templateMatchingEngineService = new TemplateMatchingEngineService();
