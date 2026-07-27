/**
 * @fileoverview FIX-121 驗證：重跑指定文件的統一處理管線並回報 Stage 2 格式辨識結果
 * @description
 *   FIX-121 修改了 Stage 2 GLOBAL prompt（排他性限縮為結構性特徵）與 CEVA 兩個格式的
 *   identificationRules（就地標註可變性）。本腳本重跑指定文件以驗證辨識未回歸。
 *
 *   邏輯照抄 src/app/api/documents/[id]/process/route.ts 的步驟 2-8，
 *   差別只在不做 session 認證（本腳本為本機一次性驗證用，不對外暴露）。
 *
 *   ⚠️ src/ 的模組一律用動態 import：ESM 的 import 會被提升到模組頂端執行，
 *      而 src/lib/prisma.ts 在載入當下就以 process.env.DATABASE_URL 建立連線池 ——
 *      若用靜態 import，dotenv.config() 尚未執行，連線字串為 undefined 而失敗。
 *
 * @module scripts/fix-121-reprocess-ceva
 * @since FIX-121 (2026-07-20)
 * @lastModified 2026-07-20
 *
 * @usage
 *   npx tsx scripts/fix-121-reprocess-ceva.ts <documentId> [documentId...]
 */
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

import type { ProcessFileInput } from '../src/types/unified-processor'

/** 重跑期間掛在處理結果上的系統使用者（沿用 seed 的系統帳號慣例） */
const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID || 'dev-user-1'

async function main() {
  const ids = process.argv.slice(2)
  if (ids.length === 0) {
    console.error('用法：npx tsx scripts/fix-121-reprocess-ceva.ts <documentId> [documentId...]')
    process.exit(1)
  }

  const { default: prisma } = await import('../src/lib/prisma')
  const { downloadBlob } = await import('../src/lib/azure-blob')
  const { getUnifiedDocumentProcessor } = await import('../src/services/unified-processor')
  const { persistProcessingResult } = await import(
    '../src/services/processing-result-persistence.service'
  )

  for (const documentId of ids) {
    try {
      const document = await prisma.document.findUnique({
        where: { id: documentId },
        select: { id: true, blobName: true, fileName: true, fileType: true, status: true },
      })

      if (!document) {
        console.log(`\n✗ ${documentId} — 文件不存在`)
        continue
      }

      console.log(`\n=== ${document.fileName} (${documentId})`)
      console.log(`    重跑前狀態=${document.status}`)

      const fileBuffer = await downloadBlob(document.blobName)

      const input: ProcessFileInput = {
        fileId: document.id,
        fileName: document.fileName,
        fileBuffer,
        mimeType: document.fileType,
        userId: SYSTEM_USER_ID,
      }

      const started = Date.now()
      const result = await getUnifiedDocumentProcessor().processFile(input, { forceV3: true })
      await persistProcessingResult({ documentId: document.id, result, userId: SYSTEM_USER_ID })

      const stage2 = await prisma.extractionResult.findFirst({
        where: { documentId: document.id },
        select: { stage2Result: true },
      })

      console.log(`    耗時=${Date.now() - started}ms 成功=${result.success}`)
      console.log(
        `    整體信心度=${result.overallConfidence ?? 'n/a'} 路由=${result.routingDecision ?? 'n/a'}`
      )
      console.log(`    stage2Result=${JSON.stringify(stage2?.stage2Result)}`)
    } catch (e) {
      console.error(`\n✗ ${documentId} 重跑失敗：`, e instanceof Error ? e.message : e)
    }
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exitCode = 1
})
