/**
 * @fileoverview Pipeline Config 服務層
 * @description
 *   管理 Pipeline 配置的 CRUD 和 resolve 邏輯。
 *   支援 GLOBAL/REGION/COMPANY 三層 scope 配置，
 *   透過 resolveEffectiveConfig 合併為最終有效配置。
 *
 * @module src/services/pipeline-config
 * @since CHANGE-032 - Pipeline Reference Number Matching & FX Conversion
 * @lastModified 2026-02-11
 *
 * @features
 *   - CRUD 操作（列表、取得、建立、更新、刪除）
 *   - 三層 scope 配置合併（COMPANY > REGION > GLOBAL）
 *   - 分頁、篩選、排序查詢
 *
 * @dependencies
 *   - @prisma/client - 資料庫存取
 *
 * @related
 *   - src/lib/validations/pipeline-config.schema.ts - 驗證 Schema
 *   - src/app/api/v1/pipeline-configs/ - API 端點
 *   - src/types/extraction-v3.types.ts - EffectivePipelineConfig 類型
 */

import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import type { PipelineConfig, PipelineConfigScope } from '@prisma/client';
import type { EffectivePipelineConfig } from '@/types/extraction-v3.types';

// ============================================================================
// Types
// ============================================================================

interface PipelineConfigQueryParams {
  page?: number;
  limit?: number;
  scope?: PipelineConfigScope;
  isActive?: boolean;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

interface PipelineConfigCreateInput {
  scope: PipelineConfigScope;
  regionId?: string | null;
  companyId?: string | null;
  documentFormatId?: string | null;
  refMatchEnabled?: boolean;
  refMatchTypes?: string[];
  refMatchMaxResults?: number;
  fxConversionEnabled?: boolean;
  fxTargetCurrency?: string | null;
  fxConvertLineItems?: boolean;
  fxConvertExtraCharges?: boolean;
  fxRoundingPrecision?: number;
  fxFallbackBehavior?: string;
  fxSourceCurrencies?: string[] | null;
  isActive?: boolean;
  description?: string | null;
}

interface PipelineConfigUpdateInput {
  refMatchEnabled?: boolean;
  refMatchTypes?: string[];
  refMatchMaxResults?: number;
  fxConversionEnabled?: boolean;
  fxTargetCurrency?: string | null;
  fxConvertLineItems?: boolean;
  fxConvertExtraCharges?: boolean;
  fxRoundingPrecision?: number;
  fxFallbackBehavior?: string;
  fxSourceCurrencies?: string[] | null;
  isActive?: boolean;
  description?: string | null;
}

// ============================================================================
// Default Config Values
// ============================================================================

const DEFAULT_EFFECTIVE_CONFIG: EffectivePipelineConfig = {
  refMatchEnabled: false,
  refMatchTypes: ['SHIPMENT', 'HAWB', 'MAWB', 'BL', 'CONTAINER'],
  refMatchMaxResults: 10,
  fxConversionEnabled: false,
  fxTargetCurrency: null,
  fxConvertLineItems: true,
  fxConvertExtraCharges: true,
  fxRoundingPrecision: 2,
  fxFallbackBehavior: 'skip',
  fxSourceCurrencies: null,
  resolvedFrom: {},
};

// ============================================================================
// FIX-037 BUG-4: Prisma 預設值對照表
// 用於區分「管理員明確設定」vs「Prisma schema 預設值」
// ============================================================================

const PRISMA_DEFAULTS: Record<string, unknown> = {
  refMatchEnabled: false,
  refMatchMaxResults: 10,
  fxConversionEnabled: false,
  fxConvertLineItems: true,
  fxConvertExtraCharges: true,
  fxRoundingPrecision: 2,
  fxFallbackBehavior: 'skip',
};

/**
 * 合併配置欄位 - 只有明確設定（非 Prisma 預設值）的值才覆蓋
 *
 * GLOBAL scope 的值一律採用；非 GLOBAL scope 則只有與預設值不同的欄位才覆蓋。
 */
function mergeConfigField<T>(
  current: T,
  incoming: T,
  prismaDefault: T,
  isGlobalScope: boolean
): T {
  if (isGlobalScope) return incoming;
  if (incoming === prismaDefault) return current;
  return incoming;
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * 查詢 Pipeline Config 列表
 */
export async function getPipelineConfigs(query: PipelineConfigQueryParams) {
  const {
    page = 1,
    limit = 20,
    scope,
    isActive,
    sortBy = 'createdAt',
    sortOrder = 'desc',
  } = query;

  const where: Prisma.PipelineConfigWhereInput = {};
  if (scope) where.scope = scope;
  if (isActive !== undefined) where.isActive = isActive;

  const [items, total] = await Promise.all([
    prisma.pipelineConfig.findMany({
      where,
      include: {
        region: { select: { id: true, name: true, code: true } },
        company: { select: { id: true, name: true } },
      },
      orderBy: { [sortBy]: sortOrder },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.pipelineConfig.count({ where }),
  ]);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * 取得單筆 Pipeline Config
 */
export async function getPipelineConfigById(id: string) {
  const config = await prisma.pipelineConfig.findUnique({
    where: { id },
    include: {
      region: { select: { id: true, name: true, code: true } },
      company: { select: { id: true, name: true } },
      // CHANGE-071: FORMAT scope 顯示格式名 + 所屬公司
      documentFormat: {
        select: {
          id: true,
          name: true,
          company: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!config) {
    throw new Error('Pipeline config not found');
  }

  return config;
}

/**
 * 建立 Pipeline Config
 */
export async function createPipelineConfig(data: PipelineConfigCreateInput) {
  // Scope 驗證：GLOBAL 不需要 regionId/companyId
  if (data.scope === 'GLOBAL') {
    data.regionId = null;
    data.companyId = null;
    data.documentFormatId = null;
  } else if (data.scope === 'REGION') {
    if (!data.regionId) throw new Error('Region scope requires regionId');
    data.companyId = null;
    data.documentFormatId = null;
  } else if (data.scope === 'COMPANY') {
    if (!data.companyId) throw new Error('Company scope requires companyId');
    data.documentFormatId = null;
  } else if (data.scope === 'FORMAT') {
    // CHANGE-071: FORMAT scope 以 documentFormatId 為鍵（格式已隱含公司）
    if (!data.documentFormatId) throw new Error('Format scope requires documentFormatId');
    data.regionId = null;
    data.companyId = null;
  }

  // 檢查重複
  const existing = await prisma.pipelineConfig.findFirst({
    where: {
      scope: data.scope,
      regionId: data.regionId ?? null,
      companyId: data.companyId ?? null,
      documentFormatId: data.documentFormatId ?? null,
    },
  });

  if (existing) {
    throw new Error('此 scope + region + company + format 組合的配置已存在');
  }

  return prisma.pipelineConfig.create({
    data: {
      scope: data.scope,
      regionId: data.regionId ?? null,
      companyId: data.companyId ?? null,
      documentFormatId: data.documentFormatId ?? null,
      refMatchEnabled: data.refMatchEnabled ?? false,
      refMatchTypes: data.refMatchTypes ?? ['SHIPMENT', 'HAWB', 'MAWB', 'BL', 'CONTAINER'],
      refMatchMaxResults: data.refMatchMaxResults ?? 10,
      fxConversionEnabled: data.fxConversionEnabled ?? false,
      fxTargetCurrency: data.fxTargetCurrency ?? null,
      fxConvertLineItems: data.fxConvertLineItems ?? true,
      fxConvertExtraCharges: data.fxConvertExtraCharges ?? true,
      fxRoundingPrecision: data.fxRoundingPrecision ?? 2,
      fxFallbackBehavior: data.fxFallbackBehavior ?? 'skip',
      fxSourceCurrencies:
        data.fxSourceCurrencies == null
          ? undefined
          : (data.fxSourceCurrencies as unknown as Prisma.InputJsonValue),
      isActive: data.isActive ?? true,
      description: data.description ?? null,
    },
    include: {
      region: { select: { id: true, name: true, code: true } },
      company: { select: { id: true, name: true } },
      // CHANGE-071: FORMAT scope 顯示格式名 + 所屬公司
      documentFormat: {
        select: {
          id: true,
          name: true,
          company: { select: { id: true, name: true } },
        },
      },
    },
  });
}

/**
 * 更新 Pipeline Config
 */
export async function updatePipelineConfig(id: string, data: PipelineConfigUpdateInput) {
  const existing = await prisma.pipelineConfig.findUnique({ where: { id } });
  if (!existing) {
    throw new Error('Pipeline config not found');
  }

  // Transform refMatchTypes for Prisma JSON compatibility
  const prismaData: Prisma.PipelineConfigUpdateInput = {
    ...data,
    refMatchTypes: data.refMatchTypes === undefined
      ? undefined
      : data.refMatchTypes as unknown as Prisma.InputJsonValue,
    fxSourceCurrencies: data.fxSourceCurrencies === undefined
      ? undefined
      : data.fxSourceCurrencies === null
        ? Prisma.DbNull
        : data.fxSourceCurrencies as unknown as Prisma.InputJsonValue,
  };

  return prisma.pipelineConfig.update({
    where: { id },
    data: prismaData,
    include: {
      region: { select: { id: true, name: true, code: true } },
      company: { select: { id: true, name: true } },
      // CHANGE-071: FORMAT scope 顯示格式名 + 所屬公司
      documentFormat: {
        select: {
          id: true,
          name: true,
          company: { select: { id: true, name: true } },
        },
      },
    },
  });
}

/**
 * 刪除 Pipeline Config
 */
export async function deletePipelineConfig(id: string) {
  const existing = await prisma.pipelineConfig.findUnique({ where: { id } });
  if (!existing) {
    throw new Error('Pipeline config not found');
  }

  return prisma.pipelineConfig.delete({ where: { id } });
}

/**
 * 解析有效配置 - 核心方法
 *
 * @description
 *   合併三層 scope 配置：COMPANY > REGION > GLOBAL
 *   逐欄位覆蓋，更具體的 scope 優先。
 *
 * @param options - regionId 和 companyId（可選）
 * @returns 合併後的有效配置
 */
export async function resolveEffectiveConfig(
  options: { regionId?: string; companyId?: string; formatId?: string } = {}
): Promise<EffectivePipelineConfig> {
  const { regionId, companyId, formatId } = options;

  // 1. 載入 GLOBAL config
  const globalConfig = await prisma.pipelineConfig.findFirst({
    where: {
      scope: 'GLOBAL',
      regionId: null,
      companyId: null,
      isActive: true,
    },
  });

  // 2. 載入 REGION config（if regionId provided）
  let regionConfig: PipelineConfig | null = null;
  if (regionId) {
    regionConfig = await prisma.pipelineConfig.findFirst({
      where: {
        scope: 'REGION',
        regionId,
        isActive: true,
      },
    });
  }

  // 3. 載入 COMPANY config（if companyId provided）
  let companyConfig: PipelineConfig | null = null;
  if (companyId) {
    companyConfig = await prisma.pipelineConfig.findFirst({
      where: {
        scope: 'COMPANY',
        companyId,
        isActive: true,
      },
    });
  }

  // 3.5 載入 FORMAT config（if formatId provided）— CHANGE-071
  let formatConfig: PipelineConfig | null = null;
  if (formatId) {
    formatConfig = await prisma.pipelineConfig.findFirst({
      where: {
        scope: 'FORMAT',
        documentFormatId: formatId,
        isActive: true,
      },
    });
  }

  // 4. 逐欄位合併：FORMAT > COMPANY > REGION > GLOBAL > DEFAULT
  const configs = [globalConfig, regionConfig, companyConfig, formatConfig].filter(
    (c): c is PipelineConfig => c !== null
  );

  if (configs.length === 0) {
    return { ...DEFAULT_EFFECTIVE_CONFIG };
  }

  const resolved: EffectivePipelineConfig = { ...DEFAULT_EFFECTIVE_CONFIG };
  const resolvedFrom: Record<string, string> = {};

  for (const config of configs) {
    const scopeLabel = config.scope.toLowerCase();
    const isGlobal = config.scope === 'GLOBAL';

    // FIX-037 BUG-4: 使用顯式覆蓋策略
    // GLOBAL scope 的值一律採用；REGION/COMPANY scope 只有與 Prisma 預設值不同的欄位才覆蓋
    resolved.refMatchEnabled = mergeConfigField(
      resolved.refMatchEnabled, config.refMatchEnabled,
      PRISMA_DEFAULTS.refMatchEnabled as boolean, isGlobal
    );
    resolved.refMatchMaxResults = mergeConfigField(
      resolved.refMatchMaxResults, config.refMatchMaxResults,
      PRISMA_DEFAULTS.refMatchMaxResults as number, isGlobal
    );
    resolved.fxConversionEnabled = mergeConfigField(
      resolved.fxConversionEnabled, config.fxConversionEnabled,
      PRISMA_DEFAULTS.fxConversionEnabled as boolean, isGlobal
    );
    resolved.fxConvertLineItems = mergeConfigField(
      resolved.fxConvertLineItems, config.fxConvertLineItems,
      PRISMA_DEFAULTS.fxConvertLineItems as boolean, isGlobal
    );
    resolved.fxConvertExtraCharges = mergeConfigField(
      resolved.fxConvertExtraCharges, config.fxConvertExtraCharges,
      PRISMA_DEFAULTS.fxConvertExtraCharges as boolean, isGlobal
    );
    resolved.fxRoundingPrecision = mergeConfigField(
      resolved.fxRoundingPrecision, config.fxRoundingPrecision,
      PRISMA_DEFAULTS.fxRoundingPrecision as number, isGlobal
    );
    resolved.fxFallbackBehavior = mergeConfigField(
      resolved.fxFallbackBehavior,
      config.fxFallbackBehavior as 'skip' | 'warn' | 'error',
      PRISMA_DEFAULTS.fxFallbackBehavior as 'skip' | 'warn' | 'error',
      isGlobal
    );

    // nullable 欄位：只有非 null 時才覆蓋（原有邏輯已正確）
    if (config.refMatchTypes) {
      resolved.refMatchTypes = config.refMatchTypes as string[];
    }
    if (config.fxTargetCurrency) {
      resolved.fxTargetCurrency = config.fxTargetCurrency;
    }
    // CHANGE-071: 來源幣別清單為 nullable，非 null 時才覆蓋（含明確空陣列 = 全轉）
    if (config.fxSourceCurrencies != null) {
      resolved.fxSourceCurrencies = config.fxSourceCurrencies as unknown as string[];
    }

    resolvedFrom[scopeLabel] = config.id;
  }

  resolved.resolvedFrom = resolvedFrom;
  return resolved;
}
