/**
 * @fileoverview CHANGE-113：把本地驗證期間改動的兩項設定恢復原狀（gated）
 * @description
 *   驗證期間為了讓分組展開跑得起來，改了兩項**與功能設定無關**的東西：
 *     1. GLOBAL 模板 `line_item_mode`：PIVOT → GROUP
 *     2. 模板實例狀態：COMPLETED → DRAFT（COMPLETED 的實例不接受新資料，重跑必須先降回）
 *
 *   ⚠️ 本腳本**不會**動四項功能設定（燃油欄位、prompt 修正、兩條映射規則）——
 *   那些是 CHANGE-113 的正式配置，已同步部署到 Azure，還原它們等於撤銷功能。
 *
 *   預設 dry-run；實際寫入需帶 `APPLY=true`。
 *
 * @module scripts/change-113/restore-local-settings
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-30
 */
require('dotenv').config()
const { Client } = require('pg')

const TEMPLATE_NAME = 'Logistics Cost - Inbound Template (Full List)'
const INSTANCE_ID = 'cms63ciay000020xgvtzogbow'

const TEMPLATE_TARGET = 'PIVOT'
const INSTANCE_TARGET = 'COMPLETED'

async function main() {
  const apply = process.env.APPLY === 'true'
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  try {
    const tpl = await client.query(
      `select id, name, line_item_mode from data_templates where name = $1`,
      [TEMPLATE_NAME]
    )
    if (tpl.rows.length !== 1) throw new Error(`模板筆數 ${tpl.rows.length}（預期 1）`)
    const template = tpl.rows[0]

    const inst = await client.query(
      `select id, name, status from template_instances where id = $1`,
      [INSTANCE_ID]
    )
    const instance = inst.rows[0] ?? null

    console.log(`模板 ${template.name}`)
    console.log(`  line_item_mode = ${template.line_item_mode} → ${TEMPLATE_TARGET}`)
    console.log(`實例 ${instance ? instance.name : '(找不到)'}`)
    if (instance) console.log(`  status = ${instance.status} → ${INSTANCE_TARGET}`)

    if (!apply) {
      console.log('\n[dry-run] 未寫入。要實際套用請帶 APPLY=true')
      return
    }

    if (template.line_item_mode !== TEMPLATE_TARGET) {
      const r = await client.query(
        `update data_templates set line_item_mode = $2, updated_at = now() where id = $1`,
        [template.id, TEMPLATE_TARGET]
      )
      if (r.rowCount !== 1) throw new Error(`模板更新 ${r.rowCount} 筆（預期 1）`)
      console.log(`✅ 模板 line_item_mode → ${TEMPLATE_TARGET}`)
    } else {
      console.log('模板已是目標值 —— 無需變更')
    }

    if (instance && instance.status !== INSTANCE_TARGET) {
      const r = await client.query(
        `update template_instances set status = $2, updated_at = now() where id = $1`,
        [instance.id, INSTANCE_TARGET]
      )
      if (r.rowCount !== 1) throw new Error(`實例更新 ${r.rowCount} 筆（預期 1）`)
      console.log(`✅ 實例 status → ${INSTANCE_TARGET}`)
    } else if (instance) {
      console.log('實例已是目標值 —— 無需變更')
    }
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
