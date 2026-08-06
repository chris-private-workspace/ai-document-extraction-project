/**
 * @fileoverview e2e 端到端覆蓋率盤點（唯讀）
 * @description
 *   以本機來源資料夾的**相異檔名**為分母，量測三段覆蓋率：
 *     ① 入庫      —— 來源檔名在 documents 找得到對應紀錄
 *     ② 提取成功  —— 該文件有 extraction_results（唯一約束，一份文件最多一筆）
 *     ③ 進實例列  —— 該文件 id 出現在任一 template_instance_rows.source_document_ids
 *
 *   三者為**逐層收斂**：③ ⊆ ② ⊆ ①。任一層的缺口即為該層的待辦來源。
 *
 *   🔴 分母定義：來源資料夾 PDF 以 `norm()` 去重後的相異檔名數。
 *      同一份發票在 export/import 兩個資料夾各放一份、或帶 ` (2)` 後綴的重複下載，
 *      都會收斂成同一個 key —— 與 `tmp-match-remaining-documents.ts` 的 `norm()` 完全相同，
 *      確保兩份報告的分母可直接對照。
 *
 *   🔴 唯讀：本腳本不寫入任何資料，故不套用三段式 gated 流程。
 *
 * @module scripts/tmp-e2e-coverage-audit
 * @since 2026-08-06（FIX-169 證據）
 * @lastModified 2026-08-06
 *
 * @usage
 *   npx tsx scripts/tmp-e2e-coverage-audit.ts
 */
import * as dotenv from 'dotenv'
import * as fs from 'fs'
import * as path from 'path'

dotenv.config({ path: '.env.local' })
dotenv.config()

const SRC = 'C:/Users/rci.ChrisLai/Downloads/SCM ai doc sample'

const line = (s = '') => console.log(s)
const hr = (t: string) => {
  line()
  line('='.repeat(100))
  line(t)
  line('='.repeat(100))
}

/** 與 tmp-match-remaining-documents.ts 完全相同的正規化 */
const norm = (f: string) =>
  f
    .replace(/\.pdf$/i, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/\s+\d+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.pdf$/i.test(e.name)) out.push(p)
  }
  return out
}

