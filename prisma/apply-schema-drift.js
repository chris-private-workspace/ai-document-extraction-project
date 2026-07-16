/**
 * @fileoverview 增量、非破壞性的 schema 漂移修補（過渡補丁）。
 *   bootstrap-db.js 只「空庫才建表」、不遷移既有 DB；當 schema.prisma 演進
 *   （加欄位 / enum / index）但 Azure DB 已有表時，既有 DB 拿不到新結構 →
 *   凡查該表的功能執行期 P2022（欄位不存在）。本 script 逐條跑冪等 DDL，
 *   把增量結構補進既有 DB（保留資料、不重建表）。
 *
 *   設計重點（比照 bootstrap-db.js）：
 *   - 只依賴 `pg`（已包含在 standalone runtime），不需 Prisma CLI / schema engine
 *   - Azure PostgreSQL 需 TLS：偵測 sslmode=require 或 azure host 時啟用
 *   - 冪等：enum 用 DO/EXCEPTION duplicate_object、欄位 ADD COLUMN IF NOT EXISTS、
 *     索引 CREATE INDEX IF NOT EXISTS；單筆失敗不影響其他筆（非致命）
 *
 *   由 docker-entrypoint.sh 的 RUN_SCHEMA_DRIFT_FIX=true 觸發，補完後把旗標設回 false。
 *   未來再有漂移 → 在 MIGRATIONS 陣列加一筆 { id, sql }（依賴在前）。
 *   通案根治仍為 CHANGE-056（migration baseline）；本 script 為過渡補丁。
 *
 * @module prisma/apply-schema-drift
 * @since CHANGE-086 (2026-06-23)
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

// 冪等增量 DDL。依賴順序：先建 enum，再加用該 enum 的欄位，最後建索引。
const MIGRATIONS = [
  {
    id: 'CHANGE-086 enum ReferenceNumberSubType',
    sql: `do $$ begin
      create type "ReferenceNumberSubType" as enum ('IMPORT', 'EXPORT', 'BOTH', 'UNKNOWN');
    exception when duplicate_object then null; end $$;`,
  },
  {
    id: 'CHANGE-086 column reference_numbers.document_sub_type',
    sql: `alter table "reference_numbers" add column if not exists "document_sub_type" "ReferenceNumberSubType";`,
  },
  {
    id: 'CHANGE-086 index reference_numbers_document_sub_type_idx',
    sql: `create index if not exists "reference_numbers_document_sub_type_idx" on "reference_numbers" ("document_sub_type");`,
  },
  // CHANGE-103 Phase 2（組件 4）：companies.suspected_duplicate_of_id（灰帶 JIT 記錄疑似重複目標）。
  // 對應 migration 20260716113449；Azure 既有 companies 表非空，bootstrap 不會套用，需此增量補上。
  {
    id: 'CHANGE-103 P2 column companies.suspected_duplicate_of_id',
    sql: `alter table "companies" add column if not exists "suspected_duplicate_of_id" text;`,
  },
  {
    id: 'CHANGE-103 P2 index companies_suspected_duplicate_of_id_idx',
    sql: `create index if not exists "companies_suspected_duplicate_of_id_idx" on "companies" ("suspected_duplicate_of_id");`,
  },
  {
    id: 'CHANGE-103 P2 fk companies_suspected_duplicate_of_id_fkey',
    sql: `do $$ begin
      alter table "companies" add constraint "companies_suspected_duplicate_of_id_fkey"
        foreign key ("suspected_duplicate_of_id") references "companies"("id")
        on delete set null on update cascade;
    exception when duplicate_object then null; end $$;`,
  },
]

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[schema-drift] DATABASE_URL not set — cannot continue')
    process.exit(1)
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveSsl(),
    connectionTimeoutMillis: 30000,
  })

  await client.connect()
  let applied = 0
  let failed = 0
  try {
    for (const m of MIGRATIONS) {
      try {
        await client.query(m.sql)
        console.log(`[schema-drift] OK ${m.id}`)
        applied++
      } catch (e) {
        console.error(`[schema-drift] ERR ${m.id}: ${e.message}`)
        failed++
      }
    }
    console.log(`[schema-drift] done — ${applied} applied, ${failed} failed`)
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('[schema-drift] FAILED:', e.message)
  process.exit(1)
})
