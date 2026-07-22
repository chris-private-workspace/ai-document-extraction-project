/**
 * @fileoverview FIX-126 回放比對：修改前後的費用認領差異（本地既有文件全量）
 * @description
 *   FIX-126 驗收條件之一「本地批次重跑既有文件，比對修改前後的 fields 差異，
 *   逐筆確認無新增誤配」的執行工具。
 *
 *   不重打 GPT（全量重跑的 GPT 非確定性會混淆前後比較，且費用不菲），改為
 *   **確定性回放**：取本地 DB 既有 `stage_3_result.lineItems` 與各公司
 *   FieldDefinitionSet 的 lineItem 類定義，分別以「舊比對邏輯（FIX-126 前，
 *   逐字複製凍結於本檔）」與「新比對邏輯（直接 import 現行 src 程式碼）」
 *   模擬認領流程（description 優先 → classifiedAs fallback，同 FIX-108），
 *   輸出逐筆差異報告：
 *     - GAINED  ：新邏輯多認領的欄位（需逐筆人工確認非誤配）
 *     - LOST    ：新邏輯不再認領的欄位（預期：非對稱化/方向閘擋掉的反向認領）
 *     - CHANGED ：同欄位金額不同（不預期出現）
 *
 *   🔴 本腳本對資料庫**只讀不寫**。
 *   🔴 本檔為 tsx 腳本，只能在本地執行（Azure runner 映像不含 scripts/ 與 tsx）。
 *
 * @module scripts/local-verify-fix126-replay
 * @since 2026-07-22（FIX-126）
 * @lastModified 2026-07-22
 *
 * @usage npx tsx scripts/local-verify-fix126-replay.ts [輸出檔路徑]
 */
import * as dotenv from 'dotenv'
import * as fs from 'fs'

dotenv.config({ path: '.env.local' })
dotenv.config()

// ============================================================================
// 舊比對邏輯（FIX-126 前）—— 逐字複製凍結，來源：
//   src/services/extraction-v3/utils/classify-normalizer.ts @ 8b0e788
//   src/services/extraction-v3/stages/stage-3-extraction.service.ts @ 8b0e788
// ============================================================================

function oldCanonicalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

type MatchKind = 'exact' | 'substring' | null

function oldMatchLabel(candidate: string, target: string): MatchKind {
  const a = oldCanonicalizeLabel(candidate)
  const b = oldCanonicalizeLabel(target)
  if (!a || !b) return null
  if (a === b) return 'exact'

  const shorter = a.length <= b.length ? a : b
  const longer = a.length <= b.length ? b : a
  const isWordBounded =
    longer === shorter ||
    longer.includes(` ${shorter} `) ||
    longer.startsWith(`${shorter} `) ||
    longer.endsWith(` ${shorter}`)
  if (isWordBounded && shorter.length >= 8 && shorter.split(' ').length >= 2) {
    return 'substring'
  }
  return null
}

interface ChargeDef {
  key: string
  label: string
  aliases?: string[]
  fieldType?: string
}

function oldResolveUniqueChargeKey(
  candidate: string,
  chargeDefs: ChargeDef[]
): string | null {
  const exactKeys: string[] = []
  const substringKeys: string[] = []

  for (const def of chargeDefs) {
    const targets = [def.label, ...(def.aliases ?? [])]
    let best: MatchKind = null
    for (const target of targets) {
      const kind = oldMatchLabel(candidate, target)
      if (kind === 'exact') {
        best = 'exact'
        break
      }
      if (kind === 'substring') best = 'substring'
    }
    if (best === 'exact') exactKeys.push(def.key)
    else if (best === 'substring') substringKeys.push(def.key)
  }

  if (exactKeys.length === 1) return exactKeys[0]
  if (exactKeys.length === 0 && substringKeys.length === 1) return substringKeys[0]
  return null
}

// ============================================================================
// 回放：FIX-108 認領流程（description 優先 → classifiedAs fallback）
// ============================================================================

interface ReplayLineItem {
  description?: string
  classifiedAs?: string
  amount?: unknown
}

/** 以指定 resolver 模擬認領，回傳 charge key → 金額加總 */
function replayClaims(
  lineItems: ReplayLineItem[],
  chargeDefs: ChargeDef[],
  resolve: (candidate: string, defs: ChargeDef[]) => string | null
): Map<string, number> {
  const claimed = new Map<string, number>()
  const claimedItems = new Set<number>()

  lineItems.forEach((li, index) => {
    if (typeof li.amount !== 'number') return
    const key = li.description ? resolve(li.description, chargeDefs) : null
    if (key) {
      claimed.set(key, (claimed.get(key) ?? 0) + li.amount)
      claimedItems.add(index)
    }
  })

  lineItems.forEach((li, index) => {
    if (claimedItems.has(index) || typeof li.amount !== 'number') return
    const key = li.classifiedAs ? resolve(li.classifiedAs, chargeDefs) : null
    if (!key) return
    claimed.set(key, (claimed.get(key) ?? 0) + li.amount)
    claimedItems.add(index)
  })

  return claimed
}

// ============================================================================
// 主流程（唯讀）
// ============================================================================

