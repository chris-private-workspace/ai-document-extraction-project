/**
 * @fileoverview 模版欄位映射服務
 * @description
 *   提供第二層映射配置的 CRUD 操作和三層優先級解析
 *   第二層映射：標準欄位 → 模版欄位
 *
 * @module src/services/template-field-mapping
 * @since Epic 19 - Story 19.1
 * @lastModified 2026-01-22
 *
 * @features
 *   - CRUD 操作（列表、詳情、創建、更新、軟刪除）
 *   - 三層優先級配置解析（FORMAT > COMPANY > GLOBAL）
 *   - 映射規則合併（高優先級覆蓋低優先級）
 *   - 快取機制（5 分鐘 TTL）
 *
 * @dependencies
 *   - prisma - 資料庫操作
 *   - nanoid - 生成規則 ID
 *   - src/types/template-field-mapping.ts - 類型定義
 */

import { prisma } from '@/lib/prisma';
import { nanoid } from 'nanoid';
import type { Prisma } from '@prisma/client';
import type {
  TemplateFieldMapping,
  TemplateFieldMappingSummary,
  TemplateFieldMappingFilters,
  TemplateFieldMappingRule,
  ResolvedMappingConfig,
  ResolveMappingParams,
  TemplateFieldMappingScope,
} from '@/types/template-field-mapping';
import type {
  CreateTemplateFieldMappingInput,
  UpdateTemplateFieldMappingInput,
} from '@/validations/template-field-mapping';
import { SCOPE_PRIORITY } from '@/types/template-field-mapping';
import type { FieldTransformType, TransformParams } from '@/types/template-field-mapping';
// FIX-128: 儲存時未知來源 key 警告
import { findUnknownRuleSourceKeys } from '@/lib/template-mapping-source-keys';
import { getResolvedFields } from '@/services/field-definition-set.service';
import { STANDARD_FIELDS } from '@/constants/standard-fields';

// ============================================================================
// Constants
// ============================================================================

/** 快取 TTL（毫秒） */
const CACHE_TTL = 5 * 60 * 1000; // 5 分鐘

// ============================================================================
// Cache
// ============================================================================

/** 快取存儲 */
const resolveCache = new Map<
  string,
  { data: ResolvedMappingConfig; timestamp: number }
>();

// ============================================================================
// Service Class
// ============================================================================

/**
 * 模版欄位映射服務類
 * @description
 *   封裝所有 TemplateFieldMapping 相關的資料庫操作和業務邏輯
 */
export class TemplateFieldMappingService {
  // --------------------------------------------------------------------------
  // Query Methods
  // --------------------------------------------------------------------------

