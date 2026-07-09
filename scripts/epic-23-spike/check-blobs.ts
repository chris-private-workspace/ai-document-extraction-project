/**
 * @fileoverview Epic 23 Spike 診斷 — 檢查歷史文件的原檔 blob 是否真的存在於 Azurite
 * @description 交叉比對 DB 的 Document.blobName 與 Azurite 容器實際內容，回報可取回率。
 * @module scripts/epic-23-spike/check-blobs
 * @since Epic 23 - Phase 0 Spike
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';

const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING ?? '';
const STORAGE_CONTAINER = process.env.AZURE_STORAGE_CONTAINER ?? 'documents';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log(`[check-blobs] 容器=${STORAGE_CONTAINER}`);
  const svc = BlobServiceClient.fromConnectionString(STORAGE_CONN);

  // 1. 列出所有容器
  console.log('--- Azurite 容器清單 ---');
  const containers: string[] = [];
  for await (const c of svc.listContainers()) containers.push(c.name);
  console.log(containers.join(', ') || '(無容器)');

  // 2. 列出目標容器實際 blob（前 20）
  const container = svc.getContainerClient(STORAGE_CONTAINER);
  const exists = await container.exists();
  console.log(`\n--- 容器 "${STORAGE_CONTAINER}" 存在=${exists} ---`);
  const actualBlobs: string[] = [];
  if (exists) {
    for await (const b of container.listBlobsFlat()) actualBlobs.push(b.name);
  }
  console.log(`容器內 blob 總數: ${actualBlobs.length}`);
  console.log('前 20 個:');
  console.log(actualBlobs.slice(0, 20).map((n) => '  ' + n).join('\n') || '  (空)');

  // 3. 交叉比對 DB 的 blobName
  const docs = await prisma.document.findMany({ select: { id: true, blobName: true, fileName: true } });
  const actualSet = new Set(actualBlobs);
  let hit = 0;
  const misses: string[] = [];
  for (const d of docs) {
    if (d.blobName && actualSet.has(d.blobName)) hit++;
    else misses.push(d.blobName ?? `(null:${d.id})`);
  }
  console.log(`\n--- DB blobName 交叉比對 ---`);
  console.log(`DB 文件數: ${docs.length}`);
  console.log(`blob 存在: ${hit}`);
  console.log(`blob 缺失: ${misses.length}`);
  console.log('缺失樣本（前 10）:');
  console.log(misses.slice(0, 10).map((n) => '  ' + n).join('\n') || '  (無)');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
