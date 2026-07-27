/**
 * @fileoverview 模版實例服務
 * @description
 *   提供 TemplateInstance 和 TemplateInstanceRow 的 CRUD 操作和業務邏輯
 *   包含行驗證、統計更新、狀態轉換等功能
 *
 * @module src/services/template-instance
 * @since Epic 19 - Story 19.2
 * @lastModified 2026-01-22
 *
 * @features
 *   - 實例 CRUD 操作（列表、詳情、創建、更新、軟刪除）
 *   - 行數據管理（添加、更新、刪除、分頁列表）
 *   - 行數據驗證（根據 DataTemplate.fields）
 *   - 統計數據自動更新（rowCount, validRowCount, errorRowCount）
 *   - 狀態轉換管理
 *
 * @dependencies
 *   - prisma - 資料庫操作
 *   - src/types/template-instance.ts - 類型定義
 *   - src/validations/template-instance.ts - 驗證工具
 */

import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  TemplateInstance,
  TemplateInstanceSummary,
  TemplateInstanceRow,
  TemplateInstanceStatus,
  TemplateInstanceRowStatus,
  TemplateInstanceFilters,
  TemplateInstanceRowFilters,
  ValidationResult,
  BatchValidationResult,
} from '@/types/template-instance';
import {
  STATUS_TRANSITIONS,
  DELETABLE_STATUSES,
  EDITABLE_STATUSES,
} from '@/types/template-instance';
import type {
  CreateTemplateInstanceInput,
  UpdateTemplateInstanceInput,
  AddRowInput,
  UpdateRowInput,
} from '@/validations/template-instance';

// ============================================================================
// Types
// ============================================================================

/**
 * DataTemplate 欄位定義（從 JSON 解析）
 */
interface DataTemplateField {
  name: string;
  label: string;
  dataType: 'string' | 'number' | 'date' | 'currency' | 'boolean' | 'array';
  isRequired: boolean;
  defaultValue?: string | number | boolean | null;
  validation?: {
    pattern?: string;
    min?: number;
    max?: number;
    maxLength?: number;
    minLength?: number;
    allowedValues?: string[];
  };
  description?: string;
  order: number;
}

/**
 * DataTemplate 資訊（用於詳情頁面）
 */
interface DataTemplateInfo {
  id: string;
  name: string;
  fields: DataTemplateField[];
}

// ============================================================================
// Service Class
// ============================================================================

/**
 * 模版實例服務類
 * @description
 *   封裝所有 TemplateInstance 相關的資料庫操作和業務邏輯
 */
export class TemplateInstanceService {
  // --------------------------------------------------------------------------
  // Instance Query Methods
  // --------------------------------------------------------------------------

