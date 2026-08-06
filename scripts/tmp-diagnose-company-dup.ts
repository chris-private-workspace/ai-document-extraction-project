/**
 * @fileoverview 診斷：Stage 1 為何把同一家公司認成兩家（唯讀）
 * @description
 *   對兩組已知重複公司，實測 resolveCompanyId 各關卡的判定結果：
 *   normalizeCompanyName → levenshteinSimilarity → classifyCompanyMatch，
 *   並列出 DB 實況（status / source / suspectedDuplicateOfId / nameVariants）。
 *
 *   目的是回答「三種補救方式為何都不治本」——治本點在哪一關失守。
 *
 * @module scripts/tmp-diagnose-company-dup
 * @since 2026-08-06
 * @lastModified 2026-08-06
 *
 * @usage npx tsx scripts/tmp-diagnose-company-dup.ts
 */
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

const line = (s = '') => console.log(s)
const hr = (t: string) => {
  line()
  line('='.repeat(100))
  line(t)
  line('='.repeat(100))
}

const PAIRS: Array<{ label: string; existing: string; created: string }> = [
  {
    label: 'Toll',
    existing: 'Toll Global Forwarder Limited',
    created: 'Toll Global Forwarding (Hong Kong) Ltd',
  },
  {
    label: 'RICOH',
    existing: 'RICOH INTERNATIONAL LOGISTICS (HK) LTD.',
    created: 'RICOH INTERNATIONAL (LOGISTICS) (HK) LTD.',
  },
]

const THRESHOLD = 0.85 // COMPANY_NAME_SIMILARITY_THRESHOLD

