/**
 * @fileoverview 唯讀盤點：已 MERGED 公司名下殘留的關聯資料，以及轉移時的唯一鍵衝突
 * @description
 *   FIX-125 的決策依據。公司合併目前只轉移 documents / extractionResults / mappingRules
 *   三類，其餘 15 類留在已設為 MERGED 的副公司名下（`autoMergeCompanies:499-501` 有明確
 *   註解記錄此決定，假設「副公司設 MERGED 後 inert」）。
 *
 *   本腳本回答三個問題：
 *     1. 實際有多少 MERGED 公司名下還掛著資料？各是哪幾類？
 *     2. 若要轉移 documentFormats，會有多少筆撞上唯一鍵
 *        (companyId, documentType, documentSubtype)？—— 決定 FIX-125 選項 A 的真實代價
 *     3. fieldDefinitionSets / templateFieldMappings 是否也有唯一鍵風險？
 *
 *   唯讀，不寫入任何資料。
 *
 *   🔴 本檔為 tsx 腳本，只能在本地執行。Azure runner 映像不含 scripts/ 與 tsx，
 *      若需在 Azure 盤點，須另寫 prisma/*.js 版本（見 memory：azure-runner-excludes-scripts-tsx）。
 *
 * @module scripts/local-inspect-merged-company-orphans
 * @since 2026-07-21（FIX-125）
 * @lastModified 2026-07-21
 *
 * @usage npx tsx scripts/local-inspect-merged-company-orphans.ts
 */
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

/** Company 的 18 個一對多關聯；前 3 個是目前合併時會轉移的 */
const RELATION_FIELDS = [
  'documents',
  'extractionResults',
  'mappingRules',
  // --- 以下 15 個目前不轉移 ---
  'documentFormats',
  'fieldDefinitionSets',
  'templateFieldMappings',
  'pipelineConfigs',
  'promptConfigs',
  'fieldMappingConfigs',
  'dataTemplates',
  'correctionPatterns',
  'correctionHistories',
  'transactionParticipations',
  'issuedDocuments',
  'identifiedHistoricalFiles',
  'changeRequests',
  'ruleSuggestions',
  'testTasks',
] as const

const TRANSFERRED_TODAY = new Set(['documents', 'extractionResults', 'mappingRules'])

