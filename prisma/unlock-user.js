/**
 * @fileoverview 解除因連續登入失敗而被鎖定的帳號（FIX-171 / BUG-7 的解鎖途徑）
 *
 * @description
 *   BUG-7 採「管理員手動解鎖」，正常途徑是管理員在 UI 操作。本腳本是**死鎖後備**：
 *   當唯一或全部管理員自己被鎖在門外時，UI 那條路走不通，需要直接操作資料庫。
 *
 *   設計取捨（為何放在 prisma/ 而非 scripts/、為何用 pg 而非 Prisma Client）：
 *   - Azure runner 映像**不含 `scripts/` 目錄、也沒有 tsx**，放那裡在真正需要時
 *     （管理員被鎖在 Azure DEV）根本執行不了 —— 這正是本腳本存在的唯一場景
 *   - 只依賴 `pg`（standalone runtime 已含），比照 bootstrap-db.js / apply-schema-drift.js
 *
 *   遵循專案的「不可逆資料操作紀律」三段式：
 *     node prisma/unlock-user.js inspect                      # 列出所有被鎖定帳號
 *     node prisma/unlock-user.js inspect --email=someone@x.com
 *     node prisma/unlock-user.js dryrun  --email=someone@x.com # 印 before/after，不寫入
 *     node prisma/unlock-user.js write   --email=someone@x.com # 實際解鎖
 *
 *   write 具備：前置快照（印出解鎖前完整狀態）、單一交易、數量閘（rowCount !== 1 即
 *   ROLLBACK）、樂觀鎖（WHERE updated_at = 讀取當下值）、冪等（已解鎖則跳過）。
 *
 *   ⚠️ 本腳本會在 stdout 印出 email —— 管理員必須據此確認解鎖對象，屬必要輸出。
 *      請勿將其輸出重導到會被提交或長期保存的檔案。
 *
 * @module prisma/unlock-user
 * @since FIX-171 / BUG-7 (2026-08-07)
 */
const { Client } = require('pg')

function resolveSsl() {
  const url = process.env.DATABASE_URL || ''
  if (/sslmode=require/i.test(url) || /\.postgres\.database\.azure\.com/i.test(url)) {
    return { rejectUnauthorized: false }
  }
  return false
}

function parseArgs() {
  const mode = process.argv[2]
  const emailArg = process.argv.find((a) => a.startsWith('--email='))
  const email = emailArg ? emailArg.slice('--email='.length).toLowerCase().trim() : null
  return { mode, email }
}

function usage() {
  console.error('用法：')
  console.error('  node prisma/unlock-user.js inspect [--email=<email>]')
  console.error('  node prisma/unlock-user.js dryrun  --email=<email>')
  console.error('  node prisma/unlock-user.js write   --email=<email>')
}

function describe(row) {
  const locked = row.locked_until && new Date(row.locked_until) > new Date()
  return [
    `  id                    = ${row.id}`,
    `  email                 = ${row.email}`,
    `  status                = ${row.status}`,
    `  failed_login_attempts = ${row.failed_login_attempts}`,
    `  locked_until          = ${row.locked_until ? row.locked_until.toISOString() : 'null'}`,
    `  → 目前${locked ? '已鎖定' : '未鎖定'}`,
  ].join('\n')
}

async function main() {
  const { mode, email } = parseArgs()

  if (!['inspect', 'dryrun', 'write'].includes(mode)) {
    usage()
    process.exit(1)
  }

  if (!process.env.DATABASE_URL) {
    console.error('[unlock-user] DATABASE_URL 未設定 — 無法繼續')
    process.exit(1)
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveSsl(),
    connectionTimeoutMillis: 30000,
  })

  await client.connect()

  try {
    // ── inspect：唯讀 ────────────────────────────────────────────────
    if (mode === 'inspect') {
      if (email) {
        const { rows } = await client.query(
          `select "id", "email", "status", "failed_login_attempts", "locked_until"
             from "users" where "email" = $1`,
          [email]
        )
        if (rows.length === 0) {
          console.log(`[unlock-user] 查無此帳號：${email}`)
          return
        }
        console.log('[unlock-user] 目前狀態：')
        console.log(describe(rows[0]))
        return
      }

      const { rows } = await client.query(
        `select "id", "email", "status", "failed_login_attempts", "locked_until"
           from "users"
          where "locked_until" is not null and "locked_until" > now()
          order by "locked_until" desc`
      )
      console.log(`[unlock-user] 目前被鎖定的帳號：${rows.length} 筆`)
      rows.forEach((r) => console.log(describe(r) + '\n'))
      return
    }

    // ── dryrun / write：需指定 email ─────────────────────────────────
    if (!email) {
      console.error('[unlock-user] dryrun / write 必須指定 --email=<email>')
      usage()
      process.exit(1)
    }

    const { rows } = await client.query(
      `select "id", "email", "status", "failed_login_attempts", "locked_until", "updated_at"
         from "users" where "email" = $1`,
      [email]
    )

    if (rows.length === 0) {
      console.error(`[unlock-user] 查無此帳號：${email}`)
      process.exit(1)
    }

    const user = rows[0]

    // 前置快照 —— 唯一的還原依據
    console.log('[unlock-user] BEFORE（解鎖前完整狀態，請保留此輸出作為還原依據）：')
    console.log(describe(user))

    // 冪等：已是目標狀態則跳過
    const isLocked = user.locked_until && new Date(user.locked_until) > new Date()
    if (!isLocked && user.failed_login_attempts === 0) {
      console.log('[unlock-user] 此帳號未被鎖定且失敗計數為 0 — 無須變更')
      return
    }

    if (mode === 'dryrun') {
      console.log('[unlock-user] AFTER（預期，dryrun 不寫入）：')
      console.log('  failed_login_attempts = 0')
      console.log('  locked_until          = null')
      console.log('[unlock-user] dryrun 結束，未寫入任何資料')
      return
    }

    // ── write：單一交易 + 樂觀鎖 + 數量閘 ────────────────────────────
    await client.query('BEGIN')
    const res = await client.query(
      `update "users"
          set "failed_login_attempts" = 0,
              "locked_until" = null,
              "updated_at" = now()
        where "id" = $1 and "updated_at" = $2`,
      [user.id, user.updated_at]
    )

    if (res.rowCount !== 1) {
      await client.query('ROLLBACK')
      throw new Error(
        `預期更新 1 筆，實際 ${res.rowCount} 筆 — 該筆記錄在讀取後已被更動（並發寫入？）。已 ROLLBACK，請重跑 inspect 確認現況。`
      )
    }

    await client.query('COMMIT')
    console.log(`[unlock-user] 已解鎖：${user.email}（failed_login_attempts 歸零、locked_until 清空）`)
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // 未開啟交易時 ROLLBACK 會失敗，忽略即可
    }
    throw e
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('[unlock-user] 失敗：', e.message)
  process.exit(1)
})
