/**
 * @fileoverview FieldDefinitionSet 欄位定義集管理服務層
 * @description
 *   提供 FieldDefinitionSet 的 CRUD 操作、欄位解析和覆蓋率分析。
 *
 *   主要功能：
 *   - getFieldDefinitionSets: 分頁列表查詢（支援篩選、排序）
 *   - getFieldDefinitionSetById: 單一記錄查詢（含 relations）
 *   - createFieldDefinitionSet: 建立記錄（含 unique constraint 檢查）
 *   - updateFieldDefinitionSet: 更新記錄（version 自增）
 *   - deleteFieldDefinitionSet: 刪除記錄
 *   - toggleFieldDefinitionSet: 切換啟用狀態
 *   - getFieldsForSet: 僅回傳 fields 陣列（給 SourceFieldCombobox）
 *   - getResolvedFields: 三層擇一解析（回傳最具體的那一層，**不合併**）
 *   - getMergedResolvedFields: 三層合併（GLOBAL 為基底，COMPANY / FORMAT 逐層覆蓋）
 *   - getFieldCoverage: 覆蓋率分析（聚合 FieldExtractionFeedback）
 *   - getCandidateFields: 從 invoice-fields.ts 轉為候選清單
 *
 * @module src/services/field-definition-set.service
 * @since CHANGE-042 Phase 3
 * @lastModified 2026-02-23
 *
 * @dependencies
 *   - prisma - 資料庫 ORM
 *
 * @related
 *   - src/lib/validations/field-definition-set.schema.ts - 驗證 Schema
 *   - src/types/extraction-v3.types.ts - FieldDefinitionEntry 類型
 *   - prisma/schema.prisma - FieldDefinitionSet, FieldExtractionFeedback 模型
 */

import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import type {
  CreateFieldDefinitionSetInput,
  UpdateFieldDefinitionSetInput,
  GetFieldDefinitionSetsQuery,
} from '@/lib/validations/field-definition-set.schema';
import type { FieldDefinitionEntry } from '@/types/extraction-v3.types';
import { INVOICE_FIELDS } from '@/types/invoice-fields';

// ============================================================================
// Types
// ============================================================================

