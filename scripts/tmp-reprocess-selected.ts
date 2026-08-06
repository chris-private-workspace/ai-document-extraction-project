/**
 * @fileoverview 重跑 REF_MATCH_FAILED 文件（參考編號補建後的驗證）
 * @description
 *   邏輯沿用 scripts/local-batch-reprocess.ts（= process route 步驟 2-8，免 session），
 *   差別在於**只處理狀態為 REF_MATCH_FAILED 且存在於樣本資料夾的文件**。
 *
 *   🔴 只取 REF_MATCH_FAILED —— 這類文件在參考編號階段即中止，沒有既有提取結果會被
 *      覆蓋。MAPPING_COMPLETED 一律不碰，避免銷毀 extraction_results（唯一約束 + upsert）。
 *   🔴 每個相異檔名只跑一份（重複上傳者取 blob 仍在的最新一份）。
 *   🔴 循序處理，一次一份（FIX-106 教訓：併發批次會使 event loop 飽和）。
 *
 *   對照組：RHEX0185 / RHEX20250410 兩份的編號未補建（檔名疑有誤），**預期仍失敗**。
 *   若這兩份也通過，表示匹配閘並未真正比對，需回頭檢查。
 *
 * @module scripts/tmp-reprocess-selected
 * @since 2026-08-06（export 參考編號補建後的驗證）
 * @lastModified 2026-08-06
 *
 * @usage npx tsx scripts/tmp-reprocess-selected.ts
 */
import * as dotenv from 'dotenv'
import * as fs from 'fs'
import * as path from 'path'

dotenv.config({ path: '.env.local' })
dotenv.config()

import type { ProcessFileInput } from '../src/types/unified-processor'

const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID || 'dev-user-1'
const SRC = 'C:/Users/rci.ChrisLai/Downloads/SCM ai doc sample'
const OUT = 'tmp-reprocess-batch.jsonl'

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.pdf$/i.test(e.name)) out.push(p)
  }
  return out
}
const norm = (f: string) =>
  f.replace(/\.pdf$/i, '').replace(/\s*\(\d+\)\s*$/, '').replace(/\s+\d+$/, '').replace(/\s+/g, ' ').trim().toLowerCase()

async function main() {
  const { default: prisma } = await import('../src/lib/prisma')
  const { downloadBlob } = await import('../src/lib/azure-blob')
  const { getUnifiedDocumentProcessor } = await import('../src/services/unified-processor')
  const { persistProcessingResult } = await import(
    '../src/services/processing-result-persistence.service'
  )
  const { BlobServiceClient } = await import('@azure/storage-blob')

  // blob 清單（避免逐份 exists 查詢）
  const svc = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING!)
  const container = svc.getContainerClient(process.env.AZURE_STORAGE_CONTAINER || 'documents')
  const blobs = new Set<string>()
  for await (const b of container.listBlobsFlat()) blobs.add(b.name)

  const srcSet = new Set(walk(SRC).map((f) => norm(path.basename(f))))

  const failed = await prisma.document.findMany({
    where: { status: 'REF_MATCH_FAILED' },
    select: { id: true, fileName: true, blobName: true, fileType: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })

  // 每個相異檔名取一份，優先 blob 仍在者
  const byName = new Map<string, (typeof failed)[number]>()
  for (const d of failed) {
    const k = norm(d.fileName)
    if (!srcSet.has(k)) continue
    const cur = byName.get(k)
    const hasBlob = d.blobName && blobs.has(d.blobName)
    if (!cur) { if (hasBlob) byName.set(k, d) }
    else if (hasBlob && !(cur.blobName && blobs.has(cur.blobName))) byName.set(k, d)
  }
  const picked = [...byName.values()]

  console.log(`REF_MATCH_FAILED 總筆數      ${failed.length}`)
  console.log(`其中屬樣本資料夾且 blob 仍在   ${picked.length}  ← 本次重跑對象\n`)

  const stream = fs.createWriteStream(OUT, { flags: 'a' })
  const startedAll = Date.now()
  let ok = 0, stillFailed = 0, errored = 0

  for (let i = 0; i < picked.length; i++) {
    const doc = picked[i]
    const tag = `[${i + 1}/${picked.length}] ${doc.fileName.slice(0, 46)}`
    try {
      const fileBuffer = await downloadBlob(doc.blobName)
      const input: ProcessFileInput = {
        fileId: doc.id,
        fileName: doc.fileName,
        fileBuffer,
        mimeType: doc.fileType,
        userId: SYSTEM_USER_ID,
      }
      const started = Date.now()
      const result = await getUnifiedDocumentProcessor().processFile(input, { forceV3: true })
      await persistProcessingResult({ documentId: doc.id, result, userId: SYSTEM_USER_ID })

      const after = await prisma.document.findUnique({
        where: { id: doc.id },
        select: { status: true, processingPath: true, errorMessage: true, companyId: true },
      })
      const rec = {
        i: i + 1,
        documentId: doc.id,
        fileName: doc.fileName,
        ms: Date.now() - started,
        statusAfter: after?.status,
        routing: after?.processingPath ?? null,
        confidence: result.overallConfidence ?? null,
        errorAfter: after?.errorMessage ?? null,
      }
      stream.write(JSON.stringify(rec) + '\n')
      if (after?.status === 'MAPPING_COMPLETED') { ok++; console.log(`${tag}  ✓ ${rec.ms}ms → ${rec.statusAfter} ${rec.routing}`) }
      else { stillFailed++; console.log(`${tag}  ⚠ ${rec.ms}ms → ${rec.statusAfter}`) }
    } catch (e) {
      errored++
      const msg = e instanceof Error ? e.message : String(e)
      stream.write(JSON.stringify({ i: i + 1, documentId: doc.id, fileName: doc.fileName, error: msg }) + '\n')
      console.error(`${tag}  ✗ ${msg.slice(0, 90)}`)
    }
  }

  stream.end()
  const mins = ((Date.now() - startedAll) / 60000).toFixed(1)
  console.log(`\n=== 完成 ===`)
  console.log(`  轉為 MAPPING_COMPLETED   ${ok}`)
  console.log(`  仍未完成                 ${stillFailed}   ← 預期含 RHEX0185 / RHEX20250410 兩份`)
  console.log(`  執行錯誤                 ${errored}`)
  console.log(`  總耗時                   ${mins} 分鐘`)
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
