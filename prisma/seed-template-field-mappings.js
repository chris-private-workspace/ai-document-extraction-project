/**
 * @fileoverview CHANGE-101（Azure 端）：批量建立公司 Template Field Mapping
 *   （Logistics Cost Inbound/Outbound）的 gated 容器腳本。
 *
 *   資料來源：docs/Doc Sample/SCM_AI_processing_platform_company_format_mapping_table_*.xlsx
 *   （38 間 forwarder × 出口/入口費用欄位 → 標準 template 欄位）。
 *
 *   三模式（由 RUN_TEMPLATE_MAPPING_SEED 環境變數控制）：
 *   - inspect：唯讀診斷。印出兩個 template 的 id+fields(name/label)、38 間公司比對結果、
 *              提取結果 sourceFields key 樣本（fieldMappings key + lineItems/extraCharges 的
 *              classifiedAs）。**不寫入任何資料。**
 *   - dryrun ：（Phase 2）完整生成 mapping + 印出將 upsert 內容與對不上清單，不寫入。
 *   - write  ：（Phase 2）冪等 upsert 至 template_field_mappings。
 *
 *   設計重點（比照 grant-global-admin.js / update-stage3-prompt.js）：
 *   - 只依賴 `pg`（standalone runtime 已含），不需 Prisma CLI / tsx
 *   - Azure PostgreSQL 需 TLS：偵測 sslmode=require 或 azure host 時啟用
 *   - 參數化查詢防注入；各診斷區塊獨立 try/catch，單一失敗不影響其餘診斷
 *
 *   由 docker-entrypoint.sh 的 RUN_TEMPLATE_MAPPING_SEED 觸發（非致命，失敗不擋啟動）。
 *
 * @module prisma/seed-template-field-mappings
 * @since CHANGE-101 (2026-07-09)
 * @lastModified 2026-07-09
 */
const { Client } = require('pg')

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

/** Excel 中出現的 38 間公司名（原樣，供比對 companies 表用） */
const COMPANY_NAMES = [
  'Redline', 'Fairate', 'Cargo Partner', 'Constant International', 'CEVA',
  'CYTS', 'DHL', 'DSV', 'Kings', 'MAINFREIGHT', 'NIPPON', 'RIL', 'TOLL',
  'UNION', 'Wang Kay', 'Worldwide', 'Yamato', 'Sanco', 'BSI', 'Cargo Link',
  'Dongnam', 'Famous', 'Fartrans', 'Hua Feng', 'Kintetsu', 'Lam', 'MOL',
  'Panda', 'Sharp', 'Unibest', 'Vinflair', 'Wangkay', 'WGL', 'Redlines',
  'Kargosmart', 'Worldwide Logistics', 'A2S Logistics', 'Profreight',
]

/** 模式（inspect / dryrun / write） */
const MODE = (process.env.RUN_TEMPLATE_MAPPING_SEED || 'inspect').trim().toLowerCase()

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function resolveSsl() {
  const url = process.env.DATABASE_URL || ''
  if (/sslmode=require/i.test(url) || /\.postgres\.database\.azure\.com/i.test(url)) {
    return { rejectUnauthorized: false }
  }
  return false
}

const ci = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase()

function line(label) {
  console.log(`\n========== ${label} ==========`)
}

// ---------------------------------------------------------------------------
// 診斷區塊 1：兩個 Logistics Cost template 的 id + fields
// ---------------------------------------------------------------------------

async function inspectTemplates(client) {
  line('1) DATA TEMPLATES（Logistics Cost）')
  try {
    const res = await client.query(
      `select id, name, scope, is_active, fields
         from data_templates
        where name ilike '%logistics cost%'
        order by name`
    )
    console.log(`找到 ${res.rowCount} 個 template（name ilike '%logistics cost%'）`)
    for (const t of res.rows) {
      const fields = Array.isArray(t.fields) ? t.fields : []
      console.log(
        `\n--- template: "${t.name}" | id=${t.id} | scope=${t.scope} | active=${t.is_active} | fields=${fields.length}`
      )
      for (const f of fields) {
        console.log(
          `    [name=${JSON.stringify(f && f.name)}] label=${JSON.stringify(f && f.label)} ` +
            `type=${f && f.dataType} required=${f && f.isRequired} order=${f && f.order}`
        )
      }
    }
  } catch (e) {
    console.error('  [templates] 查詢失敗:', e.message)
  }
}

// ---------------------------------------------------------------------------
// 診斷區塊 2：38 間公司於 companies 表的比對結果
// ---------------------------------------------------------------------------