  /**
   * 列出映射配置
   * @description
   *   查詢映射配置列表，支援多種篩選條件和分頁
   *
   * @param filters - 篩選條件
   * @param page - 頁碼（從 1 開始）
   * @param limit - 每頁數量
   * @returns 映射配置摘要列表和總數
   */
  async list(
    filters: TemplateFieldMappingFilters = {},
    page: number = 1,
    limit: number = 20
  ): Promise<{ mappings: TemplateFieldMappingSummary[]; total: number }> {
    // 建構查詢條件
    const where: Prisma.TemplateFieldMappingWhereInput = {};

    if (filters.dataTemplateId) {
      where.dataTemplateId = filters.dataTemplateId;
    }
    if (filters.scope) {
      where.scope = filters.scope;
    }
    if (filters.companyId) {
      where.companyId = filters.companyId;
    }
    if (filters.documentFormatId) {
      where.documentFormatId = filters.documentFormatId;
    }
    if (filters.isActive !== undefined) {
      where.isActive = filters.isActive;
    }
    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    // 並行查詢列表和總數
    const [mappings, total] = await Promise.all([
      prisma.templateFieldMapping.findMany({
        where,
        include: {
          dataTemplate: { select: { name: true } },
          company: { select: { name: true } },
          documentFormat: { select: { name: true } },
        },
        orderBy: [
          { scope: 'asc' },
          { priority: 'desc' },
          { updatedAt: 'desc' },
        ],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.templateFieldMapping.count({ where }),
    ]);

    // 轉換為摘要格式
    return {
      mappings: mappings.map((m) => ({
        id: m.id,
        dataTemplateId: m.dataTemplateId,
        dataTemplateName: m.dataTemplate.name,
        scope: m.scope as TemplateFieldMappingScope,
        companyId: m.companyId,
        companyName: m.company?.name ?? null,
        documentFormatId: m.documentFormatId,
        documentFormatName: m.documentFormat?.name ?? null,
        name: m.name,
        ruleCount: Array.isArray(m.mappings) ? m.mappings.length : 0,
        priority: m.priority,
        isActive: m.isActive,
        updatedAt: m.updatedAt.toISOString(),
      })),
      total,
    };
  }

  /**
   * 取得映射配置詳情
   * @param id - 配置 ID
   * @returns 完整配置資訊或 null
   */
  async getById(id: string): Promise<TemplateFieldMapping | null> {
    const mapping = await prisma.templateFieldMapping.findUnique({
      where: { id },
      include: {
        dataTemplate: { select: { name: true } },
        company: { select: { name: true } },
        documentFormat: { select: { name: true } },
      },
    });

    if (!mapping) {
      return null;
    }

    return this.mapToDto(mapping);
  }

  // --------------------------------------------------------------------------
  // Mutation Methods
  // --------------------------------------------------------------------------

  /**
   * 創建映射配置
   * @param input - 創建輸入資料
   * @param createdBy - 創建者 ID
   * @returns 新建的配置
   */
  async create(
    input: CreateTemplateFieldMappingInput,
    createdBy?: string
  ): Promise<TemplateFieldMapping> {
    // 為每條規則生成 ID
    const mappingsWithIds = input.mappings.map((rule, index) => ({
      ...rule,
      id: nanoid(),
      order: rule.order ?? index,
    }));

    const mapping = await prisma.templateFieldMapping.create({
      data: {
        dataTemplateId: input.dataTemplateId,
        scope: input.scope,
        companyId: input.companyId || null,
        documentFormatId: input.documentFormatId || null,
        name: input.name,
        description: input.description,
        mappings: mappingsWithIds as unknown as Prisma.InputJsonValue,
        priority: input.priority ?? 0,
        createdBy,
      },
      include: {
        dataTemplate: { select: { name: true } },
        company: { select: { name: true } },
        documentFormat: { select: { name: true } },
      },
    });

    // 清除相關快取
    this.invalidateCache(input.dataTemplateId);

    return this.mapToDto(mapping);
  }

  /**
   * 更新映射配置
   * @description
   *   更新配置資訊，不能更改範圍和關聯
   *
   * @param id - 配置 ID
   * @param input - 更新輸入資料
   * @returns 更新後的配置
   * @throws Error 如果配置不存在
   */
  async update(
    id: string,
    input: UpdateTemplateFieldMappingInput
  ): Promise<TemplateFieldMapping> {
    // 檢查配置是否存在
    const existing = await prisma.templateFieldMapping.findUnique({
      where: { id },
      select: { dataTemplateId: true },
    });

    if (!existing) {
      throw new Error('映射配置不存在');
    }

    // 如果更新 mappings，為新規則生成 ID
    let mappingsData: TemplateFieldMappingRule[] | undefined;
    if (input.mappings) {
      mappingsData = input.mappings.map((rule, index) => ({
        ...rule,
        id: nanoid(),
        order: rule.order ?? index,
      }));
    }

    // 建構更新資料
    const updateData: Prisma.TemplateFieldMappingUpdateInput = {};

    if (input.name !== undefined) {
      updateData.name = input.name;
    }
    if (input.description !== undefined) {
      updateData.description = input.description;
    }
    if (mappingsData) {
      updateData.mappings = mappingsData as unknown as Prisma.InputJsonValue;
    }
    if (input.priority !== undefined) {
      updateData.priority = input.priority;
    }
    if (input.isActive !== undefined) {
      updateData.isActive = input.isActive;
    }

    const mapping = await prisma.templateFieldMapping.update({
      where: { id },
      data: updateData,
      include: {
        dataTemplate: { select: { name: true } },
        company: { select: { name: true } },
        documentFormat: { select: { name: true } },
      },
    });

    // 清除相關快取
    this.invalidateCache(existing.dataTemplateId);

    return this.mapToDto(mapping);
  }

  /**
   * FIX-128: 計算映射規則中「引用了不存在來源 key」的警告
   *
   * @description
   *   儲存時的 best-effort 檢查（不擋儲存，僅回傳警告）：
   *   把規則引用的來源 key 與該 scope 解析出的欄位定義 + 標準欄位比對，
   *   列出未知 key。設計上刻意保守，避免誤報擋住合法流程：
   *   - GLOBAL scope 一律不判定（無公司語境，欄位集合無從確定）
   *   - `li_*` / `_ref_*` 動態合成欄位豁免
   *   - 欄位解析失敗時回空（警告失敗不影響儲存）
   *
   * @param params - scope 語境 + 待檢查的規則
   * @returns 每條有問題規則的 targetField + 未知 key 清單（空陣列 = 無警告）
   * @since FIX-128
   */
  async computeUnknownSourceKeyWarnings(params: {
    scope: TemplateFieldMappingScope;
    companyId?: string | null;
    documentFormatId?: string | null;
    rules: Array<{
      targetField: string;
      sourceField: string;
      transformType: FieldTransformType;
      transformParams?: TransformParams;
    }>;
  }): Promise<Array<{ targetField: string; unknownKeys: string[] }>> {
    if (params.scope === 'GLOBAL') return [];

    try {
      const resolved = await getResolvedFields(
        params.companyId ?? undefined,
        params.documentFormatId ?? undefined
      );

      const knownKeys = new Set<string>(STANDARD_FIELDS.map((f) => f.name));
      for (const entry of resolved.fields ?? []) {
        knownKeys.add(entry.key);
      }

      const warnings: Array<{ targetField: string; unknownKeys: string[] }> = [];
      for (const rule of params.rules) {
        const unknownKeys = findUnknownRuleSourceKeys(rule, knownKeys);
        if (unknownKeys.length > 0) {
          warnings.push({ targetField: rule.targetField, unknownKeys });
        }
      }
      return warnings;
    } catch (error) {
      console.error('[TemplateFieldMapping] FIX-128 warning check failed:', error);
      return [];
    }
  }

  /**
   * 刪除映射配置（軟刪除）
   * @description
   *   將配置設為非啟用狀態，而非真正刪除
   *
   * @param id - 配置 ID
   * @throws Error 如果配置不存在
   */
  async delete(id: string): Promise<void> {
    // 檢查配置狀態
    const existing = await prisma.templateFieldMapping.findUnique({
      where: { id },
      select: { dataTemplateId: true },
    });

    if (!existing) {
      throw new Error('映射配置不存在');
    }

    // 軟刪除：設為非啟用
    await prisma.templateFieldMapping.update({
      where: { id },
      data: { isActive: false },
    });

    // 清除相關快取
    this.invalidateCache(existing.dataTemplateId);
  }

  /**
   * 硬刪除映射配置（管理員專用）
   * @description
   *   真正刪除配置記錄
   *
   * @param id - 配置 ID
   * @throws Error 如果配置不存在
   */
  async hardDelete(id: string): Promise<void> {
    // 檢查配置狀態
    const existing = await prisma.templateFieldMapping.findUnique({
      where: { id },
      select: { dataTemplateId: true },
    });

    if (!existing) {
      throw new Error('映射配置不存在');
    }

    await prisma.templateFieldMapping.delete({
      where: { id },
    });

    // 清除相關快取
    this.invalidateCache(existing.dataTemplateId);
  }

  // --------------------------------------------------------------------------
  // Resolution Methods (三層優先級解析)
  // --------------------------------------------------------------------------

  /**
   * 解析映射配置
   * @description
   *   按 FORMAT → COMPANY → GLOBAL 優先級合併映射規則
   *   高優先級的規則會覆蓋低優先級的同名目標欄位
   *
   * @param params - 解析參數
   * @returns 合併後的映射配置
   */
  async resolveMapping(params: ResolveMappingParams): Promise<ResolvedMappingConfig> {
    const { dataTemplateId, companyId, documentFormatId } = params;

    // 檢查快取
    const cacheKey = this.buildCacheKey(dataTemplateId, companyId, documentFormatId);
    const cached = resolveCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    // 建構查詢條件：查找所有相關配置
    const orConditions: Prisma.TemplateFieldMappingWhereInput[] = [
      { scope: 'GLOBAL' },
    ];

    if (companyId) {
      orConditions.push({ scope: 'COMPANY', companyId });
    }
    if (documentFormatId) {
      orConditions.push({ scope: 'FORMAT', documentFormatId });
    }

    // 查詢所有相關配置
    const configs = await prisma.templateFieldMapping.findMany({
      where: {
        dataTemplateId,
        isActive: true,
        OR: orConditions,
      },
      orderBy: [
        { priority: 'desc' },
      ],
    });

    // 按優先級排序（FORMAT > COMPANY > GLOBAL）
    const sortedConfigs = configs.sort((a, b) => {
      const scopePriorityA = SCOPE_PRIORITY[a.scope as TemplateFieldMappingScope];
      const scopePriorityB = SCOPE_PRIORITY[b.scope as TemplateFieldMappingScope];
      if (scopePriorityA !== scopePriorityB) {
        return scopePriorityB - scopePriorityA; // 高優先級排前面
      }
      return b.priority - a.priority; // 同範圍按 priority 排序
    });

    // 合併映射規則（高優先級覆蓋低優先級）
    const mergedMappings = this.mergeMappings(sortedConfigs);

    const result: ResolvedMappingConfig = {
      dataTemplateId,
      resolvedFrom: sortedConfigs.map((c) => ({
        id: c.id,
        scope: c.scope as TemplateFieldMappingScope,
        name: c.name,
      })),
      mappings: mergedMappings,
    };

    // 存入快取
    resolveCache.set(cacheKey, { data: result, timestamp: Date.now() });

    return result;
  }

  /**
   * 合併映射規則
   * @description
   *   同一 targetField 只保留最高優先級的規則
   *   從低優先級到高優先級遍歷，後者覆蓋前者
   *
   * @param configs - 已排序的配置列表（高優先級在前）
   * @returns 合併後的規則列表
   */
  private mergeMappings(
    configs: Array<{ mappings: unknown }>
  ): TemplateFieldMappingRule[] {
    const targetFieldMap = new Map<string, TemplateFieldMappingRule>();

    // 從低優先級到高優先級遍歷，高優先級覆蓋低優先級
    for (const config of [...configs].reverse()) {
      const rules = config.mappings as TemplateFieldMappingRule[];
      if (Array.isArray(rules)) {
        for (const rule of rules) {
          targetFieldMap.set(rule.targetField, rule);
        }
      }
    }

    // 按 order 排序返回
    return Array.from(targetFieldMap.values()).sort((a, b) => a.order - b.order);
  }

  // --------------------------------------------------------------------------
  // Cache Management
  // --------------------------------------------------------------------------

  /**
   * 建構快取鍵
   */
  private buildCacheKey(
    dataTemplateId: string,
    companyId?: string,
    documentFormatId?: string
  ): string {
    return `${dataTemplateId}:${companyId || ''}:${documentFormatId || ''}`;
  }

  /**
   * 清除指定模版的快取
   */
  private invalidateCache(dataTemplateId: string): void {
    for (const key of resolveCache.keys()) {
      if (key.startsWith(dataTemplateId)) {
        resolveCache.delete(key);
      }
    }
  }

  /**
   * 清除所有快取
   */
  clearAllCache(): void {
    resolveCache.clear();
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  /**
   * 檢查配置是否存在
   * @param id - 配置 ID
   * @returns 是否存在
   */
  async exists(id: string): Promise<boolean> {
    const count = await prisma.templateFieldMapping.count({
      where: { id },
    });
    return count > 0;
  }

  /**
   * 將 Prisma 結果轉換為 DTO
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapToDto(mapping: any): TemplateFieldMapping {
    return {
      id: mapping.id,
      dataTemplateId: mapping.dataTemplateId,
      scope: mapping.scope as TemplateFieldMappingScope,
      companyId: mapping.companyId,
      documentFormatId: mapping.documentFormatId,
      name: mapping.name,
      description: mapping.description,
      mappings: (mapping.mappings as TemplateFieldMappingRule[]) || [],
      priority: mapping.priority,
      isActive: mapping.isActive,
      createdAt: mapping.createdAt.toISOString(),
      updatedAt: mapping.updatedAt.toISOString(),
      createdBy: mapping.createdBy,
    };
  }
}

// ============================================================================
// Service Instance Export
// ============================================================================

/** 模版欄位映射服務單例 */
export const templateFieldMappingService = new TemplateFieldMappingService();
