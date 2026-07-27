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
 * @lastModified 2026-07-27
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
  // FIX-128：template_instance_rows.transform_diagnostics（轉換診斷：引用了不存在來源 key 的清單）。
  // 對應 migration 20260722020000；Azure 既有表非空，bootstrap 不會套用，需此增量補上。
  {
    id: 'FIX-128 column template_instance_rows.transform_diagnostics',
    sql: `alter table "template_instance_rows" add column if not exists "transform_diagnostics" jsonb;`,
  },
  // FIX-133：template_field_mappings 唯一性改為 NULLS NOT DISTINCT 的部分唯一索引。
  // 原 @@unique 因 PostgreSQL 預設 NULLS DISTINCT 而對任何範圍都不生效（每種 scope 必含
  // ≥1 個 NULL），從未擋下任何重複。改限定 is_active = true —— 對應 service.create() 的
  // 檢查條件，且既有停用列不受約束、無需刪除任何資料。
  // 對應 migration 20260725060000 與 prisma/post-init-indexes.sql（三處須保持一致）。
  {
    id: 'FIX-133 drop ineffective full-table unique index on template_field_mappings',
    sql: `drop index if exists "template_field_mappings_data_template_id_scope_company_id_d_key";`,
  },
  {
    id: 'FIX-133 index template_field_mappings_active_unique (NULLS NOT DISTINCT, partial)',
    sql: `create unique index if not exists "template_field_mappings_active_unique"
      on "template_field_mappings" ("data_template_id", "scope", "company_id", "document_format_id")
      nulls not distinct
      where "is_active" = true;`,
  },
  // CHANGE-109：extraction_results.invoice_number（從 fieldMappings JSON 反正規化，供
  // 「同一發票是否有更新的文件記錄」查詢走索引）。對應 migration 20260727060000。
  // 加完欄位後**還要跑一次回填**（RUN_INVOICE_NUMBER_BACKFILL=true），否則既有資料的
  // invoice_number 全為 null，功能對存量實例靜默無效 —— 而存量實例正是要偵測的對象。
  {
    id: 'CHANGE-109 column extraction_results.invoice_number',
    sql: `alter table "extraction_results" add column if not exists "invoice_number" text;`,
  },
  {
    id: 'CHANGE-109 index extraction_results (company_id, invoice_number)',
    sql: `create index if not exists "extraction_results_company_id_invoice_number_idx"
      on "extraction_results" ("company_id", "invoice_number");`,
  },
  // ── Epic 23（Story 23.1 資料模型 + Story 23.3 P1 routing_thresholds）────────────
  // ⚠️ 這三張表是 Epic 23 全新建立的，而 init.sql 尚未含它們 —— 兩種情況 bootstrap 都不會建：
  //    既有 DB（Azure DEV）直接 skip init.sql；全新空庫套的 init.sql 裡也沒有這三張表。
  //    因此必須在此**完整建表**，只補 routing_thresholds 欄位會因表不存在而失敗。
  // DDL 由 `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`
  // 生成後逐字對齊（僅關鍵字轉小寫配合本檔風格；型別名 "LlmProviderType" 大小寫敏感，保留原樣）。
  // 對應 schema.prisma:4405-4477 的 LlmProvider / LlmModel / StageModelAssignment。
  {
    id: 'Epic-23 enum LlmProviderType',
    sql: `do $$ begin
      create type "LlmProviderType" as enum
        ('AZURE_OPENAI', 'OPENAI', 'ANTHROPIC', 'GOOGLE_GEMINI', 'XAI_GROK', 'OPENAI_COMPATIBLE');
    exception when duplicate_object then null; end $$;`,
  },
  {
    id: 'Epic-23 table llm_providers',
    sql: `create table if not exists "llm_providers" (
      "id" text not null,
      "name" text not null,
      "provider_type" "LlmProviderType" not null,
      "base_url" text,
      "api_version" text,
      "api_key_enc" text,
      "is_encrypted" boolean not null default true,
      "key_version" integer not null default 1,
      "is_enabled" boolean not null default true,
      "is_default" boolean not null default false,
      "allow_sensitive_data" boolean not null default false,
      "extra_config" jsonb,
      "created_at" timestamp(3) not null default current_timestamp,
      "updated_at" timestamp(3) not null,
      "updated_by" text,
      constraint "llm_providers_pkey" primary key ("id")
    );`,
  },
  {
    id: 'Epic-23 table llm_models',
    sql: `create table if not exists "llm_models" (
      "id" text not null,
      "provider_id" text not null,
      "model_key" text not null,
      "label" text not null,
      "capability" jsonb not null,
      "pricing" jsonb,
      "routing_thresholds" jsonb,
      "is_enabled" boolean not null default true,
      "created_at" timestamp(3) not null default current_timestamp,
      "updated_at" timestamp(3) not null,
      constraint "llm_models_pkey" primary key ("id")
    );`,
  },
  {
    id: 'Epic-23 table stage_model_assignments',
    sql: `create table if not exists "stage_model_assignments" (
      "id" text not null,
      "stage_key" text not null,
      "llm_model_id" text,
      "updated_by" text,
      "created_at" timestamp(3) not null default current_timestamp,
      "updated_at" timestamp(3) not null,
      constraint "stage_model_assignments_pkey" primary key ("id")
    );`,
  },
  // 表已存在（例如先前以舊版 schema 建過）時 create table 會整句 skip，故欄位另外補一次。
  // 對應 migration 20260727030000_add_routing_thresholds_to_llm_models。
  {
    id: 'Epic-23 column llm_models.routing_thresholds',
    sql: `alter table "llm_models" add column if not exists "routing_thresholds" jsonb;`,
  },
  {
    id: 'Epic-23 indexes llm_providers',
    sql: `create unique index if not exists "llm_providers_name_key" on "llm_providers" ("name");
      create index if not exists "llm_providers_provider_type_idx" on "llm_providers" ("provider_type");
      create index if not exists "llm_providers_is_enabled_idx" on "llm_providers" ("is_enabled");`,
  },
  {
    id: 'Epic-23 indexes llm_models',
    sql: `create index if not exists "llm_models_is_enabled_idx" on "llm_models" ("is_enabled");
      create unique index if not exists "llm_models_provider_id_model_key_key"
        on "llm_models" ("provider_id", "model_key");`,
  },
  {
    id: 'Epic-23 indexes stage_model_assignments',
    sql: `create unique index if not exists "stage_model_assignments_stage_key_key"
        on "stage_model_assignments" ("stage_key");
      create index if not exists "stage_model_assignments_llm_model_id_idx"
        on "stage_model_assignments" ("llm_model_id");`,
  },
  {
    id: 'Epic-23 fk llm_models_provider_id_fkey',
    sql: `do $$ begin
      alter table "llm_models" add constraint "llm_models_provider_id_fkey"
        foreign key ("provider_id") references "llm_providers"("id")
        on delete cascade on update cascade;
    exception when duplicate_object then null; end $$;`,
  },
  {
    id: 'Epic-23 fk stage_model_assignments_llm_model_id_fkey',
    sql: `do $$ begin
      alter table "stage_model_assignments" add constraint "stage_model_assignments_llm_model_id_fkey"
        foreign key ("llm_model_id") references "llm_models"("id")
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
