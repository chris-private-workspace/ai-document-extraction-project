/**
 * @fileoverview 清除 CHANGE-107 複製功能驗證期間建立的測試映射配置
 * @description
 *   2026-07-25 驗證 CHANGE-107（Template Field Mapping 複製記錄）時，於本地
 *   建立了 2 筆測試配置：
 *
 *     1. 「…（複製）」→ Logistics Outbound template - v1 / COMPANY / DHL Express
 *        （驗收 7：換公司同模版的正向路徑）
 *     2. 「…（複製）」→ Logistics Outbound template - v1 / COMPANY / CEVA LOGISTICS
 *        （驗收 8：原以為會撞唯一約束，實測回 201 —— 見下方說明）
 *
 *   第 2 筆同時是「unique_template_mapping 實務上從未生效」的證據：
 *   PostgreSQL 的唯一約束把 NULL 視為互不相同，而該四欄組合在每種範圍下都必然
 *   含至少一個 NULL（COMPANY 範圍的 documentFormatId 為 NULL），因此相同四元組
 *   可以無聲重複建立。CHANGE-107 已在 service.create 加應用層檢查補上這個缺口。
 *
 *   🔴 API 的 DELETE 是軟刪除（只設 isActive = false），會留下停用殘留記錄，
 *      因此本腳本改用硬刪除。
 *
 *   🔴 本檔為 tsx 腳本，只能在本地執行（Azure runner 映像不含 scripts/ 與 tsx）。
 *      這 2 筆測試資料只存在本地，Azure 無對應記錄。
 *
 * @module scripts/local-cleanup-change107-test-records
 * @since 2026-07-25（CHANGE-107 驗證善後）
 * @lastModified 2026-07-25
 *
 * @usage
 *   npx tsx scripts/local-cleanup-change107-test-records.ts                                   # 檢視（預設，不刪）
 *   RUN_DELETE_CHANGE107_TEST_RECORDS=true npx tsx scripts/local-cleanup-change107-test-records.ts   # 實際硬刪除
 */
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

/** 測試配置的名稱後綴（複製功能自動加上的 form.copyNameSuffix） */
const COPY_NAME_SUFFIX = '（複製）'

/** 安全閘：預期命中筆數，不符即中止不刪 */
const EXPECTED_COUNT = 2

/** 安全閘：只允許刪除今天建立的記錄（避免誤刪真實業務資料） */
const CREATED_ON = '2026-07-25'

async function main() {
  // 🔴 動態 import：src/lib/prisma 在載入當下即以連線字串建 pool，
  //    靜態 import 會被提升到 dotenv.config() 之前，導致以 undefined 連線
  //    並拋出「錯誤原因為空」的 Invalid invocation（見 memory）。
  const { prisma } = await import('../src/lib/prisma')

  const shouldDelete = process.env.RUN_DELETE_CHANGE107_TEST_RECORDS === 'true'

  console.log('='.repeat(72))
  console.log('CHANGE-107 測試資料清理')
  console.log(`模式：${shouldDelete ? '🔴 實際硬刪除' : '🔍 檢視（不會刪除任何東西）'}`)
  console.log('='.repeat(72))

  const candidates = await prisma.templateFieldMapping.findMany({
    where: { name: { endsWith: COPY_NAME_SUFFIX } },
    include: {
      dataTemplate: { select: { name: true } },
      company: { select: { name: true } },
      documentFormat: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  if (candidates.length === 0) {
    console.log('\n✅ 找不到任何名稱以「（複製）」結尾的配置，無需清理。')
    return
  }

  console.log(`\n找到 ${candidates.length} 筆名稱以「${COPY_NAME_SUFFIX}」結尾的配置：\n`)

  for (const [i, m] of candidates.entries()) {
    const createdDate = m.createdAt.toISOString().slice(0, 10)
    const ruleCount = Array.isArray(m.mappings) ? m.mappings.length : 0
    const target =
      m.scope === 'COMPANY'
        ? (m.company?.name ?? '(公司已不存在)')
        : m.scope === 'FORMAT'
          ? (m.documentFormat?.name ?? '(格式已不存在)')
          : '-'

    console.log(`  [${i + 1}] id           : ${m.id}`)
    console.log(`      名稱         : ${m.name}`)
    console.log(`      數據模版     : ${m.dataTemplate.name}`)
    console.log(`      範圍 / 目標  : ${m.scope} / ${target}`)
    console.log(`      規則數       : ${ruleCount}`)
    console.log(`      啟用         : ${m.isActive}`)
    console.log(`      建立時間     : ${m.createdAt.toISOString()}${createdDate === CREATED_ON ? '' : '  ⚠️ 非今天'}`)
    console.log('')
  }

  // --- 安全閘 ---
  const notToday = candidates.filter(
    (m) => m.createdAt.toISOString().slice(0, 10) !== CREATED_ON
  )

  if (notToday.length > 0) {
    console.error(
      `❌ 中止：有 ${notToday.length} 筆並非 ${CREATED_ON} 建立，可能是真實業務資料。` +
        '\n   請人工確認後改用明確的 id 清單處理，本腳本不刪任何東西。'
    )
    process.exitCode = 1
    return
  }

  if (candidates.length !== EXPECTED_COUNT) {
    console.error(
      `❌ 中止：命中 ${candidates.length} 筆，與預期的 ${EXPECTED_COUNT} 筆不符。` +
        '\n   請人工確認清單無誤後，調整 EXPECTED_COUNT 再執行。'
    )
    process.exitCode = 1
    return
  }

  if (!shouldDelete) {
    console.log('🔍 檢視模式結束，未刪除任何資料。')
    console.log('   確認上方清單無誤後，執行：')
    console.log(
      '   RUN_DELETE_CHANGE107_TEST_RECORDS=true npx tsx scripts/local-cleanup-change107-test-records.ts\n'
    )
    return
  }

  // --- 硬刪除 ---
  const ids = candidates.map((m) => m.id)
  const result = await prisma.templateFieldMapping.deleteMany({
    where: { id: { in: ids } },
  })

  console.log(`🔴 已硬刪除 ${result.count} 筆配置。`)

  if (result.count !== EXPECTED_COUNT) {
    console.error(
      `⚠️ 實際刪除筆數（${result.count}）與預期（${EXPECTED_COUNT}）不符，請人工複核。`
    )
    process.exitCode = 1
    return
  }

  const remaining = await prisma.templateFieldMapping.count({
    where: { name: { endsWith: COPY_NAME_SUFFIX } },
  })
  console.log(`✅ 複核：名稱以「${COPY_NAME_SUFFIX}」結尾的配置剩餘 ${remaining} 筆。`)
}

main()
  .catch((error) => {
    console.error('腳本執行失敗：', error)
    process.exitCode = 1
  })
  .finally(async () => {
    const { prisma } = await import('../src/lib/prisma')
    await prisma.$disconnect()
  })
