/**
 * @fileoverview 數據模版服務
 * @description
 *   提供 DataTemplate 的 CRUD 操作和業務邏輯，包括：
 *   - 模版列表查詢（支援篩選和分頁）
 *   - 模版詳情查詢
 *   - 創建/更新/刪除模版
 *   - 可用模版查詢（下拉選單用）
 *
 * @module src/services/data-template
 * @since Epic 16 - Story 16.7
 * @lastModified 2026-01-13
 *
 * @features
 *   - 系統模版保護（不可修改/刪除）
 *   - 使用中模版保護（不可刪除）
 *   - 軟刪除（設為非啟用）
 *   - 範圍過濾（GLOBAL/COMPANY）
 *
 * @dependencies
 *   - prisma - 資料庫操作
 *   - src/types/data-template.ts - 類型定義
 */

import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import type {
  DataTemplate,
  DataTemplateSummary,
  DataTemplateFilters,
  DataTemplateField,
  DataTemplateOption,
  LineItemMode,
} from '@/types/data-template';
import type {
  CreateDataTemplateInput,
  UpdateDataTemplateInput,
} from '@/validations/data-template';

// ============================================================================
// Service Class
// ============================================================================

/**
 * 數據模版服務類
 * @description
 *   封裝所有 DataTemplate 相關的資料庫操作和業務邏輯
 */
export class DataTemplateService {
  // --------------------------------------------------------------------------
  // Query Methods
  // --------------------------------------------------------------------------

