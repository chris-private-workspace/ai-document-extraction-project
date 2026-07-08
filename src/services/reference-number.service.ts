/**
 * @fileoverview Reference Number 服務層
 * @description
 *   提供 Reference Number 的 CRUD 操作功能。
 *
 *   主要功能：
 *   - list: 分頁列表查詢（支援篩選、排序）
 *   - getById: 單一記錄查詢
 *   - create: 建立新記錄（含自動生成 code）
 *   - update: 更新記錄
 *   - delete: 軟刪除記錄
 *   - importReferenceNumbers: 批次導入
 *   - exportReferenceNumbers: 批次導出
 *   - validateReferenceNumbers: 批次驗證
 *
 *   設計決策：
 *   - code 欄位自動生成：格式為 REF-{YEAR}-{REGION_CODE}-{RANDOM}
 *   - 軟刪除：刪除時設定 isActive = false
 *   - 唯一約束：(number, type, year, regionId) 組合唯一
 *
 * @module src/services/reference-number.service
 * @since Epic 20 - Story 20.3
 * @lastModified 2026-02-05 (Story 20.4: Import/Export/Validate)
 *
 * @dependencies
 *   - prisma - 資料庫 ORM
 *   - crypto - 隨機碼生成
 *
 * @related
 *   - src/lib/validations/reference-number.schema.ts - 驗證 Schema
 *   - src/app/api/v1/reference-numbers/ - API 端點
 */

import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import type {
  CreateReferenceNumberInput,
  UpdateReferenceNumberInput,
  GetReferenceNumbersQuery,
  ImportReferenceNumbersInput,
  ExportReferenceNumbersQuery,
  ValidateReferenceNumbersInput,
} from '@/lib/validations/reference-number.schema';

// ============================================================================
// Types
// ============================================================================

/**
 * Reference Number 列表項目
 */
