/**
 * @fileoverview 唯讀盤點：Template Field Mapping 的重複配置與「同範圍多筆」語意
 * @description
 *   FIX-133 的決策依據。`unique_template_mapping`
 *   (`@@unique([dataTemplateId, scope, companyId, documentFormatId])`)
 *   因 PostgreSQL 預設 NULLS DISTINCT 而對任何範圍都不生效
 *   （GLOBAL 兩欄 NULL、COMPANY 與 FORMAT 各一欄 NULL），故相同四元組可無聲重複建立。
 *
 *   本腳本回答四個問題：
 *     1. 有多少組四元組出現 count(*) > 1？各組的 priority / 規則數 / isActive / 建立時間為何？
 *     2. 依 `resolveMapping` 的實際撈取語意（service.ts:456-478），有多少次解析會撈到
 *        同範圍多筆？這些筆的 priority 是否相異、targetField 是否重疊？
 *        —— 這是判定「刻意分層 vs 資料污染」（FIX-133 BUG-3）的核心依據
 *     3. 是否存在 scope 與身分欄位不一致的記錄（如 scope=GLOBAL 但 companyId 有值）？
 *        resolveMapping 的 GLOBAL 分支只比對 scope、不檢查身分欄位是否為 NULL，
 *        故此類髒資料會被撈進合併，卻不會出現在四元組分組中。
 *     4. priority 的整體分佈 —— 若絕大多數為預設值 0，則「同範圍分層」缺乏實證支持。
 *
 *   全程唯讀，不寫入任何資料。
 *
 *   🔴 本檔為 tsx 腳本，只能在本地執行。Azure runner 映像不含 scripts/ 與 tsx，
 *      Azure DEV 的盤點改走 Kudu 唯讀查詢（見 FIX-133 §Azure 盤點方式）。
 *
 * @module scripts/local-inspect-duplicate-template-mappings
 * @since 2026-07-25（FIX-133）
 * @lastModified 2026-07-25
 *
 * @usage npx tsx scripts/local-inspect-duplicate-template-mappings.ts
 */
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

/** 映射規則的最小結構（只取盤點需要的欄位） */
interface RuleShape {
  targetField?: string
  sourceField?: string
}

/** 盤點時使用的記錄投影 */
interface MappingRow {
  id: string
  dataTemplateId: string
  scope: string
  companyId: string | null
  documentFormatId: string | null
  name: string
  priority: number
  isActive: boolean
  createdAt: Date
  createdBy: string | null
  mappings: unknown
  dataTemplate: { name: string } | null
  company: { name: string; status: string } | null
  documentFormat: { name: string } | null
}

function rulesOf(row: MappingRow): RuleShape[] {
  return Array.isArray(row.mappings) ? (row.mappings as RuleShape[]) : []
}

