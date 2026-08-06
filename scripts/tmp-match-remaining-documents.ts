/**
 * @fileoverview 補齊未進模板實例列的文件（FIX-165 手動匹配補位）
 * @description
 *   e2e 盤點 ③ 停在 75.2%（264/351）—— 因 FIX-165：三層預設模板全空，
 *   `autoMatch` 對任何文件必然回傳「沒有配置預設模版」，自動匹配從未成功過。
 *   既有的 264 份全部是人手用 `/api/v1/documents/match` 或 `template-matching/execute` 做的。
 *
 *   本腳本把剩下的缺口以**同樣的手動路徑**補齊。
 *
 *   🔴 分組依據：(方向 × companyId)
 *      - 方向取自來源資料夾（export/import），檔名參考編號 token 為後備
 *      - `template-matching-engine.service.ts:177-181` 的 `resolveMapping` **整批只吃一個
 *        companyId**，混公司的批次會把同一組規則套到所有文件上，故必須按公司拆批
 *
 *   🔴 不用 `autoTemplateMatchingService.batchMatch`：它結尾會 `tryAutoComplete`
 *      把實例轉成 COMPLETED，導致同一實例的後續批次因 `INVALID_INSTANCE_STATUS` 失敗。
 *      改為直接呼叫 engine 的 `matchDocuments`，再自行回寫 Document 欄位。
 *
 *   🔴 三段式 gated（§不可逆資料操作紀律）：
 *      inspect → 只讀，列出缺口組成、可用模板、映射解析、重複公司診斷
 *      dryrun  → 只讀，用 previewMatch 逐組驗證欄位轉換與驗證結果
 *      write   → 實際寫入：前置快照 + 單一交易回寫 + 數量閘 + 冪等
 *
 * @module scripts/tmp-match-remaining-documents
 * @since 2026-08-06（e2e 端到端補救）
 * @lastModified 2026-08-06
 *
 * @usage
 *   npx tsx scripts/tmp-match-remaining-documents.ts inspect
 *   npx tsx scripts/tmp-match-remaining-documents.ts dryrun
 *   npx tsx scripts/tmp-match-remaining-documents.ts write
 */
import * as dotenv from 'dotenv'
import * as fs from 'fs'
import * as path from 'path'

dotenv.config({ path: '.env.local' })
dotenv.config()

const SRC = 'C:/Users/rci.ChrisLai/Downloads/SCM ai doc sample'
const MODE = (process.argv[2] || 'inspect').toLowerCase()

/** 可歸因來源標記 —— 回滾與事後辨識的唯一依據 */
const RUN_TAG = 'e2e-backfill 2026-08-06'
const SNAPSHOT = 'match-backfill-snapshot-before-write.json'

/** 方向 → 目標模板（與既有 264 份用的主力模板一致） */
const TEMPLATE_BY_DIRECTION: Record<string, { id: string; name: string }> = {
  OUTBOUND: {
    id: 'cmrbhjbl4033101o3n77yg0sh',
    name: 'Logistics Cost - Outbound Template (Full List)',
  },
  INBOUND: {
    id: 'cmrbi0ktk033201o3rivrxb6h',
    name: 'Logistics Cost - Inbound Template (Full List)',
  },
}

const line = (s = '') => console.log(s)
const hr = (t: string) => {
  line()
  line('='.repeat(100))
  line(t)
  line('='.repeat(100))
}

/** 與 e2e-audit 完全相同的正規化，確保兩份報告的分母可對照 */
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

/** 方向：來源資料夾優先，檔名參考編號 token 為後備 */
function resolveDirection(relDir: string, fileName: string): 'INBOUND' | 'OUTBOUND' | 'UNKNOWN' {
  const d = relDir.toLowerCase()
  if (d.includes('import')) return 'INBOUND'
  if (d.includes('export')) return 'OUTBOUND'
  const m = fileName.toUpperCase().match(/R?[CH](IM|EX)\d/)
  if (m) return m[1] === 'IM' ? 'INBOUND' : 'OUTBOUND'
  return 'UNKNOWN'
}

/** 名稱主幹（去括號/標點/法人後綴）以偵測同名異體 */
const stem = (n: string) =>
  n
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\b(LTD|LIMITED|CO|INC|CORP|COMPANY)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

type Gap = {
  key: string
  fileName: string
  dir: string
  direction: string
  docId: string
  companyId: string | null
  companyName: string
}

