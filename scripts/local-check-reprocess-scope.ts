/**
 * @fileoverview 批次重跑前的唯讀盤點：文件狀態分佈、公司分佈、Stage 2 prompt 版本、CEVA 格式
 * @description 僅 SELECT，不寫入。輸出決定批次重跑的範圍與基準。
 * @module scripts/local-check-reprocess-scope
 * @since 2026-07-21（批次重跑任務）
 * @lastModified 2026-07-21
 */
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

async function main() {
  const { default: prisma } = await import('../src/lib/prisma')

  // 1. 文件狀態分佈
  const byStatus = await prisma.document.groupBy({
    by: ['status'],
    _count: { id: true },
  })
  console.log('=== 文件狀態分佈 ===')
  byStatus
    .sort((a, b) => b._count.id - a._count.id)
    .forEach((r) => console.log(`  ${r.status}  ${r._count.id}`))

  // 2. 公司分佈（前 15）
  const byCompany = await prisma.document.groupBy({
    by: ['companyId'],
    _count: { id: true },
  })
  const companies = await prisma.company.findMany({
    where: { id: { in: byCompany.map((r) => r.companyId).filter((x): x is string => !!x) } },
    select: { id: true, name: true },
  })
  const nameMap = new Map(companies.map((c) => [c.id, c.name]))
  console.log('\n=== 公司分佈 ===')
  byCompany
    .sort((a, b) => b._count.id - a._count.id)
    .slice(0, 15)
    .forEach((r) =>
      console.log(`  ${r._count.id}  ${r.companyId ? nameMap.get(r.companyId) || r.companyId : '(無公司)'}`)
    )

  // 3. Stage 2 GLOBAL prompt 版本
  const prompt = await prisma.promptConfig.findFirst({
    where: { promptType: 'STAGE_2_FORMAT_IDENTIFICATION', scope: 'GLOBAL' },
    select: { id: true, version: true, isActive: true, systemPrompt: true },
  })
  console.log('\n=== Stage 2 GLOBAL prompt ===')
  console.log(
    `  id=${prompt?.id} version=${prompt?.version} active=${prompt?.isActive} hasKnownFormatsVar=${prompt?.systemPrompt?.includes('${knownFormats}')}`
  )

  // 4. CEVA 主公司格式
  const cevaFormats = await prisma.documentFormat.findMany({
    where: { companyId: '0d02b680-165b-4cfd-8c1b-7ebfa6da8424' },
    select: { id: true, name: true, documentSubtype: true },
  })
  console.log('\n=== CEVA 主公司格式（本地） ===')
  cevaFormats.forEach((f) => console.log(`  ${f.id} | ${f.documentSubtype} | ${f.name}`))

  // 5. 目前 isNewFormat 分佈（重跑前基準）
  const results = await prisma.extractionResult.findMany({
    select: { stage2Result: true },
    where: { stage2Result: { not: undefined } },
  })
  let isNew = 0
  let notNew = 0
  let noStage2 = 0
  for (const r of results) {
    const s2 = r.stage2Result as { isNewFormat?: boolean } | null
    if (!s2 || s2.isNewFormat === undefined) noStage2++
    else if (s2.isNewFormat) isNew++
    else notNew++
  }
  console.log('\n=== 重跑前 isNewFormat 基準（extraction_results） ===')
  console.log(`  isNewFormat=true: ${isNew} | false: ${notNew} | 無資料: ${noStage2}`)

  // 6. 可重跑文件總數（依 process route 的 PROCESSABLE_STATUSES）
  const processable = await prisma.document.count({
    where: {
      status: {
        in: ['UPLOADED', 'OCR_COMPLETED', 'OCR_FAILED', 'REF_MATCH_FAILED', 'MAPPING_COMPLETED'],
      },
    },
  })
  const total = await prisma.document.count()
  console.log(`\n=== 可重跑 / 總數：${processable} / ${total} ===`)

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exitCode = 1
})