async function main() {
  const { default: prisma } = await import('../src/lib/prisma')
  const { levenshteinSimilarity, classifyCompanyMatch } = await import(
    '../src/services/similarity'
  )
  const { Stage1CompanyService } = await import(
    '../src/services/extraction-v3/stages/stage-1-company.service'
  )

  // normalizeCompanyName 是 private，用結構型別取出（TS private 僅編譯期）
  const svc = new Stage1CompanyService() as unknown as {
    normalizeCompanyName(n: string): string
  }
  const nz = (n: string) => svc.normalizeCompanyName(n)

  hr('1  正規化實測（normalizeCompanyName）')
  for (const p of PAIRS) {
    const a = nz(p.existing)
    const b = nz(p.created)
    line()
    line(`── ${p.label}`)
    line(`   既有  "${p.existing}"`)
    line(`         → "${a}"`)
    line(`   新建  "${p.created}"`)
    line(`         → "${b}"`)
    line(`   正規化相等？ ${a === b ? '✅ 是' : '🔴 否'}`)
    const sim = levenshteinSimilarity(a, b)
    line(
      `   Levenshtein 相似度 ${sim.toFixed(4)}　閾值 ${THRESHOLD}　→ ${sim >= THRESHOLD ? '✅ 命中 EXACT' : '🔴 未達閾值'}`
    )
    const tier = classifyCompanyMatch(b, a)
    line(`   classifyCompanyMatch(新建, 既有) = ${tier ?? 'null（無關係）'}`)
    line(
      `   ⇒ findDuplicateCompany 結果：${
        a === b || sim >= THRESHOLD
          ? 'EXACT → 配到既有，不會建新公司'
          : tier === 'AUTO'
            ? 'AUTO → 配到既有，不會建新公司'
            : tier === 'GRAY'
              ? 'GRAY → 建 PENDING + 掛疑似重複標記'
              : '🔴 null → JIT 建 ACTIVE 新公司（重複就此產生）'
      }`
    )
  }

  hr('2  資料庫實況（這兩對公司現在長什麼樣）')
  for (const p of PAIRS) {
    for (const [role, name] of [
      ['既有', p.existing],
      ['新建', p.created],
    ] as const) {
      const c = await prisma.company.findFirst({
        where: { name },
        select: {
          id: true,
          name: true,
          status: true,
          source: true,
          suspectedDuplicateOfId: true,
          nameVariants: true,
          createdAt: true,
          _count: {
            select: {
              documents: true,
              templateFieldMappings: true,
              fieldDefinitionSets: true,
            },
          },
        },
      })
      line()
      if (!c) {
        line(`   ${p.label} ${role}：🔴 查無此公司名（"${name}"）`)
        continue
      }
      line(`   ${p.label} ${role}　${c.name}`)
      line(`     id                     ${c.id}`)
      line(`     status                 ${c.status}`)
      line(`     source                 ${c.source}`)
      line(
        `     suspectedDuplicateOfId ${c.suspectedDuplicateOfId ?? '🔴 null（未掛疑似重複標記）'}`
      )
      line(`     createdAt              ${c.createdAt.toISOString().slice(0, 19)}`)
      line(
        `     文件 ${c._count.documents}　映射組 ${c._count.templateFieldMappings}　欄位集 ${c._count.fieldDefinitionSets}`
      )
      line(
        `     nameVariants (${c.nameVariants.length})　${c.nameVariants.slice(0, 6).join(' | ') || '（空）'}`
      )
    }
  }

  hr('3  全庫掃描：還有多少疑似重複公司未被處理')
  const all = await prisma.company.findMany({
    select: {
      id: true,
      name: true,
      status: true,
      source: true,
      suspectedDuplicateOfId: true,
      createdAt: true,
      _count: { select: { documents: true, templateFieldMappings: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  line(`公司總數 ${all.length}`)
  const byStatus = new Map<string, number>()
  const bySource = new Map<string, number>()
  all.forEach((c) => {
    byStatus.set(c.status, (byStatus.get(c.status) || 0) + 1)
    bySource.set(c.source, (bySource.get(c.source) || 0) + 1)
  })
  line(`  status  ${[...byStatus.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`)
  line(`  source  ${[...bySource.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`)
  const flagged = all.filter((c) => c.suspectedDuplicateOfId)
  line(`  已掛 suspectedDuplicateOfId 者：${flagged.length}`)
  flagged.slice(0, 10).forEach((c) =>
    line(`     ${c.status.padEnd(9)} ${c.name.slice(0, 44).padEnd(46)} 文件${c._count.documents}`)
  )

  // 用正規化字串找出「同一家卻分裂成多筆」的族群
  //   🔴 classifyCompanyMatch 回傳字串 'NONE'（非 null），所以判準必須明寫 AUTO/GRAY，
  //      否則 `!tier` 永遠為 false，會把全部 1431 對都印出來（初版即犯此錯）。
  line()
  line('🔴 現行邏輯下仍會分裂成兩筆的公司對（正規化不等、Levenshtein 未達 0.85）：')
  const norms = all.map((c) => ({ ...c, norm: nz(c.name) }))
  const pairsTotal = (norms.length * (norms.length - 1)) / 2
  let scanned = 0
  let hits = 0
  for (let i = 0; i < norms.length; i++) {
    for (let j = i + 1; j < norms.length; j++) {
      const a = norms[i]
      const b = norms[j]
      scanned++
      if (!a.norm || !b.norm) continue
      const sim = levenshteinSimilarity(a.norm, b.norm)
      const tier = classifyCompanyMatch(a.norm, b.norm)
      // 只有會被 Stage 1 判為「同一家」的才不算分裂
      const wouldMerge = a.norm === b.norm || sim >= THRESHOLD || tier === 'AUTO'
      const isSuspect = tier === 'GRAY' || (sim >= 0.75 && sim < THRESHOLD)
      if (wouldMerge || !isSuspect) continue
      hits++
      line(
        `   ${String(tier).padEnd(5)} sim=${sim.toFixed(3)}  ${a.name.slice(0, 38).padEnd(40)}(文件${String(a._count.documents).padStart(3)}, 映射${a._count.templateFieldMappings}, ${a.status})`
      )
      line(
        `   ${' '.repeat(17)}${b.name.slice(0, 38).padEnd(40)}(文件${String(b._count.documents).padStart(3)}, 映射${b._count.templateFieldMappings}, ${b.status})`
      )
    }
  }
  line(`   掃描 ${scanned} 對（應為 ${pairsTotal}）→ 命中 ${hits} 對`)

  hr('4  Toll 兩家的文件實況（判斷是否真為同一法人）')
  for (const p of [PAIRS[0]]) {
    for (const name of [p.existing, p.created]) {
      const c = await prisma.company.findFirst({ where: { name }, select: { id: true, name: true } })
      if (!c) continue
      const cdocs = await prisma.document.findMany({
        where: { companyId: c.id },
        select: { id: true, fileName: true },
        take: 400,
      })
      // 從 extraction_result.stage1Result 取 GPT 實際讀到的公司名
      const ers = await prisma.extractionResult.findMany({
        where: { documentId: { in: cdocs.map((d) => d.id) } },
        select: { documentId: true, stage1Result: true },
      })
      const tally = new Map<string, number>()
      for (const er of ers) {
        const s1 = er.stage1Result as Record<string, unknown> | null
        const nm = (s1?.companyName ?? s1?.matchedKnownCompany ?? '(無)') as string
        tally.set(nm, (tally.get(nm) || 0) + 1)
      }
      line()
      line(`── ${c.name}　文件 ${cdocs.length} 份，有 stage1Result ${ers.length} 份`)
      line(`   發票上 GPT 讀到的公司名分佈：`)
      ;[...tally.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .forEach(([k, v]) => line(`     ${String(v).padStart(4)} × "${k}"`))
      const prefixes = [...new Set(cdocs.map((d) => d.fileName.split('_')[0]))]
      line(`   檔名前綴：${prefixes.slice(0, 6).join(' / ')}`)
    }
  }

  hr('5  人工核對用樣本（Toll 兩家各 2 份，附來源資料夾完整路徑）')
  const fs = await import('fs')
  const path = await import('path')
  const SRC = 'C:/Users/rci.ChrisLai/Downloads/SCM ai doc sample'
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.pdf$/i.test(e.name)) out.push(p)
    }
    return out
  }
  const srcFiles = walk(SRC)
  /** 以檔名（去重複上傳後綴）反查來源檔案完整路徑 */
  const findSrc = (fileName: string): string | null => {
    const base = fileName
      .replace(/\.pdf$/i, '')
      .replace(/\s*\(\d+\)\s*$/, '')
      .replace(/\s+\d+$/, '')
      .trim()
      .toLowerCase()
    const hit = srcFiles.find(
      (f) =>
        path
          .basename(f)
          .replace(/\.pdf$/i, '')
          .replace(/\s*\(\d+\)\s*$/, '')
          .replace(/\s+\d+$/, '')
          .trim()
          .toLowerCase() === base
    )
    return hit ? hit.replace(/\\/g, '/') : null
  }

  const crossover: Array<{ owner: string; gptName: string; fileName: string; src: string | null }> = []
  for (const name of [PAIRS[0].existing, PAIRS[0].created]) {
    const c = await prisma.company.findFirst({ where: { name }, select: { id: true, name: true } })
    if (!c) continue
    const cdocs = await prisma.document.findMany({
      where: { companyId: c.id },
      select: { id: true, fileName: true },
      orderBy: { fileName: 'asc' },
    })
    const ers = await prisma.extractionResult.findMany({
      where: { documentId: { in: cdocs.map((d) => d.id) } },
      select: { documentId: true, stage1Result: true },
    })
    const gptByDoc = new Map<string, string>()
    for (const er of ers) {
      const s1 = er.stage1Result as Record<string, unknown> | null
      gptByDoc.set(er.documentId, (s1?.companyName ?? '(無)') as string)
    }

    const matching = cdocs.filter((d) => gptByDoc.get(d.id) === c.name)
    const differing = cdocs.filter((d) => {
      const g = gptByDoc.get(d.id)
      return g && g !== c.name
    })
    differing.forEach((d) =>
      crossover.push({
        owner: c.name,
        gptName: gptByDoc.get(d.id)!,
        fileName: d.fileName,
        src: findSrc(d.fileName),
      })
    )

    line()
    line(`── 掛在「${c.name}」底下（共 ${cdocs.length} 份，其中 ${matching.length} 份 GPT 讀到同名）`)
    for (const d of matching.slice(0, 2)) {
      const p = findSrc(d.fileName)
      line()
      line(`   檔名        ${d.fileName}`)
      line(`   GPT 讀到    "${gptByDoc.get(d.id)}"`)
      line(`   來源路徑    ${p ?? '🔴 來源資料夾找不到同名檔'}`)
    }
  }

  line()
  line(`🔴 交叉樣本（掛在 A 底下、但 GPT 讀到 B 的名字）共 ${crossover.length} 份 —— 這幾份最能分辨「真混用」還是「讀錯」：`)
  for (const x of crossover) {
    line()
    line(`   檔名        ${x.fileName}`)
    line(`   掛在        ${x.owner}`)
    line(`   GPT 讀到    "${x.gptName}"　← 不一致`)
    line(`   來源路徑    ${x.src ?? '🔴 來源資料夾找不到同名檔'}`)
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