export interface ReferenceNumberListItem {
  id: string;
  code: string;
  number: string;
  type: string;
  status: string;
  documentSubType: string | null;
  year: number;
  regionId: string;
  regionCode: string;
  regionName: string;
  description: string | null;
  validFrom: string | null;
  validUntil: string | null;
  matchCount: number;
  lastMatchedAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Reference Number 詳情
 */
export interface ReferenceNumberDetail extends ReferenceNumberListItem {
  createdById: string;
}

/**
 * 分頁資訊
 */
export interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * 列表查詢結果
 */
export interface ReferenceNumberListResult {
  items: ReferenceNumberListItem[];
  pagination: PaginationInfo;
}

// ============================================================================
// Helper Functions
// ============================================================================

/** SI-6：code 隨機碼字母表（大寫英數，36 種） */
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * 生成隨機碼（保證 6 字元大寫英數字）
 *
 * SI-6：原實作以 base64 過濾後取前 6 字元，過濾非英數後可能不足 6 字元、
 * 縮小唯一性空間。改為逐字元從 36 字元表取樣，保證固定長度並降低碰撞。
 */
function generateRandomCode(): string {
  const bytes = randomBytes(6);
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return result;
}

/**
 * 生成 Reference Number code
 * 格式: REF-{YEAR}-{REGION_CODE}-{RANDOM}
 * 範例: REF-2026-APAC-A1B2C3
 */
async function generateCode(year: number, regionCode: string): Promise<string> {
  const random = generateRandomCode();
  const code = `REF-${year}-${regionCode}-${random}`;

  // 確保唯一性
  const existing = await prisma.referenceNumber.findUnique({ where: { code } });
  if (existing) {
    return generateCode(year, regionCode);
  }

  return code;
}

/**
 * SI-6：以記憶體集合確保唯一的 code 生成（供批次匯入使用）
 * 不查詢資料庫，改在傳入的 usedCodes 集合中檢查與登記，避免逐筆 N+1 查詢。
 */
function generateUniqueCodeInMemory(
  year: number,
  regionCode: string,
  usedCodes: Set<string>
): string {
  let code: string;
  let attempts = 0;
  do {
    code = `REF-${year}-${regionCode}-${generateRandomCode()}`;
    attempts++;
  } while (usedCodes.has(code) && attempts < 20);
  usedCodes.add(code);
  return code;
}

/**
 * 格式化日期為 ISO 字串
 */
function formatDate(date: Date | null | undefined): string | null {
  return date?.toISOString() ?? null;
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * 查詢 Reference Number 列表
 *
 * @param query - 查詢參數
 * @returns 列表結果（含分頁資訊）
 */
export async function getReferenceNumbers(
  query: GetReferenceNumbersQuery
): Promise<ReferenceNumberListResult> {
  const {
    page,
    limit,
    year,
    regionId,
    type,
    status,
    documentSubType,
    isActive,
    search,
    sortBy,
    sortOrder,
  } = query;

  // 建立查詢條件
  const where: Prisma.ReferenceNumberWhereInput = {};

  if (year !== undefined) {
    where.year = year;
  }

  if (regionId) {
    where.regionId = regionId;
  }

  if (type) {
    where.type = type;
  }

  if (status) {
    where.status = status;
  }

  if (documentSubType) {
    where.documentSubType = documentSubType;
  }

  if (isActive !== undefined) {
    where.isActive = isActive;
  }

  if (search) {
    where.number = { contains: search, mode: 'insensitive' };
  }

  // 並行查詢資料和總數
  const [items, total] = await Promise.all([
    prisma.referenceNumber.findMany({
      where,
      include: {
        region: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
      },
      orderBy: { [sortBy]: sortOrder },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.referenceNumber.count({ where }),
  ]);

  // 格式化結果
  const formattedItems: ReferenceNumberListItem[] = items.map((item) => ({
    id: item.id,
    code: item.code,
    number: item.number,
    type: item.type,
    status: item.status,
    documentSubType: item.documentSubType,
    year: item.year,
    regionId: item.regionId,
    regionCode: item.region.code,
    regionName: item.region.name,
    description: item.description,
    validFrom: formatDate(item.validFrom),
    validUntil: formatDate(item.validUntil),
    matchCount: item.matchCount,
    lastMatchedAt: formatDate(item.lastMatchedAt),
    isActive: item.isActive,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }));

  return {
    items: formattedItems,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * 查詢單一 Reference Number
 *
 * @param id - Reference Number ID
 * @returns Reference Number 詳情，或 null（不存在）
 */
export async function getReferenceNumberById(
  id: string
): Promise<ReferenceNumberDetail | null> {
  const item = await prisma.referenceNumber.findUnique({
    where: { id },
    include: {
      region: {
        select: {
          id: true,
          code: true,
          name: true,
        },
      },
    },
  });

  if (!item) {
    return null;
  }

  return {
    id: item.id,
    code: item.code,
    number: item.number,
    type: item.type,
    status: item.status,
    documentSubType: item.documentSubType,
    year: item.year,
    regionId: item.regionId,
    regionCode: item.region.code,
    regionName: item.region.name,
    description: item.description,
    validFrom: formatDate(item.validFrom),
    validUntil: formatDate(item.validUntil),
    matchCount: item.matchCount,
    lastMatchedAt: formatDate(item.lastMatchedAt),
    isActive: item.isActive,
    createdById: item.createdById,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

/**
 * 建立 Reference Number
 *
 * @param input - 建立資料
 * @param createdById - 建立者 ID
 * @returns 建立的 Reference Number
 * @throws Error - 地區不存在或唯一約束違反
 */
export async function createReferenceNumber(
  input: CreateReferenceNumberInput,
  createdById: string
): Promise<ReferenceNumberDetail> {
  // 取得 region 資訊
  const region = await prisma.region.findUnique({
    where: { id: input.regionId },
    select: { id: true, code: true, name: true },
  });

  if (!region) {
    throw new Error('地區不存在');
  }

  // 檢查唯一約束
  const existing = await prisma.referenceNumber.findFirst({
    where: {
      number: input.number,
      type: input.type,
      year: input.year,
      regionId: input.regionId,
    },
  });

  if (existing) {
    throw new Error(
      `此組合已存在：number=${input.number}, type=${input.type}, year=${input.year}, regionId=${input.regionId}`
    );
  }

  // 生成或使用提供的 code
  const code = input.code || (await generateCode(input.year, region.code));

  // 檢查 code 唯一性
  if (input.code) {
    const existingCode = await prisma.referenceNumber.findUnique({
      where: { code: input.code },
    });
    if (existingCode) {
      throw new Error(`識別碼 ${input.code} 已存在`);
    }
  }

  // 建立記錄
  const item = await prisma.referenceNumber.create({
    data: {
      code,
      number: input.number,
      type: input.type,
      documentSubType: input.documentSubType ?? null,
      year: input.year,
      regionId: input.regionId,
      description: input.description ?? null,
      validFrom: input.validFrom ? new Date(input.validFrom) : null,
      validUntil: input.validUntil ? new Date(input.validUntil) : null,
      createdById,
    },
    include: {
      region: {
        select: {
          id: true,
          code: true,
          name: true,
        },
      },
    },
  });

  return {
    id: item.id,
    code: item.code,
    number: item.number,
    type: item.type,
    status: item.status,
    documentSubType: item.documentSubType,
    year: item.year,
    regionId: item.regionId,
    regionCode: item.region.code,
    regionName: item.region.name,
    description: item.description,
    validFrom: formatDate(item.validFrom),
    validUntil: formatDate(item.validUntil),
    matchCount: item.matchCount,
    lastMatchedAt: formatDate(item.lastMatchedAt),
    isActive: item.isActive,
    createdById: item.createdById,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

/**
 * 更新 Reference Number
 *
 * @param id - Reference Number ID
 * @param input - 更新資料
 * @returns 更新後的 Reference Number
 * @throws Error - 記錄不存在或唯一約束違反
 */
export async function updateReferenceNumber(
  id: string,
  input: UpdateReferenceNumberInput
): Promise<ReferenceNumberDetail> {
  // 檢查記錄是否存在
  const existing = await prisma.referenceNumber.findUnique({
    where: { id },
  });

  if (!existing) {
    throw new Error('Reference Number 不存在');
  }

  // 如果更新了會影響唯一約束的欄位，需要檢查
  const newNumber = input.number ?? existing.number;
  const newType = input.type ?? existing.type;
  const newYear = input.year ?? existing.year;
  const newRegionId = input.regionId ?? existing.regionId;

  // 檢查更新後是否會違反唯一約束
  if (
    input.number !== undefined ||
    input.type !== undefined ||
    input.year !== undefined ||
    input.regionId !== undefined
  ) {
    const duplicate = await prisma.referenceNumber.findFirst({
      where: {
        number: newNumber,
        type: newType,
        year: newYear,
        regionId: newRegionId,
        id: { not: id }, // 排除自己
      },
    });

    if (duplicate) {
      throw new Error(
        `此組合已存在：number=${newNumber}, type=${newType}, year=${newYear}, regionId=${newRegionId}`
      );
    }
  }

  // 如果更新了 regionId，驗證新地區存在
  if (input.regionId) {
    const region = await prisma.region.findUnique({
      where: { id: input.regionId },
    });
    if (!region) {
      throw new Error('地區不存在');
    }
  }

  // 建立更新資料
  const updateData: Prisma.ReferenceNumberUpdateInput = {};

  if (input.number !== undefined) {
    updateData.number = input.number;
  }
  if (input.type !== undefined) {
    updateData.type = input.type;
  }
  if (input.status !== undefined) {
    updateData.status = input.status;
  }
  if (input.documentSubType !== undefined) {
    updateData.documentSubType = input.documentSubType;
  }
  if (input.year !== undefined) {
    updateData.year = input.year;
  }
  if (input.regionId !== undefined) {
    updateData.region = { connect: { id: input.regionId } };
  }
  if (input.description !== undefined) {
    updateData.description = input.description;
  }
  if (input.validFrom !== undefined) {
    updateData.validFrom = input.validFrom ? new Date(input.validFrom) : null;
  }
  if (input.validUntil !== undefined) {
    updateData.validUntil = input.validUntil ? new Date(input.validUntil) : null;
  }
  if (input.isActive !== undefined) {
    updateData.isActive = input.isActive;
  }

  // 執行更新
  const item = await prisma.referenceNumber.update({
    where: { id },
    data: updateData,
    include: {
      region: {
        select: {
          id: true,
          code: true,
          name: true,
        },
      },
    },
  });

  return {
    id: item.id,
    code: item.code,
    number: item.number,
    type: item.type,
    status: item.status,
    documentSubType: item.documentSubType,
    year: item.year,
    regionId: item.regionId,
    regionCode: item.region.code,
    regionName: item.region.name,
    description: item.description,
    validFrom: formatDate(item.validFrom),
    validUntil: formatDate(item.validUntil),
    matchCount: item.matchCount,
    lastMatchedAt: formatDate(item.lastMatchedAt),
    isActive: item.isActive,
    createdById: item.createdById,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

/**
 * 刪除 Reference Number（軟刪除）
 *
 * @param id - Reference Number ID
 * @throws Error - 記錄不存在
 */
export async function deleteReferenceNumber(id: string): Promise<void> {
  // 檢查記錄是否存在
  const existing = await prisma.referenceNumber.findUnique({
    where: { id },
  });

  if (!existing) {
    throw new Error('Reference Number 不存在');
  }

  // 軟刪除
  await prisma.referenceNumber.update({
    where: { id },
    data: { isActive: false },
  });
}

/**
 * 檢查 Reference Number 是否存在
 *
 * @param id - Reference Number ID
 * @returns 是否存在
 */
export async function referenceNumberExists(id: string): Promise<boolean> {
  const count = await prisma.referenceNumber.count({
    where: { id },
  });
  return count > 0;
}

// ============================================================================
// Import (Story 20.4)
// ============================================================================

/** SI-5：分批交易的每批筆數（平衡交易時長與可靠性） */
const IMPORT_BATCH_SIZE = 200;

/**
 * SI-4：匯入跳過/失敗的原因分類
 * - DUPLICATE_EXISTING：記錄已存在且未啟用覆蓋
 * - REGION_NOT_FOUND：地區代碼不存在
 * - VALIDATION_FAILED：資料驗證失敗或其他寫入錯誤
 */
export type ImportSkipReason =
  | 'DUPLICATE_EXISTING'
  | 'REGION_NOT_FOUND'
  | 'VALIDATION_FAILED';

/**
 * SI-4：帶原因分類的匯入單筆錯誤
 */
class ImportItemError extends Error {
  constructor(
    public reason: ImportSkipReason,
    message: string
  ) {
    super(message);
    this.name = 'ImportItemError';
  }
}

/**
 * 導入結果統計
 */
export interface ImportResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: Array<{ index: number; error: string }>;
  /** SI-4：跳過/失敗的原因明細（相容擴充） */
  skippedDetails: Array<{
    index: number;
    reason: ImportSkipReason;
    message: string;
  }>;
}

/**
 * 批次導入 Reference Numbers
 *
 * @description
 *   使用 code 匹配現有記錄，regionCode 關聯地區。
 *   支援 overwriteExisting（覆蓋）和 skipInvalid（跳過無效）選項。
 *   skipInvalid = false 時，遇到錯誤整批失敗。
 *
 * @param input - 導入請求資料
 * @param createdById - 建立者 ID
 * @returns 導入結果統計
 */
export async function importReferenceNumbers(
  input: ImportReferenceNumbersInput,
  createdById: string
): Promise<ImportResult> {
  const { items, options } = input;
  const { overwriteExisting, skipInvalid } = options;

  const result: ImportResult = {
    imported: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    skippedDetails: [],
  };

  // 預先載入所有 region 代碼映射，避免 N+1 查詢
  const regions = await prisma.region.findMany({
    select: { id: true, code: true },
  });
  const regionMap = new Map(
    regions.map((r) => [r.code.toUpperCase(), r.id])
  );

  // SI-6：一次撈出既有 code 至記憶體集合，生成流水號時在記憶體檢查唯一性，
  // 避免逐筆 findUnique 造成的 N+1 查詢
  const existingCodeRows = await prisma.referenceNumber.findMany({
    select: { code: true },
  });
  const usedCodes = new Set(existingCodeRows.map((r) => r.code));

  // 單筆處理邏輯（db 可為 prisma 或交易 client tx）
  // 拋出 ImportItemError（帶原因）或其他錯誤；由呼叫端依 skipInvalid 決定容錯或中止
  const processItem = async (
    db: Prisma.TransactionClient,
    item: ImportReferenceNumbersInput['items'][number],
    index: number
  ): Promise<void> => {
    // 查找 region
    const regionId = regionMap.get(item.regionCode.toUpperCase());
    if (!regionId) {
      throw new ImportItemError(
        'REGION_NOT_FOUND',
        `地區代碼 ${item.regionCode} 不存在`
      );
    }

    // 檢查是否已存在（優先 by code，其次唯一約束）
    let existing = null;
    if (item.code) {
      existing = await db.referenceNumber.findUnique({
        where: { code: item.code },
      });
    }

    if (!existing) {
      existing = await db.referenceNumber.findFirst({
        where: {
          number: item.number,
          type: item.type,
          year: item.year,
          regionId,
        },
      });
    }

    if (existing) {
      if (overwriteExisting) {
        await db.referenceNumber.update({
          where: { id: existing.id },
          data: {
            number: item.number,
            type: item.type,
            documentSubType: item.documentSubType ?? null,
            year: item.year,
            regionId,
            description: item.description ?? null,
            validFrom: item.validFrom ? new Date(item.validFrom) : null,
            validUntil: item.validUntil ? new Date(item.validUntil) : null,
            isActive: item.isActive,
          },
        });
        result.updated++;
      } else {
        result.skipped++;
        result.skippedDetails.push({
          index,
          reason: 'DUPLICATE_EXISTING',
          message: '記錄已存在且未啟用覆蓋',
        });
      }
    } else {
      // 生成或使用提供的 code（記憶體集合確保唯一）
      let code: string;
      if (item.code) {
        code = item.code;
        usedCodes.add(code);
      } else {
        code = generateUniqueCodeInMemory(item.year, item.regionCode, usedCodes);
      }

      await db.referenceNumber.create({
        data: {
          code,
          number: item.number,
          type: item.type,
          documentSubType: item.documentSubType ?? null,
          year: item.year,
          regionId,
          description: item.description ?? null,
          validFrom: item.validFrom ? new Date(item.validFrom) : null,
          validUntil: item.validUntil ? new Date(item.validUntil) : null,
          isActive: item.isActive,
          createdById,
        },
      });
      result.imported++;
    }
  };

  if (skipInvalid) {
    // SI-5（容錯模式）：逐筆獨立寫入，不使用交易。
    // 單筆錯誤（含資料庫約束衝突）只影響該筆，其餘照常寫入。
    // 註：容錯與「批次原子性」語意互斥——若包在單一交易內，PostgreSQL 交易一旦
    // 因某筆出錯進入 aborted 狀態，同批後續操作都會失敗，故此模式刻意不包交易。
    for (let i = 0; i < items.length; i++) {
      try {
        await processItem(prisma, items[i], i);
      } catch (error) {
        const reason: ImportSkipReason =
          error instanceof ImportItemError ? error.reason : 'VALIDATION_FAILED';
        const message = error instanceof Error ? error.message : '未知錯誤';
        result.errors.push({ index: i, error: message });
        result.skippedDetails.push({ index: i, reason, message });
        result.skipped++;
      }
    }
  } else {
    // SI-5（嚴格模式）：分批交易，批次內全有或全無。
    // 任一筆失敗即拋出 → 該批 rollback 並中止整個匯入
    // （已提交的前序批次保留，可從失敗點續傳）。
    for (
      let batchStart = 0;
      batchStart < items.length;
      batchStart += IMPORT_BATCH_SIZE
    ) {
      const batchEnd = Math.min(batchStart + IMPORT_BATCH_SIZE, items.length);

      await prisma.$transaction(
        async (tx) => {
          for (let i = batchStart; i < batchEnd; i++) {
            try {
              await processItem(tx, items[i], i);
            } catch (error) {
              throw new Error(
                `導入第 ${i + 1} 筆時失敗：${
                  error instanceof Error ? error.message : '未知錯誤'
                }`
              );
            }
          }
        },
        { timeout: 30000, maxWait: 10000 }
      );
    }
  }

  return result;
}

// ============================================================================
// Export (Story 20.4)
// ============================================================================

/**
 * 導出項目結構
 */
export interface ExportItem {
  code: string;
  number: string;
  type: string;
  status: string;
  documentSubType: string | null;
  year: number;
  regionCode: string;
  description: string | null;
  validFrom: string | null;
  validUntil: string | null;
  matchCount: number;
  isActive: boolean;
}

/**
 * 導出結果結構
 */
export interface ExportResult {
  exportVersion: string;
  exportedAt: string;
  totalCount: number;
  items: ExportItem[];
}

/**
 * 批次導出 Reference Numbers
 *
 * @description
 *   支援按年份、地區、類型、狀態、啟用狀態篩選。
 *   返回 JSON 格式，使用 code 和 regionCode（而非 ID）。
 *
 * @param query - 篩選條件
 * @returns 導出結果
 */
export async function exportReferenceNumbers(
  query: ExportReferenceNumbersQuery
): Promise<ExportResult> {
  const where: Prisma.ReferenceNumberWhereInput = {};

  if (query.year !== undefined) {
    where.year = query.year;
  }
  if (query.regionId) {
    where.regionId = query.regionId;
  }
  if (query.type) {
    where.type = query.type;
  }
  if (query.status) {
    where.status = query.status;
  }
  if (query.documentSubType) {
    where.documentSubType = query.documentSubType;
  }
  if (query.isActive !== undefined) {
    where.isActive = query.isActive;
  }

  const items = await prisma.referenceNumber.findMany({
    where,
    include: {
      region: { select: { code: true } },
    },
    orderBy: [
      { year: 'desc' },
      { number: 'asc' },
    ],
  });

  return {
    exportVersion: '1.0',
    exportedAt: new Date().toISOString(),
    totalCount: items.length,
    items: items.map((item) => ({
      code: item.code,
      number: item.number,
      type: item.type,
      status: item.status,
      documentSubType: item.documentSubType,
      year: item.year,
      regionCode: item.region.code,
      description: item.description,
      validFrom: formatDate(item.validFrom),
      validUntil: formatDate(item.validUntil),
      matchCount: item.matchCount,
      isActive: item.isActive,
    })),
  };
}

// ============================================================================
// Validate (Story 20.4)
// ============================================================================

/**
 * 驗證匹配結果
 */
export interface ValidateMatch {
  id: string;
  number: string;
  type: string;
  year: number;
  regionCode: string;
  status: string;
}

/**
 * 驗證單一結果
 */
export interface ValidateResultItem {
  value: string;
  found: boolean;
  matches: ValidateMatch[];
}

/**
 * 驗證摘要
 */
export interface ValidateSummary {
  total: number;
  found: number;
  notFound: number;
}

/**
 * 驗證結果
 */
export interface ValidateResult {
  results: ValidateResultItem[];
  summary: ValidateSummary;
}

/**
 * 批次驗證 Reference Numbers
 *
 * @description
 *   檢查號碼列表是否存在於系統中。
 *   匹配成功時自動增加 matchCount 和更新 lastMatchedAt。
 *   只匹配 isActive = true 且 status = ACTIVE 的記錄。
 *
 * @param input - 驗證請求資料
 * @returns 驗證結果（含每個號碼的匹配詳情和摘要）
 */
export async function validateReferenceNumbers(
  input: ValidateReferenceNumbersInput
): Promise<ValidateResult> {
  const { numbers, options } = input;

  const results = await Promise.all(
    numbers.map(async ({ value, type }) => {
      const where: Prisma.ReferenceNumberWhereInput = {
        number: { equals: value, mode: 'insensitive' },
        isActive: true,
        status: 'ACTIVE',
      };

      if (type) {
        where.type = type;
      }
      if (options?.year) {
        where.year = options.year;
      }
      if (options?.regionId) {
        where.regionId = options.regionId;
      }

      const matches = await prisma.referenceNumber.findMany({
        where,
        include: {
          region: { select: { code: true } },
        },
        take: 5, // 限制每個號碼最多 5 個匹配
      });

      // 更新匹配計數
      if (matches.length > 0) {
        await prisma.referenceNumber.updateMany({
          where: { id: { in: matches.map((m) => m.id) } },
          data: {
            matchCount: { increment: 1 },
            lastMatchedAt: new Date(),
          },
        });
      }

      return {
        value,
        found: matches.length > 0,
        matches: matches.map((m) => ({
          id: m.id,
          number: m.number,
          type: m.type,
          year: m.year,
          regionCode: m.region.code,
          status: m.status,
        })),
      };
    })
  );

  const foundCount = results.filter((r) => r.found).length;

  return {
    results,
    summary: {
      total: numbers.length,
      found: foundCount,
      notFound: numbers.length - foundCount,
    },
  };
}

// ============================================================================
// Text Matching (CHANGE-036: DB Substring Matching)
// ============================================================================

/**
 * DB substring 匹配結果
 */
export interface TextMatchResult {
  id: string;
  number: string;
  type: string;
  status: string;
  year: number;
  regionId: string;
  regionCode: string;
  regionName: string;
}

/**
 * 從文字中匹配 Reference Numbers（DB-first substring 模式）
 *
 * @description
 *   使用 PostgreSQL ILIKE 執行 DB-first substring 匹配：
 *   `WHERE :text ILIKE '%' || number || '%'`
 *   匹配結果按 number 長度降序排列，避免短號碼假陽性。
 *   年份範圍為當前年 ±1。
 *
 * @since CHANGE-036
 * @param options - 匹配選項
 * @returns 匹配到的 Reference Numbers
 */
export async function findMatchesInText(options: {
  text: string;
  types: string[];
  regionId?: string;
  maxResults?: number;
}): Promise<TextMatchResult[]> {
  const { text, types, regionId, maxResults = 10 } = options;

  if (!text || types.length === 0) {
    return [];
  }

  const currentYear = new Date().getFullYear();
  const yearFrom = currentYear - 1;
  const yearTo = currentYear + 1;

  const regionFilter = regionId
    ? Prisma.sql`AND rn."region_id" = ${regionId}`
    : Prisma.empty;

  const results = await prisma.$queryRaw<TextMatchResult[]>(Prisma.sql`
    SELECT
      rn."id",
      rn."number",
      rn."type",
      rn."status",
      rn."year",
      rn."region_id" AS "regionId",
      r."code" AS "regionCode",
      r."name" AS "regionName"
    FROM "reference_numbers" rn
    JOIN "regions" r ON rn."region_id" = r."id"
    WHERE ${text} ILIKE '%' || rn."number" || '%'
      AND rn."is_active" = true
      AND rn."status" = 'ACTIVE'
      AND rn."type" IN (${Prisma.join(types)})
      ${regionFilter}
      AND rn."year" BETWEEN ${yearFrom} AND ${yearTo}
    ORDER BY LENGTH(rn."number") DESC
    LIMIT ${maxResults}
  `);

  // 更新匹配計數
  if (results.length > 0) {
    const matchedIds = results.map((r) => r.id);
    await prisma.referenceNumber.updateMany({
      where: { id: { in: matchedIds } },
      data: {
        matchCount: { increment: 1 },
        lastMatchedAt: new Date(),
      },
    });
  }

  return results;
}
