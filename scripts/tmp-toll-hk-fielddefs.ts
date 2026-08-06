/**
 * @fileoverview 為 Toll 香港實體補齊欄位定義集 → 重新提取 → 建映射 → 進模板實例列
 * @description
 *   ## 根因（2026-08-06 查證）
 *
 *   `Toll Global Forwarding (Hong Kong) Ltd`（1ce60466…）的 34 份文件進不了模板實例列。
 *   初判為「缺 template_field_mapping」，實際查證後推翻：
 *
 *       香港 field_definition_sets = 0（GLOBAL 層也是 0）
 *         → Stage 3 沒有自訂費用欄位可注入 prompt
 *         → 只提取到通用發票欄位（費用僅一個籠統的 freight_charge）
 *         → template_field_mapping 的 sourceField 全部落空
 *         → 補映射規則等於空轉
 *
 *   反證：香港 34 份中有 2 份（TOLL_RHIM260062_51857）確實有細分費用 —— 它們是 Stage 1
 *   讀到泰國抬頭、匹配到泰國 companyId 的交叉樣本，因而注入了泰國的 37 個欄位定義。
 *
 *   ## 因此正確順序是（本腳本的階段）
 *
 *     inspect          唯讀。現況 + 將建立的內容
 *     create-fielddefs 建立香港的 field_definition_set（複製泰國 37 個科目）
 *     test-reprocess   試跑 2 份，確認真的提取出細分費用
 *     reprocess-all    重跑其餘文件
 *     create-mappings  建立 template_field_mappings
 *     match            跑模板匹配，進實例列
 *
 *   🔴 `reprocess` 會**覆蓋** `extraction_results`（document_id 唯一約束 + upsert）。
 *      每個 reprocess 階段都先把現有提取結果完整快照到檔案，那是唯一的還原依據。
 *
 *   🔴 欄位定義不回溯：建立欄位集後，既有提取結果不會自動更新，必須重跑。
 *
 * @module scripts/tmp-toll-hk-fielddefs
 * @since 2026-08-06
 * @lastModified 2026-08-06
 *
 * @usage npx tsx scripts/tmp-toll-hk-fielddefs.ts <stage>
 */
import * as dotenv from 'dotenv'
import * as fs from 'fs'

dotenv.config({ path: '.env.local' })
dotenv.config()

import type { ProcessFileInput } from '../src/types/unified-processor'

const STAGE = (process.argv[2] || 'inspect').toLowerCase()
const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID || 'dev-user-1'

const SRC_COMPANY_ID = '8f933f53-fae5-4c52-944c-3eac699e4ac4' // 泰國（有欄位集 + 映射）
const DST_COMPANY_ID = '1ce60466-ecfa-4e82-aee0-13c3ccccc192' // 香港（全空）
const SRC_FIELDSET_ID = '14fc7955-3ce7-4350-8291-13a27d94b93d'

const RUN_TAG = 'toll-hk-backfill 2026-08-06'
const EXTRACTION_SNAPSHOT = '.snapshots/toll-hk-extraction-before-reprocess.json'
const CONFIG_SNAPSHOT = '.snapshots/toll-hk-config-before-write.json'

/**
 * 判斷提取結果是否含細分費用的科目清單。
 *
 * 🔴 初版硬編了 8 個常見科目，導致 7 份實際有細分費用的文件（`handling_fee_origin_incl_pu`
 *    / `origin_charge_incl_pick_up` / `pick_up_cartage_origin`）被誤報成「仍無細分費用」。
 *    判準必須來自**欄位集本身**，不是手寫的樣本清單 —— 手寫清單永遠會漏掉真實資料裡的長尾。
 */
let CHARGE_MARKERS: string[] = []

const line = (s = '') => console.log(s)
const hr = (t: string) => {
  line()
  line('='.repeat(100))
  line(t)
  line('='.repeat(100))
}