type Group = {
  direction: string
  companyId: string | null
  companyName: string
  items: Gap[]
  ruleCount: number
  templateId: string
  templateName: string
}

async function main() {
  const { default: prisma } = await import('../src/lib/prisma')
  const { templateFieldMappingService } = await import(
    '../src/services/template-field-mapping.service'
  )

  // ---------------------------------------------------------------- 缺口計算
  const files = walk(SRC)
  const srcMeta = new Map<string, { fileName: string; dir: string }>()
  for (const f of files) {
    const k = norm(path.basename(f))
    if (!srcMeta.has(k)) {
      srcMeta.set(k, {
        fileName: path.basename(f),
        dir: path.dirname(path.relative(SRC, f)).replace(/\\/g, '/'),
      })
    }
  }

  const docs = await prisma.document.findMany({
    select: {
      id: true,
      fileName: true,
      status: true,
      companyId: true,
      templateInstanceId: true,
      templateMatchedAt: true,
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

  const rows = await prisma.templateInstanceRow.findMany({
    select: { sourceDocumentIds: true, templateInstanceId: true },
  })
  const inRows = new Set<string>()
  for (const r of rows) for (const id of r.sourceDocumentIds || []) inRows.add(id)

  const gaps: Gap[] = []
  let notCompleted = 0
  for (const [k, meta] of srcMeta) {
    const list = dbByName.get(k)
    if (!list) continue
    if (list.some((d) => inRows.has(d.id))) continue // 冪等：任一份已進實例列即跳過
    const completed = list.filter((d) => d.status === 'MAPPING_COMPLETED')
    if (completed.length === 0) {
      notCompleted++
      continue
    }
    const doc = completed[0] // createdAt desc → 最新一份
    gaps.push({
      key: k,
      fileName: meta.fileName,
      dir: meta.dir,
      direction: resolveDirection(meta.dir, meta.fileName),
      docId: doc.id,
      companyId: doc.companyId,
      companyName: doc.company?.name ?? '（無公司）',
    })
  }

  hr('1  缺口盤點（來源相異檔名，已處理完成但未進任何模板實例列）')
  line(`來源相異檔名                      ${srcMeta.size}`)
  line(`　已進實例列（任一份）              ${srcMeta.size - gaps.length - notCompleted}`)
  line(`　🔴 已完成但未進實例列（本次目標） ${gaps.length}`)
  line(`　未達 MAPPING_COMPLETED（不處理）  ${notCompleted}`)

  // ---------------------------------------------------------------- 分組
  const groupMap = new Map<string, Group>()
  for (const g of gaps) {
    const key = `${g.direction}::${g.companyId ?? 'NULL'}`
    if (!groupMap.has(key)) {
      const tpl = TEMPLATE_BY_DIRECTION[g.direction]
      groupMap.set(key, {
        direction: g.direction,
        companyId: g.companyId,
        companyName: g.companyName,
        items: [],
        ruleCount: 0,
        templateId: tpl?.id ?? '',
        templateName: tpl?.name ?? '（方向不明，無對應模板）',
      })
    }
    groupMap.get(key)!.items.push(g)
  }
  const groups = [...groupMap.values()].sort((a, b) => b.items.length - a.items.length)

  // 解析每組的映射規則數（決定可做 / 受阻）
  for (const g of groups) {
    if (!g.templateId) continue
    const cfg = await templateFieldMappingService.resolveMapping({
      dataTemplateId: g.templateId,
      companyId: g.companyId ?? undefined,
    })
    g.ruleCount = cfg.mappings.length
  }

  const runnable = groups.filter((g) => g.templateId && g.ruleCount > 0)
  const blocked = groups.filter((g) => !g.templateId || g.ruleCount === 0)
  const runnableDocs = runnable.reduce((n, g) => n + g.items.length, 0)
  const blockedDocs = blocked.reduce((n, g) => n + g.items.length, 0)

  hr('2  分組（方向 × 公司）—— matchDocuments 的批次單位')
  line(
    `  ${'方向'.padEnd(9)} ${'公司'.padEnd(44)} ${'份數'.padStart(5)} ${'規則'.padStart(5)}  目標模板`
  )
  line(`  ${'-'.repeat(9)} ${'-'.repeat(44)} ${'-'.repeat(5)} ${'-'.repeat(5)}  ${'-'.repeat(20)}`)
  for (const g of groups) {
    const mark = g.ruleCount > 0 ? '  ' : '🔴'
    line(
      `${mark}${g.direction.padEnd(9)} ${g.companyName.slice(0, 42).padEnd(44)} ${String(g.items.length).padStart(5)} ${String(g.ruleCount).padStart(5)}  ${g.templateName.replace('Logistics Cost - ', '')}`
    )
  }
  line()
  line(`✅ 可執行  ${runnable.length} 組 / ${runnableDocs} 份`)
  line(`🔴 受阻    ${blocked.length} 組 / ${blockedDocs} 份（解析不到任何映射規則）`)

  // ---------------------------------------------------------------- inspect 專屬診斷
  if (MODE === 'inspect') {
    hr('3  受阻公司診斷（是否為公司重複，見 memory project_company_dup_breaks_company_mapping）')
    const allCompanies = await prisma.company.findMany({
      select: {
        id: true,
        name: true,
        createdAt: true,
        _count: {
          select: { documents: true, templateFieldMappings: true, fieldDefinitionSets: true },
        },
      },
    })
    for (const bg of blocked) {
      if (!bg.companyId) continue
      const prefix = stem(bg.companyName).split(' ').slice(0, 2).join(' ')
      const family = allCompanies.filter((c) => stem(c.name).startsWith(prefix))
      if (family.length < 2) continue
      line()
      line(`🔴 ${bg.companyName}　→　同族「${prefix}」共 ${family.length} 家`)
      for (const c of family.sort((a, b) => b._count.templateFieldMappings - a._count.templateFieldMappings)) {
        const mark = c.id === bg.companyId ? '🔴' : '✅'
        line(
          `  ${mark} ${c.name.slice(0, 42).padEnd(44)} 文件${String(c._count.documents).padStart(4)} 映射組${String(c._count.templateFieldMappings).padStart(3)} 欄位集${String(c._count.fieldDefinitionSets).padStart(3)}  建於 ${c.createdAt.toISOString().slice(0, 19)}`
        )
        line(`     id=${c.id}`)
      }
    }

    hr('完成（inspect：全程唯讀，未寫入任何資料）')
    await prisma.$disconnect()
    return
  }

  // ---------------------------------------------------------------- dryrun
  const { templateMatchingEngineService } = await import(
    '../src/services/template-matching-engine.service'
  )

  /** 從 ExtractionResult.stage2Result 解析 formatId（沿用 auto-template-matching 的作法） */
  async function resolveFormatId(documentId: string): Promise<string | undefined> {
    const e = await prisma.extractionResult.findUnique({
      where: { documentId },
      select: { stage2Result: true },
    })
    if (!e?.stage2Result) return undefined
    const s = e.stage2Result as Record<string, unknown>
    return (s.matchedFormatId ?? s.formatId) as string | undefined
  }

  if (MODE === 'dryrun') {
    // 🔴 對照組：既有實例列的填充率。沒有基準就無法判讀「平均填入 4 欄」是常態還是異常
    //    （§feedback_baseline_before_diagnosing）
    hr('3  對照組 —— 既有實例列的欄位填充率（本次結果的判讀基準）')
    for (const [dir, tpl] of Object.entries(TEMPLATE_BY_DIRECTION)) {
      const existing = await prisma.templateInstanceRow.findMany({
        where: { templateInstance: { dataTemplateId: tpl.id } },
        select: { fieldValues: true, status: true },
      })
      if (existing.length === 0) {
        line(`  ${dir.padEnd(9)} ${tpl.name}　既有列 0 筆，無對照組`)
        continue
      }
      const counts = existing.map(
        (r) =>
          Object.values((r.fieldValues as Record<string, unknown>) || {}).filter(
            (v) => v !== null && v !== undefined && v !== ''
          ).length
      )
      const avg = counts.reduce((a, b) => a + b, 0) / counts.length
      const sortedC = [...counts].sort((a, b) => a - b)
      const statusTally = new Map<string, number>()
      existing.forEach((r) => statusTally.set(r.status, (statusTally.get(r.status) || 0) + 1))
      line(
        `  ${dir.padEnd(9)} 既有列 ${String(existing.length).padStart(4)}　平均填入 ${avg.toFixed(1)} 欄　中位數 ${sortedC[Math.floor(sortedC.length / 2)]}　最小 ${sortedC[0]}　最大 ${sortedC[sortedC.length - 1]}`
      )
      line(
        `  ${' '.repeat(9)} 狀態分佈：${[...statusTally.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`
      )
    }

    hr('4  dryrun —— previewMatch 逐組驗證（不寫入任何資料）')
    for (const g of runnable) {
      const formatId = await resolveFormatId(g.items[0].docId)
      const preview = await templateMatchingEngineService.previewMatch({
        documentIds: g.items.map((i) => i.docId),
        dataTemplateId: g.templateId,
        companyId: g.companyId ?? undefined,
        formatId,
      })
      const unresolved = new Map<string, number>()
      for (const r of preview.rows) {
        for (const k of Object.keys(r.unresolvedSourceKeys || {})) {
          unresolved.set(k, (unresolved.get(k) || 0) + 1)
        }
      }
      // 欄位填充率：有值的欄位數 / 總欄位數
      const filled = preview.rows.map(
        (r) => Object.values(r.fieldValues || {}).filter((v) => v !== null && v !== undefined && v !== '').length
      )
      const avgFilled = filled.length ? (filled.reduce((a, b) => a + b, 0) / filled.length).toFixed(1) : '0'

      line()
      line(`── ${g.direction} / ${g.companyName}　(${g.items.length} 份，${g.ruleCount} 條規則)`)
      line(`   模板       ${g.templateName}`)
      line(`   formatId   ${formatId ?? '（無）'}`)
      line(
        `   預覽列數   ${preview.rows.length}　通過 ${preview.summary.validRows}　未通過 ${preview.summary.invalidRows}`
      )
      line(`   平均填入欄位數 ${avgFilled}`)
      if (unresolved.size) {
        const top = [...unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
        line(`   ⚠️ mapping 引用但取不到值的來源 key（出現份數）：`)
        top.forEach(([k, n]) => line(`        ${k.padEnd(38)} ${n}/${g.items.length}`))
      }
      const firstInvalid = preview.rows.find((r) => !r.validation.isValid)
      if (firstInvalid) {
        const errs = (firstInvalid.validation.errors || []).slice(0, 4)
        line(`   ⚠️ 未通過樣本 ${firstInvalid.documentId}：`)
        errs.forEach((e: unknown) => line(`        ${JSON.stringify(e).slice(0, 110)}`))
      }
    }

    hr('完成（dryrun：全程唯讀，未寫入任何資料）')
    line(`若接受上述結果，執行：npx tsx scripts/tmp-match-remaining-documents.ts write`)
    await prisma.$disconnect()
    return
  }

  // ---------------------------------------------------------------- write
  if (MODE !== 'write') {
    line()
    line(`🔴 未知模式「${MODE}」，可用：inspect / dryrun / write`)
    await prisma.$disconnect()
    return
  }

  hr('3  write —— 前置快照')
  const snapshotDocs = await prisma.document.findMany({
    where: { id: { in: runnable.flatMap((g) => g.items.map((i) => i.docId)) } },
    select: {
      id: true,
      fileName: true,
      companyId: true,
      templateInstanceId: true,
      templateMatchedAt: true,
      updatedAt: true,
    },
  })
  const rowsBefore = await prisma.templateInstanceRow.count()
  const instancesBefore = await prisma.templateInstance.count()
  fs.writeFileSync(
    SNAPSHOT,
    JSON.stringify(
      {
        runTag: RUN_TAG,
        capturedAt: new Date().toISOString(),
        rowsBefore,
        instancesBefore,
        documents: snapshotDocs,
        groups: runnable.map((g) => ({
          direction: g.direction,
          companyId: g.companyId,
          companyName: g.companyName,
          templateId: g.templateId,
          count: g.items.length,
          documentIds: g.items.map((i) => i.docId),
        })),
      },
      null,
      2
    )
  )
  line(`快照已寫出：${SNAPSHOT}`)
  line(`  文件 ${snapshotDocs.length} 份　template_instance_rows ${rowsBefore}　template_instances ${instancesBefore}`)

  hr('4  write —— 建立目標實例（每方向一個）')
  const instanceByDirection = new Map<string, string>()
  for (const dir of [...new Set(runnable.map((g) => g.direction))]) {
    const tpl = TEMPLATE_BY_DIRECTION[dir]
    const inst = await prisma.templateInstance.create({
      data: {
        dataTemplateId: tpl.id,
        name: `${RUN_TAG} — ${dir}`,
        description: `FIX-165 手動匹配補位：自動匹配從未運作，本實例由 scripts/tmp-match-remaining-documents.ts 建立（${RUN_TAG}）`,
        status: 'DRAFT',
      },
      select: { id: true, name: true },
    })
    instanceByDirection.set(dir, inst.id)
    line(`  ${dir.padEnd(9)} → ${inst.id}　${inst.name}`)
  }

  hr('5  write —— 逐組匹配（數量閘：每組實際文件數必須等於預期）')
  let okGroups = 0
  let failedGroups = 0
  let totalRows = 0
  let totalDocsWritten = 0

  for (const g of runnable) {
    const instanceId = instanceByDirection.get(g.direction)!
    const expected = g.items.length
    const ids = g.items.map((i) => i.docId)
    const tag = `${g.direction} / ${g.companyName.slice(0, 34)}`
    try {
      const formatId = await resolveFormatId(ids[0])
      const result = await templateMatchingEngineService.matchDocuments({
        documentIds: ids,
        templateInstanceId: instanceId,
        options: { companyId: g.companyId ?? undefined, formatId },
      })

      // 數量閘 1：載入的文件數必須等於預期
      if (result.totalDocuments !== expected) {
        throw new Error(
          `數量閘失敗：載入 ${result.totalDocuments} 份，預期 ${expected} 份`
        )
      }
      // 數量閘 2：必須真的產生列
      if (result.totalRows === 0) {
        throw new Error('數量閘失敗：未產生任何實例列')
      }

      // 回寫 Document（單一交易 + 樂觀鎖：只更新仍未匹配者）
      const upd = await prisma.document.updateMany({
        where: { id: { in: ids }, templateInstanceId: null },
        data: { templateInstanceId: instanceId, templateMatchedAt: new Date() },
      })

      okGroups++
      totalRows += result.totalRows
      totalDocsWritten += upd.count
      line(
        `  ✓ ${tag.padEnd(46)} 文件 ${String(result.totalDocuments).padStart(3)}　列 ${String(result.totalRows).padStart(3)}　通過 ${String(result.validRows).padStart(3)}　未通過 ${String(result.invalidRows).padStart(3)}　錯誤 ${String(result.errorRows).padStart(3)}　回寫 ${upd.count}`
      )
    } catch (e) {
      failedGroups++
      const msg = e instanceof Error ? e.message : String(e)
      line(`  ✗ ${tag.padEnd(46)} ${msg.slice(0, 90)}`)
    }
  }

  hr('6  write —— 事後核對')
  const rowsAfter = await prisma.templateInstanceRow.count()
  line(`  組別       成功 ${okGroups}　失敗 ${failedGroups}`)
  line(`  新增實例列 ${rowsAfter - rowsBefore}（引擎回報 ${totalRows}）`)
  line(`  回寫 Document.templateInstanceId  ${totalDocsWritten} 份`)

  // 🔴 最終驗收：目標文件是否真的出現在實例列裡（不能只信引擎回報的數字）
  const targetIds = runnable.flatMap((g) => g.items.map((i) => i.docId))
  const rowsNow = await prisma.templateInstanceRow.findMany({
    select: { sourceDocumentIds: true },
  })
  const inRowsNow = new Set<string>()
  for (const r of rowsNow) for (const id of r.sourceDocumentIds || []) inRowsNow.add(id)
  const landed = targetIds.filter((id) => inRowsNow.has(id))
  const missed = targetIds.filter((id) => !inRowsNow.has(id))
  line()
  line(`  🔴 驗收（分母 ${targetIds.length}）：實際進入實例列 ${landed.length}　未進 ${missed.length}`)
  if (missed.length) {
    const missedDocs = snapshotDocs.filter((d) => missed.includes(d.id))
    missedDocs.slice(0, 15).forEach((d) => line(`      ${d.fileName}`))
  }
  line()
  if (blockedDocs > 0) {
    line(`  🔴 未處理 ${blockedDocs} 份（受阻於映射規則缺失，見 inspect §3 的公司重複診斷）`)
  }
  line(`  回滾依據：template_instances.name 前綴「${RUN_TAG}」+ 快照檔 ${SNAPSHOT}`)

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
