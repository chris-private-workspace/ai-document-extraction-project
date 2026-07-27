/**
 * @fileoverview FIX-110（Azure 端）：一次性把 9 條針對性 aliases 冪等寫入已部署 DB 的
 *   COMPANY 級 FieldDefinitionSet 費用欄位（`fieldType === 'lineItem'`）。
 *
 *   背景：Stage 3 費用回填（`backfillLineItemCharges`）以 lineItem 的 description 對
 *   field def 的 `label` + `aliases` 比對（見 stage-3-extraction.service.ts /
 *   classify-normalizer.ts）。FIX-110 盤查 Azure DEV 267 份文件後確認:少數費用行的
 *   description 是乾淨 label 文字、只是與現有 label 用字不同（如 `Terminal Handling
 *   Charge at Origin` vs label `Origin THC - Terminal Handling Charge`），原本只靠
 *   GPT 改寫的 classifiedAs 才勉強命中（脆弱）。補這 9 條 alias 後即轉為確定性穩定。
 *
 *   這 9 條每條皆通過碰撞檢查（加入後該 description 仍唯一解到目標 key）。詳見
 *   claudedocs/4-changes/bug-fixes/FIX-110-*.md §4/§5。
 *
 *   FieldDefinitionSet 來自本地 DB 同步匯入，**重新部署 / re-import 不會帶入本次直接
 *   寫入的 aliases**（essential seed 不 seed 它）。故保留本 gated 腳本,DEV 若被
 *   reset/re-import 可冪等重跑補回。
 *
 *   設計重點（比照 update-stage3-prompt.js / grant-global-admin.js）：
 *   - 只依賴 `pg`（已包含在 standalone runtime），不需 Prisma CLI / tsx
 *   - Azure PostgreSQL 需 TLS：偵測 sslmode=require 或 azure host 時啟用
 *   - 冪等：alias 已存在（正規化比對）則跳過；只在有變更時才 UPDATE
 *   - 安全:公司以「精確名稱 → 恰好 1 個 active COMPANY set」解析;0 或 >1 則跳過該公司
 *     （避免誤寫到重名/重複公司的 set,例如多個 CEVA 變體）
 *   - 參數化查詢防注入；非致命（由 entrypoint 包 || 處理）
 *
 *   由 docker-entrypoint.sh 的 RUN_FIX110_ALIAS_BACKFILL=true 觸發；補完後把旗標設回 false。
 *
 * @module prisma/apply-fix110-aliases
 * @since FIX-110 (2026-07-15)
 * @lastModified 2026-07-15
 */
const { Client } = require('pg')

function resolveSsl() {
  const url = process.env.DATABASE_URL || ''
  if (/sslmode=require/i.test(url) || /\.postgres\.database\.azure\.com/i.test(url)) {
    return { rejectUnauthorized: false }
  }
  return false
}

// 正規化比對（大小寫、標點、空白不敏感）—— 對齊 classify-normalizer.canonicalizeLabel 的精神,
// 僅供「alias 是否已存在」冪等判斷用。
function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// FIX-110 §4 的 9 條:{ 公司精確名稱, field def key, 要補的 alias }
const TARGETS = [
  { company: 'CEVA Logistics', key: 'origin_thc_terminal_handling_charge', alias: 'Terminal Handling Charge at Origin' },
  { company: 'CEVA Logistics', key: 'solas_vgm_management_fee', alias: 'Vgm Certificate Fee' },
  { company: 'CEVA Logistics', key: 'destination_document_processing_fee', alias: 'Documentation at Destination' },
  { company: 'CEVA Logistics', key: 'destination_handling', alias: 'Handling & Processing at Destination' },
  { company: 'CEVA Logistics', key: 'destination_thc_terminal_handling_charge', alias: 'Terminal Handling Charge at Destination' },
  { company: 'Nippon Express Logistics', key: 'other_charges', alias: 'OTHER CHARGES' },
  { company: 'Fairate Express', key: 'airline_document_charge', alias: 'AIRLINE DOCUMENTATION CHARGE' },
  { company: 'Fairate Express', key: 'container_field_station_charge', alias: 'CONTAINER FIELD STATION CHARGES' },
  { company: 'NIPPON EXPRESS (HK) CO., LTD.（NIPPON EXPRESS）', key: 'container_seal_fee', alias: 'CONTAINER SEAL FEE - FCL' },
]

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[fix110-alias] DATABASE_URL not set — cannot continue')
    process.exit(1)
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveSsl(),
    connectionTimeoutMillis: 30000,
  })
  await client.connect()

  let added = 0
  let noop = 0
  let skipped = 0

  try {
    // 依公司分組（一間公司一次 UPDATE，把該公司的多條 alias 一起寫）
    const byCompany = {}
    for (const t of TARGETS) (byCompany[t.company] = byCompany[t.company] || []).push(t)

    for (const name of Object.keys(byCompany)) {
      const sets = await client.query(
        `select s.id, s.fields
           from field_definition_sets s
           join companies co on co.id = s.company_id
          where co.name = $1 and s.scope::text = 'COMPANY' and s.is_active = true`,
        [name]
      )
      if (sets.rows.length !== 1) {
        console.error(
          `[fix110-alias] SKIP company "${name}": matched ${sets.rows.length} active COMPANY sets (need exactly 1)`
        )
        skipped += byCompany[name].length
        continue
      }

      const row = sets.rows[0]
      const fields = Array.isArray(row.fields) ? row.fields : []
      let changed = false

      for (const t of byCompany[name]) {
        const entry = fields.find((f) => f && f.key === t.key)
        if (!entry) {
          console.error(`[fix110-alias] SKIP ${name} / ${t.key}: key not found`)
          skipped++
          continue
        }
        if (!Array.isArray(entry.aliases)) entry.aliases = []
        if (entry.aliases.some((a) => norm(a) === norm(t.alias))) {
          noop++
          continue
        }
        entry.aliases.push(t.alias)
        changed = true
        added++
      }

      if (changed) {
        await client.query(
          `update field_definition_sets set fields = $1::jsonb, updated_at = now() where id = $2`,
          [JSON.stringify(fields), row.id]
        )
        console.log(`[fix110-alias] wrote set ${row.id} (${name})`)
      }
    }

    console.log(
      `[fix110-alias] done — added ${added}, already-present ${noop}, skipped ${skipped} (of ${TARGETS.length} targets)`
    )
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('[fix110-alias] FAILED:', e.message)
  process.exit(1)
})
