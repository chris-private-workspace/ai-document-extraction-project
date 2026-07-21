/**
 * @fileoverview 批次重跑後的唯讀覆核：狀態分佈、isNewFormat 分佈、失敗文件詳情
 * @module scripts/local-check-reprocess-result
 * @since 2026-07-21（批次重跑任務）
 * @lastModified 2026-07-21
 */
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

const FAILED_IDS = [
  '637859a9-8c22-4e52-a77b-d3394d4e19f7',
  '15558818-372d-4e41-82e8-3e279e07e2a1',
  '7a0d9dcc-d059-4966-a624-4f42a337e698',
  '8ee843d5-b4fa-460c-bf55-04c5d5fb5d7b',
  '2e932bc5-a862-4b0f-a2de-030c85cb47e7',
  'b0858839-86ef-446e-a370-94309812f803',
]

async function main() {
  const { default: prisma } = await import('../src/lib/prisma')

  const byStatus = await prisma.document.groupBy({ by: ['status'], _count: { id: true } })
  console.log('=== 重跑後文件狀態分佈 ===')
  byStatus
    .sort((a, b) => b._count.id - a._count.id)
    .forEach((r) => console.log(`  ${r.status}  ${r._count.id}`))

  const results = await prisma.extractionResult.findMany({ select: { stage2Result: true } })
  let isNew = 0
  let notNew = 0
  let other = 0
  for (const r of results) {
    const s2 = r.stage2Result as { isNewFormat?: boolean } | null
    if (s2?.isNewFormat === true) isNew++
    else if (s2?.isNewFormat === false) notNew++
    else other++
  }
  console.log(`\n=== 重跑後 isNewFormat 分佈：true=${isNew} false=${notNew} 缺值=${other} ===`)

  console.log('\n=== success:false 的 6 份文件現況 ===')
  const failedDocs = await prisma.document.findMany({
    where: { id: { in: FAILED_IDS } },
    select: { id: true, fileName: true, status: true, errorMessage: true },
  })
  failedDocs.forEach((d) =>
    console.log(`  ${d.fileName} [${d.id.slice(0, 8)}]\n    狀態=${d.status} 錯誤=${d.errorMessage ?? '(無)'}`)
  )

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exitCode = 1
})
