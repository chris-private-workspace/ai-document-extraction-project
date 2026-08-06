/**
 * @fileoverview 傾印指定文件的 stage1Result 完整內容（唯讀）
 * @description
 *   查明 Stage 1 是否保存了「GPT 從發票讀到的原印法」。
 *   `stage1Result.companyName` 是 resolveCompanyId 匹配後的公司 name，
 *   不是原印法 —— 需確認 aiDetails 或其他欄位是否留有 GPT raw response。
 *
 * @module scripts/tmp-dump-stage1
 * @since 2026-08-06
 * @lastModified 2026-08-06
 *
 * @usage npx tsx scripts/tmp-dump-stage1.ts
 */
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

const TARGETS = [
  'TOLL_RCEX240700_56839.pdf',
  'TOLL_RCEX250018_56933.PDF',
  'TOLL_RHEX250045_03713.pdf',
  'TOLL_RHEX250050_03998.pdf',
]

const line = (s = '') => console.log(s)

async function main() {
  const { default: prisma } = await import('../src/lib/prisma')

  for (const fileName of TARGETS) {
    const doc = await prisma.document.findFirst({
      where: { fileName },
      select: {
        id: true,
        fileName: true,
        companyId: true,
        createdAt: true,
        company: { select: { name: true, nameVariants: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
    line()
    line('='.repeat(100))
    line(fileName)
    line('='.repeat(100))
    if (!doc) {
      line('🔴 查無此文件')
      continue
    }
    line(`documentId   ${doc.id}`)
    line(`掛在公司     ${doc.company?.name ?? '(無)'}`)
    line(`該公司變體   ${JSON.stringify(doc.company?.nameVariants ?? [])}`)

    const er = await prisma.extractionResult.findUnique({
      where: { documentId: doc.id },
      select: { stage1Result: true },
    })
    if (!er?.stage1Result) {
      line('🔴 無 stage1Result')
      continue
    }
    const s1 = er.stage1Result as Record<string, unknown>
    line()
    line(`stage1Result 頂層欄位：${Object.keys(s1).join(', ')}`)
    line()
    // 逐一印出非 aiDetails 的純量欄位
    for (const [k, v] of Object.entries(s1)) {
      if (k === 'aiDetails') continue
      line(`  ${k.padEnd(22)} ${JSON.stringify(v)?.slice(0, 160)}`)
    }
    const ai = s1.aiDetails as Record<string, unknown> | undefined
    if (ai) {
      line()
      line(`  aiDetails 欄位：${Object.keys(ai).join(', ')}`)
      for (const [k, v] of Object.entries(ai)) {
        const s = typeof v === 'string' ? v : JSON.stringify(v)
        line(`    ${k.padEnd(20)} ${String(s).slice(0, 600)}`)
      }
    }
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
