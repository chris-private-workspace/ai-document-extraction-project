/**
 * @fileoverview 為 Toll 香港實體補建 template field mapping（唯讀 inspect / dryrun / 寫入 write）
 * @description
 *   `Toll Global Forwarding (Hong Kong) Ltd`（id 1ce60466…）有 34 份文件但 **0 組映射**，
 *   導致 `resolveMapping` 回傳 0 條規則、`matchDocuments` 直接拋 MAPPING_NOT_FOUND，
 *   31 份進不了模板實例列。
 *
 *   同族的 `Toll Global Forwarder Limited`（id 8f933f53…）有 2 組映射（Inbound 16 條 /
 *   Outbound 14 條）。使用者 2026-08-06 目視發票確認：**兩者是不同法人**
 *   （泰國 Toll Global Forwarding (Thailand) Limited vs 香港 Toll Global Forwarding
 *   (Hong Kong) Ltd），因此**不可合併公司**，正解是為香港實體補一組自己的映射。
 *
 *   🔴 但「不同法人」不等於「發票格式不同」。複製規則前必須先證明兩家文件的
 *      `mappedFields` key 結構相容 —— 本腳本 inspect 階段就是做這件事，不預設答案。
 *
 *   🔴 本操作是**新增**（新 company_id 的 mapping），不是修改既有 mapping，
 *      故不會奪走泰國那組的規則（對照 FIX-150 的教訓）。
 *
 * @module scripts/tmp-add-toll-hk-mappings
 * @since 2026-08-06
 * @lastModified 2026-08-06
 *
 * @usage
 *   npx tsx scripts/tmp-add-toll-hk-mappings.ts inspect
 *   npx tsx scripts/tmp-add-toll-hk-mappings.ts dryrun
 *   npx tsx scripts/tmp-add-toll-hk-mappings.ts write
 */
import * as dotenv from 'dotenv'
import * as fs from 'fs'

dotenv.config({ path: '.env.local' })
dotenv.config()

const MODE = (process.argv[2] || 'inspect').toLowerCase()

/** 來源：泰國實體（有規則） */
const SRC_COMPANY_ID = '8f933f53-fae5-4c52-944c-3eac699e4ac4'
/** 目標：香港實體（0 規則） */
const DST_COMPANY_ID = '1ce60466-ecfa-4e82-aee0-13c3ccccc192'

const RUN_TAG = 'toll-hk-mapping 2026-08-06'
const SNAPSHOT = 'toll-hk-mapping-snapshot-before-write.json'

const line = (s = '') => console.log(s)
const hr = (t: string) => {
  line()
  line('='.repeat(100))
  line(t)
  line('='.repeat(100))
}

/**
 * 用同一組規則跑 previewMatch，回傳可比較的輪廓。
 *
 * 🔴 不直接查 `Document.mappedFields` —— 那不是 DB 欄位。引擎的 `loadDocuments`
 *    是從 `extractionResult.fieldMappings` 經 `extractFieldValues` 組出，再疊加
 *    `flattenChargeItems`（li_* 展平）與 `injectRefNumberFields`。要看「規則實際
 *    取不取得到值」，唯一忠實的做法是走 previewMatch 並讀 `unresolvedSourceKeys`。
 */
async function profileWithRules(
  prisma: import('@prisma/client').PrismaClient,
  engine: { previewMatch: (p: Record<string, unknown>) => Promise<PreviewLike> },
  companyIdOfDocs: string,
  dataTemplateId: string,
  companyIdOfRules: string,
  take = 40
): Promise<{
  docCount: number
  valid: number
  invalid: number
  avgFilled: number
  unresolved: Map<string, number>
} | null> {
  const docs = await prisma.document.findMany({
    where: { companyId: companyIdOfDocs, status: 'MAPPING_COMPLETED' },
    select: { id: true },
    take,
  })
  if (docs.length === 0) return null

  const preview = await engine.previewMatch({
    documentIds: docs.map((d) => d.id),
    dataTemplateId,
    companyId: companyIdOfRules,
  })

  const unresolved = new Map<string, number>()
  const filled: number[] = []
  for (const r of preview.rows) {
    for (const k of Object.keys(r.unresolvedSourceKeys || {})) {
      unresolved.set(k, (unresolved.get(k) || 0) + 1)
    }
    filled.push(
      Object.values(r.fieldValues || {}).filter(
        (v) => v !== null && v !== undefined && v !== ''
      ).length
    )
  }
  return {
    docCount: preview.rows.length,
    valid: preview.summary.validRows,
    invalid: preview.summary.invalidRows,
    avgFilled: filled.length ? filled.reduce((a, b) => a + b, 0) / filled.length : 0,
    unresolved,
  }
}