  /**
   * 列出模版實例
   * @description
   *   查詢實例列表，支援多種篩選條件和分頁
   *
   * @param filters - 篩選條件
   * @param page - 頁碼（從 1 開始）
   * @param limit - 每頁數量
   * @returns 實例摘要列表和總數
   */
  async list(
    filters: TemplateInstanceFilters = {},
    page: number = 1,
    limit: number = 20
  ): Promise<{ instances: TemplateInstanceSummary[]; total: number }> {
    // 建構查詢條件
    const where: Prisma.TemplateInstanceWhereInput = {};

    if (filters.dataTemplateId) {
      where.dataTemplateId = filters.dataTemplateId;
    }
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
      ];
    }
    if (filters.dateFrom || filters.dateTo) {
      where.createdAt = {};
      if (filters.dateFrom) {
        where.createdAt.gte = new Date(filters.dateFrom);
      }
      if (filters.dateTo) {
        where.createdAt.lte = new Date(filters.dateTo);
      }
    }
    if (filters.createdBy) {
      where.createdBy = filters.createdBy;
    }

    // 並行查詢列表和總數
    const [instances, total] = await Promise.all([
      prisma.templateInstance.findMany({
        where,
        include: {
          dataTemplate: { select: { name: true } },
        },
        orderBy: [{ updatedAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.templateInstance.count({ where }),
    ]);

    // 轉換為摘要格式
    return {
      instances: instances.map((inst) => ({
        id: inst.id,
        dataTemplateId: inst.dataTemplateId,
        dataTemplateName: inst.dataTemplate.name,
        name: inst.name,
        status: inst.status as TemplateInstanceStatus,
        rowCount: inst.rowCount,
        validRowCount: inst.validRowCount,
        errorRowCount: inst.errorRowCount,
        exportedAt: inst.exportedAt?.toISOString() ?? null,
        updatedAt: inst.updatedAt.toISOString(),
      })),
      total,
    };
  }

  /**
   * 取得實例詳情
   * @param id - 實例 ID
   * @returns 完整實例資訊或 null
   */
  async getById(id: string): Promise<TemplateInstance | null> {
    const instance = await prisma.templateInstance.findUnique({
      where: { id },
      include: {
        dataTemplate: { select: { name: true } },
      },
    });

    if (!instance) {
      return null;
    }

    return this.mapInstanceToDto(instance);
  }

  /**
   * 取得實例詳情（含完整 DataTemplate）
   * @param id - 實例 ID
   * @returns 完整實例資訊（含 DataTemplate）或 null
   */
  async getByIdWithTemplate(id: string): Promise<(TemplateInstance & { dataTemplate: DataTemplateInfo | null }) | null> {
    const instance = await prisma.templateInstance.findUnique({
      where: { id },
      include: {
        dataTemplate: true,
      },
    });

    if (!instance) {
      return null;
    }

    const dto = this.mapInstanceToDto(instance);
    return {
      ...dto,
      dataTemplate: instance.dataTemplate
        ? {
            id: instance.dataTemplate.id,
            name: instance.dataTemplate.name,
            fields: instance.dataTemplate.fields as unknown as DataTemplateField[],
          }
        : null,
    };
  }

  // --------------------------------------------------------------------------
  // Instance Mutation Methods
  // --------------------------------------------------------------------------

  /**
   * 創建模版實例
   * @param input - 創建輸入資料
   * @param createdBy - 創建者 ID
   * @returns 新建的實例
   */
  async create(
    input: CreateTemplateInstanceInput,
    createdBy?: string
  ): Promise<TemplateInstance> {
    // 驗證 DataTemplate 是否存在
    const template = await prisma.dataTemplate.findUnique({
      where: { id: input.dataTemplateId },
      select: { id: true, isActive: true },
    });

    if (!template) {
      throw new Error('數據模版不存在');
    }

    if (!template.isActive) {
      throw new Error('數據模版已停用');
    }

    const instance = await prisma.templateInstance.create({
      data: {
        dataTemplateId: input.dataTemplateId,
        name: input.name,
        description: input.description,
        status: 'DRAFT',
        createdBy,
      },
      include: {
        dataTemplate: { select: { name: true } },
      },
    });

    return this.mapInstanceToDto(instance);
  }

  /**
   * 更新模版實例
   * @param id - 實例 ID
   * @param input - 更新輸入資料
   * @returns 更新後的實例
   */
  async update(
    id: string,
    input: UpdateTemplateInstanceInput
  ): Promise<TemplateInstance> {
    // 檢查實例是否存在且可編輯
    const existing = await prisma.templateInstance.findUnique({
      where: { id },
      select: { status: true },
    });

    if (!existing) {
      throw new Error('模版實例不存在');
    }

    if (!EDITABLE_STATUSES.includes(existing.status as TemplateInstanceStatus)) {
      throw new Error(`狀態為 ${existing.status} 的實例不可編輯`);
    }

    // 建構更新資料
    const updateData: Prisma.TemplateInstanceUpdateInput = {};

    if (input.name !== undefined) {
      updateData.name = input.name;
    }
    if (input.description !== undefined) {
      updateData.description = input.description;
    }

    const instance = await prisma.templateInstance.update({
      where: { id },
      data: updateData,
      include: {
        dataTemplate: { select: { name: true } },
      },
    });

    return this.mapInstanceToDto(instance);
  }

  /**
   * 刪除模版實例
   * @description
   *   只有 DRAFT 狀態可以刪除，會連帶刪除所有行數據
   *
   * @param id - 實例 ID
   */
  async delete(id: string): Promise<void> {
    // 檢查實例是否存在且可刪除
    const existing = await prisma.templateInstance.findUnique({
      where: { id },
      select: { status: true },
    });

    if (!existing) {
      throw new Error('模版實例不存在');
    }

    if (!DELETABLE_STATUSES.includes(existing.status as TemplateInstanceStatus)) {
      throw new Error(`狀態為 ${existing.status} 的實例不可刪除`);
    }

    // 刪除實例（行數據會因為 onDelete: Cascade 自動刪除）
    await prisma.templateInstance.delete({
      where: { id },
    });
  }

  // --------------------------------------------------------------------------
  // Row Query Methods
  // --------------------------------------------------------------------------

  /**
   * 取得實例的行列表
   * @param instanceId - 實例 ID
   * @param filters - 篩選條件
   * @param page - 頁碼
   * @param limit - 每頁數量
   * @returns 行列表和總數
   */
  async getRows(
    instanceId: string,
    filters: TemplateInstanceRowFilters = {},
    page: number = 1,
    limit: number = 20
  ): Promise<{ rows: TemplateInstanceRow[]; total: number }> {
    // 建構查詢條件
    const where: Prisma.TemplateInstanceRowWhereInput = {
      templateInstanceId: instanceId,
    };

    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.search) {
      where.rowKey = { contains: filters.search, mode: 'insensitive' };
    }

    // 並行查詢
    const [rows, total] = await Promise.all([
      prisma.templateInstanceRow.findMany({
        where,
        orderBy: { rowIndex: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.templateInstanceRow.count({ where }),
    ]);

    // CHANGE-091 1.6: 批量解析來源文件檔名（id → fileName），供 UI 顯示來源
    // CHANGE-106: 一併取 processingEndedAt，判斷來源文件是否在 row 產生後被重新處理
    const sourceIds = Array.from(
      new Set(rows.flatMap((row) => row.sourceDocumentIds ?? []))
    );
    const docMap = new Map<string, { fileName: string; processingEndedAt: Date | null }>();
    if (sourceIds.length > 0) {
      const docs = await prisma.document.findMany({
        where: { id: { in: sourceIds } },
        select: { id: true, fileName: true, processingEndedAt: true },
      });
      docs.forEach((doc) =>
        docMap.set(doc.id, {
          fileName: doc.fileName,
          processingEndedAt: doc.processingEndedAt,
        })
      );
    }

    return {
      rows: rows.map((row) => ({
        ...this.mapRowToDto(row),
        sourceDocuments: (row.sourceDocumentIds ?? []).map((id) => ({
          id,
          fileName: docMap.get(id)?.fileName ?? id,
        })),
        // CHANGE-106: 來源文件在本行最後更新之後又完成處理 → 本行是舊快照。
        // 以 processingEndedAt 為準（只在重新處理完成時更新）；updatedAt 會因
        // 無關操作（審核、改公司）變動，用它判斷會產生假陽性噪音。
        staleSources: (row.sourceDocumentIds ?? []).flatMap((id) => {
          const doc = docMap.get(id);
          if (!doc?.processingEndedAt || doc.processingEndedAt <= row.updatedAt) {
            return [];
          }
          return [
            {
              id,
              fileName: doc.fileName,
              processedAt: doc.processingEndedAt.toISOString(),
            },
          ];
        }),
      })),
      total,
    };
  }

  /**
   * 取得單行詳情
   * @param rowId - 行 ID
   * @returns 行數據或 null
   */
  async getRowById(rowId: string): Promise<TemplateInstanceRow | null> {
    const row = await prisma.templateInstanceRow.findUnique({
      where: { id: rowId },
    });

    if (!row) {
      return null;
    }

    return this.mapRowToDto(row);
  }

  // --------------------------------------------------------------------------
  // Row Mutation Methods
  // --------------------------------------------------------------------------

  /**
   * 添加行
   * @param instanceId - 實例 ID
   * @param input - 行數據
   * @returns 新建的行
   */
  async addRow(
    instanceId: string,
    input: AddRowInput
  ): Promise<TemplateInstanceRow> {
    // 檢查實例是否存在且可編輯
    const instance = await prisma.templateInstance.findUnique({
      where: { id: instanceId },
      select: {
        status: true,
        dataTemplateId: true,
        dataTemplate: { select: { fields: true } },
      },
    });

    if (!instance) {
      throw new Error('模版實例不存在');
    }

    if (!EDITABLE_STATUSES.includes(instance.status as TemplateInstanceStatus)) {
      throw new Error(`狀態為 ${instance.status} 的實例不可添加行`);
    }

    // 檢查 rowKey 是否已存在
    const existingRow = await prisma.templateInstanceRow.findUnique({
      where: {
        templateInstanceId_rowKey: {
          templateInstanceId: instanceId,
          rowKey: input.rowKey,
        },
      },
    });

    if (existingRow) {
      throw new Error(`行識別碼 ${input.rowKey} 已存在`);
    }

    // 取得當前最大 rowIndex
    const maxRow = await prisma.templateInstanceRow.findFirst({
      where: { templateInstanceId: instanceId },
      orderBy: { rowIndex: 'desc' },
      select: { rowIndex: true },
    });

    const newRowIndex = (maxRow?.rowIndex ?? -1) + 1;

    // 驗證行數據
    const templateFields = instance.dataTemplate.fields as unknown as DataTemplateField[];
    const validationResult = this.validateRowData(input.fieldValues, templateFields);

    // 創建行
    const row = await prisma.templateInstanceRow.create({
      data: {
        templateInstanceId: instanceId,
        rowKey: input.rowKey,
        rowIndex: newRowIndex,
        sourceDocumentIds: input.sourceDocumentIds ?? [],
        fieldValues: input.fieldValues as Prisma.InputJsonValue,
        validationErrors: validationResult.errors
          ? (validationResult.errors as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        status: validationResult.isValid ? 'VALID' : 'INVALID',
      },
    });

    // 更新實例統計
    await this.updateStatistics(instanceId);

    return this.mapRowToDto(row);
  }

  /**
   * 更新行
   * @param rowId - 行 ID
   * @param input - 更新數據
   * @returns 更新後的行
   */
  async updateRow(
    rowId: string,
    input: UpdateRowInput
  ): Promise<TemplateInstanceRow> {
    // 取得行和實例資訊
    const row = await prisma.templateInstanceRow.findUnique({
      where: { id: rowId },
      include: {
        templateInstance: {
          select: {
            status: true,
            dataTemplate: { select: { fields: true } },
          },
        },
      },
    });

    if (!row) {
      throw new Error('行不存在');
    }

    if (!EDITABLE_STATUSES.includes(row.templateInstance.status as TemplateInstanceStatus)) {
      throw new Error(`實例狀態為 ${row.templateInstance.status}，不可編輯行`);
    }

    // 如果更新 rowKey，檢查是否重複
    if (input.rowKey && input.rowKey !== row.rowKey) {
      const existingRow = await prisma.templateInstanceRow.findUnique({
        where: {
          templateInstanceId_rowKey: {
            templateInstanceId: row.templateInstanceId,
            rowKey: input.rowKey,
          },
        },
      });

      if (existingRow) {
        throw new Error(`行識別碼 ${input.rowKey} 已存在`);
      }
    }

    // 建構更新資料
    const updateData: Prisma.TemplateInstanceRowUpdateInput = {};

    if (input.rowKey !== undefined) {
      updateData.rowKey = input.rowKey;
    }
    if (input.sourceDocumentIds !== undefined) {
      updateData.sourceDocumentIds = input.sourceDocumentIds;
    }
    if (input.status !== undefined) {
      updateData.status = input.status;
    }

    // 如果更新欄位值，重新驗證
    if (input.fieldValues !== undefined) {
      updateData.fieldValues = input.fieldValues as Prisma.InputJsonValue;

      const templateFields = row.templateInstance.dataTemplate.fields as unknown as DataTemplateField[];
      const validationResult = this.validateRowData(input.fieldValues, templateFields);

      updateData.validationErrors = validationResult.errors
        ? (validationResult.errors as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull;

      // 如果沒有手動指定狀態，根據驗證結果更新
      if (input.status === undefined) {
        updateData.status = validationResult.isValid ? 'VALID' : 'INVALID';
      }
    }

    const updatedRow = await prisma.templateInstanceRow.update({
      where: { id: rowId },
      data: updateData,
    });

    // 更新實例統計
    await this.updateStatistics(row.templateInstanceId);

    return this.mapRowToDto(updatedRow);
  }

  /**
   * 刪除行
   * @param rowId - 行 ID
   */
  async deleteRow(rowId: string): Promise<void> {
    // 取得行和實例資訊
    const row = await prisma.templateInstanceRow.findUnique({
      where: { id: rowId },
      select: {
        templateInstanceId: true,
        templateInstance: { select: { status: true } },
      },
    });

    if (!row) {
      throw new Error('行不存在');
    }

    if (!EDITABLE_STATUSES.includes(row.templateInstance.status as TemplateInstanceStatus)) {
      throw new Error(`實例狀態為 ${row.templateInstance.status}，不可刪除行`);
    }

    await prisma.templateInstanceRow.delete({
      where: { id: rowId },
    });

    // 更新實例統計
    await this.updateStatistics(row.templateInstanceId);
  }

  // --------------------------------------------------------------------------
  // Validation Methods
  // --------------------------------------------------------------------------

  /**
   * 驗證行數據
   * @param fieldValues - 欄位值
   * @param templateFields - 模版欄位定義
   * @returns 驗證結果
   */
  validateRowData(
    fieldValues: Record<string, unknown>,
    templateFields: DataTemplateField[]
  ): ValidationResult {
    const errors: Record<string, string> = {};

    for (const field of templateFields) {
      const value = fieldValues[field.name];

      // 1. 必填檢查
      if (field.isRequired && (value === undefined || value === null || value === '')) {
        errors[field.name] = '此欄位為必填';
        continue;
      }

      // 2. 類型檢查（如果有值）
      if (value !== undefined && value !== null && value !== '') {
        const typeError = this.validateType(value, field.dataType);
        if (typeError) {
          errors[field.name] = typeError;
          continue;
        }

        // 3. 驗證規則檢查
        if (field.validation) {
          const validationError = this.validateRules(value, field.validation, field.dataType);
          if (validationError) {
            errors[field.name] = validationError;
          }
        }
      }
    }

    return {
      isValid: Object.keys(errors).length === 0,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
    };
  }

  /**
   * 驗證值的類型
   */
  private validateType(
    value: unknown,
    dataType: DataTemplateField['dataType']
  ): string | null {
    switch (dataType) {
      case 'string':
        if (typeof value !== 'string') {
          return '值必須為字串';
        }
        break;
      case 'number':
      case 'currency':
        if (typeof value !== 'number' && isNaN(Number(value))) {
          return '值必須為數字';
        }
        break;
      case 'date':
        if (typeof value === 'string') {
          const date = new Date(value);
          if (isNaN(date.getTime())) {
            return '無效的日期格式';
          }
        } else if (!(value instanceof Date)) {
          return '值必須為日期';
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          return '值必須為布林值';
        }
        break;
      case 'array':
        if (!Array.isArray(value)) {
          return '值必須為陣列';
        }
        break;
    }
    return null;
  }

  /**
   * 驗證值是否符合驗證規則
   */
  private validateRules(
    value: unknown,
    validation: NonNullable<DataTemplateField['validation']>,
    dataType: DataTemplateField['dataType']
  ): string | null {
    // 字串長度驗證
    if (typeof value === 'string') {
      if (validation.minLength !== undefined && value.length < validation.minLength) {
        return `長度不能少於 ${validation.minLength} 個字元`;
      }
      if (validation.maxLength !== undefined && value.length > validation.maxLength) {
        return `長度不能超過 ${validation.maxLength} 個字元`;
      }
      if (validation.pattern) {
        const regex = new RegExp(validation.pattern);
        if (!regex.test(value)) {
          return '格式不符合要求';
        }
      }
    }

    // 數字範圍驗證
    if (dataType === 'number' || dataType === 'currency') {
      const numValue = typeof value === 'number' ? value : Number(value);
      if (validation.min !== undefined && numValue < validation.min) {
        return `值不能小於 ${validation.min}`;
      }
      if (validation.max !== undefined && numValue > validation.max) {
        return `值不能大於 ${validation.max}`;
      }
    }

    // 允許值列表驗證
    if (validation.allowedValues && validation.allowedValues.length > 0) {
      if (!validation.allowedValues.includes(String(value))) {
        return `值必須是以下之一: ${validation.allowedValues.join(', ')}`;
      }
    }

    return null;
  }

  /**
   * 驗證實例的所有行
   * @param instanceId - 實例 ID
   * @returns 驗證統計
   */
  async validateAllRows(instanceId: string): Promise<BatchValidationResult> {
    // 取得實例和模版欄位
    const instance = await prisma.templateInstance.findUnique({
      where: { id: instanceId },
      select: {
        dataTemplate: { select: { fields: true } },
      },
    });

    if (!instance) {
      throw new Error('模版實例不存在');
    }

    const templateFields = instance.dataTemplate.fields as unknown as DataTemplateField[];

    // 取得所有行
    const rows = await prisma.templateInstanceRow.findMany({
      where: { templateInstanceId: instanceId },
    });

    let valid = 0;
    let invalid = 0;

    // 逐行驗證並更新
    for (const row of rows) {
      const fieldValues = row.fieldValues as Record<string, unknown>;
      const result = this.validateRowData(fieldValues, templateFields);

      await prisma.templateInstanceRow.update({
        where: { id: row.id },
        data: {
          validationErrors: result.errors
            ? (result.errors as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          status: result.isValid ? 'VALID' : 'INVALID',
        },
      });

      if (result.isValid) {
        valid++;
      } else {
        invalid++;
      }
    }

    // 更新統計
    await this.updateStatistics(instanceId);

    return {
      valid,
      invalid,
      total: rows.length,
    };
  }

  // --------------------------------------------------------------------------
  // Statistics Methods
  // --------------------------------------------------------------------------

  /**
   * 更新實例統計數據
   * @param instanceId - 實例 ID
   */
  async updateStatistics(instanceId: string): Promise<void> {
    // 計算各狀態的行數
    const stats = await prisma.templateInstanceRow.groupBy({
      by: ['status'],
      where: { templateInstanceId: instanceId },
      _count: { status: true },
    });

    const statusCounts = stats.reduce(
      (acc, stat) => {
        acc[stat.status as TemplateInstanceRowStatus] = stat._count.status;
        return acc;
      },
      {} as Record<TemplateInstanceRowStatus, number>
    );

    const rowCount =
      (statusCounts.PENDING ?? 0) +
      (statusCounts.VALID ?? 0) +
      (statusCounts.INVALID ?? 0) +
      (statusCounts.SKIPPED ?? 0);
    const validRowCount = statusCounts.VALID ?? 0;
    const errorRowCount = statusCounts.INVALID ?? 0;

    await prisma.templateInstance.update({
      where: { id: instanceId },
      data: {
        rowCount,
        validRowCount,
        errorRowCount,
      },
    });
  }

  // --------------------------------------------------------------------------
  // Status Management Methods
  // --------------------------------------------------------------------------

  /**
   * 變更實例狀態
   * @param instanceId - 實例 ID
   * @param newStatus - 新狀態
   * @param errorMessage - 錯誤訊息（當狀態為 ERROR 時）
   */
  async changeStatus(
    instanceId: string,
    newStatus: TemplateInstanceStatus,
    errorMessage?: string
  ): Promise<TemplateInstance> {
    const instance = await prisma.templateInstance.findUnique({
      where: { id: instanceId },
      select: { status: true },
    });

    if (!instance) {
      throw new Error('模版實例不存在');
    }

    const currentStatus = instance.status as TemplateInstanceStatus;
    const allowedStatuses = STATUS_TRANSITIONS[currentStatus];

    if (!allowedStatuses.includes(newStatus)) {
      throw new Error(
        `無法從 ${currentStatus} 轉換到 ${newStatus}，允許的目標狀態: ${allowedStatuses.join(', ') || '無'}`
      );
    }

    const updated = await prisma.templateInstance.update({
      where: { id: instanceId },
      data: { status: newStatus },
      include: {
        dataTemplate: { select: { name: true } },
      },
    });

    return this.mapInstanceToDto(updated);
  }

  /**
   * 標記為已導出
   * @param instanceId - 實例 ID
   * @param format - 導出格式
   * @param exportedBy - 導出者
   */
  async markExported(
    instanceId: string,
    format: 'xlsx' | 'csv' | 'json',
    exportedBy?: string
  ): Promise<TemplateInstance> {
    // 先變更狀態到 EXPORTED
    await this.changeStatus(instanceId, 'EXPORTED');

    // 更新導出資訊
    const updated = await prisma.templateInstance.update({
      where: { id: instanceId },
      data: {
        exportedAt: new Date(),
        exportedBy,
        exportFormat: format,
      },
      include: {
        dataTemplate: { select: { name: true } },
      },
    });

    return this.mapInstanceToDto(updated);
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  /**
   * 檢查實例是否存在
   * @param id - 實例 ID
   * @returns 是否存在
   */
  async exists(id: string): Promise<boolean> {
    const count = await prisma.templateInstance.count({
      where: { id },
    });
    return count > 0;
  }

  /**
   * 將 Prisma 實例轉換為 DTO
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapInstanceToDto(instance: any): TemplateInstance {
    return {
      id: instance.id,
      dataTemplateId: instance.dataTemplateId,
      name: instance.name,
      description: instance.description,
      status: instance.status as TemplateInstanceStatus,
      rowCount: instance.rowCount,
      validRowCount: instance.validRowCount,
      errorRowCount: instance.errorRowCount,
      exportedAt: instance.exportedAt?.toISOString() ?? null,
      exportedBy: instance.exportedBy,
      exportFormat: instance.exportFormat,
      createdAt: instance.createdAt.toISOString(),
      updatedAt: instance.updatedAt.toISOString(),
      createdBy: instance.createdBy,
    };
  }

  /**
   * 將 Prisma 行轉換為 DTO
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapRowToDto(row: any): TemplateInstanceRow {
    return {
      id: row.id,
      templateInstanceId: row.templateInstanceId,
      rowKey: row.rowKey,
      rowIndex: row.rowIndex,
      sourceDocumentIds: row.sourceDocumentIds || [],
      fieldValues: (row.fieldValues as Record<string, unknown>) || {},
      validationErrors: row.validationErrors as Record<string, string> | null,
      // FIX-128: 轉換診斷（引用了不存在來源 key 的清單）
      transformDiagnostics: row.transformDiagnostics as Record<string, string[]> | null,
      status: row.status as TemplateInstanceRowStatus,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

// ============================================================================
// Service Instance Export
// ============================================================================

/** 模版實例服務單例 */
export const templateInstanceService = new TemplateInstanceService();