  /**
   * 列出模版
   * @description
   *   查詢模版列表，支援多種篩選條件和分頁
   *
   * @param filters - 篩選條件
   * @param page - 頁碼（從 1 開始）
   * @param limit - 每頁數量
   * @returns 模版摘要列表和總數
   */
  async list(
    filters: DataTemplateFilters = {},
    page: number = 1,
    limit: number = 20
  ): Promise<{ templates: DataTemplateSummary[]; total: number }> {
    // 建構查詢條件
    const where: Prisma.DataTemplateWhereInput = {};

    if (filters.scope) {
      where.scope = filters.scope;
    }
    if (filters.companyId) {
      where.companyId = filters.companyId;
    }
    if (filters.isActive !== undefined) {
      where.isActive = filters.isActive;
    }
    if (filters.isSystem !== undefined) {
      where.isSystem = filters.isSystem;
    }
    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    // 並行查詢列表和總數
    const [templates, total] = await Promise.all([
      prisma.dataTemplate.findMany({
        where,
        include: {
          company: { select: { name: true } },
          _count: { select: { fieldMappingConfigs: true } },
        },
        orderBy: [
          { isSystem: 'desc' },  // 系統模版排在前面
          { updatedAt: 'desc' },
        ],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.dataTemplate.count({ where }),
    ]);

    // 轉換為摘要格式
    return {
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        scope: t.scope as 'GLOBAL' | 'COMPANY',
        companyId: t.companyId,
        companyName: t.company?.name ?? null,
        fieldCount: (t.fields as unknown as DataTemplateField[]).length,
        isActive: t.isActive,
        isSystem: t.isSystem,
        updatedAt: t.updatedAt.toISOString(),
        usageCount: t._count.fieldMappingConfigs,
      })),
      total,
    };
  }

  /**
   * 取得模版詳情
   * @param id - 模版 ID
   * @returns 模版完整資訊或 null
   */
  async getById(id: string): Promise<DataTemplate | null> {
    const template = await prisma.dataTemplate.findUnique({
      where: { id },
      include: {
        company: { select: { name: true } },
      },
    });

    if (!template) {
      return null;
    }

    return {
      id: template.id,
      name: template.name,
      description: template.description,
      scope: template.scope as 'GLOBAL' | 'COMPANY',
      companyId: template.companyId,
      fields: template.fields as unknown as DataTemplateField[],
      lineItemMode: template.lineItemMode as LineItemMode,
      isActive: template.isActive,
      isSystem: template.isSystem,
      createdAt: template.createdAt.toISOString(),
      updatedAt: template.updatedAt.toISOString(),
      createdBy: template.createdBy,
    };
  }

  /**
   * 取得可用模版列表（下拉選單用）
   * @description
   *   返回啟用中的模版，包含全局模版和指定公司的模版
   *
   * @param companyId - 公司 ID（可選）
   * @returns 可用模版選項列表
   */
  async getAvailable(companyId?: string): Promise<DataTemplateOption[]> {
    const templates = await prisma.dataTemplate.findMany({
      where: {
        isActive: true,
        OR: [
          { scope: 'GLOBAL' },
          ...(companyId ? [{ companyId }] : []),
        ],
      },
      select: {
        id: true,
        name: true,
        scope: true,
      },
      orderBy: [
        { scope: 'asc' },  // COMPANY 排在前面（更具體的優先）
        { name: 'asc' },
      ],
    });

    return templates.map((t) => ({
      id: t.id,
      name: t.name,
      scope: t.scope as 'GLOBAL' | 'COMPANY',
    }));
  }

  // --------------------------------------------------------------------------
  // Mutation Methods
  // --------------------------------------------------------------------------

  /**
   * 創建模版
   * @param input - 創建輸入資料
   * @param createdBy - 創建者 ID
   * @returns 新建的模版
   */
  async create(
    input: CreateDataTemplateInput,
    createdBy?: string
  ): Promise<DataTemplate> {
    const template = await prisma.dataTemplate.create({
      data: {
        name: input.name,
        description: input.description,
        scope: input.scope,
        companyId: input.scope === 'COMPANY' ? input.companyId : null,
        fields: input.fields,
        ...(input.lineItemMode ? { lineItemMode: input.lineItemMode } : {}),
        isSystem: false,
        createdBy,
      },
    });

    return this.getById(template.id) as Promise<DataTemplate>;
  }

  /**
   * 更新模版
   * @description
   *   更新模版資訊，系統模版不可修改
   *
   * @param id - 模版 ID
   * @param input - 更新輸入資料
   * @returns 更新後的模版
   * @throws Error 如果模版不存在或為系統模版
   */
  async update(id: string, input: UpdateDataTemplateInput): Promise<DataTemplate> {
    // 檢查模版是否存在及是否為系統模版
    const existing = await prisma.dataTemplate.findUnique({
      where: { id },
      select: { isSystem: true },
    });

    if (!existing) {
      throw new Error('模版不存在');
    }

    if (existing.isSystem) {
      throw new Error('系統模版不可修改');
    }

    // 建構更新資料
    const updateData: Prisma.DataTemplateUpdateInput = {};

    if (input.name !== undefined) {
      updateData.name = input.name;
    }
    if (input.description !== undefined) {
      updateData.description = input.description;
    }
    if (input.fields !== undefined) {
      updateData.fields = input.fields;
    }
    if (input.lineItemMode !== undefined) {
      updateData.lineItemMode = input.lineItemMode;
    }
    if (input.isActive !== undefined) {
      updateData.isActive = input.isActive;
    }

    await prisma.dataTemplate.update({
      where: { id },
      data: updateData,
    });

    return this.getById(id) as Promise<DataTemplate>;
  }

  /**
   * 刪除模版（軟刪除）
   * @description
   *   將模版設為非啟用狀態，而非真正刪除
   *   系統模版不可刪除，使用中的模版不可刪除
   *
   * @param id - 模版 ID
   * @throws Error 如果模版為系統模版或正被使用
   */
  async delete(id: string): Promise<void> {
    // 檢查模版狀態
    const existing = await prisma.dataTemplate.findUnique({
      where: { id },
      select: {
        isSystem: true,
        _count: { select: { fieldMappingConfigs: true } },
      },
    });

    if (!existing) {
      throw new Error('模版不存在');
    }

    if (existing.isSystem) {
      throw new Error('系統模版不可刪除');
    }

    if (existing._count.fieldMappingConfigs > 0) {
      throw new Error(
        `此模版正被 ${existing._count.fieldMappingConfigs} 個映射配置使用中，無法刪除`
      );
    }

    // 軟刪除：設為非啟用
    await prisma.dataTemplate.update({
      where: { id },
      data: { isActive: false },
    });
  }

  /**
   * 硬刪除模版（管理員專用）
   * @description
   *   真正刪除模版記錄，僅限管理員使用
   *   系統模版不可刪除，使用中的模版不可刪除
   *
   * @param id - 模版 ID
   * @throws Error 如果模版為系統模版或正被使用
   */
  async hardDelete(id: string): Promise<void> {
    // 檢查模版狀態
    const existing = await prisma.dataTemplate.findUnique({
      where: { id },
      select: {
        isSystem: true,
        _count: { select: { fieldMappingConfigs: true } },
      },
    });

    if (!existing) {
      throw new Error('模版不存在');
    }

    if (existing.isSystem) {
      throw new Error('系統模版不可刪除');
    }

    if (existing._count.fieldMappingConfigs > 0) {
      throw new Error(
        `此模版正被 ${existing._count.fieldMappingConfigs} 個映射配置使用中，無法刪除`
      );
    }

    await prisma.dataTemplate.delete({
      where: { id },
    });
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  /**
   * 檢查模版是否存在
   * @param id - 模版 ID
   * @returns 是否存在
   */
  async exists(id: string): Promise<boolean> {
    const count = await prisma.dataTemplate.count({
      where: { id },
    });
    return count > 0;
  }

  /**
   * 取得模版的欄位列表
   * @param id - 模版 ID
   * @returns 欄位定義列表或 null
   */
  async getFields(id: string): Promise<DataTemplateField[] | null> {
    const template = await prisma.dataTemplate.findUnique({
      where: { id },
      select: { fields: true },
    });

    if (!template) {
      return null;
    }

    return template.fields as unknown as DataTemplateField[];
  }

  /**
   * 複製模版
   * @description
   *   創建一個模版的副本，可用於基於現有模版創建新模版
   *
   * @param id - 來源模版 ID
   * @param newName - 新模版名稱
   * @param createdBy - 創建者 ID
   * @returns 新建的模版
   */
  async duplicate(
    id: string,
    newName: string,
    createdBy?: string
  ): Promise<DataTemplate> {
    const source = await this.getById(id);

    if (!source) {
      throw new Error('來源模版不存在');
    }

    return this.create(
      {
        name: newName,
        description: source.description ?? undefined,
        scope: source.scope,
        companyId: source.companyId ?? undefined,
        fields: source.fields,
      },
      createdBy
    );
  }
}

// ============================================================================
// Service Instance Export
// ============================================================================

/** 數據模版服務單例 */
export const dataTemplateService = new DataTemplateService();