/** FieldDefinitionSet 列表項目 */
export interface FieldDefinitionSetListItem {
  id: string;
  name: string;
  scope: string;
  companyId: string | null;
  companyName: string | null;
  documentFormatId: string | null;
  documentFormatName: string | null;
  description: string | null;
  isActive: boolean;
  version: number;
  fieldsCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

/** FieldDefinitionSet 詳情 */
export interface FieldDefinitionSetDetail extends FieldDefinitionSetListItem {
  fields: FieldDefinitionEntry[];
}

/** 分頁資訊 */
export interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** 列表查詢結果 */
export interface FieldDefinitionSetListResult {
  items: FieldDefinitionSetListItem[];
  pagination: PaginationInfo;
}

/** 覆蓋率數據 */
export interface FieldCoverageData {
  totalExtractions: number;
  overallCoverageRate: number;
  fields: FieldCoverageItem[];
  unexpectedFields: UnexpectedFieldItem[];
}

/** 單欄位覆蓋率 */
export interface FieldCoverageItem {
  key: string;
  label: string;
  foundCount: number;
  missingCount: number;
  totalCount: number;
  coverageRate: number;
  status: 'healthy' | 'warning' | 'critical';
}

/** 意外欄位 */
export interface UnexpectedFieldItem {
  key: string;
  occurrenceCount: number;
  percentage: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 從 Prisma Json 欄位安全地解析 FieldDefinitionEntry[]
 */
function parseFieldEntries(json: unknown): FieldDefinitionEntry[] {
  if (!Array.isArray(json)) return [];
  return json as unknown as FieldDefinitionEntry[];
}

/**
 * 將 FieldDefinitionEntry[] 轉為 Prisma 可接受的 JSON 輸入
 */
function toJsonInput(fields: FieldDefinitionEntry[]): Prisma.InputJsonValue {
  return fields as unknown as Prisma.InputJsonValue;
}

/**
 * 將 Prisma 查詢結果格式化為列表項目
 */
function formatListItem(
  record: Prisma.FieldDefinitionSetGetPayload<{
    include: { company: { select: { name: true } }; documentFormat: { select: { name: true } } };
  }>
): FieldDefinitionSetListItem {
  const fields = Array.isArray(record.fields) ? record.fields : [];
  return {
    id: record.id,
    name: record.name,
    scope: record.scope,
    companyId: record.companyId,
    companyName: record.company?.name ?? null,
    documentFormatId: record.documentFormatId,
    documentFormatName: record.documentFormat?.name ?? null,
    description: record.description,
    isActive: record.isActive,
    version: record.version,
    fieldsCount: fields.length,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    createdBy: record.createdBy,
  };
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * 查詢 FieldDefinitionSet 列表（分頁 + 篩選 + 排序）
 */
export async function getFieldDefinitionSets(
  query: GetFieldDefinitionSetsQuery
): Promise<FieldDefinitionSetListResult> {
  const { page, limit, scope, companyId, documentFormatId, isActive, search, sortBy, sortOrder } =
    query;

  const where: Prisma.FieldDefinitionSetWhereInput = {};
  if (scope) where.scope = scope;
  if (companyId) where.companyId = companyId;
  if (documentFormatId) where.documentFormatId = documentFormatId;
  if (isActive !== undefined) where.isActive = isActive;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [records, total] = await Promise.all([
    prisma.fieldDefinitionSet.findMany({
      where,
      include: {
        company: { select: { name: true } },
        documentFormat: { select: { name: true } },
      },
      orderBy: { [sortBy]: sortOrder },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.fieldDefinitionSet.count({ where }),
  ]);

  return {
    items: records.map(formatListItem),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * 查詢單一 FieldDefinitionSet（含 relations）
 */
export async function getFieldDefinitionSetById(
  id: string
): Promise<FieldDefinitionSetDetail | null> {
  const record = await prisma.fieldDefinitionSet.findUnique({
    where: { id },
    include: {
      company: { select: { name: true } },
      documentFormat: { select: { name: true } },
    },
  });

  if (!record) return null;

  const fields = parseFieldEntries(record.fields);

  return {
    ...formatListItem(record),
    fields,
  };
}

/**
 * 建立 FieldDefinitionSet
 *
 * @description 包含 unique constraint 檢查（scope + companyId + documentFormatId）
 */
export async function createFieldDefinitionSet(
  input: CreateFieldDefinitionSetInput
): Promise<FieldDefinitionSetDetail> {
  // Unique constraint 檢查
  const existing = await prisma.fieldDefinitionSet.findFirst({
    where: {
      scope: input.scope,
      companyId: input.companyId ?? null,
      documentFormatId: input.documentFormatId ?? null,
    },
  });

  if (existing) {
    throw new Error(
      `DUPLICATE_SCOPE: A field definition set with scope=${input.scope}, companyId=${input.companyId ?? 'null'}, documentFormatId=${input.documentFormatId ?? 'null'} already exists (id: ${existing.id})`
    );
  }

  const record = await prisma.fieldDefinitionSet.create({
    data: {
      name: input.name,
      scope: input.scope,
      companyId: input.companyId ?? null,
      documentFormatId: input.documentFormatId ?? null,
      description: input.description ?? null,
      isActive: input.isActive,
      fields: toJsonInput(input.fields),
    },
    include: {
      company: { select: { name: true } },
      documentFormat: { select: { name: true } },
    },
  });

  return {
    ...formatListItem(record),
    fields: input.fields,
  };
}

/**
 * 更新 FieldDefinitionSet（version 自增）
 */
export async function updateFieldDefinitionSet(
  id: string,
  input: UpdateFieldDefinitionSetInput
): Promise<FieldDefinitionSetDetail> {
  const existing = await prisma.fieldDefinitionSet.findUnique({ where: { id } });
  if (!existing) {
    throw new Error(`NOT_FOUND: FieldDefinitionSet with id ${id} not found`);
  }

  const data: Prisma.FieldDefinitionSetUpdateInput = {
    version: { increment: 1 },
  };
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.fields !== undefined) data.fields = toJsonInput(input.fields);

  const record = await prisma.fieldDefinitionSet.update({
    where: { id },
    data,
    include: {
      company: { select: { name: true } },
      documentFormat: { select: { name: true } },
    },
  });

  const fields = parseFieldEntries(record.fields);

  return {
    ...formatListItem(record),
    fields,
  };
}

/**
 * 刪除 FieldDefinitionSet
 */
export async function deleteFieldDefinitionSet(id: string): Promise<void> {
  const existing = await prisma.fieldDefinitionSet.findUnique({ where: { id } });
  if (!existing) {
    throw new Error(`NOT_FOUND: FieldDefinitionSet with id ${id} not found`);
  }

  await prisma.fieldDefinitionSet.delete({ where: { id } });
}

/**
 * 切換 FieldDefinitionSet 啟用狀態
 */
export async function toggleFieldDefinitionSet(
  id: string
): Promise<{ id: string; isActive: boolean }> {
  const existing = await prisma.fieldDefinitionSet.findUnique({
    where: { id },
    select: { isActive: true },
  });
  if (!existing) {
    throw new Error(`NOT_FOUND: FieldDefinitionSet with id ${id} not found`);
  }

  const record = await prisma.fieldDefinitionSet.update({
    where: { id },
    data: { isActive: !existing.isActive },
    select: { id: true, isActive: true },
  });

  return record;
}

/**
 * 取得 FieldDefinitionSet 的欄位列表（給 SourceFieldCombobox）
 */
export async function getFieldsForSet(id: string): Promise<FieldDefinitionEntry[]> {
  const record = await prisma.fieldDefinitionSet.findUnique({
    where: { id },
    select: { fields: true },
  });

  if (!record) {
    throw new Error(`NOT_FOUND: FieldDefinitionSet with id ${id} not found`);
  }

  return parseFieldEntries(record.fields);
}

/**
 * 三層擇一解析欄位（FORMAT → COMPANY → GLOBAL → FALLBACK）
 *
 * @description
 *   🔴 **本函式不合併各層** —— 依 FORMAT → COMPANY → GLOBAL 順序查找，
 *   命中第一個存在且啟用的欄位集就直接回傳該層的完整 fields，其餘層不參與。
 *   回傳的 `source` 標示實際採用的是哪一層。
 *
 *   若 FORMAT 層只放了「需要覆蓋的少數欄位」，本函式會**只回傳那幾個欄位**，
 *   不會補上 COMPANY / GLOBAL 層的其餘欄位 —— 這與實際提取時的行為不同，
 *   請勿用本函式的輸出推斷提取管線會拿到哪些欄位。
 *
 *   需要合併結果請改用 {@link getMergedResolvedFields}。實際提取管線採用的是
 *   合併語意：Stage 3 走 `stage-3-extraction.service.ts` 內的 `loadFieldDefinitionSet`，
 *   匯率換算走 `getMergedResolvedFields`（CHANGE-072）。
 *
 *   用途：SourceFieldCombobox 等需要「某一層設定了什麼」的設定介面。
 *
 * @param companyId - 公司 ID（可選）
 * @param formatId - 格式 ID（可選；需與 companyId 並用才查 FORMAT 層）
 * @returns 最具體那一層的欄位集 + `source`（FORMAT / COMPANY / GLOBAL / FALLBACK）
 */
export async function getResolvedFields(
  companyId?: string,
  formatId?: string
): Promise<{ fields: FieldDefinitionEntry[]; setId?: string; source: string }> {
  // 1. FORMAT scope（最高優先）
  if (companyId && formatId) {
    const formatSet = await prisma.fieldDefinitionSet.findFirst({
      where: { scope: 'FORMAT', companyId, documentFormatId: formatId, isActive: true },
      select: { id: true, fields: true },
    });
    if (formatSet) {
      return {
        fields: parseFieldEntries(formatSet.fields),
        setId: formatSet.id,
        source: 'FORMAT',
      };
    }
  }

  // 2. COMPANY scope
  if (companyId) {
    const companySet = await prisma.fieldDefinitionSet.findFirst({
      where: { scope: 'COMPANY', companyId, documentFormatId: null, isActive: true },
      select: { id: true, fields: true },
    });
    if (companySet) {
      return {
        fields: parseFieldEntries(companySet.fields),
        setId: companySet.id,
        source: 'COMPANY',
      };
    }
  }

  // 3. GLOBAL scope
  const globalSet = await prisma.fieldDefinitionSet.findFirst({
    where: { scope: 'GLOBAL', companyId: null, documentFormatId: null, isActive: true },
    select: { id: true, fields: true },
  });
  if (globalSet) {
    return {
      fields: parseFieldEntries(globalSet.fields),
      setId: globalSet.id,
      source: 'GLOBAL',
    };
  }

  // 4. Fallback: invoice-fields.ts
  return {
    fields: getCandidateFields(),
    source: 'FALLBACK',
  };
}

/**
 * 三層合併解析欄位（GLOBAL base → COMPANY override → FORMAT override）
 *
 * @description
 *   與 stage-3-extraction.service 的 loadFieldDefinitionSet 採用**相同的合併語意**：
 *   GLOBAL 為基底，COMPANY 覆蓋/追加，FORMAT 覆蓋/追加（同 key 取代、新 key 追加）。
 *
 *   與 getResolvedFields 的差異：getResolvedFields 只回傳「最具體那一層」的欄位集，
 *   而本函式回傳「合併後的完整欄位集」，與實際提取時 stage3Result.fields 的 key 集合一致。
 *
 *   用途：需要完整欄位定義的場景，例如 CHANGE-072 匯率換算需依 dataType==='currency'
 *   判定動態 fields 中哪些 key 是貨幣金額欄位（這些 key 可能來自任一層）。
 *
 * @param companyId - 公司 ID（可選）
 * @param formatId - 格式 ID（可選；需與 companyId 並用才查 FORMAT 層）
 * @returns 合併後的 FieldDefinitionEntry 陣列；全部找不到時 fallback 到候選欄位清單
 * @since CHANGE-072
 */
export async function getMergedResolvedFields(
  companyId?: string,
  formatId?: string
): Promise<FieldDefinitionEntry[]> {
  const [formatSet, companySet, globalSet] = await Promise.all([
    companyId && formatId
      ? prisma.fieldDefinitionSet.findFirst({
          where: { scope: 'FORMAT', companyId, documentFormatId: formatId, isActive: true },
          select: { fields: true },
        })
      : Promise.resolve(null),
    companyId
      ? prisma.fieldDefinitionSet.findFirst({
          where: { scope: 'COMPANY', companyId, documentFormatId: null, isActive: true },
          select: { fields: true },
        })
      : Promise.resolve(null),
    prisma.fieldDefinitionSet.findFirst({
      where: { scope: 'GLOBAL', companyId: null, documentFormatId: null, isActive: true },
      select: { fields: true },
    }),
  ]);

  const merged = new Map<string, FieldDefinitionEntry>();
  for (const f of parseFieldEntries(globalSet?.fields)) merged.set(f.key, f);
  for (const f of parseFieldEntries(companySet?.fields)) merged.set(f.key, f);
  for (const f of parseFieldEntries(formatSet?.fields)) merged.set(f.key, f);

  if (merged.size === 0) return getCandidateFields();
  return Array.from(merged.values());
}

/**
 * 欄位覆蓋率分析
 *
 * @description 聚合 FieldExtractionFeedback，計算各欄位 found/missing 比率
 */
export async function getFieldCoverage(setId: string): Promise<FieldCoverageData> {
  const [set, feedbacks] = await Promise.all([
    prisma.fieldDefinitionSet.findUnique({
      where: { id: setId },
      select: { fields: true },
    }),
    prisma.fieldExtractionFeedback.findMany({
      where: { fieldDefinitionSetId: setId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ]);

  if (!set) {
    throw new Error(`NOT_FOUND: FieldDefinitionSet with id ${setId} not found`);
  }

  const definedFields = parseFieldEntries(set.fields);
  const totalExtractions = feedbacks.length;

  if (totalExtractions === 0) {
    return {
      totalExtractions: 0,
      overallCoverageRate: 0,
      fields: definedFields.map((f) => ({
        key: f.key,
        label: f.label,
        foundCount: 0,
        missingCount: 0,
        totalCount: 0,
        coverageRate: 0,
        status: 'critical' as const,
      })),
      unexpectedFields: [],
    };
  }

  // 計算每個定義欄位的 found/missing 次數
  const fieldStats = new Map<string, { found: number; missing: number }>();
  for (const f of definedFields) {
    fieldStats.set(f.key, { found: 0, missing: 0 });
  }

  const unexpectedFieldCounts = new Map<string, number>();

  for (const fb of feedbacks) {
    const foundFields = (Array.isArray(fb.foundFields) ? fb.foundFields : []) as string[];
    const missingFields = (Array.isArray(fb.missingFields) ? fb.missingFields : []) as string[];
    const unexpectedFields = (
      Array.isArray(fb.unexpectedFields) ? fb.unexpectedFields : []
    ) as string[];

    for (const key of foundFields) {
      const stat = fieldStats.get(key);
      if (stat) stat.found++;
    }

    for (const key of missingFields) {
      const stat = fieldStats.get(key);
      if (stat) stat.missing++;
    }

    for (const key of unexpectedFields) {
      unexpectedFieldCounts.set(key, (unexpectedFieldCounts.get(key) ?? 0) + 1);
    }
  }

  // 組裝欄位覆蓋率
  const fieldCoverageItems: FieldCoverageItem[] = definedFields.map((f) => {
    const stat = fieldStats.get(f.key) ?? { found: 0, missing: 0 };
    const totalCount = stat.found + stat.missing;
    const coverageRate = totalCount > 0 ? (stat.found / totalCount) * 100 : 0;

    let status: 'healthy' | 'warning' | 'critical';
    if (coverageRate >= 80) status = 'healthy';
    else if (coverageRate >= 50) status = 'warning';
    else status = 'critical';

    return {
      key: f.key,
      label: f.label,
      foundCount: stat.found,
      missingCount: stat.missing,
      totalCount,
      coverageRate: Math.round(coverageRate * 10) / 10,
      status,
    };
  });

  // 意外欄位
  const unexpectedFieldItems: UnexpectedFieldItem[] = Array.from(unexpectedFieldCounts.entries())
    .map(([key, count]) => ({
      key,
      occurrenceCount: count,
      percentage: Math.round((count / totalExtractions) * 1000) / 10,
    }))
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount);

  // 整體覆蓋率
  const totalFound = fieldCoverageItems.reduce((sum, f) => sum + f.foundCount, 0);
  const totalAll = fieldCoverageItems.reduce((sum, f) => sum + f.totalCount, 0);
  const overallCoverageRate =
    totalAll > 0 ? Math.round((totalFound / totalAll) * 1000) / 10 : 0;

  return {
    totalExtractions,
    overallCoverageRate,
    fields: fieldCoverageItems,
    unexpectedFields: unexpectedFieldItems,
  };
}

/**
 * 取得候選欄位列表（從 invoice-fields.ts 轉換）
 *
 * @description 將 INVOICE_FIELDS 靜態定義轉為 FieldDefinitionEntry[] 格式
 */
export function getCandidateFields(): FieldDefinitionEntry[] {
  return Object.values(INVOICE_FIELDS).map((field) => ({
    key: field.name,
    label: field.label,
    category: field.category,
    dataType: normalizeDataType(field.dataType),
    required: field.isRequired,
    description: field.description,
    aliases: field.aliases,
  }));
}

/**
 * 將 invoice-fields.ts 的 dataType 正規化為 FieldDefinitionEntry 支援的類型
 */
function normalizeDataType(dataType: string): 'string' | 'number' | 'date' | 'currency' {
  switch (dataType) {
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'currency':
      return 'currency';
    default:
      return 'string';
  }
}
