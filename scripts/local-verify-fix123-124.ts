/**
 * @fileoverview FIX-123 / FIX-124 實機驗證：從 Stage 2 的 GPT 原始回應反推比對鏈命中路徑
 * @description
 *   批次重跑後，僅看 stage2Result 無法區分兩種「isNewFormat: true」：
 *     (a) GPT 主動宣告「非已知格式」（matchedKnownFormat 為 null）→ 屬辨識能力/資料面問題
 *     (b) GPT 宣告匹配，但名稱比對沒接住 → 屬 FIX-123 未覆蓋的漏洞
 *   本腳本解析 extraction_results.stage_2_ai_details.response 取出 matchedKnownFormat，
 *   與該公司的 DocumentFormat 名稱逐一比對，還原 resolveFormatId 會走到哪一段。
 *
 *   唯讀，不寫入任何資料。
 *
 * @module scripts/local-verify-fix123-124
 * @since 2026-07-21（FIX-123/124 實機驗證）
 * @lastModified 2026-07-21
 *
 * @usage npx tsx scripts/local-verify-fix123-124.ts
 */
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

/** 從 GPT 回應文字取出 JSON 物件（可能包在 markdown fence 裡） */
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

/** 還原 resolveFormatId 的比對鏈，回報這筆會命中哪一段 */
function classify(
  matchedKnownFormat: string | null,
  formatName: string | null,
  formatNames: string[]
): string {
  if (!matchedKnownFormat && !formatName) return '無回傳值'

  if (matchedKnownFormat) {
    // 步驟 1：完全相等
    if (formatNames.includes(matchedKnownFormat)) return '步驟1 完全相等'

    // 步驟 2：剝除 ': ' 後綴後完全相等（FIX-123 BUG-1）
    const sep = matchedKnownFormat.indexOf(': ')
    if (sep > 0) {
      const stripped = matchedKnownFormat.slice(0, sep).trim()
      const hits = formatNames.filter((n) => n === stripped)
      if (hits.length === 1) return '步驟2 剝除後綴（FIX-123 BUG-1）'
      if (hits.length > 1) return '步驟2 命中多筆→守門擋下'
    }
  }

  // 步驟 3：反向包含（FIX-123 BUG-2）
  const haystacks = [matchedKnownFormat, formatName].filter((s): s is string => !!s)
  const contained = formatNames.filter((n) => haystacks.some((h) => h.includes(n)))
  if (contained.length === 1) return '步驟3 反向包含（FIX-123 BUG-2）'
  if (contained.length > 1) return '步驟3 命中多筆→守門擋下'

  // 步驟 4：既有模糊比對（DB 名稱 ⊃ formatName）
  if (formatName && formatNames.some((n) => n.toLowerCase().includes(formatName.toLowerCase()))) {
    return '步驟4 既有模糊比對'
  }

  return matchedKnownFormat ? '未命中（GPT 有給名稱）' : '未命中（GPT 回 null）'
}

async function main() {
  const { default: prisma } = await import('../src/lib/prisma')

  const formats = await prisma.documentFormat.findMany({
    select: { id: true, name: true, companyId: true },
  })
  const byCompany = new Map<string, string[]>()
  for (const f of formats) {
    if (!f.companyId || !f.name) continue
    const list = byCompany.get(f.companyId) ?? []
    list.push(f.name)
    byCompany.set(f.companyId, list)
  }

  const results = await prisma.extractionResult.findMany({
    select: {
      documentId: true,
      stage2Result: true,
      stage2AiDetails: true,
      document: { select: { fileName: true, companyId: true } },
    },
  })

  const classCount = new Map<string, number>()
  const detail: string[] = []
  const nexDetail: string[] = []

  for (const r of results) {
    const s2 = r.stage2Result as { isNewFormat?: boolean; formatId?: string } | null
    if (!s2 || s2.isNewFormat === undefined) continue

    const details = r.stage2AiDetails as { response?: unknown } | null
    const parsed = parseGptResponse(details?.response)
    const matched = (parsed?.matchedKnownFormat as string | null) ?? null
    const fname = (parsed?.formatName as string | null) ?? null
    const names = r.document?.companyId ? (byCompany.get(r.document.companyId) ?? []) : []

    const bucket = classify(matched, fname, names)
    const label = `${bucket} | isNew=${s2.isNewFormat} formatId=${s2.formatId ? '有' : '無'}`
    classCount.set(label, (classCount.get(label) ?? 0) + 1)

    // 走步驟 2/3（FIX-123 新增路徑）或最終未命中者，都要看明細
    if (bucket !== '步驟1 完全相等') {
      detail.push(
        `  ${r.document?.fileName ?? '?'} [${r.documentId.slice(0, 8)}]\n` +
          `    分類: ${bucket} | isNew=${s2.isNewFormat} formatId=${s2.formatId ? '有' : '無'}\n` +
          `    matchedKnownFormat: ${matched === null ? '(null)' : `"${matched.slice(0, 110)}"`}\n` +
          `    formatName:         ${fname === null ? '(null)' : `"${fname.slice(0, 110)}"`}`
      )
    }

    // FIX-123 的指標案例：Nippon Express 3 份副本
    if (/NEX|Nippon/i.test(r.document?.fileName ?? '')) {
      nexDetail.push(
        `  ${r.document?.fileName ?? '?'} [${r.documentId.slice(0, 8)}]\n` +
          `    分類: ${bucket} | isNew=${s2.isNewFormat} formatId=${s2.formatId ? '有' : '無'}\n` +
          `    matchedKnownFormat: ${matched === null ? '(null)' : `"${matched.slice(0, 140)}"`}`
      )
    }
  }

  console.log('=== 比對鏈命中分類（全部有 stage2 結果的文件）===')
  ;[...classCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${v.toString().padStart(3)}  ${k}`))

  console.log(`\n=== Nippon Express 指標案例 ===`)
  nexDetail.forEach((d) => console.log(d))

  console.log(`\n=== 未走「步驟1 完全相等」的文件明細（${detail.length} 份）===`)
  detail.forEach((d) => console.log(d))

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exitCode = 1
})