async function main() {
  const { default: prisma } = await import('../src/lib/prisma')

  const countSelect = Object.fromEntries(RELATION_FIELDS.map((f) => [f, true]))

  const merged = await prisma.company.findMany({
    where: { status: 'MERGED' },
    select: {
      id: true,
      name: true,
      mergedIntoId: true,
      _count: { select: countSelect as Record<string, boolean> },
    },
    orderBy: { name: 'asc' },
  })

  console.log(`=== 已 MERGED 的公司：${merged.length} 間 ===\n`)

  const totals = new Map<string, number>()
  let companiesWithOrphans = 0

  for (const c of merged) {
    const counts = c._count as unknown as Record<string, number>
    const nonZero = RELATION_FIELDS.filter((f) => (counts[f] ?? 0) > 0)
    const orphans = nonZero.filter((f) => !TRANSFERRED_TODAY.has(f))

    for (const f of nonZero) totals.set(f, (totals.get(f) ?? 0) + counts[f])

    if (orphans.length === 0) continue
    companiesWithOrphans++

    console.log(`--- ${c.name}`)
    console.log(`    id=${c.id}  → 併入 ${c.mergedIntoId ?? '(無)'}`)
    nonZero.forEach((f) =>
      console.log(`    ${TRANSFERRED_TODAY.has(f) ? '  ' : '🔴'} ${f}: ${counts[f]}`)
    )
    console.log('')
  }

  console.log(`=== 名下仍有「不轉移類別」資料的 MERGED 公司：${companiesWithOrphans} 間 ===`)
  console.log(`\n=== 各類別在 MERGED 公司名下的總筆數 ===`)
  ;[...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([f, n]) =>
      console.log(`  ${TRANSFERRED_TODAY.has(f) ? '  ' : '🔴'} ${f}: ${n}`)
    )

  // ---- documentFormats 轉移的唯一鍵衝突模擬 ----
  console.log(`\n\n=== documentFormats 轉移的唯一鍵衝突模擬 ===`)
  console.log(`（唯一鍵：companyId + documentType + documentSubtype）\n`)

  const orphanFormats = await prisma.documentFormat.findMany({
    where: { company: { status: 'MERGED' } },
    select: {
      id: true,
      name: true,
      documentType: true,
      documentSubtype: true,
      companyId: true,
      company: { select: { name: true, mergedIntoId: true } },
    },
  })

  if (orphanFormats.length === 0) {
    console.log('  MERGED 公司名下沒有任何 documentFormat —— 本地無存量問題。')
  }

  let conflicts = 0
  let transferable = 0
  for (const f of orphanFormats) {
    const targetId = f.company?.mergedIntoId
    if (!targetId) {
      console.log(`  ⚠️  ${f.name}\n      來源公司無 mergedIntoId，無法判斷目標`)
      continue
    }
    const clash = await prisma.documentFormat.findFirst({
      where: {
        companyId: targetId,
        documentType: f.documentType,
        documentSubtype: f.documentSubtype,
      },
      select: { id: true, name: true },
    })
    if (clash) {
      conflicts++
      console.log(`  ❌ 撞鍵：${f.name}`)
      console.log(`      來源公司: ${f.company?.name}`)
      console.log(`      鍵: ${f.documentType}/${f.documentSubtype}`)
      console.log(`      目標已有: ${clash.name} [${clash.id.slice(0, 12)}]`)
    } else {
      transferable++
      console.log(`  ✅ 可轉移：${f.name}（${f.documentType}/${f.documentSubtype}）`)
    }
  }
  console.log(
    `\n  合計 ${orphanFormats.length} 筆：可直接轉移 ${transferable} / 撞鍵 ${conflicts}`
  )

  // ---- MERGED 但無 mergedIntoId：存量修復的前置障礙 ----
  const danglingMerged = merged.filter((c) => !c.mergedIntoId)
  if (danglingMerged.length > 0) {
    console.log(`\n\n=== 🔴 MERGED 但無 mergedIntoId：${danglingMerged.length} 間 ===`)
    console.log(`（無法自動判斷資料該轉移到哪間存活公司，存量修復需人工指定目標）`)
    danglingMerged.forEach((c) => console.log(`  ${c.name} [${c.id}]`))

    // 列出同類名稱的存活公司作為可能目標，供人工判斷
    console.log(`\n--- 可能的目標（ACTIVE / PENDING 公司全覽）---`)
    const alive = await prisma.company.findMany({
      where: { status: { not: 'MERGED' } },
      select: {
        id: true,
        name: true,
        status: true,
        _count: { select: { documents: true, documentFormats: true } },
      },
      orderBy: { name: 'asc' },
    })
    alive.forEach((c) =>
      console.log(
        `  [${c.status}] ${c.name} [${c.id.slice(0, 8)}] 文件=${c._count.documents} 格式=${c._count.documentFormats}`
      )
    )
  }

  // ---- 全部 documentFormat 明細：供人工判斷目標與撞鍵風險 ----
  console.log(`\n\n=== 全部 documentFormat 明細（依公司分組）===`)
  const allFormats = await prisma.documentFormat.findMany({
    select: {
      id: true,
      name: true,
      documentType: true,
      documentSubtype: true,
      company: { select: { name: true, status: true, mergedIntoId: true } },
    },
    orderBy: [{ companyId: 'asc' }, { createdAt: 'asc' }],
  })
  const grouped = new Map<string, typeof allFormats>()
  for (const f of allFormats) {
    const key = `[${f.company?.status}] ${f.company?.name}`
    grouped.set(key, [...(grouped.get(key) ?? []), f])
  }
  ;[...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([company, fmts]) => {
      console.log(`\n  ${company}`)
      fmts.forEach((f) =>
        console.log(`    ${f.documentType}/${f.documentSubtype}  ${f.name}`)
      )
    })

  // ---- 另兩類是否有唯一鍵風險 ----
  console.log(`\n\n=== fieldDefinitionSets / templateFieldMappings 存量 ===`)
  const orphanFds = await prisma.fieldDefinitionSet.count({
    where: { company: { status: 'MERGED' } },
  })
  const orphanTfm = await prisma.templateFieldMapping.count({
    where: { company: { status: 'MERGED' } },
  })
  console.log(`  fieldDefinitionSets: ${orphanFds}`)
  console.log(`  templateFieldMappings: ${orphanTfm}`)

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exitCode = 1
})
