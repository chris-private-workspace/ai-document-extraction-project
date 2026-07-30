/**
 * @fileoverview CHANGE-113：清掉舊列並重跑模板匹配（端到端驗收用）
 * @description
 *   `autoTemplateMatchingService.autoMatch` 對已匹配的文件會直接短路回傳既有
 *   實例（見該服務 `if (document.templateInstanceId)`），因此重新提取之後模板列
 *   不會跟著更新。驗收要看新的分組如何落到列上，必須先解除既有匹配。
 *
 *   ⚠️ 這支腳本會**刪除**該實例中屬於此文件的列。刪除前先把現況寫成快照檔
 *   （不可逆資料操作前留還原依據 —— 本專案的模板匹配沒有 audit/rollback）。
 *
 *   用法：
 *     npx tsx scripts/change-113/rematch-document.ts <檔名前綴> <快照輸出路徑> [實例ID]
 *
 *   給了實例 ID 就直接呼叫匹配引擎 —— 手動建立的實例沒有「預設模板」配置，
 *   走 autoMatch 會停在「沒有配置預設模版」。
 *
 * @module scripts/change-113/rematch-document
 * @since CHANGE-113 階段一
 * @lastModified 2026-07-29
 */
import 'dotenv/config'
import { writeFileSync } from 'node:fs'

const FILE_NAME_PREFIX = process.argv[2]
const SNAPSHOT_PATH = process.argv[3]
const INSTANCE_ID = process.argv[4]

async function main(): Promise<void> {
  if (!FILE_NAME_PREFIX || !SNAPSHOT_PATH) {
    throw new Error('用法：npx tsx rematch-document.ts <檔名前綴> <快照輸出路徑>')
  }

  const { default: prisma } = await import('@/lib/prisma')
  const { autoTemplateMatchingService } = await import(
    '@/services/auto-template-matching.service'
  )
  const { templateMatchingEngineService } = await import(
    '@/services/template-matching-engine.service'
  )

  const document = await prisma.document.findFirst({
    where: { fileName: { startsWith: FILE_NAME_PREFIX } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, fileName: true, companyId: true, templateInstanceId: true },
  })
  if (!document) throw new Error(`找不到檔名以 ${FILE_NAME_PREFIX} 開頭的文件`)

  console.log(`文件：${document.fileName}`)
  console.log(`  documentId = ${document.id}`)
  const targetInstanceId = INSTANCE_ID ?? document.templateInstanceId
  console.log(`  既有實例   = ${document.templateInstanceId ?? '(無)'}`)
  console.log(`  目標實例   = ${targetInstanceId ?? '(無)'}`)

  if (targetInstanceId) {
    const rows = await prisma.templateInstanceRow.findMany({
      where: {
        templateInstanceId: targetInstanceId,
        sourceDocumentIds: { has: document.id },
      },
    })

    writeFileSync(
      SNAPSHOT_PATH,
      JSON.stringify({ documentId: document.id, instanceId: targetInstanceId, rows }, null, 2)
    )
    console.log(`  已快照 ${rows.length} 列 → ${SNAPSHOT_PATH}`)

    const deleted = await prisma.templateInstanceRow.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    })
    console.log(`  已刪除 ${deleted.count} 列`)

    if (document.templateInstanceId) {
      await prisma.document.update({
        where: { id: document.id },
        data: { templateInstanceId: null, templateMatchedAt: null },
      })
      console.log('  已解除既有匹配')
    }
  }

  if (INSTANCE_ID) {
    // 前一輪跑完會自動完成（tryAutoComplete），COMPLETED 的實例不接受新資料
    const instance = await prisma.templateInstance.update({
      where: { id: INSTANCE_ID },
      data: { status: 'DRAFT' },
      select: { status: true },
    })
    console.log(`  實例狀態已重設為 ${instance.status}`)

    // 直接呼叫匹配引擎（手動建立的實例沒有預設模板配置，autoMatch 走不到）
    const result = await templateMatchingEngineService.matchDocuments({
      documentIds: [document.id],
      templateInstanceId: INSTANCE_ID,
      options: { companyId: document.companyId ?? undefined },
    })
    console.log(`\n重新匹配（直接呼叫引擎）：${JSON.stringify(result, null, 2)}`)
    await prisma.document.update({
      where: { id: document.id },
      data: { templateInstanceId: INSTANCE_ID, templateMatchedAt: new Date() },
    })
  } else {
    const match = await autoTemplateMatchingService.autoMatch(document.id)
    console.log(
      `\n重新匹配：success=${match.success} instance=${match.templateInstanceId ?? '(無)'}${
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