function targetFieldsOf(row: MappingRow): string[] {
  return rulesOf(row)
    .map((r) => r.targetField)
    .filter((f): f is string => typeof f === 'string' && f.length > 0)
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

/** 一筆記錄的單行摘要 */
function line(row: MappingRow): string {
  const rules = rulesOf(row).length
  return (
    `    ${row.isActive ? '啟用' : '停用'}  priority=${String(row.priority).padStart(3)}  ` +
    `規則=${String(rules).padStart(3)}  ${fmtDate(row.createdAt)}  ` +
    `[${row.id.slice(0, 10)}]  ${row.name}` +
    (row.createdBy ? `  建立者=${row.createdBy.slice(0, 10)}` : '')
  )
}

/** 四元組分組鍵（= DB 唯一約束的意圖） */
function quadKey(row: MappingRow): string {
  return [row.dataTemplateId, row.scope, row.companyId ?? 'NULL', row.documentFormatId ?? 'NULL'].join(
    '|'
  )
}

/**
 * resolveMapping 的實際撈取分組鍵。
 * GLOBAL 只以 scope 撈取（不看身分欄位），故整個 dataTemplate 下的 GLOBAL 全部同組。
 */
function resolveGroupKey(row: MappingRow): string | null {
  if (row.scope === 'GLOBAL') return `${row.dataTemplateId}|GLOBAL`
  if (row.scope === 'COMPANY') return `${row.dataTemplateId}|COMPANY|${row.companyId ?? 'NULL'}`
  if (row.scope === 'FORMAT') return `${row.dataTemplateId}|FORMAT|${row.documentFormatId ?? 'NULL'}`
  return null
}

function describeGroup(rows: MappingRow[]): string {
  const r = rows[0]
  const target =
    r.scope === 'COMPANY'
      ? `公司=${r.company?.name ?? '(公司不存在)'}${r.company ? ` [${r.company.status}]` : ''}`
      : r.scope === 'FORMAT'
        ? `格式=${r.documentFormat?.name ?? '(格式不存在)'}`
        : '（全域）'
  return `模版=${r.dataTemplate?.name ?? '(模版不存在)'}  範圍=${r.scope}  ${target}`
}

async function main() {
  const { default: prisma } = await import('../src/lib/prisma')

  const all = (await prisma.templateFieldMapping.findMany({
    select: {
      id: true,
      dataTemplateId: true,
      scope: true,
      companyId: true,
      documentFormatId: true,
      name: true,
      priority: true,
      isActive: true,
      createdAt: true,
      createdBy: true,
      mappings: true,
      dataTemplate: { select: { name: true } },
      company: { select: { name: true, status: true } },
      documentFormat: { select: { name: true } },
    },
    orderBy: [{ dataTemplateId: 'asc' }, { scope: 'asc' }, { createdAt: 'asc' }],
  })) as unknown as MappingRow[]

  // ============ 1. 全表概況 ============
  console.log('='.repeat(78))
  console.log('=== 1. 全表概況 ===')
  console.log('='.repeat(78))
  console.log(`\n總筆數：${all.length}（啟用 ${all.filter((r) => r.isActive).length} / 停用 ${all.filter((r) => !r.isActive).length}）\n`)

  const byScope = new Map<string, MappingRow[]>()
  for (const r of all) byScope.set(r.scope, [...(byScope.get(r.scope) ?? []), r])
  console.log('依範圍分佈：')
  for (const scope of ['GLOBAL', 'COMPANY', 'FORMAT']) {
    const rows = byScope.get(scope) ?? []
    console.log(
      `  ${scope.padEnd(8)} ${String(rows.length).padStart(4)} 筆（啟用 ${rows.filter((r) => r.isActive).length}）`
    )
  }

  // ============ 2. priority 分佈 ============
  console.log(`\n\n${'='.repeat(78)}`)
  console.log('=== 2. priority 分佈（判定「同範圍分層」是否有實證支持）===')
  console.log('='.repeat(78))
  const byPriority = new Map<number, number>()
  for (const r of all) byPriority.set(r.priority, (byPriority.get(r.priority) ?? 0) + 1)
  console.log('')
  ;[...byPriority.entries()]
    .sort((a, b) => a[0] - b[0])
    .forEach(([p, n]) =>
      console.log(`  priority=${String(p).padStart(4)}  ${String(n).padStart(4)} 筆${p === 0 ? '  ← 預設值' : ''}`)
    )
  const nonDefault = all.filter((r) => r.priority !== 0).length
  console.log(
    `\n  非預設 priority：${nonDefault} / ${all.length} 筆` +
      (nonDefault === 0 ? '  → 從未有人使用 priority 分層' : '')
  )

  // ============ 3. 四元組重複（DB 唯一約束的意圖） ============
  console.log(`\n\n${'='.repeat(78)}`)
  console.log('=== 3. 四元組重複組（unique_template_mapping 本應阻擋的情形）===')
  console.log('='.repeat(78))
  console.log('（鍵：dataTemplateId + scope + companyId + documentFormatId）\n')

  const quadGroups = new Map<string, MappingRow[]>()
  for (const r of all) quadGroups.set(quadKey(r), [...(quadGroups.get(quadKey(r)) ?? []), r])
  const quadDups = [...quadGroups.values()].filter((rows) => rows.length > 1)

  if (quadDups.length === 0) {
    console.log('  ✅ 0 組 —— 沒有任何四元組出現重複。')
  } else {
    console.log(`  🔴 ${quadDups.length} 組重複，共 ${quadDups.reduce((s, g) => s + g.length, 0)} 筆\n`)
    quadDups.forEach((rows, i) => {
      const activeCount = rows.filter((r) => r.isActive).length
      console.log(`  --- 組 ${i + 1}：${describeGroup(rows)}`)
      console.log(`      共 ${rows.length} 筆（啟用 ${activeCount}）${activeCount > 1 ? '  🔴 多筆同時啟用 → resolveMapping 會全部撈到' : '  ⓘ 僅 ≤1 筆啟用 → 不影響解析'}`)
      rows.forEach((r) => console.log(line(r)))
      console.log('')
    })
  }

  // ============ 4. resolveMapping 語意下的同範圍多筆（BUG-3 判定核心） ============
  console.log(`\n${'='.repeat(78)}`)
  console.log('=== 4. resolveMapping 會撈到同範圍多筆的情形（BUG-3 判定核心）===')
  console.log('='.repeat(78))
  console.log('（只計啟用記錄，因 resolveMapping 的 where 含 isActive: true）')
  console.log('（GLOBAL 依 service.ts:458 只比對 scope，故同模版下所有 GLOBAL 皆同組）\n')

  const activeRows = all.filter((r) => r.isActive)
  const resolveGroups = new Map<string, MappingRow[]>()
  for (const r of activeRows) {
    const k = resolveGroupKey(r)
    if (!k) continue
    resolveGroups.set(k, [...(resolveGroups.get(k) ?? []), r])
  }
  const multi = [...resolveGroups.values()].filter((rows) => rows.length > 1)

  if (multi.length === 0) {
    console.log('  ✅ 0 組 —— 每次解析在同一範圍內都只會撈到單筆配置。')
    console.log('     → 無法從既有資料證明「同範圍分層」曾被使用。')
  } else {
    console.log(`  ⚠️  ${multi.length} 組，共 ${multi.reduce((s, g) => s + g.length, 0)} 筆啟用配置\n`)
    multi.forEach((rows, i) => {
      const priorities = [...new Set(rows.map((r) => r.priority))]
      const distinctPriority = priorities.length > 1

      // targetField 重疊分析：完全重疊 → 低優先級整筆被覆蓋（污染跡象）
      //                       完全不重疊 → 互補分層（刻意設計跡象）
      const sets = rows.map((r) => new Set(targetFieldsOf(r)))
      const union = new Set<string>()
      sets.forEach((s) => s.forEach((f) => union.add(f)))
      const sumSizes = sets.reduce((s, x) => s + x.size, 0)
      const overlapCount = sumSizes - union.size

      console.log(`  --- 組 ${i + 1}：${describeGroup(rows)}`)
      console.log(`      ${rows.length} 筆啟用；priority ${distinctPriority ? `相異 [${priorities.join(', ')}]  🔎 分層跡象` : `全部相同 (${priorities[0]})  🔎 污染跡象`}`)
      console.log(
        `      targetField：聯集 ${union.size} 個 / 各筆合計 ${sumSizes} 個 → 重疊 ${overlapCount} 個` +
          (overlapCount === 0
            ? '  🔎 完全互補（分層跡象）'
            : union.size === Math.max(...sets.map((s) => s.size)) && overlapCount > 0
              ? '  🔎 某筆被完全覆蓋（污染跡象）'
              : '  🔎 部分重疊')
      )
      rows.forEach((r) => console.log(line(r)))
      console.log('')
    })
  }

  // ============ 5. scope 與身分欄位不一致的髒資料 ============
  console.log(`\n${'='.repeat(78)}`)
  console.log('=== 5. scope 與身分欄位不一致的記錄 ===')
  console.log('='.repeat(78))
  console.log('（resolveMapping 的 GLOBAL 分支不檢查身分欄位是否為 NULL，此類記錄會被誤撈）\n')

  const inconsistent = all.filter((r) => {
    if (r.scope === 'GLOBAL') return r.companyId !== null || r.documentFormatId !== null
    if (r.scope === 'COMPANY') return r.companyId === null || r.documentFormatId !== null
    if (r.scope === 'FORMAT') return r.documentFormatId === null || r.companyId !== null
    return false
  })

  if (inconsistent.length === 0) {
    console.log('  ✅ 0 筆 —— 所有記錄的 scope 與身分欄位一致。')
  } else {
    console.log(`  🔴 ${inconsistent.length} 筆\n`)
    inconsistent.forEach((r) => {
      console.log(`  scope=${r.scope}  companyId=${r.companyId ?? 'NULL'}  documentFormatId=${r.documentFormatId ?? 'NULL'}`)
      console.log(line(r))
    })
  }

  // ============ 6. 摘要 ============
  console.log(`\n\n${'='.repeat(78)}`)
  console.log('=== 6. 盤點摘要 ===')
  console.log('='.repeat(78))
  console.log(`
  總筆數                                ${all.length}
  四元組重複組（BUG-2）                 ${quadDups.length}
  其中多筆同時啟用                      ${quadDups.filter((g) => g.filter((r) => r.isActive).length > 1).length}
  resolveMapping 同範圍多筆組（BUG-3）  ${multi.length}
    其中 priority 相異（分層跡象）      ${multi.filter((g) => new Set(g.map((r) => r.priority)).size > 1).length}
    其中 priority 相同（污染跡象）      ${multi.filter((g) => new Set(g.map((r) => r.priority)).size === 1).length}
  scope/身分欄位不一致                  ${inconsistent.length}
  非預設 priority 筆數                  ${nonDefault}
`)

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exitCode = 1
})
