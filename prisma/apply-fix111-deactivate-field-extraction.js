/**
 * @fileoverview FIX-111（Azure 端，即時資料層修正）：把 GLOBAL 的通用 `FIELD_EXTRACTION`
 *   PromptConfig 設為 is_active=false，讓 V3.1 Stage 3 的 GLOBAL 選型只剩帶「amount HKD only」
 *   規則的 `STAGE_3_FIELD_EXTRACTION`。
 *
 *   背景：Stage 3 由 loadPromptConfigHierarchical() 以 `promptType IN
 *   ('STAGE_3_FIELD_EXTRACTION','FIELD_EXTRACTION')` 查 GLOBAL PromptConfig。當兩型都 active
 *   時，原 findFirst 無 orderBy → 由 DB 列順序任意選一；Azure DEV 實測選中無 HKD 規則的
 *   FIELD_EXTRACTION，使費用金額取到非 HKD 欄（詳見 FIX-111 §根因）。
 *
 *   FIX-111 的程式碼修正（pickPreferredExtractionConfig，STAGE_3 優先）隨映像生效後即根治此問題；
 *   本腳本是**在映像重建前**的即時修正——直接讓 FIELD_EXTRACTION 退出 GLOBAL active 集合。
 *
 *   ⚠️ 安全性：停用 GLOBAL FIELD_EXTRACTION 對 legacy 路徑（gpt-vision getPromptForType /
 *   config-fetching.step）行為中性——它們在 DB 無此 config 時 fallback 到 static-prompts.ts 的
 *   FIELD_EXTRACTION，內容與現行 DB 版（FIX-095 模板）逐字相同。
 *
 *   安全閘：僅當存在「GLOBAL 且 active 的 STAGE_3_FIELD_EXTRACTION」時才停用，否則中止
 *   （避免停用後 Stage 3 GLOBAL 完全無提取 prompt、退回程式碼硬編碼 default）。
 *
 *   設計重點（比照 update-stage3-prompt.js / apply-fix110-aliases.js）：
 *   - 只依賴 `pg`（standalone runtime 已含），不需 Prisma CLI / tsx
 *   - Azure PostgreSQL 需 TLS：偵測 sslmode=require 或 azure host 時啟用
 *   - 冪等：只更新目前仍 active 者（is_active=true 條件）；已停用則 0 筆
 *   - 參數化查詢防注入；非致命（由 entrypoint 包 || 處理）；不印連線字串
 *
 *   由 docker-entrypoint.sh 的 RUN_FIX111_DEACTIVATE_FIELD_EXTRACTION=true 觸發；補完後把旗標設回 false。
 *
 * @module prisma/apply-fix111-deactivate-field-extraction
 * @since FIX-111 (2026-07-16)
 * @lastModified 2026-07-16
 */
const { Client } = require('pg')

function resolveSsl() {
  const url = process.env.DATABASE_URL || ''
  if (/sslmode=require/i.test(url) || /\.postgres\.database\.azure\.com/i.test(url)) {
    return { rejectUnauthorized: false }
  }
  return false
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[fix111] DATABASE_URL not set — cannot continue')
    process.exit(1)
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveSsl(),
    connectionTimeoutMillis: 30000,
  })
  await client.connect()

  try {
    // 安全閘：確認 GLOBAL 仍有 active 的 STAGE_3_FIELD_EXTRACTION，否則不可停用 FIELD_EXTRACTION。
    const guard = await client.query(
      `select count(*)::int as n
         from prompt_configs
        where scope::text = 'GLOBAL'
          and prompt_type::text = 'STAGE_3_FIELD_EXTRACTION'
          and is_active = true`
    )
    const stage3Count = guard.rows[0] ? guard.rows[0].n : 0
    if (stage3Count < 1) {
      console.error(
        `[fix111] ABORT: no active GLOBAL STAGE_3_FIELD_EXTRACTION found (${stage3Count}); ` +
          'refusing to deactivate GLOBAL FIELD_EXTRACTION (would leave Stage 3 without an extraction prompt)'
      )
      return
    }

    // 停用 GLOBAL 的通用 FIELD_EXTRACTION（冪等：只動仍 active 者）。
    const res = await client.query(
      `update prompt_configs
         set is_active = false, updated_at = now()
       where scope::text = 'GLOBAL'
         and prompt_type::text = 'FIELD_EXTRACTION'
         and is_active = true`
    )
    console.log(
      `[fix111] done — deactivated ${res.rowCount} GLOBAL FIELD_EXTRACTION config(s) ` +
        `(0 = already inactive); kept ${stage3Count} active GLOBAL STAGE_3_FIELD_EXTRACTION`
    )
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('[fix111] FAILED:', e.message)
  process.exit(1)
})
