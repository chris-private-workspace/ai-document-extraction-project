/**
 * @fileoverview CHANGE-113：重新處理單一文件並重跑模板匹配（端到端驗收用）
 * @description
 *   等同 `POST /api/documents/[id]/process` 的處理流程，但不經過 HTTP 與認證 ——
 *   驗收要看的是提取管線本身的產出，不該被 session 取得方式拖住。
 *
 *   步驟與該路由一致：下載 blob → UnifiedDocumentProcessor → 持久化 →
 *   自動模板匹配。差別只在此處**等待**匹配完成（路由是 fire-and-forget），
 *   否則腳本會在匹配寫入前就結束。
 *
 *   ⚠️ 這支腳本會**寫入**：文件狀態、ExtractionResult、模板實例列。
 *   僅用於重跑本來就要重跑的驗收文件。
 *
 *   用法：
 *     npx tsx scripts/change-113/reprocess-document.ts <檔名前綴>
 *
 * @module scripts/change-113/reprocess-document
 * @since CHANGE-113 階段一
 * @lastModified 2026-07-29
 */
import 'dotenv/config'

const FILE_NAME_PREFIX = process.argv[2]

async function main(): Promise<void> {
  if (!FILE_NAME_PREFIX) {
    throw new Error('用法：npx tsx reprocess-document.ts <檔名前綴>')
  }

  // 動態 import：src/ 模組在頂層 import 會早於 dotenv 生效，Prisma 會以 undefined
  // 連線字串建 pool，錯誤訊息還是空的（見 memory feedback_script_dotenv_dynamic_import）
  const { default: prisma } = await import('@/lib/prisma')
  const { downloadBlob } = await import('@/lib/azure-blob')
  const { getUnifiedDocumentProcessor } = await import('@/services/unified-processor')
  const { persistProcessingResult } = await import(
    '@/services/processing-result-persistence.service'
  )
  const { autoTemplateMatchingService } = await import(
    '@/services/auto-template-matching.service'
  )

  const document = await prisma.document.findFirst({
    where: { fileName: { startsWith: FILE_NAME_PREFIX } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      blobName: true,
      fileName: true,
      fileType: true,
      status: true,
      uploadedBy: true,
    },
  })

  if (!document) throw new Error(`找不到檔名以 ${FILE_NAME_PREFIX} 開頭的文件`)

  console.log(`文件：${document.fileName}`)
  console.log(`  documentId = ${document.id}`)
  console.log(`  目前狀態   = ${document.status}`)

  const fileBuffer = await downloadBlob(document.blobName)
  console.log(`  已下載 ${fileBuffer.length} bytes`)

  const processor = getUnifiedDocumentProcessor()
  const result = await processor.processFile(
    {
      fileId: document.id,
      fileName: document.fileName,
      fileBuffer,
      mimeType: document.fileType,
      userId: document.uploadedBy,
    },
    { forceV3: true }
  )

  console.log(`\n處理結果：success=${result.success} 耗時=${result.totalDurationMs}ms`)
  if (result.error) console.log(`  error: ${result.error}`)
  for (const warning of result.warnings ?? []) console.log(`  ⚠ ${warning}`)

  const persisted = await persistProcessingResult({
    documentId: document.id,
    result,
    userId: document.uploadedBy,
  })
  console.log(`  持久化：狀態=${persisted.documentStatus} 欄位=${persisted.fieldCount}`)

  if (result.success && result.companyId) {
    // 路由是 fire-and-forget；此處等待完成，否則腳本會在寫入前結束
    const match = await autoTemplateMatchingService.autoMatch(document.id)
    console.log(
      `  模板匹配：success=${match.success} instance=${match.templateInstanceId ?? '(無)'}${
        match.error ? ` error=${match.error}` : ''
      }`
    )
  }

  await prisma.$disconnect()
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
})
