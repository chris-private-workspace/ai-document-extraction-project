/**
 * @fileoverview 批次重跑全部文件的統一處理管線（本地環境，新邏輯驗證）
 * @description
 *   FIX-115/121 修好 Stage 2 已知格式清單注入後，既有文件的 stage2Result 仍是舊邏輯
 *   產物（isNewFormat 恆為 true）。本腳本把所有可重跑狀態的文件依統一管線重新處理，
 *   使歷史記錄反映新邏輯。
 *
 *   設計要點：
 *   - 邏輯沿用 scripts/fix-121-reprocess-ceva.ts（= process route 步驟 2-8，免 session）
 *   - 🔴 循序處理，一次一份 —— FIX-106 教訓：併發批次會使 event loop 飽和
 *   - 逐份容錯：單份失敗記錄後繼續，不中斷批次
 *   - 每份記錄重跑前後的 stage2Result 對照，輸出 JSONL 供覆核
 *   - src/ 模組一律動態 import（ESM 提升 vs dotenv 時序，同 fix-121 腳本）
 *
 * @module scripts/local-batch-reprocess
 * @since 2026-07-21（FIX-115/121 批次重跑任務）
 * @lastModified 2026-07-21
 *
 * @usage
 *   npx tsx scripts/local-batch-reprocess.ts [--limit N] [--out path.jsonl]
 */
import * as dotenv from 'dotenv'
import * as fs from 'fs'

dotenv.config({ path: '.env.local' })
dotenv.config()

import type { ProcessFileInput } from '../src/types/unified-processor'

const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID || 'dev-user-1'

/** process route 允許重跑的狀態（src/app/api/documents/[id]/process/route.ts） */
const PROCESSABLE_STATUSES = [
  'UPLOADED',
  'OCR_COMPLETED',
  'OCR_FAILED',
  'REF_MATCH_FAILED',
  'MAPPING_COMPLETED',
] as const

interface Stage2Snapshot {
  formatId?: string
  formatName?: string
  isNewFormat?: boolean
  confidence?: number
}

function pickStage2(s2: unknown): Stage2Snapshot | null {
  if (!s2 || typeof s2 !== 'object') return null
  const o = s2 as Record<string, unknown>
  return {
    formatId: typeof o.formatId === 'string' ? o.formatId : undefined,
    formatName: typeof o.formatName === 'string' ? o.formatName : undefined,
    isNewFormat: typeof o.isNewFormat === 'boolean' ? o.isNewFormat : undefined,
    confidence: typeof o.confidence === 'number' ? o.confidence : undefined,
  }
}

function parseArgs(): { limit: number | null; out: string } {
  const args = process.argv.slice(2)
  let limit: number | null = null
  let out = 'batch-reprocess-results.jsonl'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10)
    else if (args[i] === '--out' && args[i + 1]) out = args[++i]
  }
  return { limit, out }
}

async function main() {
  const { limit, out } = parseArgs()

  const { default: prisma } = await import('../src/lib/prisma')
  const { downloadBlob } = await import('../src/lib/azure-blob')
  const { getUnifiedDocumentProcessor } = await import('../src/services/unified-processor')
  const { persistProcessingResult } = await import(
    '../src/services/processing-result-persistence.service'
  )

  const documents = await prisma.document.findMany({
    where: { status: { in: [...PROCESSABLE_STATUSES] } },
    select: { id: true, blobName: true, fileName: true, fileType: true, status: true },
    orderBy: { createdAt: 'asc' },
    ...(limit ? { take: limit } : {}),
  })

  console.log(`[batch] 待重跑 ${documents.length} 份（limit=${limit ?? '無'}）→ 結果檔 ${out}`)
  const stream = fs.createWriteStream(out, { flags: 'a' })
  const startedAll = Date.now()
  let ok = 0
  let failed = 0

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i]
    const tag = `[${i + 1}/${documents.length}] ${doc.fileName}`
    try {
      // 重跑前 stage2 快照
      const beforeRow = await prisma.extractionResult.findFirst({
        where: { documentId: doc.id },
        select: { stage2Result: true },
      })
      const before = pickStage2(beforeRow?.stage2Result)

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

      const afterRow = await prisma.extractionResult.findFirst({
        where: { documentId: doc.id },
        select: { stage2Result: true },
      })
      const after = pickStage2(afterRow?.stage2Result)

      const record = {
        i: i + 1,
        documentId: doc.id,
        fileName: doc.fileName,
        success: result.success,
        ms: Date.now() - started,
        routing: result.routingDecision ?? null,
        overallConfidence: result.overallConfidence ?? null,
        before,
        after,
      }
      stream.write(JSON.stringify(record) + '\n')
      ok++
      console.log(
        `${tag} ✓ ${record.ms}ms 路由=${record.routing} ` +
          `格式: ${before?.formatName ?? '?'} → ${after?.formatName ?? '?'} ` +
          `isNew: ${before?.isNewFormat} → ${after?.isNewFormat}`
      )
    } catch (e) {
      failed++
      const msg = e instanceof Error ? e.message : String(e)
      stream.write(
        JSON.stringify({ i: i + 1, documentId: doc.id, fileName: doc.fileName, error: msg }) + '\n'
      )
      console.error(`${tag} ✗ ${msg}`)
    }
  }

  stream.end()
  const mins = ((Date.now() - startedAll) / 60000).toFixed(1)
  console.log(`\n[batch] 完成：成功 ${ok} / 失敗 ${failed} / 總耗時 ${mins} 分鐘`)
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exitCode = 1
})