/** 從 extractionResult.fieldMappings 取出有值的 key */
function valuedKeys(fieldMappings: unknown): string[] {
  if (!fieldMappings || typeof fieldMappings !== 'object') return []
  const out: string[] = []
  for (const [k, fd] of Object.entries(
    fieldMappings as Record<string, { value?: unknown; rawValue?: unknown }>
  )) {
    if (!fd || typeof fd !== 'object') continue
    const v = fd.value ?? fd.rawValue ?? null
    if (v === null || v === undefined || v === '') continue
    out.push(k)
  }
  return out
}

async function main() {
  const { default: prisma } = await import('../src/lib/prisma')

  if (!fs.existsSync('.snapshots')) fs.mkdirSync('.snapshots', { recursive: true })

  // 判準來自欄位集（香港優先，未建立時退回泰國來源）
  const markerSet =
    (await prisma.fieldDefinitionSet.findFirst({
      where: { companyId: DST_COMPANY_ID, isActive: true },
      select: { fields: true },
    })) ??
    (await prisma.fieldDefinitionSet.findUnique({
      where: { id: SRC_FIELDSET_ID },
      select: { fields: true },
    }))
  CHARGE_MARKERS = ((markerSet?.fields as Array<{ key?: string }>) || [])
    .map((f) => f?.key)
    .filter((k): k is string => typeof k === 'string' && k.length > 0)
  if (CHARGE_MARKERS.length === 0) {
    line('🔴 取不到任何費用科目 key，判準無效，中止')
    await prisma.$disconnect()
    return
  }

  const dstDocs = await prisma.document.findMany({
    where: { companyId: DST_COMPANY_ID, status: 'MAPPING_COMPLETED' },
    select: {
      id: true,
      fileName: true,
      blobName: true,
      fileType: true,
      createdAt: true,
      extractionResult: { select: { fieldMappings: true } },
    },
    orderBy: { fileName: 'asc' },
  })

  /** 目前已有細分費用的份數（進度指標） */
  const withCharges = dstDocs.filter((d) =>
    valuedKeys(d.extractionResult?.fieldMappings).some((k) => CHARGE_MARKERS.includes(k))
  )

  hr('0  現況')
  line(`  費用科目判準（來自欄位集）${CHARGE_MARKERS.length} 個 key`)
  line(`  香港已完成文件            ${dstDocs.length}`)
  line(`  其中已有細分費用欄位      ${withCharges.length}`)
  const existingSet = await prisma.fieldDefinitionSet.findFirst({
    where: { companyId: DST_COMPANY_ID },
    select: { id: true, name: true, version: true, isActive: true, fields: true },
  })
  line(
    `  香港 field_definition_set ${existingSet ? `已存在（${existingSet.id}，${(existingSet.fields as unknown[]).length} 欄）` : '🔴 不存在'}`
  )
  const existingMappings = await prisma.templateFieldMapping.count({
    where: { companyId: DST_COMPANY_ID, isActive: true },
  })
  line(`  香港 template_field_mappings ${existingMappings} 組`)

  // ================================================================ inspect
  if (STAGE === 'inspect') {
    const srcSet = await prisma.fieldDefinitionSet.findUnique({
      where: { id: SRC_FIELDSET_ID },
      select: { name: true, scope: true, version: true, fields: true },
    })
    const fields = (srcSet?.fields as Array<Record<string, unknown>>) || []
    hr('1  將複製的欄位定義（來自泰國）')
    line(`  來源 ${srcSet?.name}　scope=${srcSet?.scope}　version=${srcSet?.version}　欄位 ${fields.length}`)
    line()
    line('  ⚠️ 這些定義**沒有 aliases** —— 只是科目清單（key/label/category/dataType/fieldType），')
    line('     不含公司特定術語，因此複製到香港的風險低於含別名的設定。')
    line()
    const byType = new Map<string, number>()
    fields.forEach((f) => {
      const t = `${f.category}/${f.fieldType}`
      byType.set(t, (byType.get(t) || 0) + 1)
    })
    line(`  組成：${[...byType.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`)
    line()
    fields.forEach((f, i) => line(`  [${String(i + 1).padStart(2)}] ${f.key}　${f.label}`))

    hr('2  執行計劃')
    line('  1) create-fielddefs  建立香港的 field_definition_set（可逆：刪除該筆即可）')
    line('  2) test-reprocess    試跑 2 份，確認真的提取出細分費用')
    line('  3) reprocess-all     重跑其餘 32 份')
    line('  4) create-mappings   複製泰國的 2 組 template_field_mapping')
    line('  5) match             跑模板匹配，進實例列')
    line()
    line(`  🔴 步驟 2/3 會覆蓋 extraction_results，執行前會先快照到 ${EXTRACTION_SNAPSHOT}`)
    hr('完成（inspect：全程唯讀）')
    await prisma.$disconnect()
    return
  }

  // ================================================== create-fielddefs
  if (STAGE === 'create-fielddefs') {
    if (existingSet) {
      line()
      line(`  ⏭ 香港已有 field_definition_set（${existingSet.id}），跳過（冪等）`)
      await prisma.$disconnect()
      return
    }
    const srcSet = await prisma.fieldDefinitionSet.findUnique({ where: { id: SRC_FIELDSET_ID } })
    if (!srcSet) {
      line('🔴 來源欄位集不存在，中止')
      await prisma.$disconnect()
      return
    }

    hr('1  前置快照')
    fs.writeFileSync(
      CONFIG_SNAPSHOT,
      JSON.stringify(
        {
          runTag: RUN_TAG,
          capturedAt: new Date().toISOString(),
          note: '建立香港 field_definition_set 前的設定快照',
          srcFieldSet: srcSet,
          dstFieldSetsBefore: await prisma.fieldDefinitionSet.findMany({
            where: { companyId: DST_COMPANY_ID },
          }),
          dstMappingsBefore: await prisma.templateFieldMapping.findMany({
            where: { companyId: DST_COMPANY_ID },
          }),
        },
        null,
        2
      )
    )
    line(`  已寫出 ${CONFIG_SNAPSHOT}`)

    hr('2  建立香港的 field_definition_set')
    const created = await prisma.fieldDefinitionSet.create({
      data: {
        scope: 'COMPANY',
        companyId: DST_COMPANY_ID,
        documentFormatId: null,
        name: 'Toll Global Forwarding (Hong Kong) Ltd - 自訂費用欄位集',
        description: `${RUN_TAG}：複製自「${srcSet.name}」（${SRC_FIELDSET_ID}）。兩者為同集團不同法人（泰國／香港），科目清單不含 aliases 故可直接沿用。建立後需重新處理文件才會生效（欄位定義不回溯）。`,
        isActive: true,
        fields: srcSet.fields as never,
        createdBy: SYSTEM_USER_ID,
      },
      select: { id: true, name: true, fields: true },
    })
    const n = (created.fields as unknown[]).length
    line(`  ✓ ${created.name}`)
    line(`    id=${created.id}　欄位 ${n}`)

    // 數量閘
    if (n !== (srcSet.fields as unknown[]).length) {
      line(`  🔴 數量閘失敗：來源 ${(srcSet.fields as unknown[]).length} 欄，建立後 ${n} 欄`)
    } else {
      line(`  ✅ 數量閘通過（${n} 欄與來源一致）`)
    }
    line()
    line(`  回滾：刪除 field_definition_sets 中 id=${created.id} 的那筆`)
    line(`  ⚠️ 尚未生效 —— 需執行 test-reprocess 重新處理文件`)
    await prisma.$disconnect()
    return
  }

  // ============================================ test-reprocess / reprocess-all
  if (STAGE === 'test-reprocess' || STAGE === 'reprocess-all') {
    if (!existingSet) {
      line()
      line('  🔴 香港還沒有 field_definition_set，先執行 create-fielddefs')
      await prisma.$disconnect()
      return
    }

    const { downloadBlob } = await import('../src/lib/azure-blob')
    const { getUnifiedDocumentProcessor } = await import('../src/services/unified-processor')
    const { persistProcessingResult } = await import(
      '../src/services/processing-result-persistence.service'
    )
    const { BlobServiceClient } = await import('@azure/storage-blob')

    const svc = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING!
    )
    const container = svc.getContainerClient(process.env.AZURE_STORAGE_CONTAINER || 'documents')
    const blobs = new Set<string>()
    for await (const b of container.listBlobsFlat()) blobs.add(b.name)

    // 目標：尚無細分費用、且 blob 還在
    const pending = dstDocs.filter(
      (d) =>
        d.blobName &&
        blobs.has(d.blobName) &&
        !valuedKeys(d.extractionResult?.fieldMappings).some((k) => CHARGE_MARKERS.includes(k))
    )
    const targets = STAGE === 'test-reprocess' ? pending.slice(0, 2) : pending

    hr('1  前置快照（🔴 重跑會覆蓋 extraction_results）')
    const snapDocs = await prisma.extractionResult.findMany({
      where: { documentId: { in: dstDocs.map((d) => d.id) } },
    })
    const prev = fs.existsSync(EXTRACTION_SNAPSHOT)
      ? JSON.parse(fs.readFileSync(EXTRACTION_SNAPSHOT, 'utf8'))
      : null
    if (prev) {
      line(`  ⏭ 快照已存在（${prev.capturedAt}，${prev.results?.length} 筆），保留原始快照不覆寫`)
    } else {
      fs.writeFileSync(
        EXTRACTION_SNAPSHOT,
        JSON.stringify(
          { runTag: RUN_TAG, capturedAt: new Date().toISOString(), results: snapDocs },
          null,
          2
        )
      )
      line(`  已寫出 ${EXTRACTION_SNAPSHOT}（${snapDocs.length} 筆提取結果）`)
    }

    hr(`2  重跑（${STAGE}）—— 目標 ${targets.length} / 待處理 ${pending.length}`)
    let ok = 0
    let noCharge = 0
    let errored = 0
    for (let i = 0; i < targets.length; i++) {
      const doc = targets[i]
      const tag = `[${i + 1}/${targets.length}] ${doc.fileName.slice(0, 44)}`
      try {
        const fileBuffer = await downloadBlob(doc.blobName!)
        const input: ProcessFileInput = {
          fileId: doc.id,
          fileName: doc.fileName,
          fileBuffer,
          mimeType: doc.fileType,
          userId: SYSTEM_USER_ID,
        }
        const started = Date.now()
        const result = await getUnifiedDocumentProcessor().processFile(input, { forceV3: true })
        await persistProcessingResult({ documentId: doc.id, result, userId: SYSTEM_USER_ID })

        const after = await prisma.extractionResult.findUnique({
          where: { documentId: doc.id },
          select: { fieldMappings: true },
        })
        const keys = valuedKeys(after?.fieldMappings)
        const charges = keys.filter((k) => CHARGE_MARKERS.includes(k))
        const ms = Date.now() - started
        if (charges.length > 0) {
          ok++
          line(`  ✓ ${tag}  ${ms}ms　有值欄位 ${keys.length}　細分費用 ${charges.length}：${charges.slice(0, 4).join(', ')}`)
        } else {
          noCharge++
          line(`  ⚠ ${tag}  ${ms}ms　有值欄位 ${keys.length}　🔴 仍無細分費用`)
        }
      } catch (e) {
        errored++
        line(`  ✗ ${tag}  ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`)
      }
    }

    hr('3  結果')
    line(`  有細分費用   ${ok}`)
    line(`  仍無細分費用 ${noCharge}`)
    line(`  執行錯誤     ${errored}`)
    line()
    if (STAGE === 'test-reprocess') {
      line(
        ok > 0
          ? '  ✅ 欄位集生效 —— 可執行 reprocess-all'
          : '  🔴 欄位集未生效，不要繼續 reprocess-all，先查為什麼'
      )
    } else {
      line('  下一步：create-mappings')
    }
    line(`  回滾依據：${EXTRACTION_SNAPSHOT}`)
    await prisma.$disconnect()
    return
  }

  // ================================================== create-mappings
  if (STAGE === 'create-mappings') {
    // 🔴 初版的閘寫成「還有 >2 份沒細分費用就中止」，那是錯的判準 ——
    //    它分不清「還沒重跑」與「重跑過但發票本來就沒有分項費用」。
    //    改為：列出無細分費用者的實際欄位，讓人判斷是哪一種，不阻擋流程。
    const noCharge = dstDocs.filter(
      (d) => !valuedKeys(d.extractionResult?.fieldMappings).some((k) => CHARGE_MARKERS.includes(k))
    )
    if (noCharge.length > 0) {
      hr(`0b  ⚠️ ${noCharge.length} 份無細分費用 —— 逐份列出實際欄位以判斷成因`)
      for (const d of noCharge) {
        const keys = valuedKeys(d.extractionResult?.fieldMappings)
        const fm = d.extractionResult?.fieldMappings as Record<
          string,
          { value?: unknown; rawValue?: unknown }
        >
        const amt = (k: string) => {
          const v = fm?.[k]
          return v ? String(v.value ?? v.rawValue ?? '') : '—'
        }
        line()
        line(`  ${d.fileName}`)
        line(`    有值欄位 ${keys.length}：${keys.join(', ')}`)
        line(
          `    total_amount=${amt('total_amount')}　subtotal=${amt('subtotal')}　freight_charge=${amt('freight_charge')}`
        )
      }
      line()
      line('  ⇒ 若 freight_charge 有值而細分科目全空 → 發票只給一筆總運費（業務事實，非缺陷）')
      line('    這些文件仍可用通用欄位進實例列，只是費用欄位為空。')
    }

    const srcMappings = await prisma.templateFieldMapping.findMany({
      where: { companyId: SRC_COMPANY_ID, isActive: true },
      select: {
        id: true,
        dataTemplateId: true,
        scope: true,
        mappings: true,
        priority: true,
        dataTemplate: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
    const existing = await prisma.templateFieldMapping.findMany({
      where: { companyId: DST_COMPANY_ID, isActive: true },
      select: { dataTemplateId: true },
    })
    const existingIds = new Set(existing.map((e) => e.dataTemplateId))

    hr('1  建立 template_field_mappings（單一交易）')
    const created: string[] = []
    await prisma.$transaction(async (tx) => {
      for (const m of srcMappings) {
        if (existingIds.has(m.dataTemplateId)) {
          line(`  ⏭ ${m.dataTemplate.name} —— 已存在，跳過（冪等）`)
          continue
        }
        const rules = (m.mappings as unknown as unknown[]) || []
        const rec = await tx.templateFieldMapping.create({
          data: {
            dataTemplateId: m.dataTemplateId,
            scope: m.scope,
            companyId: DST_COMPANY_ID,
            documentFormatId: null,
            name: `Toll Global Forwarding (Hong Kong) Ltd - ${m.dataTemplate.name}`,
            description: `${RUN_TAG}：複製自泰國實體的同名映射組（${m.id}）。`,
            mappings: m.mappings as never,
            priority: m.priority,
            isActive: true,
          },
          select: { id: true, name: true },
        })
        created.push(rec.id)
        line(`  ✓ ${rec.name}　規則 ${rules.length} 條　id=${rec.id}`)
      }
    })

    hr('2  驗收：resolveMapping 對香港的回傳')
    const { templateFieldMappingService } = await import(
      '../src/services/template-field-mapping.service'
    )
    for (const m of srcMappings) {
      const cfg = await templateFieldMappingService.resolveMapping({
        dataTemplateId: m.dataTemplateId,
        companyId: DST_COMPANY_ID,
      })
      const mark = cfg.mappings.length > 0 ? '✅' : '🔴'
      line(`  ${mark} ${m.dataTemplate.name.padEnd(48)} 規則 ${cfg.mappings.length}`)
    }
    line()
    line(`  本次建立 ${created.length} 組　回滾依據：description 前綴「${RUN_TAG}」`)
    line('  下一步：match')
    await prisma.$disconnect()
    return
  }

  // ================================================== match
  if (STAGE === 'match') {
    const { templateMatchingEngineService } = await import(
      '../src/services/template-matching-engine.service'
    )

    const rows = await prisma.templateInstanceRow.findMany({
      select: { sourceDocumentIds: true },
    })
    const inRows = new Set<string>()
    for (const r of rows) for (const id of r.sourceDocumentIds || []) inRows.add(id)

    // 冪等：已進實例列者跳過
    const targets = dstDocs.filter((d) => !inRows.has(d.id))
    hr(`1  待匹配 ${targets.length} / 香港已完成 ${dstDocs.length}`)
    if (targets.length === 0) {
      line('  全部已進實例列，無事可做')
      await prisma.$disconnect()
      return
    }

    // 依檔名參考編號判方向：RHIM/RCIM = INBOUND，RHEX/RCEX = OUTBOUND
    const dirOf = (fn: string) => {
      const m = fn.toUpperCase().match(/R?[CH](IM|EX)\d/)
      return m ? (m[1] === 'IM' ? 'INBOUND' : 'OUTBOUND') : 'UNKNOWN'
    }
    const TPL: Record<string, string> = {
      OUTBOUND: 'cmrbhjbl4033101o3n77yg0sh',
      INBOUND: 'cmrbi0ktk033201o3rivrxb6h',
    }
    const groups = new Map<string, typeof targets>()
    for (const d of targets) {
      const dir = dirOf(d.fileName)
      groups.set(dir, [...(groups.get(dir) || []), d] as typeof targets)
    }
    for (const [dir, list] of groups) line(`  ${dir.padEnd(9)} ${list.length} 份`)

    hr('2  逐方向匹配（每方向一個新實例）')
    const rowsBefore = await prisma.templateInstanceRow.count()
    let totalRows = 0
    for (const [dir, list] of groups) {
      if (!TPL[dir]) {
        line(`  🔴 ${dir} 無對應模板，跳過 ${list.length} 份`)
        continue
      }
      const inst = await prisma.templateInstance.create({
        data: {
          dataTemplateId: TPL[dir],
          name: `${RUN_TAG} — Toll HK ${dir}`,
          description: `${RUN_TAG}：Toll 香港實體補齊欄位集並重新提取後的模板匹配。`,
          status: 'DRAFT',
        },
        select: { id: true },
      })
      const result = await templateMatchingEngineService.matchDocuments({
        documentIds: list.map((d) => d.id),
        templateInstanceId: inst.id,
        options: { companyId: DST_COMPANY_ID },
      })
      if (result.totalDocuments !== list.length) {
        line(`  🔴 ${dir} 數量閘失敗：載入 ${result.totalDocuments}，預期 ${list.length}`)
        continue
      }
      await prisma.document.updateMany({
        where: { id: { in: list.map((d) => d.id) }, templateInstanceId: null },
        data: { templateInstanceId: inst.id, templateMatchedAt: new Date() },
      })
      totalRows += result.totalRows
      line(
        `  ✓ ${dir.padEnd(9)} 文件 ${result.totalDocuments}　列 ${result.totalRows}　通過 ${result.validRows}　未通過 ${result.invalidRows}　錯誤 ${result.errorRows}`
      )
    }

    hr('3  驗收')
    const rowsAfter = await prisma.templateInstanceRow.count()
    const rowsNow = await prisma.templateInstanceRow.findMany({
      select: { sourceDocumentIds: true },
    })
    const inNow = new Set<string>()
    for (const r of rowsNow) for (const id of r.sourceDocumentIds || []) inNow.add(id)
    const landed = targets.filter((d) => inNow.has(d.id)).length
    line(`  新增實例列 ${rowsAfter - rowsBefore}（引擎回報 ${totalRows}）`)
    line(`  🔴 驗收（分母 ${targets.length}）：實際進入實例列 ${landed}　未進 ${targets.length - landed}`)
    await prisma.$disconnect()
    return
  }

  line()
  line(`🔴 未知階段「${STAGE}」`)
  line('  可用：inspect / create-fielddefs / test-reprocess / reprocess-all / create-mappings / match')
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
