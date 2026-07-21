/**
 * @fileoverview 清除 2026-06-16 測試 session 遺留的公司 / 格式 / Prompt 配置（FIX-125 存量）
 * @description
 *   FIX-125 的存量盤點原本假設「已 MERGED 公司名下的格式是該歸位的處理知識」。
 *   查證後推翻該假設 —— 本地這批不是業務資料，而是 2026-06-16 06:22~06:32 一次連續
 *   測試 session 的殘留：
 *
 *     06:22:16  TEST RICH KING HONG Stage2 COMPANY override
 *     06:26:51  TEST MODERN LEASING Stage2 COMPANY override
 *     06:28:48  公司 DHL EXPRESS (HK) LIMITED (AUTO_CREATED)
 *     06:28:53  格式 DHL Express Invoice (HK/貨運發票模板)
 *     06:29:21  TEST DHL EXPRESS HK Stage2 COMPANY override
 *     06:29:44  公司 DHL Express (Hong Kong) Limited / DHL Express
 *     06:29:48  格式 DHL Express 電子發票（INV/ACCOUNT SUMMARY）
 *     06:32:25  TEST DHL-BB Stage2 COMPANY override
 *     06:32:31  公司 DHL EXPRESS (HK) OPERATIONS LTD.
 *     06:32:36  格式 DHL Express 物流發票—標準小型表格
 *
 *   佐證：3 個格式 fileCount 全為 0、3 間公司文件數 0、Prompt 配置名稱皆以 TEST 起始
 *   且 description 標明「示範用」、id 前綴同批（cmqg9…）。三個格式的 identificationRules
 *   描述高度雷同（連舉例日期都相同），是同一版面因公司被重複 AUTO_CREATED 三次而各建一份。
 *
 *   🔴 其中 3 筆 Prompt 配置 `is_active = true` 且掛在**有真實文件的 ACTIVE 公司**上，
 *      並非單純殘留而是現行 bug：它們 merge_strategy = OVERRIDE，會整個取代全域 Stage 2
 *      prompt，而自身 template 不含 `${knownFormats}`（FIX-115 的注入點被洗掉），
 *      system_prompt 又把 `"matchedKnownFormat": null` 寫死在 JSON 範例裡，誘導模型永遠
 *      回傳 null（FIX-123 比對鏈的輸入被破壞）。影響 DHL Express 41 份、
 *      RICH KING HONG 1 份、MODERN LEASING 1 份文件。
 *
 *   刪除前逐項驗證安全條件，任一項不符即中止且不刪任何東西。
 *
 *   🔴 本檔為 tsx 腳本，只能在本地執行（Azure runner 映像不含 scripts/ 與 tsx）。
 *      腳本內的 id 為**本地值**，Azure 的對應記錄 id 不同，不可直接套用。
 *
 * @module scripts/local-cleanup-test-residue
 * @since 2026-07-21（FIX-125 存量處理）
 * @lastModified 2026-07-21
 *
 * @usage
 *   npx tsx scripts/local-cleanup-test-residue.ts                        # dry-run（預設）
 *   RUN_DELETE_TEST_RESIDUE=true npx tsx scripts/local-cleanup-test-residue.ts   # 實際刪除
 */
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

/** 3 間測試中 AUTO_CREATED 並設為 MERGED 的公司 */
const TARGET_COMPANY_IDS = [
  'd0cade87-fc6b-4f93-89ea-60c5fdd6ebbd', // DHL EXPRESS (HK) LIMITED
  'bb9b8831-11f3-4ebf-bb78-397c8e9ad8bd', // DHL Express (Hong Kong) Limited / DHL Express
  '08509190-b61f-4248-b02b-807b4c9f1a3e', // DHL EXPRESS (HK) OPERATIONS LTD.
]

/** 3 個掛在上述公司名下、fileCount 為 0 的格式 */
const TARGET_FORMAT_IDS = [
  'cmqg9haq40005i8xg585vcsfi', // DHL Express Invoice (HK/貨運發票模板)
  'cmqg9ihg70007i8xg38fcos2s', // DHL Express 電子發票（INV/ACCOUNT SUMMARY）模板
  'cmqg9m2tu0009i8xgt7ftnr6h', // DHL Express 物流發票—標準小型表格+付款資訊版型
]