/**
 * 統計一家公司所有已完成文件的 `extractionResult.fieldMappings` 中「有值」的 key。
 *
 * 這是映射規則 `sourceField` 實際查詢的對象：引擎的 `extractFieldValues` 把
 * `{ key: { value, rawValue } }` 攤平成 `{ key: value ?? rawValue ?? null }`。
 */
async function fieldMappingKeyProfile(
  prisma: import('@prisma/client').PrismaClient,
  companyId: string
): Promise<{ docCount: number; keys: Map<string, number> }> {
  const docs = await prisma.document.findMany({
    where: { companyId, status: 'MAPPING_COMPLETED' },
    select: { extractionResult: { select: { fieldMappings: true } } },
  })
  const keys = new Map<string, number>()
  let counted = 0
  for (const d of docs) {
    const fm = d.extractionResult?.fieldMappings as
      | Record<string, { value?: unknown; rawValue?: unknown }>
      | null
    if (!fm || typeof fm !== 'object') continue
    counted++
    for (const [k, fd] of Object.entries(fm)) {
      if (!fd || typeof fd !== 'object') continue
      const v = fd.value ?? fd.rawValue ?? null
      if (v === null || v === undefined || v === '') continue
      keys.set(k, (keys.get(k) || 0) + 1)
    }
  }
  // 🔴 分母用「真的有 fieldMappings 的份數」，不是文件總數 —— 否則零值會被誤讀
  return { docCount: counted, keys }
}

type PreviewLike = {
  rows: Array<{
    fieldValues?: Record<string, unknown>
    unresolvedSourceKeys?: Record<string, unknown>
  }>
  summary: { validRows: number; invalidRows: number }
}

