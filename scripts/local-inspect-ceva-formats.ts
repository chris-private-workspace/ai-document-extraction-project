/**
 * @fileoverview 唯讀檢視：CEVA 主公司既有格式定義 + 未命中文件的 GPT 版面特徵
 * @description
 *   為「建立 CEVA 第三種版面（清關型）」蒐集依據：
 *     1. 既有兩個 DocumentFormat 的完整定義（identificationRules 寫法作為風格基準）
 *     2. 重跑後 isNewFormat=true 文件的 GPT formatName / formatCharacteristics（歸納共同特徵）
 *   唯讀，不寫入任何資料。
 *
 * @module scripts/local-inspect-ceva-formats
 * @since 2026-07-21（FIX-124 待辦 1）
 * @lastModified 2026-07-21
 *
 * @usage npx tsx scripts/local-inspect-ceva-formats.ts
 */
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

const CEVA_COMPANY_ID = '0d02b680-165b-4cfd-8c1b-7ebfa6da8424'

function parseGptResponse(response: unknown): Record<string, unknown> | null {
  if (typeof response !== 'string') return null
  const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates = [fenced?.[1], response].filter((s): s is string => !!s)
  for (const c of candidates) {
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    try {
      return JSON.parse(c.slice(start, end + 1)) as Record<string, unknown>
    } catch {
      /* 換下一個候選 */
    }
  }
  return null
}

async function main() {
  const { default: prisma } = await import('../src/lib/prisma')

  const company = await prisma.company.findUnique({
    where: { id: CEVA_COMPANY_ID },
    select: { id: true, name: true },
  })
  console.log(`=== 公司 ===\n  ${company?.name} [${company?.id}]`)

  const formats = await prisma.documentFormat.findMany({
    where: { companyId: CEVA_COMPANY_ID },
    select: {
      id: true,
      name: true,
      documentType: true,
      documentSubtype: true,
      identificationRules: true,
      features: true,
      commonTerms: true,
      fileCount: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`\n=== 既有格式（${formats.length} 個）===`)
  for (const f of formats) {
    console.log(`\n--- ${f.name}`)
    console.log(`  id=${f.id} subtype=${f.documentSubtype} fileCount=${f.fileCount}`)
    console.log(`  identificationRules:\n${JSON.stringify(f.identificationRules, null, 2)}`)
    console.log(`  features:\n${JSON.stringify(f.features, null, 2)}`)
    console.log(`  commonTerms: ${JSON.stringify(f.commonTerms)}`)
  }

  // 未命中文件的 GPT 特徵
  const results = await prisma.extractionResult.findMany({
    select: {
      documentId: true,
      stage2Result: true,
      stage2AiDetails: true,
      document: { select: { fileName: true, companyId: true } },
    },
  })

  // 可傳入 documentId 前綴清單指定要看的文件；未傳則列出所有 isNewFormat=true 的 CEVA 文件
  const idPrefixes = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const useIdFilter = idPrefixes.length > 0

  console.log(
    `\n\n=== ${useIdFilter ? `指定的 ${idPrefixes.length} 份文件` : '未命中文件（isNewFormat=true）'} 的 GPT 版面特徵 ===`
  )
  let n = 0
  for (const r of results) {
    const s2 = r.stage2Result as { isNewFormat?: boolean; formatName?: string } | null
    if (useIdFilter) {
      if (!idPrefixes.some((p) => r.documentId.startsWith(p))) continue
    } else {
      if (s2?.isNewFormat !== true) continue
      if (r.document?.companyId !== CEVA_COMPANY_ID) continue
    }

    const parsed = parseGptResponse((r.stage2AiDetails as { response?: unknown } | null)?.response)
    const chars = (parsed?.formatCharacteristics as string[] | undefined) ?? []
    n++
    console.log(`\n[${n}] ${r.document?.fileName} [${r.documentId.slice(0, 8)}]`)
    console.log(`  matchedKnownFormat: ${(parsed?.matchedKnownFormat as string | null) ?? '(null)'}`)
    console.log(`  formatName: ${parsed?.formatName ?? '(無)'}`)
    console.log(`  最終落到: ${s2?.formatName ?? '(無)'} | isNew=${s2?.isNewFormat}`)
    console.log(`  characteristics:`)
    chars.forEach((c) => console.log(`    - ${c}`))
  }
  console.log(`\n  合計 ${n} 份`)

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exitCode = 1
})
