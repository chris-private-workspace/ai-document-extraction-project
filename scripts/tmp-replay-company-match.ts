/**
 * @fileoverview 重放 Stage 1 公司比對：給定發票上的原印法，看它會命中哪一家（唯讀）
 * @description
 *   `stage1Result` 只保存匹配後的 company.name，不保存 GPT 讀到的原印法，
 *   因此無法從資料回推「為什麼這份文件被判給這家公司」。
 *   本腳本以 resolveCompanyId 的實際查詢條件重放 Step 1 / 2a / 2b，
 *   證明匹配路徑而非推論。
 *
 * @module scripts/tmp-replay-company-match
 * @since 2026-08-06
 * @lastModified 2026-08-06
 *
 * @usage npx tsx scripts/tmp-replay-company-match.ts
 */
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

/** 使用者肉眼從發票讀到的公司名 */
const CANDIDATES = [
  'Toll Global Forwarding (Thailand) Limited',
  'Toll Global Forwarding (Hong Kong) Ltd',
  'Toll Global Forwarding (Hong Kong) Limited',
]

const line = (s = '') => console.log(s)
const hr = (t: string) => {
  line()
  line('='.repeat(100))
  line(t)
  line('='.repeat(100))
}

async function main() {
  const { default: prisma } = await import('../src/lib/prisma')
  const { Stage1CompanyService } = await import(
    '../src/services/extraction-v3/stages/stage-1-company.service'
  )
  const svc = new Stage1CompanyService() as unknown as {
    normalizeCompanyName(n: string): string
  }

  for (const candidate of CANDIDATES) {
    hr(`發票原印法："${candidate}"`)

    // Step 1：matchedKnownCompany（GPT 若回報匹配到已知公司，走 name / nameVariants 精確比對）
    const step1 = await prisma.company.findFirst({
      where: {
        OR: [{ name: candidate }, { nameVariants: { has: candidate } }],
        status: 'ACTIVE',
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    })
    line(
      `  Step 1  (name = 原印法 或 nameVariants 含原印法，限 ACTIVE)`
    )
    line(`          → ${step1 ? `✅ 命中「${step1.name}」　${step1.id}` : '未命中'}`)

    // Step 2a：DB 層 OR —— nameVariants 精確 / name 不分大小寫相等 / name 包含原印法
    const step2a = await prisma.company.findFirst({
      where: {
        status: 'ACTIVE',
        OR: [
          { nameVariants: { has: candidate } },
          { name: { equals: candidate, mode: 'insensitive' } },
          { name: { contains: candidate, mode: 'insensitive' } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    })
    line(`  Step 2a (nameVariants 精確 / name 相等 / name 包含原印法)`)
    line(`          → ${step2a ? `✅ 命中「${step2a.name}」　${step2a.id}` : '未命中'}`)

    // Step 2b：正規化相等
    const norm = svc.normalizeCompanyName(candidate)
    const actives = await prisma.company.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, nameVariants: true },
    })
    const step2b = actives.find((c) =>
      [c.name, ...(c.nameVariants ?? [])].some(
        (n) => svc.normalizeCompanyName(n) === norm
      )
    )
    line(`  Step 2b (正規化後相等；原印法正規化 = "${norm}")`)
    line(`          → ${step2b ? `✅ 命中「${step2b.name}」　${step2b.id}` : '未命中'}`)

    const winner = step1 ?? step2a ?? step2b
    line()
    line(
      `  ⇒ 實際會掛到：${winner ? `「${winner.name}」` : '🔴 無命中 → 走 JIT 建立新公司'}`
    )
    if (winner) {
      const c = await prisma.company.findUnique({
        where: { id: winner.id },
        select: { name: true, nameVariants: true, _count: { select: { templateFieldMappings: true } } },
      })
      line(`     該公司 name         "${c?.name}"`)
      line(`     該公司 nameVariants ${JSON.stringify(c?.nameVariants ?? [])}`)
      line(`     映射組              ${c?._count.templateFieldMappings}`)
      line(
        `     🔴 存進 stage1Result.companyName 的是「${c?.name}」—— 原印法「${candidate}」不會被保存`
      )
    }
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