async function main() {
  const { prisma } = await import('../src/lib/prisma')
  const { matchLabel, extractChargeDirections } = await import(
    '../src/services/extraction-v3/utils/classify-normalizer'
  )

  // 新邏輯的 resolveUniqueChargeKey（與 stage-3-extraction.service.ts 現行版一致：
  // 方向閘 → label/aliases 取最強對照 → 唯一性裁決）
  function newResolveUniqueChargeKey(
    candidate: string,
    chargeDefs: ChargeDef[]
  ): string | null {
    const exactKeys: string[] = []
    const substringKeys: string[] = []
    const candidateDirections = extractChargeDirections(candidate)

    for (const def of chargeDefs) {
      const defDirections = extractChargeDirections(def.label)
      if (defDirections.size > 0) {
        const sharesDirection = [...defDirections].some((d) =>
          candidateDirections.has(d)
        )
        if (!sharesDirection) continue
      }

      const targets = [def.label, ...(def.aliases ?? [])]
      let best: MatchKind = null
      for (const target of targets) {
        const kind = matchLabel(candidate, target)
        if (kind === 'exact') {
          best = 'exact'
          break
        }
        if (kind === 'substring') best = 'substring'
      }
      if (best === 'exact') exactKeys.push(def.key)
      else if (best === 'substring') substringKeys.push(def.key)
    }

    if (exactKeys.length === 1) return exactKeys[0]
    if (exactKeys.length === 0 && substringKeys.length === 1) return substringKeys[0]
    return null
  }

  const outPath = process.argv[2] ?? 'fix-126-replay-report.txt'
  const lines: string[] = []
  const log = (s: string) => lines.push(s)

  try {
    // 各公司的 lineItem 類欄位定義
    const defSets = await prisma.fieldDefinitionSet.findMany({
      where: { isActive: true, scope: 'COMPANY', companyId: { not: null } },
      select: { companyId: true, name: true, fields: true },
    })
    const defsByCompany = new Map<string, ChargeDef[]>()
    for (const set of defSets) {
      const all = Array.isArray(set.fields) ? (set.fields as unknown as ChargeDef[]) : []
      const chargeDefs = all.filter((d) => d.fieldType === 'lineItem')
      if (chargeDefs.length > 0 && set.companyId) {
        defsByCompany.set(set.companyId, chargeDefs)
      }
    }

    const results = await prisma.extractionResult.findMany({
      select: {
        documentId: true,
        companyId: true,
        stage3Result: true,
        document: { select: { fileName: true } },
      },
    })

    let replayed = 0
    let skippedNoDefs = 0
    let skippedNoItems = 0
    let identical = 0
    const gained: string[] = []
    const lost: string[] = []
    const changed: string[] = []

    for (const r of results) {
      const chargeDefs = r.companyId ? defsByCompany.get(r.companyId) : undefined
      if (!chargeDefs) {
        skippedNoDefs++
        continue
      }
      const stage3 = r.stage3Result as { lineItems?: ReplayLineItem[] } | null
      const lineItems = stage3?.lineItems
      if (!Array.isArray(lineItems) || lineItems.length === 0) {
        skippedNoItems++
        continue
      }

      replayed++
      const oldClaims = replayClaims(lineItems, chargeDefs, oldResolveUniqueChargeKey)
      const newClaims = replayClaims(lineItems, chargeDefs, newResolveUniqueChargeKey)

      const doc = r.document?.fileName ?? r.documentId
      let docDiffs = 0
      for (const [key, sum] of newClaims) {
        if (!oldClaims.has(key)) {
          const src = lineItems
            .filter(
              (li) =>
                (li.description &&
                  newResolveUniqueChargeKey(li.description, chargeDefs) === key) ||
                (li.classifiedAs &&
                  newResolveUniqueChargeKey(li.classifiedAs, chargeDefs) === key)
            )
            .map((li) => `"${li.description ?? li.classifiedAs}"`)
            .join(', ')
          gained.push(`GAINED  ${doc} :: ${key} = ${sum} ← ${src}`)
          docDiffs++
        } else if (Math.abs((oldClaims.get(key) ?? 0) - sum) > 0.005) {
          changed.push(`CHANGED ${doc} :: ${key} = ${oldClaims.get(key)} → ${sum}`)
          docDiffs++
        }
      }
      for (const [key, sum] of oldClaims) {
        if (!newClaims.has(key)) {
          lost.push(`LOST    ${doc} :: ${key} = ${sum}`)
          docDiffs++
        }
      }
      if (docDiffs === 0) identical++
    }

    log('FIX-126 回放比對報告（本地 DB，唯讀）')
    log(`產生時間: ${new Date().toISOString()}`)
    log('')
    log(`extraction results 總數: ${results.length}`)
    log(`回放: ${replayed}（無 lineItem 定義跳過 ${skippedNoDefs}、無 lineItems 跳過 ${skippedNoItems}）`)
    log(`前後完全一致: ${identical}/${replayed}`)
    log(`GAINED（新增認領，需逐筆確認）: ${gained.length}`)
    log(`LOST（不再認領）: ${lost.length}`)
    log(`CHANGED（金額改變）: ${changed.length}`)
    log('')
    for (const l of [...gained, ...changed, ...lost]) log(l)
  } finally {
    await prisma.$disconnect()
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8')
  console.log(`報告已寫入 ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
