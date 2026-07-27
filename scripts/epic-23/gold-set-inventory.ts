/**
 * @fileoverview Epic 23 OQ-A — gold set 可標註素材盤點（唯讀）
 * @description
 *   回答「gold set 能有多大、涵蓋多廣」——這是 OQ-A（來源與規模）的前置事實。
 *
 *   盤點口徑：一份文件要能進 gold set，必須同時滿足
 *     1. `ExtractionResult` 為 COMPLETED 且有 stage 3 結果（有東西可比對）
 *     2. `Document.blobName` 存在**且 blob 實際取得到**（標註者要看得到原始發票）
 *
 *   第 2 點是關鍵：2026-07-27 的 spike 取樣中 5 份有 3 份 blob 回 404，
 *   本地 Azurite 的實際可用量遠低於 DB 記錄數，不實際探測會高估規模。
 *
 *   ⚠️ 唯讀：不寫 DB、不呼叫任何 LLM。
 *   ⚠️ 主控台只輸出彙總；含檔名的明細只寫 scratchpad，不進 repo。
 *
 * @module scripts/epic-23/gold-set-inventory
 * @since Epic 23 - OQ-A
 *
 * @usage
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/epic-23/gold-set-inventory.ts
 *   環境變數：
 *     GOLD_OUT_DIR   明細輸出目錄（預設 scratchpad）
 *     GOLD_NO_BLOB   設為 '1' 則跳過 blob 探測（只看 DB 記錄，快但會高估）
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import * as fs from 'fs';
import * as path from 'path';

const OUT_DIR = process.env.GOLD_OUT_DIR ?? path.resolve('.', 'tmp-gold-set-inventory');
const SKIP_BLOB = process.env.GOLD_NO_BLOB === '1';
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING ?? '';
const STORAGE_CONTAINER = process.env.AZURE_STORAGE_CONTAINER ?? 'documents';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

interface Candidate {
  documentId: string;
  fileName: string;
  companyId: string | null;
  companyName: string | null;
  documentFormatId: string | null;
  processingPath: string | null;
  extractionVersion: string | null;
  /** stage 3 回傳的欄位數（標註工作量的代理指標） */
  fieldCount: number;
  lineItemCount: number;
  blobName: string | null;
  blobAvailable: boolean | null; // null = 未探測
}

/** 計算 stage 3 結果的欄位數 / 行項目數（僅計數，不取值） */
function countStage3(raw: unknown): { fieldCount: number; lineItemCount: number } {
  if (!raw || typeof raw !== 'object') return { fieldCount: 0, lineItemCount: 0 };
  const rec = raw as Record<string, unknown>;
  const fields = rec.fields;
  const lineItems = rec.lineItems;
  return {
    fieldCount: fields && typeof fields === 'object' ? Object.keys(fields).length : 0,
    lineItemCount: Array.isArray(lineItems) ? lineItems.length : 0,
  };
}

