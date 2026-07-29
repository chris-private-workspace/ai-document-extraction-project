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
  TemplateRowUnit,
} from '@/types/template-matching-engine';
import { MatchingEngineError } from '@/types/template-matching-engine';
import type { TemplateFieldMappingRule, ResolvedMappingConfig } from '@/types/template-field-mapping';
import type { DataTemplateField, LineItemMode } from '@/types/data-template';
import { DEFAULT_LINE_ITEM_MODE } from '@/types/data-template';
import type { LineItemGroupV3 } from '@/types/extraction-v3.types';
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
// Internal Types
// ============================================================================

/**
 * 已載入的文件（含模板層需要的提取結果片段）
 * @since CHANGE-113 階段二
 */
interface LoadedDocument {
  /** 文件 ID */
  id: string;
  /** 文件層級來源欄位（fieldMappings + li_* 展平 + _ref_*） */
  mappedFields: Record<string, unknown>;
  /** 文件層級行項目 */
  lineItems?: TemplateRowUnit['lineItems'];
  /** 文件層級額外費用 */
  extraCharges?: TemplateRowUnit['extraCharges'];
  /** CHANGE-113: Stage 3 依 groupKey 切好的分組（各組費用欄位已單獨回填） */
  lineItemGroups?: LineItemGroupV3[];
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * 正規化參考編號 token
 *
 * @description
 *   人工在 PDF 上補註的分組鍵格式並不統一 —— 實測同一批 DHL 文件出現
 *   `RCIM-25-0111`、`RCIM/25/0246`、結尾帶 `\r` 等變體（四位標註者各寫各的）。
 *   參考編號主檔則統一為 `RCIM250111`。去掉所有非英數字元並轉大寫後即可對上，
 *   毋須在程式中維護格式規則。
 *
 * @since CHANGE-113 階段二
 */
export function normalizeReferenceToken(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

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

    // 3.1 CHANGE-113 階段二: 依模板的分列模式展開成列單元
    //     PIVOT（現況）一份文件一個單元；GROUP 則每個分組鍵各一個單元。
    //     展開在交易外完成 —— 組層級的參考編號查詢不佔用交易連線（FIX-132）。
    const rowUnits = await this.buildRowUnits(
      documents,
      (template.lineItemMode as LineItemMode) || DEFAULT_LINE_ITEM_MODE,
      options.rowKeyField || DEFAULT_ROW_KEY_FIELD
    );

    // 4. 分批處理
    const results: RowResult[] = [];
    const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
    const batches = this.createBatches(rowUnits, batchSize);
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
        const processed = Math.min((i + 1) * batchSize, rowUnits.length);
        options.onProgress({
          processed,
          total: rowUnits.length,
          currentBatch: i + 1,
          totalBatches,
          percentage: Math.round((processed / rowUnits.length) * 100),
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
  // Private Methods - Row Expansion (CHANGE-113 階段二)
  // --------------------------------------------------------------------------

  /**
   * 依模板的分列模式，把文件展開成待寫入的列單元
   *
   * @description
   *   `PIVOT`（現況）一份文件產生一個單元。`GROUP` 則對「一份發票含多個 shipment」
   *   的文件，依 Stage 3 切好的 `lineItemGroups` 每組產生一個單元，並把三種來源
   *   全部替換成**組層級**的值：
   *
   *   1. **費用欄位**（field definition key）—— 取自該組單獨回填的結果。若沿用文件
   *      層級的值，每一列都會拿到整份發票的加總（DHL 實測：兩列都會是 2557.50 而非
   *      各自的 247.50 / 2310.00）。
   *   2. **`li_*` 展平值** —— 對組內行項目重算，供 `AGGREGATE` 型映射使用。
   *   3. **`_ref_number`** —— 分組鍵對到參考編號主檔後的標準號碼。既有映射規則
   *      `_ref_number → shipment_number` 因此自動變成每列各自的號碼，**規則本身不用改**。
   *
   *   `EXPAND`（1 筆費用 = 1 列）尚未實作 —— 見 CHANGE-113 §階段二範圍說明。
   *   選到該值時行為與 `PIVOT` 相同。
   *
   * @param documents - 已載入的文件
   * @param lineItemMode - 模板的分列模式
   * @param rowKeyField - 非 GROUP 模式下用於取 rowKey 的欄位名
   * @since CHANGE-113 階段二
   */
  private async buildRowUnits(
    documents: LoadedDocument[],
    lineItemMode: LineItemMode,
    rowKeyField: string
  ): Promise<TemplateRowUnit[]> {
    const useGrouping = lineItemMode === 'GROUP';

    // 一次查完所有分組鍵對應的主檔號碼（交易外、逐份查會放大連線壓力 — FIX-132）
    const refNumberByToken = useGrouping
      ? await this.resolveGroupReferenceNumbers(documents)
      : new Map<string, { number: string; type: string }>();

    const units: TemplateRowUnit[] = [];

    for (const doc of documents) {
      const groups = useGrouping ? doc.lineItemGroups : undefined;

      // 非 GROUP 模式，或該文件沒有分組（一般發票）→ 維持一份文件一列
      if (!groups || groups.length === 0) {
        units.push({
          documentId: doc.id,
          rowKey: this.extractRowKey(doc.mappedFields, rowKeyField),
          sourceFields: doc.mappedFields,
          lineItems: doc.lineItems,
          extraCharges: doc.extraCharges,
        });
        continue;
      }

      // 任一組認領過的費用欄位 key。各組單元必須先排除文件層級的同名值 ——
      // 否則「本組沒有、他組才有」的費用欄位會殘留整份發票的加總。
      const groupChargeKeys = new Set(
        groups.flatMap((group) => Object.keys(group.fields ?? {}))
      );

      for (const group of groups) {
        const sourceFields: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(doc.mappedFields)) {
          if (groupChargeKeys.has(key)) continue; // 文件層級費用加總不帶入
          if (key.startsWith('li_')) continue; // 文件層級 li_* 展平不帶入
          sourceFields[key] = value;
        }

        // 1. 組層級費用欄位
        for (const [key, fieldValue] of Object.entries(group.fields ?? {})) {
          sourceFields[key] = fieldValue?.value ?? null;
        }

        // 2. 組層級 li_* 展平
        Object.assign(sourceFields, this.flattenChargeItems(group.lineItems));

        // 3. 組層級 _ref_*：對到主檔用標準號碼，對不到則保留原始分組鍵
        //    （寧可讓該列帶著人工補註的原始格式，也不要與別組共用同一個 rowKey）
        const matched = refNumberByToken.get(normalizeReferenceToken(group.groupKey));
        const rowKey = matched?.number ?? group.groupKey;
        sourceFields['_ref_number'] = rowKey;
        if (matched) {
          sourceFields['_ref_type'] = matched.type;
          sourceFields[`_ref_${matched.type}`] = matched.number;
        }

        units.push({
          documentId: doc.id,
          rowKey,
          sourceFields,
          lineItems: group.lineItems,
        });
      }
    }

    return units;
  }

  /**
   * 批次解析各分組鍵對應的參考編號主檔記錄
   *
   * @description
   *   以正規化後的分組鍵精確比對主檔 `number`。
   *
   *   **不使用 `findMatchesInText()`**：那是給「從一段文字裡找出號碼」用的
   *   ILIKE substring 查詢，且會遞增主檔的 `matchCount` / `lastMatchedAt` ——
   *   模板匹配可重複執行，套用它會污染參考編號的匹配統計。此處已握有完整號碼，
   *   精確比對即可，也無副作用。
   *
   *   已知界限：分組鍵帶額外後綴時（實測有 `RCEX-25-0479 PDI`）精確比對會落空，
   *   該列改用原始分組鍵作 rowKey。列不會消失，只是號碼不是主檔的標準格式。
   *
   * @since CHANGE-113 階段二
   */
  private async resolveGroupReferenceNumbers(
    documents: LoadedDocument[]
  ): Promise<Map<string, { number: string; type: string }>> {
    const tokens = new Set<string>();
    for (const doc of documents) {
      for (const group of doc.lineItemGroups ?? []) {
        const token = normalizeReferenceToken(group.groupKey ?? '');
        if (token) tokens.add(token);
      }
    }

    if (tokens.size === 0) {
      return new Map();
    }

    const records = await prisma.referenceNumber.findMany({
      where: {
        number: { in: [...tokens] },
        isActive: true,
        status: 'ACTIVE',
      },
      select: { number: true, type: true },
    });

    return new Map(
      records.map((record) => [
        record.number,
        { number: record.number, type: record.type as string },
      ])
    );
  }

  // --------------------------------------------------------------------------
  // Private Methods - Batch Processing
  // --------------------------------------------------------------------------

  /**
   * 處理單批列單元
   *
   * @description
   *   使用事務確保批次內的一致性，單列失敗不影響其他列。
   *
   *   CHANGE-113 階段二：輸入由「文件」改為「列單元」—— 一份文件在 `GROUP` 模式下
   *   會展開成多個單元。展開與 rowKey 決定都已在 {@link buildRowUnits} 完成，
   *   本方法只負責寫入。
   */
  private async processBatch(
    rowUnits: TemplateRowUnit[],
    instance: { id: string; dataTemplateId: string },
    templateFields: DataTemplateField[],
    mappingConfig: ResolvedMappingConfig,
    options: { skipValidation?: boolean }
  ): Promise<RowResult[]> {
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

      for (const unit of rowUnits) {
        try {
          // 轉換欄位（含 AGGREGATE 所需的 lineItems context）
          const { values: transformedFields, unresolvedSourceKeys } =
            await this.transformFields(
              unit.sourceFields,
              mappingConfig.mappings,
              unit.lineItems,
              unit.extraCharges
            );

          // 驗證
          let validation: ValidationResult = { isValid: true };
          if (!options.skipValidation) {
            validation = templateInstanceService.validateRowData(transformedFields, templateFields);
          }

          // 創建或更新行（FIX-132: 傳入預分配的 rowIndex，新建列時消耗並遞增）
          const { row, created } = await this.upsertRow(tx, {
            instanceId: instance.id,
            rowKey: unit.rowKey,
            documentId: unit.documentId,
            fieldValues: transformedFields,
            validation,
            unresolvedSourceKeys,
            rowIndex: nextRowIndex,
          });
          if (created) nextRowIndex++;

          results.push({
            documentId: unit.documentId,
            rowId: row.id,
            rowKey: unit.rowKey,
            status: validation.isValid ? 'VALID' : 'INVALID',
            errors: validation.errors,
            ...(Object.keys(unresolvedSourceKeys).length > 0
              ? { unresolvedSourceKeys }
              : {}),
          });
        } catch (error) {
          results.push({
            documentId: unit.documentId,
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
   *   CHANGE-113 階段二：`lineItems` / `extraCharges` 改由呼叫端直接傳入 —— `GROUP`
   *   模式下它們是**該組的子集**，不再是整份文件的行項目。
   *
   * @lastModified CHANGE-113 階段二 (2026-07-29)
   */
  private async transformFields(
    sourceFields: Record<string, unknown>,
    mappings: TemplateFieldMappingRule[],
    lineItems?: TemplateRowUnit['lineItems'],
    extraCharges?: TemplateRowUnit['extraCharges']
  ): Promise<{
    values: Record<string, unknown>;
    unresolvedSourceKeys: Record<string, string[]>;
  }> {
    const result: Record<string, unknown> = {};
    const unresolvedSourceKeys: Record<string, string[]> = {};
    const knownRowKeys = new Set(Object.keys(sourceFields));

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
            lineItems,
            extraCharges,
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
   *   從 Document 及其關聯的 ExtractionResult 載入 fieldMappings。
   *
   *   CHANGE-113 階段二：一併載入 `stage3Result.lineItemGroups`（Stage 3 依
   *   `groupKey` 切好、且各組已單獨回填費用欄位的結果），供 `GROUP` 模式展開。
   */
  private async loadDocuments(documentIds: string[]): Promise<LoadedDocument[]> {
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

    return documents.map((doc) => {
      const stage3 = this.readStage3Result(doc.extractionResult?.stage3Result);

      const mappedFields = this.extractFieldValues(doc.extractionResult?.fieldMappings);
      // CHANGE-043: 展平 lineItems + extraCharges 為 li_* pseudo-fields
      Object.assign(
        mappedFields,
        this.flattenChargeItems(stage3.lineItems, stage3.extraCharges)
      );
      // CHANGE-047: 注入 Pipeline 匹配的 Reference Number 為合成來源欄位
      this.injectRefNumberFields(mappedFields, doc.extractionResult?.referenceNumberMatch);

      return {
        id: doc.id,
        mappedFields,
        lineItems: stage3.lineItems,
        extraCharges: stage3.extraCharges,
        lineItemGroups: stage3.lineItemGroups,
      };
    });
  }

  /**
   * 讀取 `ExtractionResult.stage3Result` 中模板層需要的部分
   * @since CHANGE-113 階段二（原內嵌於 extractMappedFields / transformFields）
   */
  private readStage3Result(stage3Result: unknown): {
    lineItems?: TemplateRowUnit['lineItems'];
    extraCharges?: TemplateRowUnit['extraCharges'];
    lineItemGroups?: LineItemGroupV3[];
  } {
    if (!stage3Result || typeof stage3Result !== 'object') {
      return {};
    }

    return stage3Result as {
      lineItems?: TemplateRowUnit['lineItems'];
      extraCharges?: TemplateRowUnit['extraCharges'];
      lineItemGroups?: LineItemGroupV3[];
    };
  }

  /**
   * 從 fieldMappings JSON 提取欄位值
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
   * @since CHANGE-043 Phase 1（CHANGE-113 階段二：li_* 展平抽至 flattenChargeItems）
   */
  private extractFieldValues(fieldMappings: unknown): Record<string, unknown> {
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

    return result;
  }

  /**
   * 按 `classifiedAs` 聚合費用項，展平為 `li_*` pseudo-fields
   *
   * @description
   *   - `li_{CLASSIFIED_AS}_total`: 金額合計
   *   - `li_{CLASSIFIED_AS}_count`: 筆數
   *
   *   CHANGE-113 階段二：抽成獨立方法，讓 `GROUP` 模式能對**組內**行項目重算
   *   同一組 pseudo-fields（否則每一列都會拿到整份文件的加總）。
   *
   * @since CHANGE-043 Phase 1
   */
  private flattenChargeItems(
    lineItems?: Array<{ classifiedAs?: string; amount?: number }>,
    extraCharges?: Array<{ classifiedAs?: string; amount?: number }>
  ): Record<string, unknown> {
    // 合併 lineItems 和 extraCharges（對用戶而言都是費用項）
    const allItems = [...(lineItems || []), ...(extraCharges || [])];
    if (allItems.length === 0) {
      return {};
    }

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

    const result: Record<string, unknown> = {};
    for (const [classifiedAs, agg] of aggregated) {
      result[`li_${classifiedAs}_total`] = agg.total;
      result[`li_${classifiedAs}_count`] = agg.count;
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