async function main() {
  const { default: prisma } = await import('../src/lib/prisma')

  const [src, dst] = await Promise.all([
    prisma.company.findUnique({
      where: { id: SRC_COMPANY_ID },
      select: { id: true, name: true, _count: { select: { documents: true } } },
    }),
    prisma.company.findUnique({
      where: { id: DST_COMPANY_ID },
      select: { id: true, name: true, _count: { select: { documents: true } } },
    }),
  ])
  if (!src || !dst) {
    line('🔴 來源或目標公司不存在，中止')
    await prisma.$disconnect()
    return
  }

  hr('1  來源與目標')
  line(`  來源（有規則）  ${src.name}`)
  line(`                  id=${src.id}　文件 ${src._count.documents}`)
  line(`  目標（0 規則）  ${dst.name}`)
  line(`                  id=${dst.id}　文件 ${dst._count.documents}`)

  // ---------------------------------------------------------------- 來源規則
  const srcMappings = await prisma.templateFieldMapping.findMany({
    where: { companyId: SRC_COMPANY_ID, isActive: true },
    select: {
      id: true,
      name: true,
      scope: true,
      dataTemplateId: true,
      documentFormatId: true,
      mappings: true,
      priority: true,
      description: true,
      dataTemplate: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  const dstMappings = await prisma.templateFieldMapping.findMany({
    where: { companyId: DST_COMPANY_ID },
    select: { id: true, name: true, isActive: true },
  })

  hr('2  來源的映射組（將被複製的內容）')
  line(`  來源 ${srcMappings.length} 組　目標現有 ${dstMappings.length} 組`)
  for (const m of srcMappings) {
    const rules = (m.mappings as unknown as Array<Record<string, unknown>>) || []
    line()
    line(`  ── ${m.name}`)
    line(`     模板       ${m.dataTemplate.name}`)
    line(`     scope      ${m.scope}　formatId=${m.documentFormatId ?? '（無）'}　priority=${m.priority}`)
    line(`     規則數     ${rules.length}`)
    const srcFields = rules.map((r) => String(r.sourceField)).sort()
    line(`     sourceField: ${srcFields.join(', ')}`)
  }

  // ------------------------------------------------- 相容性驗證（含對照組）
  const { templateMatchingEngineService } = await import(
    '../src/services/template-matching-engine.service'
  )
  const engine = templateMatchingEngineService as unknown as {
    previewMatch: (p: Record<string, unknown>) => Promise<PreviewLike>
  }

  // ---- 先建立兩家的 fieldMappings key 輪廓（規則吃的就是這些 key）----
  const [srcProf, dstProf] = await Promise.all([
    fieldMappingKeyProfile(prisma, SRC_COMPANY_ID),
    fieldMappingKeyProfile(prisma, DST_COMPANY_ID),
  ])
  const srcKeys = srcProf.keys
  const dstKeys = dstProf.keys
  const srcDocCount = srcProf.docCount
  const dstDocCount = dstProf.docCount

  hr('3  兩家文件的 fieldMappings key 輪廓')
  line(`  來源（泰國）已完成文件 ${srcDocCount} 份，出現過 ${srcKeys.size} 個有值欄位`)
  line(`  目標（香港）已完成文件 ${dstDocCount} 份，出現過 ${dstKeys.size} 個有值欄位`)
  const onlySrc = [...srcKeys.keys()].filter((k) => !dstKeys.has(k))
  const onlyDst = [...dstKeys.keys()].filter((k) => !srcKeys.has(k))
  const bothK = [...srcKeys.keys()].filter((k) => dstKeys.has(k))
  line()
  line(`  兩家都有 ${bothK.length}　只有來源 ${onlySrc.length}　只有目標 ${onlyDst.length}`)
  if (onlySrc.length) line(`  只有來源：${onlySrc.slice(0, 25).join(', ')}${onlySrc.length > 25 ? ` …+${onlySrc.length - 25}` : ''}`)
  if (onlyDst.length) line(`  只有目標：${onlyDst.slice(0, 25).join(', ')}${onlyDst.length > 25 ? ` …+${onlyDst.length - 25}` : ''}`)

  // 🔴 目標公司實際有值的欄位全清單 —— 要為香港建規則，得先知道它到底有什麼
  const ruleSourceFields = new Set<string>()
  for (const m of srcMappings) {
    for (const r of (m.mappings as unknown as Array<Record<string, unknown>>) || []) {
      ruleSourceFields.add(String(r.sourceField))
    }
  }
  line()
  line(`  🔴 目標（香港）實際有值的欄位全清單（${dstKeys.size} 個，依出現份數排序）：`)
  line(`     ${'欄位'.padEnd(46)} ${'份數'.padStart(8)}  來源規則有引用？`)
  line(`     ${'-'.repeat(46)} ${'-'.repeat(8)}  ${'-'.repeat(16)}`)
  for (const [k, n] of [...dstKeys.entries()].sort((a, b) => b[1] - a[1])) {
    const used = ruleSourceFields.has(k)
    line(
      `     ${k.padEnd(46)} ${`${n}/${dstDocCount}`.padStart(8)}  ${used ? '✅ 有' : '🔴 沒有'}`
    )
  }
  const dstCovered = [...dstKeys.keys()].filter((k) => ruleSourceFields.has(k))
  line()
  line(
    `  ⇒ 目標的 ${dstKeys.size} 個有值欄位中，只有 ${dstCovered.length} 個被來源規則引用`
  )

  hr('4  🔴 關鍵驗證：來源規則套在目標文件上的效果（含對照組）')
  line('  作法：previewMatch 傳「目標公司的文件」+「來源公司的 companyId」，')
  line('        等同模擬「規則複製過去之後」的效果。')
  line('  🔵 對照組＝同一組規則套在來源自己的文件上 —— 沒有它就無法判讀數字好壞。')

  let allCompatible = true
  for (const m of srcMappings) {
    const rules = (m.mappings as unknown as Array<Record<string, unknown>>) || []
    const [dstProfile, srcProfile] = await Promise.all([
      profileWithRules(prisma, engine, DST_COMPANY_ID, m.dataTemplateId, SRC_COMPANY_ID),
      profileWithRules(prisma, engine, SRC_COMPANY_ID, m.dataTemplateId, SRC_COMPANY_ID),
    ])

    line()
    line(`  ── ${m.dataTemplate.name}（${rules.length} 條規則）`)
    if (!dstProfile || !srcProfile) {
      line('     🔴 其中一方沒有已完成文件，無法比較')
      allCompatible = false
      continue
    }
    line(
      `     目標（香港）${String(dstProfile.docCount).padStart(3)} 份　通過 ${dstProfile.valid}　未通過 ${dstProfile.invalid}　平均填入 ${dstProfile.avgFilled.toFixed(1)} 欄`
    )
    line(
      `  🔵 對照（泰國）${String(srcProfile.docCount).padStart(3)} 份　通過 ${srcProfile.valid}　未通過 ${srcProfile.invalid}　平均填入 ${srcProfile.avgFilled.toFixed(1)} 欄`
    )

    // 🔴 逐條規則：sourceField 在兩家的 fieldMappings 中實際有值的份數。
    //    不用 unresolvedSourceKeys —— 它的 key 是 **targetField** 而非 sourceField，
    //    拿 sourceField 去查會全部落空並偽裝成「零問題」。
    line()
    line(
      `     ${'sourceField'.padEnd(42)} ${'目標有值'.padStart(12)} ${'對照有值'.padStart(12)}`
    )
    line(`     ${'-'.repeat(42)} ${'-'.repeat(12)} ${'-'.repeat(12)}`)
    let missingInDst = 0
    for (const r of rules) {
      const sf = String(r.sourceField)
      const d = dstKeys.get(sf) || 0
      const s = srcKeys.get(sf) || 0
      const dPct = dstDocCount ? d / dstDocCount : 0
      const sPct = srcDocCount ? s / srcDocCount : 0
      // 對照組有、目標沒有（差 50 個百分點以上）＝ 這條規則搬過去等於空轉
      const bad = sPct - dPct > 0.5
      if (bad) missingInDst++
      line(
        `  ${bad ? '🔴' : '  '} ${sf.padEnd(42)} ${`${d}/${dstDocCount}`.padStart(12)} ${`${s}/${srcDocCount}`.padStart(12)}`
      )
    }
    if (missingInDst > 0) {
      allCompatible = false
      line(`     🔴 ${missingInDst}/${rules.length} 條規則的來源欄位在目標文件幾乎都沒有值`)
    } else {
      line(`     ✅ 每條規則的來源欄位在目標文件的覆蓋率都不低於對照組`)
    }
  }

  hr('4  相容性結論')
  if (allCompatible) {
    line('  ✅ 兩家的欄位結構相容 —— 複製規則是合理的')
  } else {
    line('  🔴 有差異 —— 見上方標記，複製前需人工確認')
  }

  if (MODE === 'inspect' || MODE === 'dryrun') {
    hr(`完成（${MODE}：全程唯讀，未寫入任何資料）`)
    line(
      MODE === 'inspect'
        ? '  下一步：npx tsx scripts/tmp-add-toll-hk-mappings.ts dryrun'
        : '  若接受上述結果：npx tsx scripts/tmp-add-toll-hk-mappings.ts write'
    )
    await prisma.$disconnect()
    return
  }

  // ---------------------------------------------------------------- write
  if (MODE !== 'write') {
    line(`\n🔴 未知模式「${MODE}」，可用：inspect / dryrun / write`)
    await prisma.$disconnect()
    return
  }

  hr('5  write —— 前置快照')
  const before = await prisma.templateFieldMapping.findMany({
    where: { companyId: { in: [SRC_COMPANY_ID, DST_COMPANY_ID] } },
  })
  const totalBefore = await prisma.templateFieldMapping.count()
  fs.writeFileSync(
    SNAPSHOT,
    JSON.stringify(
      { runTag: RUN_TAG, capturedAt: new Date().toISOString(), totalBefore, mappings: before },
      null,
      2
    )
  )
  line(`  快照已寫出：${SNAPSHOT}`)
  line(`  兩家現有映射組 ${before.length}　全庫 template_field_mappings ${totalBefore}`)

  // 冪等：目標已有該模板的 mapping 就跳過
  const existingDst = await prisma.templateFieldMapping.findMany({
    where: { companyId: DST_COMPANY_ID, isActive: true },
    select: { dataTemplateId: true },
  })
  const existingTemplateIds = new Set(existingDst.map((e) => e.dataTemplateId))

  hr('6  write —— 建立目標公司的映射組（單一交易）')
  const created: Array<{ id: string; name: string; rules: number }> = []
  await prisma.$transaction(async (tx) => {
    for (const m of srcMappings) {
      if (existingTemplateIds.has(m.dataTemplateId)) {
        line(`  ⏭  ${m.dataTemplate.name} —— 目標已有該模板的映射組，跳過（冪等）`)
        continue
      }
      const rules = (m.mappings as unknown as Array<Record<string, unknown>>) || []
      const rec = await tx.templateFieldMapping.create({
        data: {
          dataTemplateId: m.dataTemplateId,
          scope: m.scope,
          companyId: DST_COMPANY_ID,
          documentFormatId: null, // 不沿用來源的 formatId（格式屬於來源公司）
          name: `${dst.name} - ${m.dataTemplate.name}`,
          description: `${RUN_TAG}：複製自「${src.name}」的同名映射組（${m.id}）。兩者為同集團不同法人（泰國 / 香港），發票欄位結構經 dryrun 驗證相容。`,
          mappings: m.mappings as never,
          priority: m.priority,
          isActive: true,
        },
        select: { id: true, name: true },
      })
      created.push({ id: rec.id, name: rec.name, rules: rules.length })
      line(`  ✓ ${rec.name}　規則 ${rules.length} 條　id=${rec.id}`)
    }
  })

  hr('7  write —— 事後核對（數量閘）')
  const totalAfter = await prisma.templateFieldMapping.count()
  const dstAfter = await prisma.templateFieldMapping.findMany({
    where: { companyId: DST_COMPANY_ID, isActive: true },
    select: { id: true, dataTemplateId: true },
  })
  line(`  全庫 template_field_mappings  ${totalBefore} → ${totalAfter}（+${totalAfter - totalBefore}）`)
  line(`  目標公司映射組                ${existingDst.length} → ${dstAfter.length}`)
  line(`  本次建立                      ${created.length}`)

  const expected = srcMappings.filter((m) => !existingTemplateIds.has(m.dataTemplateId)).length
  if (created.length !== expected) {
    line(`  🔴 數量閘失敗：預期建立 ${expected}，實際 ${created.length}`)
  } else {
    line(`  ✅ 數量閘通過（預期 ${expected}）`)
  }

  // 驗收：目標公司現在能解析到規則了嗎
  const { templateFieldMappingService } = await import(
    '../src/services/template-field-mapping.service'
  )
  line()
  line('  🔴 驗收：resolveMapping 對目標公司的回傳')
  for (const m of srcMappings) {
    const cfg = await templateFieldMappingService.resolveMapping({
      dataTemplateId: m.dataTemplateId,
      companyId: DST_COMPANY_ID,
    })
    line(`     ${m.dataTemplate.name.padEnd(48)} 規則 ${cfg.mappings.length}`)
  }
  line()
  line(`  回滾依據：description 前綴「${RUN_TAG}」+ 快照檔 ${SNAPSHOT}`)
  line(`  ⚠️ 補映射不回溯 —— 那 31 份仍需重跑模板匹配才會進實例列`)

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