/** 從 stage 2 結果取格式 id（欄位名在不同版本間可能不同，逐一嘗試） */
function extractFormatId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  for (const key of ['formatId', 'documentFormatId', 'matchedFormatId']) {
    const v = rec[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/** 逐筆探測 blob 是否真的取得到（`exists()` 為輕量呼叫，不下載內容） */
async function probeBlobs(candidates: Candidate[]): Promise<void> {
  if (SKIP_BLOB) return;
  if (!STORAGE_CONN) {
    console.warn('[gold] 缺 AZURE_STORAGE_CONNECTION_STRING → 跳過 blob 探測（規模數字會高估）');
    return;
  }
  const container = BlobServiceClient.fromConnectionString(STORAGE_CONN).getContainerClient(
    STORAGE_CONTAINER,
  );
  let done = 0;
  for (const c of candidates) {
    if (!c.blobName) {
      c.blobAvailable = false;
      continue;
    }
    try {
      c.blobAvailable = await container.getBlockBlobClient(c.blobName).exists();
    } catch {
      c.blobAvailable = false;
    }
    done++;
    if (done % 20 === 0) process.stdout.write(`[gold] blob 探測 ${done}/${candidates.length}\r`);
  }
  process.stdout.write('\n');
}

/** 依 key 分組計數，輸出由多到少 */
function groupCount<T>(rows: T[], key: (r: T) => string): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  console.log('[gold] OQ-A 素材盤點開始（唯讀）');

  const rows = await prisma.extractionResult.findMany({
    where: { status: 'COMPLETED' },
    select: {
      companyId: true,
      extractionVersion: true,
      stage3Result: true,
      // 格式沒有 Document 上的外鍵，資訊在 stage 2 結果的 JSON 內
      stage2Result: true,
      document: {
        select: {
          id: true,
          fileName: true,
          blobName: true,
          processingPath: true,
        },
      },
    },
  });

  const companies = await prisma.company.findMany({ select: { id: true, name: true } });
  const companyName = new Map(companies.map((c) => [c.id, c.name]));

  const candidates: Candidate[] = [];
  for (const r of rows) {
    const d = r.document;
    if (!d) continue;
    const { fieldCount, lineItemCount } = countStage3(r.stage3Result);
    candidates.push({
      documentId: d.id,
      fileName: d.fileName,
      companyId: r.companyId,
      companyName: r.companyId ? (companyName.get(r.companyId) ?? null) : null,
      documentFormatId: extractFormatId(r.stage2Result),
      processingPath: d.processingPath,
      extractionVersion: r.extractionVersion,
      fieldCount,
      lineItemCount,
      blobName: d.blobName,
      blobAvailable: null,
    });
  }

  console.log(`[gold] COMPLETED 提取結果：${rows.length} 筆 → 有文件關聯：${candidates.length} 筆`);

  await probeBlobs(candidates);

  const withStage3 = candidates.filter((c) => c.fieldCount > 0);
  const annotatable = withStage3.filter((c) => c.blobAvailable !== false);

  // ---- 彙總（主控台只印聚合數字，不印檔名）----
  console.log('\n===== 可標註素材彙總 =====');
  console.log(
    JSON.stringify(
      {
        提取結果_COMPLETED: rows.length,
        有文件關聯: candidates.length,
        有stage3欄位: withStage3.length,
        blob實際可取得: SKIP_BLOB ? '未探測' : annotatable.length,
        blob遺失: SKIP_BLOB ? '未探測' : withStage3.length - annotatable.length,
        涵蓋公司數: new Set(annotatable.map((c) => c.companyId ?? 'none')).size,
        涵蓋格式數: new Set(annotatable.map((c) => c.documentFormatId ?? 'none')).size,
        欄位數_中位數: (() => {
          const s = annotatable.map((c) => c.fieldCount).sort((a, b) => a - b);
          return s.length ? s[Math.floor(s.length / 2)] : 0;
        })(),
        總欄位數_標註工作量: annotatable.reduce((n, c) => n + c.fieldCount, 0),
      },
      null,
      2,
    ),
  );

  console.log('\n--- 依公司分佈（可標註者）---');
  for (const [name, n] of groupCount(annotatable, (c) => c.companyName ?? '(無公司)')) {
    console.log(`  ${n.toString().padStart(4)}  ${name}`);
  }

  console.log('\n--- 依處理路徑分佈（可標註者）---');
  for (const [p, n] of groupCount(annotatable, (c) => c.processingPath ?? '(無)')) {
    console.log(`  ${n.toString().padStart(4)}  ${p}`);
  }

  console.log('\n--- 依提取版本分佈（可標註者）---');
  for (const [v, n] of groupCount(annotatable, (c) => c.extractionVersion ?? '(無)')) {
    console.log(`  ${n.toString().padStart(4)}  ${v}`);
  }

  // ---- 明細（含檔名）只寫檔 ----
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'gold-set-candidates.json');
  fs.writeFileSync(outPath, JSON.stringify({ annotatable, all: candidates }, null, 2), 'utf-8');
  console.log(`\n[gold] 明細（含檔名）寫入：${outPath}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('[gold] 失敗:', e);
  await prisma.$disconnect();
  process.exit(1);
});
