/**
 * @fileoverview FIX-125 端到端驗證：合併後 Stage 2 的 `${knownFormats}` 能列出原屬副公司的格式
 * @description
 *   FIX-125 的驗收條件之一。程式修復本身有單元測試覆蓋（company-merge-transfer.test.ts），
 *   但那是對轉移函數的隔離測試 —— 它證明「格式的 companyId 被改寫」，卻沒有證明
 *   **改寫後真的會出現在 Stage 2 給 GPT 的已知格式清單裡**。中間隔著
 *   `loadFormatConfig` 的查詢條件與 `buildStage2VariableContext` 的字串組裝，
 *   任何一環對不上，FIX-125 就仍然無法達成它的目的（讓 FIX-115 在合併過的公司身上生效）。
 *
 *   本腳本串起真實的三段程式碼，不複製任何查詢邏輯：
 *     1. `mergeCompanies()`            — src/services/company.service.ts
 *     2. `Stage2FormatService` 的 `loadFormatConfig()` — 真實的 where: { companyId } 查詢
 *     3. `buildStage2VariableContext()` — 真正組出 ${knownFormats} 字串的函數
 *
 *   同時驗證正反兩條路徑：
 *     情境 A（可轉移）：副公司的格式在目標公司名下無同組唯一鍵 → 應轉移並出現在清單中
 *     情境 B（撞鍵）  ：副公司的格式與目標公司既有格式同鍵     → 應跳過、記入 skipped，
 *                       且**不得**覆寫目標公司原有的格式
 *
 *   🔴 本腳本會寫入資料庫，但只建立自己的 sandbox 資料（名稱前綴 `__FIX125_VERIFY__`），
 *      並在 finally 中一律清除。不觸碰任何既有公司或格式。
 *
 *   🔴 本檔為 tsx 腳本，只能在本地執行（Azure runner 映像不含 scripts/ 與 tsx）。
 *
 * @module scripts/local-verify-fix125-known-formats
 * @since 2026-07-21（FIX-125）
 * @lastModified 2026-07-21
 *
 * @usage npx tsx scripts/local-verify-fix125-known-formats.ts
 */
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

/** sandbox 資料的名稱前綴，用於辨識與清理 */
const PREFIX = '__FIX125_VERIFY__'

/** 情境 A：副公司獨有的格式（目標公司無同鍵）→ 應轉移 */
const FORMAT_A_NAME = `${PREFIX} Ocean Freight Layout (transferable)`
/** 情境 B：與目標公司既有格式同鍵 → 應跳過 */
const FORMAT_B_NAME = `${PREFIX} General Layout (source, collides)`
/** 目標公司既有格式，用來製造情境 B 的衝突 */
const FORMAT_T_NAME = `${PREFIX} General Layout (target, incumbent)`

interface CheckResult {
  label: string
  passed: boolean
  detail: string
}

const checks: CheckResult[] = []

function check(label: string, passed: boolean, detail: string) {
  checks.push({ label, passed, detail })
}