/** 4 個 TEST Prompt 配置（1 個在 MERGED 公司名下，3 個 is_active 掛在 ACTIVE 公司上） */
const TARGET_PROMPT_CONFIG_IDS = [
  'cmqg9ludg0008i8xgw4netqb6', // TEST DHL-BB Stage2 COMPANY override（inactive）
  'cmqg9hwdr0006i8xg13ca6rf4', // TEST DHL EXPRESS HK Stage2 COMPANY override（active，DHL Express 41 份文件）
  'cmqg98smd0001i8xgtf6pp2tw', // TEST RICH KING HONG Stage2 COMPANY override（active）
  'cmqg9eotb0003i8xgu5si8uaz', // TEST MODERN LEASING Stage2 COMPANY override（active）
]

/** Company 的 18 個一對多關聯；刪除公司前這些都必須為 0（documentFormats / promptConfigs 由本腳本一併刪除） */
const COMPANY_RELATIONS = [
  'documents',
  'extractionResults',
  'mappingRules',
  'fieldDefinitionSets',
  'templateFieldMappings',
  'pipelineConfigs',
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

/** DocumentFormat 的子關聯；刪除格式前這些都必須為 0（promptConfigs 由本腳本一併刪除） */
const FORMAT_RELATIONS = [
  'fieldMappingConfigs',
  'files',
  'templateFieldMappings',
  'fieldDefinitionSets',
  'pipelineConfigs',
] as const

const problems: string[] = []

function fail(message: string) {
  problems.push(message)
}

async function main() {
  const { prisma } = await import('../src/lib/prisma')

  const shouldDelete = process.env.RUN_DELETE_TEST_RESIDUE === 'true'

  console.log(
    `\n=== 測試殘留清理 ${shouldDelete ? '【實際刪除】' : '【dry-run，不寫入】'} ===\n`
  )

  // ---------- 驗證 Prompt 配置 ----------
  const promptConfigs = await prisma.promptConfig.findMany({
    where: { id: { in: TARGET_PROMPT_CONFIG_IDS } },
    select: {
      id: true,
      name: true,
      scope: true,
      promptType: true,
      isActive: true,
      companyId: true,
      company: { select: { name: true, status: true } },
    },
  })

  if (promptConfigs.length !== TARGET_PROMPT_CONFIG_IDS.length) {
    fail(
      `Prompt 配置預期 ${TARGET_PROMPT_CONFIG_IDS.length} 筆，實際查到 ${promptConfigs.length} 筆`
    )
  }

  console.log('--- Prompt 配置 ---')
  for (const pc of promptConfigs) {
    // 安全條件：名稱必須以 TEST 起始，且為 COMPANY scope 的 Stage 2 配置
    if (!pc.name.startsWith('TEST ')) {
      fail(`Prompt 配置 ${pc.id} 名稱不以 "TEST " 起始（"${pc.name}"），拒絕刪除`)
    }
    if (pc.scope !== 'COMPANY' || pc.promptType !== 'STAGE_2_FORMAT_IDENTIFICATION') {
      fail(`Prompt 配置 ${pc.id} 的 scope/promptType 與預期不符，拒絕刪除`)
    }
    console.log(
      `  ${pc.id}  ${pc.isActive ? '🔴 啟用中' : '停用'}  "${pc.name}"` +
        `  → 公司 ${pc.company?.name ?? '(無)'} [${pc.company?.status ?? '-'}]`
    )
  }

  // ---------- 驗證格式 ----------
  const formats = await prisma.documentFormat.findMany({
    where: { id: { in: TARGET_FORMAT_IDS } },
    select: {
      id: true,
      name: true,
      companyId: true,
      fileCount: true,
      documentType: true,
      documentSubtype: true,
      company: { select: { name: true, status: true } },
      _count: { select: Object.fromEntries(FORMAT_RELATIONS.map((r) => [r, true])) as never },
    },
  })

  if (formats.length !== TARGET_FORMAT_IDS.length) {
    fail(`格式預期 ${TARGET_FORMAT_IDS.length} 筆，實際查到 ${formats.length} 筆`)
  }

  console.log('\n--- 文件格式 ---')
  for (const f of formats) {
    const counts = f._count as unknown as Record<string, number>
    const nonZero = Object.entries(counts).filter(([, n]) => n > 0)

    // 安全條件：必須無文件使用、無子關聯、且隸屬於待刪公司
    if (f.fileCount !== 0) {
      fail(`格式 ${f.id} 的 fileCount = ${f.fileCount}（非 0），有文件使用中，拒絕刪除`)
    }
    if (nonZero.length > 0) {
      fail(
        `格式 ${f.id} 仍有子關聯：${nonZero.map(([k, n]) => `${k}=${n}`).join(', ')}，拒絕刪除`
      )
    }
    if (!TARGET_COMPANY_IDS.includes(f.companyId)) {
      fail(`格式 ${f.id} 不隸屬於待刪公司（companyId=${f.companyId}），拒絕刪除`)
    }
    console.log(
      `  ${f.id}  ${f.documentType}/${f.documentSubtype}  fileCount=${f.fileCount}  "${f.name}"` +
        `  → 公司 ${f.company.name} [${f.company.status}]`
    )
  }

  // ---------- 驗證公司 ----------
  const companies = await prisma.company.findMany({
    where: { id: { in: TARGET_COMPANY_IDS } },
    select: {
      id: true,
      name: true,
      status: true,
      source: true,
      _count: { select: Object.fromEntries(COMPANY_RELATIONS.map((r) => [r, true])) as never },
    },
  })

  if (companies.length !== TARGET_COMPANY_IDS.length) {
    fail(`公司預期 ${TARGET_COMPANY_IDS.length} 間，實際查到 ${companies.length} 間`)
  }

  console.log('\n--- 公司 ---')
  for (const c of companies) {
    const counts = c._count as unknown as Record<string, number>
    const nonZero = Object.entries(counts).filter(([, n]) => n > 0)

    // 安全條件：必須是 AUTO_CREATED 且已 MERGED，且除待刪的格式/配置外無其他關聯
    if (c.status !== 'MERGED') {
      fail(`公司 ${c.id} 狀態為 ${c.status}（非 MERGED），拒絕刪除`)
    }
    if (c.source !== 'AUTO_CREATED') {
      fail(`公司 ${c.id} 來源為 ${c.source}（非 AUTO_CREATED），拒絕刪除`)
    }
    if (nonZero.length > 0) {
      fail(
        `公司 ${c.id} 仍有其他關聯：${nonZero.map(([k, n]) => `${k}=${n}`).join(', ')}，拒絕刪除`
      )
    }
    console.log(`  ${c.id}  [${c.status}/${c.source}]  "${c.name}"`)
  }

  // ---------- 中止或執行 ----------
  if (problems.length > 0) {
    console.log('\n🔴 安全條件未通過，未刪除任何資料：\n')
    for (const p of problems) {
      console.log(`  - ${p}`)
    }
    process.exitCode = 1
    return
  }

  console.log(
    `\n✅ 安全條件全部通過。待刪除：` +
      `${promptConfigs.length} 筆 Prompt 配置、${formats.length} 個格式、${companies.length} 間公司`
  )

  if (!shouldDelete) {
    console.log(
      '\n這是 dry-run。確認以上清單無誤後，執行：\n' +
        '  RUN_DELETE_TEST_RESIDUE=true npx tsx scripts/local-cleanup-test-residue.ts\n'
    )
    return
  }

  const result = await prisma.$transaction(async (tx) => {
    // 順序：Prompt 配置 → 格式 → 公司（由葉往根，避免外鍵阻擋）
    const pc = await tx.promptConfig.deleteMany({
      where: { id: { in: TARGET_PROMPT_CONFIG_IDS } },
    })
    const fm = await tx.documentFormat.deleteMany({
      where: { id: { in: TARGET_FORMAT_IDS } },
    })
    const co = await tx.company.deleteMany({
      where: { id: { in: TARGET_COMPANY_IDS } },
    })
    return { promptConfigs: pc.count, formats: fm.count, companies: co.count }
  })

  console.log(
    `\n✅ 已刪除：Prompt 配置 ${result.promptConfigs} 筆、` +
      `格式 ${result.formats} 個、公司 ${result.companies} 間\n`
  )
}

main()
  .catch((error) => {
    console.error('[清理失敗]', error)
    process.exit(1)
  })
  .finally(async () => {
    const { prisma } = await import('../src/lib/prisma')
    await prisma.$disconnect()
  })
