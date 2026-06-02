#!/usr/bin/env node
/**
 * @fileoverview FIX-059 驗證腳本：月度成本報表 SQL 煙霧測試
 * @description
 *   對 dev DB 執行「修正前」與「修正後」的 SQL，證明：
 *   1. 修正前的 `SUM(ai_cost) FROM documents` 會拋 `column "ai_cost" does not exist`
 *   2. 修正後的查詢（documents 計數 + api_usage_logs 加總 estimated_cost）皆成功執行
 *
 *   採原生 pg（沿用 scripts/verify-environment.ts 的 precedent），唯讀、不改任何資料。
 *   DB 不可達時優雅 SKIP（exit 0），避免在無 DB 環境中誤判失敗。
 *
 * @module scripts/verify-fix-059-monthly-cost-sql
 * @since FIX-059
 * @lastModified 2026-06-02
 *
 * 用法：
 *   npx ts-node scripts/verify-fix-059-monthly-cost-sql.ts
 *
 * 退出碼：
 *   0 - 全部通過（或 DB 不可達而 SKIP）
 *   1 - 修正後 SQL 仍失敗，或修正前 SQL 未如預期報錯
 */

import 'dotenv/config'
import { Pool } from 'pg'

const START = new Date('2000-01-01T00:00:00.000Z')
const END = new Date('2999-12-31T23:59:59.999Z')

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.log('🟡 SKIP：未設定 DATABASE_URL，跳過 SQL 煙霧測試。')
    process.exit(0)
  }

  const pool = new Pool({ connectionString, connectionTimeoutMillis: 4000 })

  // 連線可達性檢查（不可達 → SKIP）
  try {
    await pool.query('SELECT 1')
  } catch (err) {
    console.log(
      `🟡 SKIP：dev DB 不可達（${(err as Error).message}）。請先 docker-compose up -d 後再跑。`
    )
    await pool.end()
    process.exit(0)
  }

  const results: CheckResult[] = []

  // 1) 修正前的查詢應報錯（證明 bug 真實存在且來源正確）
  try {
    await pool.query(
      `SELECT COALESCE(SUM(ai_cost), 0)::float AS cost FROM documents
       WHERE created_at >= $1 AND created_at <= $2`,
      [START, END]
    )
    results.push({
      name: '修正前 SUM(ai_cost) FROM documents 應報錯',
      ok: false,
      detail: '⚠️ 預期報錯但竟成功 —— documents.ai_cost 似乎存在，請重新確認 schema',
    })
  } catch (err) {
    const msg = (err as Error).message
    const expected = /ai_cost/.test(msg) && /does not exist/.test(msg)
    results.push({
      name: '修正前 SUM(ai_cost) FROM documents 應報錯',
      ok: expected,
      detail: expected ? `如預期報錯：${msg}` : `報錯但訊息非預期：${msg}`,
    })
  }

  // 2) 修正後：documents 按城市計數（volume 來源）
  await runOk(
    pool,
    results,
    '修正後 documents 按城市計數',
    `SELECT city_code, COUNT(*)::bigint AS volume FROM documents
     WHERE created_at >= $1 AND created_at <= $2 GROUP BY city_code`
  )

  // 3) 修正後：api_usage_logs 按城市加總 estimated_cost（AI 成本來源）
  await runOk(
    pool,
    results,
    '修正後 api_usage_logs 按城市加總 estimated_cost',
    `SELECT city_code, COALESCE(SUM(estimated_cost), 0)::float AS cost FROM api_usage_logs
     WHERE created_at >= $1 AND created_at <= $2 GROUP BY city_code`
  )

  // 4) 修正後：documents 按日計數
  await runOk(
    pool,
    results,
    '修正後 documents 按日計數',
    `SELECT DATE(created_at) AS date, COUNT(*)::bigint AS volume FROM documents
     WHERE created_at >= $1 AND created_at <= $2 GROUP BY DATE(created_at)`
  )

  // 5) 修正後：api_usage_logs 按日加總 estimated_cost
  await runOk(
    pool,
    results,
    '修正後 api_usage_logs 按日加總 estimated_cost',
    `SELECT DATE(created_at) AS date, COALESCE(SUM(estimated_cost), 0)::float AS cost FROM api_usage_logs
     WHERE created_at >= $1 AND created_at <= $2 GROUP BY DATE(created_at)`
  )

  await pool.end()

  // 輸出結果
  console.log('\n=== FIX-059 SQL 煙霧測試結果 ===')
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}\n   ${r.detail}`)
  }

  const allOk = results.every((r) => r.ok)
  console.log(`\n${allOk ? '✅ 全部通過' : '❌ 有檢查未通過'}`)
  process.exit(allOk ? 0 : 1)
}

async function runOk(
  pool: Pool,
  results: CheckResult[],
  name: string,
  sql: string
): Promise<void> {
  try {
    const res = await pool.query(sql, [START, END])
    results.push({
      name,
      ok: true,
      detail: `成功執行，回傳 ${res.rowCount} 列`,
    })
  } catch (err) {
    results.push({
      name,
      ok: false,
      detail: `執行失敗：${(err as Error).message}`,
    })
  }
}

main().catch((err) => {
  console.error('腳本未預期錯誤：', err)
  process.exit(1)
})