const pct = (n: number, d: number) => (d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1)}%`)

async function main() {
  const { default: prisma } = await import('../src/lib/prisma')

  // ------------------------------------------------------------------ 分母
  const files = walk(SRC)
  const srcMeta = new Map<string, { fileName: string; dir: string; copies: number }>()
  for (const f of files) {
    const k = norm(path.basename(f))
    const prev = srcMeta.get(k)
    if (prev) prev.copies++
    else
      srcMeta.set(k, {
        fileName: path.basename(f),
        dir: path.dirname(path.relative(SRC, f)).replace(/\\/g, '/'),
        copies: 1,
      })
  }

  // ------------------------------------------------------------------ DB 現況
  const docs = await prisma.document.findMany({
    select: {
      id: true,
      fileName: true,
      status: true,
      blobName: true,
      companyId: true,
      createdAt: true,
      company: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
  const dbByName = new Map<string, typeof docs>()
  for (const d of docs) {
    const k = norm(d.fileName)
    dbByName.set(k, (dbByName.get(k) || []).concat(d) as typeof docs)
  }

  const extracted = new Set(
    (await prisma.extractionResult.findMany({ select: { documentId: true } })).map(
      (e) => e.documentId
    )
  )

  const inRows = new Set<string>()
  for (const r of await prisma.templateInstanceRow.findMany({
    select: { sourceDocumentIds: true },
  })) {
    for (const id of r.sourceDocumentIds || []) inRows.add(id)
  }

  // ------------------------------------------------------------------ 逐層收斂
  const missIngest: string[] = []
  const missExtract: string[] = []
  const missRow: string[] = []
  let ingested = 0
  let extractedCount = 0
  let rowed = 0

  for (const [k, meta] of srcMeta) {
    const list = dbByName.get(k)
    if (!list || list.length === 0) {
      missIngest.push(meta.fileName)
      continue
    }
    ingested++

    if (list.some((d) => extracted.has(d.id))) extractedCount++
    else missExtract.push(meta.fileName)

    if (list.some((d) => inRows.has(d.id))) rowed++
    else missRow.push(meta.fileName)
  }

  const D = srcMeta.size

  hr('e2e 覆蓋率（分母＝來源相異檔名）')
  line(`來源 PDF 實體檔案數        ${files.length}`)
  line(`來源相異檔名（分母 D）      ${D}`)
  line(`　重複下載／雙資料夾份數    ${files.length - D}`)
  line()
  line(`  ① 入庫       ${String(ingested).padStart(4)} / ${D}   ${pct(ingested, D)}`)
  line(`  ② 提取成功   ${String(extractedCount).padStart(4)} / ${D}   ${pct(extractedCount, D)}`)
  line(`  ③ 進實例列   ${String(rowed).padStart(4)} / ${D}   ${pct(rowed, D)}`)

  hr('缺口明細')
  line(`① 未入庫              ${missIngest.length}`)
  for (const f of missIngest) line(`    ${f}`)
  line()
  line(`② 已入庫但無提取結果   ${missExtract.length}`)
  for (const f of missExtract) {
    const list = dbByName.get(norm(f))!
    const d = list[0]
    line(`    ${f}`)
    line(`      status=${d.status}  blob=${d.blobName || '（空）'}  docId=${d.id}`)
  }
  line()
  line(`③ 已入庫但未進實例列   ${missRow.length}`)
  for (const f of missRow) {
    const list = dbByName.get(norm(f))!
    const d = list[0]
    line(
      `    ${f}  status=${d.status}  company=${d.company?.name ?? '（無）'}  hasExtraction=${list.some((x) => extracted.has(x.id))}`
    )
  }

  // ------------------------------------------------------------------ 缺口根因
  hr('缺口根因（②③ 每一份的公司狀態與映射解析）')
  const { templateFieldMappingService } = await import(
    '../src/services/template-field-mapping.service'
  )
  const TEMPLATES = [
    { id: 'cmrbhjbl4033101o3n77yg0sh', name: 'Outbound' },
    { id: 'cmrbi0ktk033201o3rivrxb6h', name: 'Inbound' },
  ]
  const gapNames = [...new Set([...missExtract, ...missRow])]
  for (const f of gapNames) {
    const list = dbByName.get(norm(f))!
    const d = list[0]
    line()
    line(`── ${f}`)
    line(`   docId       ${d.id}`)
    line(`   status      ${d.status}`)
    line(`   建立/更新    ${d.createdAt.toISOString()}`)
    line(`   同名份數     ${list.length}（狀態：${list.map((x) => x.status).join(', ')}）`)
    if (d.companyId) {
      const c = await prisma.company.findUnique({
        where: { id: d.companyId },
        select: {
          id: true,
          name: true,
          status: true,
          mergedIntoId: true,
          suspectedDuplicateOfId: true,
        },
      })
      line(
        `   公司        ${c?.name}  status=${c?.status}  mergedInto=${c?.mergedIntoId ?? '—'}  suspectedDupOf=${c?.suspectedDuplicateOfId ?? '—'}`
      )
      const dupes = await prisma.company.findMany({
        where: { name: { contains: (c?.name ?? '').slice(0, 12) } },
        select: { id: true, name: true, status: true },
      })
      line(`   同名候選     ${dupes.length}`)
      for (const x of dupes) line(`      ${x.status.padEnd(10)} ${x.name}  (${x.id})`)
      for (const t of TEMPLATES) {
        const cfg = await templateFieldMappingService.resolveMapping({
          dataTemplateId: t.id,
          companyId: d.companyId,
        })
        line(`   映射規則 ${t.name.padEnd(9)} ${cfg.mappings.length}`)
      }
    } else {
      line(`   公司        （NULL —— Stage 1 未歸屬，resolveMapping 無從解析）`)
    }
  }

  // ------------------------------------------------------------------ 正規化實測
  hr('normalizeCompanyName 實測（判斷重複公司是否為正規化規則造成）')
  const { Stage1CompanyService } = await import(
    '../src/services/extraction-v3/stages/stage-1-company.service'
  )
  const s1 = new Stage1CompanyService(prisma)
  const normName = (n: string) =>
    (s1 as unknown as { normalizeCompanyName(x: string): string }).normalizeCompanyName(n)
  const PROBES = [
    'RICOH INTERNATIONAL (LOGISTICS) (HK) LTD.',
    'RICOH INTERNATIONAL LOGISTICS (HK) LTD.',
  ]
  for (const p of PROBES) line(`  ${p.padEnd(45)} → "${normName(p)}"`)
  line()
  line(`  兩者正規化後相等？  ${normName(PROBES[0]) === normName(PROBES[1])}`)

  // ------------------------------------------------------------------ 補救成果
  hr('本輪補救成果（依可歸因標記統計，即回滾依據）')
  const tagged = await prisma.templateInstance.findMany({
    where: { OR: [{ name: { startsWith: 'e2e-backfill' } }, { name: { startsWith: 'toll-hk' } }] },
    select: {
      id: true,
      name: true,
      status: true,
      createdAt: true,
      _count: { select: { rows: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  line(`可歸因實例   ${tagged.length}`)
  let taggedRows = 0
  const taggedDocIds = new Set<string>()
  for (const t of tagged) {
    taggedRows += t._count.rows
    line(`  ${t.name.padEnd(38)} status=${t.status.padEnd(10)} 列數=${t._count.rows}`)
    for (const r of await prisma.templateInstanceRow.findMany({
      where: { templateInstanceId: t.id },
      select: { sourceDocumentIds: true },
    })) {
      for (const id of r.sourceDocumentIds || []) taggedDocIds.add(id)
    }
  }
  line(`　合計列數   ${taggedRows}`)
  line(`　涵蓋文件   ${taggedDocIds.size}（相異 document id）`)
  // 本輪涵蓋的 84 份，未必每份都落在 351 分母內（檔名變體會 norm 不到來源 key）
  const docById = new Map(docs.map((d) => [d.id, d]))
  const inDenominator: string[] = []
  const outDenominator: string[] = []
  for (const id of taggedDocIds) {
    const d = docById.get(id)
    if (!d) continue
    ;(srcMeta.has(norm(d.fileName)) ? inDenominator : outDenominator).push(d.fileName)
  }
  line(`　其中落在分母內 ${inDenominator.length}，分母外 ${outDenominator.length}`)
  for (const f of outDenominator) line(`      分母外：${f}`)
  line(`　③ 扣除本輪貢獻後的既有覆蓋 = ${rowed} − ${inDenominator.length} = ${rowed - inDenominator.length}`)

  const taggedMappings = await prisma.templateFieldMapping.count({
    where: { description: { startsWith: 'toll-hk-backfill' } },
  })
  line()
  line(`可歸因映射規則（description 前綴 toll-hk-backfill）  ${taggedMappings}`)

  const taggedDefSets = await prisma.fieldDefinitionSet.findMany({
    where: { description: { contains: 'toll-hk' } },
    select: { id: true, name: true, companyId: true },
  })
  line(`可歸因欄位定義集                                   ${taggedDefSets.length}`)
  for (const s of taggedDefSets) line(`    ${s.name}  (${s.id})`)

  // ------------------------------------------------------------------ 反向：DB 有、來源無
  hr('反向對照（DB 有紀錄但來源資料夾找不到同名檔）')
  const srcKeys = new Set(srcMeta.keys())
  const orphan = [...dbByName.keys()].filter((k) => !srcKeys.has(k))
  line(`DB 相異檔名   ${dbByName.size}`)
  line(`　來源找不到   ${orphan.length}`)
  for (const k of orphan.slice(0, 40)) line(`    ${dbByName.get(k)![0].fileName}`)
  if (orphan.length > 40) line(`    …（其餘 ${orphan.length - 40} 筆略）`)

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  process.exit(1)
})