async function main() {
  const { prisma } = await import('../src/lib/prisma')
  const { mergeCompanies } = await import('../src/services/company.service')
  const { Stage2FormatService } = await import(
    '../src/services/extraction-v3/stages/stage-2-format.service'
  )
  const { buildStage2VariableContext } = await import(
    '../src/services/extraction-v3/utils/variable-replacer'
  )

  let sourceId: string | undefined
  let targetId: string | undefined

  try {
    // ---- 前置：找一個既有 user 當 createdById（Company.createdById 為必填外鍵）----
    const user = await prisma.user.findFirst({ select: { id: true } })
    if (!user) {
      throw new Error('本地資料庫沒有任何 user，無法建立測試公司（createdById 為必填）')
    }

    // ---- 建立 sandbox：目標公司 + 副公司 ----
    const target = await prisma.company.create({
      data: {
        name: `${PREFIX} Target Co`,
        displayName: `${PREFIX} Target Co`,
        createdById: user.id,
        nameVariants: [],
        identificationPatterns: [],
      },
      select: { id: true },
    })
    targetId = target.id

    const source = await prisma.company.create({
      data: {
        name: `${PREFIX} Source Co`,
        displayName: `${PREFIX} Source Co`,
        createdById: user.id,
        nameVariants: [],
        identificationPatterns: [],
      },
      select: { id: true },
    })
    sourceId = source.id

    // 目標公司既有格式：INVOICE / GENERAL（情境 B 的衝突對象）
    const incumbent = await prisma.documentFormat.create({
      data: {
        companyId: targetId,
        documentType: 'INVOICE',
        documentSubtype: 'GENERAL',
        name: FORMAT_T_NAME,
        commonTerms: ['incumbent-term'],
        identificationRules: { keywords: ['incumbent-keyword'] },
      },
      select: { id: true },
    })

    // 副公司格式 A：INVOICE / OCEAN_FREIGHT（目標公司沒有此組合 → 應可轉移）
    const formatA = await prisma.documentFormat.create({
      data: {
        companyId: sourceId,
        documentType: 'INVOICE',
        documentSubtype: 'OCEAN_FREIGHT',
        name: FORMAT_A_NAME,
        commonTerms: ['ocean-term'],
        identificationRules: { keywords: ['bill-of-lading', 'vessel'] },
      },
      select: { id: true },
    })

    // 副公司格式 B：INVOICE / GENERAL（與 incumbent 同鍵 → 應跳過）
    const formatB = await prisma.documentFormat.create({
      data: {
        companyId: sourceId,
        documentType: 'INVOICE',
        documentSubtype: 'GENERAL',
        name: FORMAT_B_NAME,
        commonTerms: ['source-general-term'],
        identificationRules: { keywords: ['source-general-keyword'] },
      },
      select: { id: true },
    })

    const stage2 = new Stage2FormatService(prisma)
    /** loadFormatConfig 宣告為 private，但 TypeScript 的 private 只存在於編譯期；
     *  此處刻意呼叫真實方法，避免在驗證腳本裡複製一份查詢條件而失去驗證意義。 */
    const loadFormatConfig = (companyId: string) =>
      (
        stage2 as unknown as {
          loadFormatConfig: (id: string) => Promise<{
            source: string
            formats: Array<{ formatId: string; formatName: string; patterns: string[] }>
          }>
        }
      ).loadFormatConfig(companyId)

    // ---- 合併前的基準 ----
    const before = await loadFormatConfig(targetId)
    const beforeNames = before.formats.map((f) => f.formatName)
    check(
      '合併前：目標公司的已知格式清單不含副公司的格式',
      !beforeNames.includes(FORMAT_A_NAME) && beforeNames.length === 1,
      `清單 = [${beforeNames.join(' | ')}]`
    )

    // ---- 執行真實合併 ----
    const merged = await mergeCompanies(sourceId, targetId)
    const report = merged.knowledgeTransfer

    check(
      '轉移報告：documentFormats 轉移 1 筆',
      report.transferred.documentFormats === 1,
      `transferred = ${JSON.stringify(report.transferred)}`
    )

    const skippedFormat = report.skipped.find((s) => s.recordId === formatB.id)
    check(
      '轉移報告：撞鍵的格式被跳過並記錄（情境 B）',
      skippedFormat !== undefined,
      skippedFormat
        ? `relation=${skippedFormat.relation} label="${skippedFormat.label}" reason=${skippedFormat.reason}`
        : `skipped 中找不到 ${formatB.id}；skipped = ${JSON.stringify(report.skipped)}`
    )

    // ---- 核心驗收：合併後的已知格式清單 ----
    const after = await loadFormatConfig(targetId)
    const afterNames = after.formats.map((f) => f.formatName)

    check(
      '🔴 核心：合併後目標公司的已知格式清單包含原屬副公司的格式（情境 A）',
      afterNames.includes(FORMAT_A_NAME),
      `清單 = [${afterNames.join(' | ')}]`
    )

    check(
      '合併後：目標公司原有格式未被覆寫，清單為 2 筆',
      afterNames.includes(FORMAT_T_NAME) && after.formats.length === 2,
      `共 ${after.formats.length} 筆 = [${afterNames.join(' | ')}]`
    )

    check(
      '合併後：配置來源為 COMPANY_SPECIFIC',
      after.source === 'COMPANY_SPECIFIC',
      `source = ${after.source}`
    )

    // ---- 最終驗收：真正注入 Prompt 的 ${knownFormats} 字串 ----
    const ctx = buildStage2VariableContext({
      companyName: `${PREFIX} Target Co`,
      knownFormats: after.formats.map((f) => ({
        name: f.formatName,
        description: f.patterns?.join(', ') || null,
      })),
      fileName: 'verify.pdf',
      pageCount: 1,
    })
    const knownFormats = ctx.knownFormats ?? ''

    check(
      '🔴 核心：${knownFormats} 字串含轉移過來的格式名（這就是 GPT 實際看到的清單）',
      knownFormats.includes(FORMAT_A_NAME),
      `\n--- ${'$'}{knownFormats} 實際內容 ---\n${knownFormats}\n---`
    )

    check(
      '${knownFormats} 保留該格式的識別關鍵字（供 GPT 判別版面）',
      knownFormats.includes('bill-of-lading'),
      knownFormats.includes('bill-of-lading') ? 'keywords 已帶入' : 'keywords 遺失'
    )

    // ---- 副作用檢查：撞鍵的格式應留在原地，而非被刪或被改 ----
    const formatBAfter = await prisma.documentFormat.findUnique({
      where: { id: formatB.id },
      select: { companyId: true },
    })
    check(
      '撞鍵的格式仍留在副公司名下（未被靜默改動）',
      formatBAfter?.companyId === sourceId,
      `companyId = ${formatBAfter?.companyId ?? '(已不存在)'}`
    )

    const formatAAfter = await prisma.documentFormat.findUnique({
      where: { id: formatA.id },
      select: { companyId: true },
    })
    check(
      '轉移的是同一筆記錄（id 不變，非複製）',
      formatAAfter?.companyId === targetId,
      `format A companyId = ${formatAAfter?.companyId ?? '(已不存在)'}`
    )

    const incumbentAfter = await prisma.documentFormat.findUnique({
      where: { id: incumbent.id },
      select: { companyId: true, name: true },
    })
    check(
      '目標公司原有格式內容未受影響',
      incumbentAfter?.name === FORMAT_T_NAME && incumbentAfter?.companyId === targetId,
      `name = ${incumbentAfter?.name ?? '(已不存在)'}`
    )

    // ---- 輸出 ----
    console.log('\n=== FIX-125 端到端驗證：合併後 ${knownFormats} ===\n')
    for (const c of checks) {
      console.log(`${c.passed ? '✅' : '❌'} ${c.label}`)
      console.log(`   ${c.detail}\n`)
    }

    const failed = checks.filter((c) => !c.passed)
    console.log(
      `結果：${checks.length - failed.length}/${checks.length} 項通過` +
        (failed.length > 0 ? `，${failed.length} 項失敗` : '')
    )
    if (failed.length > 0) {
      process.exitCode = 1
    }
  } finally {
    // ---- 清理 sandbox（無論成敗都執行）----
    const { prisma } = await import('../src/lib/prisma')
    const ids = [sourceId, targetId].filter((v): v is string => Boolean(v))
    if (ids.length > 0) {
      const deletedFormats = await prisma.documentFormat.deleteMany({
        where: { companyId: { in: ids } },
      })
      const deletedCompanies = await prisma.company.deleteMany({
        where: { id: { in: ids } },
      })
      console.log(
        `\n[清理] 已刪除 ${deletedFormats.count} 個測試格式、${deletedCompanies.count} 間測試公司`
      )
    }
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error('[驗證失敗]', error)
  process.exit(1)
})