async function inspectCompanies(client) {
  line('2) COMPANIES 比對（Excel 38 間 → companies 表）')
  let companies = []
  try {
    const res = await client.query(`select id, name, code from companies order by name`)
    companies = res.rows
    console.log(`companies 表共 ${companies.length} 筆\n`)
  } catch (e) {
    console.error('  [companies] 查詢失敗:', e.message)
    return
  }

  // 印出全部 companies（供 Excel 名 → companyId 對應草案用）
  console.log('--- 全部 companies（id | name | code）---')
  for (const c of companies) {
    console.log(`  ${c.id} | ${c.name} | ${c.code ?? '(null)'}`)
  }
  console.log('\n--- Excel 38 名比對 ---')

  for (const target of COMPANY_NAMES) {
    const exact = companies.filter(
      (c) => ci(c.name) === ci(target) || (c.code && ci(c.code) === ci(target))
    )
    const contains = companies.filter(
      (c) => !exact.includes(c) && (ci(c.name).includes(ci(target)) || ci(target).includes(ci(c.name)))
    )
    let tag = '找不到 ✗'
    if (exact.length === 1) tag = '唯一 ✓'
    else if (exact.length > 1) tag = `重複 ⚠(${exact.length})`
    else if (contains.length > 0) tag = `僅模糊候選 ?(${contains.length})`

    const fmt = (c) => `{id=${c.id}, name="${c.name}", code=${JSON.stringify(c.code)}}`
    const detail = exact.length
      ? exact.map(fmt).join(' , ')
      : contains.map(fmt).join(' , ')
    console.log(`  "${target}" → ${tag}${detail ? '  ' + detail : ''}`)
  }
}

// ---------------------------------------------------------------------------
// 診斷區塊 3：提取結果的 sourceFields key 樣本
//   （fieldMappings key + stage3 lineItems/extraCharges 的 classifiedAs）
// ---------------------------------------------------------------------------

async function inspectExtractionKeys(client) {
  line('3) 提取結果 sourceFields key 樣本')

  // 3a) 幾筆完整樣本（看結構）
  try {
    const res = await client.query(
      `select id, field_mappings, stage_3_result
         from extraction_results
        where stage_3_result is not null
        order by created_at desc
        limit 5`
    )
    console.log(`最近 ${res.rowCount} 筆 extraction_results 樣本：`)
    for (const r of res.rows) {
      const fmKeys =
        r.field_mappings && typeof r.field_mappings === 'object'
          ? Object.keys(r.field_mappings)
          : []
      const s3 = r.stage_3_result || {}
      const li = Array.isArray(s3.lineItems) ? s3.lineItems : []
      const ec = Array.isArray(s3.extraCharges) ? s3.extraCharges : []
      const caOf = (arr) => arr.map((x) => x && x.classifiedAs).filter(Boolean)
      console.log(`\n  --- extraction_result id=${r.id}`)
      console.log(`      fieldMappings keys (${fmKeys.length}): ${JSON.stringify(fmKeys)}`)
      console.log(`      lineItems classifiedAs (${li.length}): ${JSON.stringify(caOf(li))}`)
      console.log(`      extraCharges classifiedAs (${ec.length}): ${JSON.stringify(caOf(ec))}`)
    }
  } catch (e) {
    console.error('  [extraction sample] 查詢失敗:', e.message)
  }

  // 3b) 全體 distinct classifiedAs（決定 li_{classifiedAs}_total 與 AGGREGATE classifiedAsIn）
  try {
    const res = await client.query(
      `select distinct ca from (
         select jsonb_array_elements(stage_3_result->'lineItems')->>'classifiedAs' as ca
           from extraction_results where jsonb_typeof(stage_3_result->'lineItems') = 'array'
         union all
         select jsonb_array_elements(stage_3_result->'extraCharges')->>'classifiedAs' as ca
           from extraction_results where jsonb_typeof(stage_3_result->'extraCharges') = 'array'
       ) t
       where ca is not null and ca <> ''
       order by ca`
    )
    console.log(
      `\n  全體 distinct classifiedAs (${res.rowCount}):\n    ${res.rows.map((x) => x.ca).join(' | ')}`
    )
  } catch (e) {
    console.error('  [distinct classifiedAs] 查詢失敗:', e.message)
  }
}

// ---------------------------------------------------------------------------
// 診斷區塊 4：既有 template_field_mappings 現況（避免重複建立）
// ---------------------------------------------------------------------------

async function inspectExistingMappings(client) {
  line('4) 既有 template_field_mappings 現況 + Full List rule 範本')
  try {
    const res = await client.query(
      `select tfm.id, tfm.scope, tfm.company_id, c.name as company_name,
              dt.name as template_name, tfm.mappings, tfm.is_active
         from template_field_mappings tfm
         left join companies c on c.id = tfm.company_id
         left join data_templates dt on dt.id = tfm.data_template_id
        where dt.name ilike '%logistics cost%'
        order by dt.name, c.name`
    )
    console.log(`已存在 ${res.rowCount} 筆（Logistics Cost 相關）：`)
    for (const m of res.rows) {
      const rules = Array.isArray(m.mappings) ? m.mappings : []
      console.log(
        `\n  {template="${m.template_name}", scope=${m.scope}, company="${m.company_name}", ` +
          `rules=${rules.length}, active=${m.is_active}, id=${m.id}}`
      )
      // Full List template 的印完整 rule JSON，作為生成其他公司 mapping 的範本
      if (/full list/i.test(m.template_name || '')) {
        for (const r of rules) {
          console.log(`      RULE: ${JSON.stringify(r)}`)
        }
      }
    }
  } catch (e) {
    console.error('  [existing mappings] 查詢失敗:', e.message)
  }
}

// ---------------------------------------------------------------------------
// Seed（dryrun / write）：讀 template-mappings-data.json，upsert COMPANY-scope mapping
// ---------------------------------------------------------------------------

async function runSeed(client, doWrite) {
  const fs = require('fs')
  const path = require('path')
  let data
  try {
    data = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'template-mappings-data.json'), 'utf8')
    )
  } catch (e) {
    console.error('[seed] 讀取 template-mappings-data.json 失敗:', e.message)
    return
  }
  const generated = data.generated || []
  const unmatched = data.unmatched || []
  console.log(`[seed] ${doWrite ? 'WRITE' : 'DRYRUN'} — ${generated.length} 筆 mapping`)

  // 驗證 company / template 在 DB 存在（不存在則該筆 SKIP）
  const companyIds = [...new Set(generated.map((m) => m.companyId))]
  const templateIds = [...new Set(generated.map((m) => m.dataTemplateId))]
  const cRes = await client.query('select id from companies where id = any($1)', [companyIds])
  const tRes = await client.query('select id from data_templates where id = any($1)', [templateIds])
  const foundC = new Set(cRes.rows.map((r) => r.id))
  const foundT = new Set(tRes.rows.map((r) => r.id))
  console.log(
    `  company 驗證: ${foundC.size}/${companyIds.length} 存在；template 驗證: ${foundT.size}/${templateIds.length} 存在`
  )
  for (const id of companyIds) if (!foundC.has(id)) console.log(`    ⚠ company 不存在: ${id}`)
  for (const id of templateIds) if (!foundT.has(id)) console.log(`    ⚠ template 不存在: ${id}`)

  let done = 0
  let skipped = 0
  for (const m of generated) {
    if (!foundC.has(m.companyId) || !foundT.has(m.dataTemplateId)) {
      console.log(`  SKIP（company/template 不存在）: ${m.name}`)
      skipped++
      continue
    }
    console.log(
      `  ${doWrite ? 'WRITE' : 'DRYRUN'}: ${m.azureName} | ${m.direction} | rules=${m.mappings.length}`
    )
    if (doWrite) {
      await client.query('begin')
      try {
        // 冪等：先刪同 (template, company, COMPANY, null format) 舊列，再插
        // （null document_format_id 會使 @@unique 失效，故不用 on conflict）
        await client.query(
          `delete from template_field_mappings
             where data_template_id=$1 and company_id=$2 and scope='COMPANY' and document_format_id is null`,
          [m.dataTemplateId, m.companyId]
        )
        await client.query(
          `insert into template_field_mappings
             (id, data_template_id, scope, company_id, document_format_id, name, description,
              mappings, priority, is_active, created_at, updated_at)
           values (gen_random_uuid()::text, $1, 'COMPANY', $2, null, $3, $4, $5::jsonb, 0, true, now(), now())`,
          [m.dataTemplateId, m.companyId, m.name, 'CHANGE-101 batch import', JSON.stringify(m.mappings)]
        )
        await client.query('commit')
        done++
      } catch (e) {
        await client.query('rollback')
        console.error(`    ✗ WRITE 失敗 ${m.name}:`, e.message)
      }
    }
  }
  console.log(
    `\n[seed] ${doWrite ? `已寫入 ${done}` : `將寫入 ${generated.length - skipped}`} 筆，skip ${skipped} 筆`
  )
  console.log(`[seed] Excel 對不上 template 欄位（未納入，${unmatched.length}）：`)
  for (const u of unmatched) console.log(`    ${u.company} [${u.dir}] "${u.targetVal}"`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[template-mapping] DATABASE_URL not set — cannot continue')
    process.exit(1)
  }

  console.log(`[template-mapping] MODE=${MODE}`)

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveSsl(),
    connectionTimeoutMillis: 30000,
  })

  await client.connect()
  try {
    if (MODE === 'inspect') {
      console.log('[template-mapping] === INSPECT（唯讀，不寫入）===')
      await inspectTemplates(client)
      await inspectCompanies(client)
      await inspectExtractionKeys(client)
      await inspectExistingMappings(client)
      console.log('\n[template-mapping] INSPECT 完成（DB 無任何變更）')
    } else if (MODE === 'dryrun' || MODE === 'write') {
      await runSeed(client, MODE === 'write')
    } else {
      console.log(
        `[template-mapping] 未知 MODE=${MODE}，僅支援 inspect / dryrun / write。不執行。`
      )
    }
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('[template-mapping] FAILED:', e.message)
  process.exit(1)
})
