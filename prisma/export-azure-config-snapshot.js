/**
 * Azure DEV → 本地：配置快照匯出（CHANGE-108 Phase 1）
 *
 * 🔴 嚴格唯讀 —— 本檔只有 SELECT，不含 INSERT / UPDATE / DELETE / DDL 任何寫入路徑。
 *    Azure DEV 是用戶正在實測的環境，本工具不得改動它。
 *
 * 設計與 import-dev-data.js / bootstrap-db.js 一致：只依賴 `pg`（standalone runtime 已有），
 * 不需 Prisma CLI。可經 Kudu 寫入容器 /tmp 直接執行，無需重新部署或 entrypoint gated flag。
 *
 * 模式（SNAPSHOT_MODE）：
 *   probe（預設）— 只印各表筆數與 JSON / gzip 預估大小，決定分塊策略用，不輸出資料
 *   export       — 輸出 gzip + base64 快照到 stdout，夾在 BEGIN/END 標記之間
 *
 * 選表（SNAPSHOT_TABLES）：逗號分隔的表名子集；未設則全部。用於分塊匯出避開 stdout 上限。
 *
 * 排除清單見 CHANGE-108「明確排除的表」—— 特別是 system_configs 含環境特定值
 * （Azure 模型部署名帶 -aidocprocessing 後綴、endpoint 等），同步會污染本地環境設定。
 */
'use strict';
const zlib = require('zlib');
const { Client } = require('pg');

// 匯出順序 = import-dev-data.js 的 PLAN 順序（父表先），加 prompt_variables。
// 匯入端依此正序 INSERT、逆序 DELETE。
const TABLES = [
  'companies',
  'document_formats',
  'mapping_rules',
  'prompt_configs',
  'prompt_variables',
  'exchange_rates',
  'field_definition_sets',
  'data_templates',
  'field_mapping_configs',
  'field_mapping_rules',
  'template_field_mappings',
  'template_instances',
  'template_instance_rows',
  'pipeline_configs',
  'reference_numbers',
];

const MODE = process.env.SNAPSHOT_MODE || 'probe';
const ONLY = (process.env.SNAPSHOT_TABLES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function resolveSsl() {
  const url = process.env.DATABASE_URL || '';
  if (/sslmode=require/i.test(url) || /\.postgres\.database\.azure\.com/i.test(url)) {
    return { rejectUnauthorized: false };
  }
  return false;
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[export] DATABASE_URL not set — abort');
    process.exit(1);
  }

  const tables = ONLY.length > 0 ? TABLES.filter((t) => ONLY.includes(t)) : TABLES;
  if (ONLY.length > 0) {
    const unknown = ONLY.filter((t) => !TABLES.includes(t));
    if (unknown.length > 0) {
      console.error('[export] unknown table(s) in SNAPSHOT_TABLES: ' + unknown.join(', '));
      process.exit(1);
    }
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveSsl(),
    connectionTimeoutMillis: 30000,
    statement_timeout: 120000,
  });
  await client.connect();

  try {
    const v = await client.query('select version()');
    console.error('[export] ' + v.rows[0].version.split(',')[0]);
    console.error('[export] mode=' + MODE + '  tables=' + tables.length + '/' + TABLES.length);

    const snapshot = { _meta: {}, _refs: {} };

    // ---- regions：供匯入端以 code 重映射（跨環境 UUID 不同）----
    const regions = await client.query('select id, code from regions order by code');
    snapshot._refs.regions = regions.rows;

    // ---- users：僅供對照參考（不匯入；匯入端把 owner 欄位改指本地 admin）----
    const users = await client.query(
      'select id, email, is_global_admin from users order by created_at asc'
    );
    snapshot._refs.users = users.rows;

    // ---- documents metadata 清單：供用戶挑選「出問題的文件」（Phase 3 用）----
    // 只取診斷所需欄位，不含 OCR / 提取內容（gpt_response / stage_*_result 等），避免快照膨脹。
    // extraction_results 對 documents 非保證 1:1 → lateral 取最新一筆，確保每份文件一行。
    const docs = await client.query(
      `select d.id, d.file_name, d.status, d.created_at,
              d.blob_name, d.file_hash, d.processing_path, d.error_message,
              d.company_id, c.name as company_name,
              d.template_instance_id, d.template_matched_at,
              er.id as extraction_result_id, er.status as extraction_status,
              er.average_confidence, er.extraction_version,
              er.stage_2_config_source, er.stage_3_config_scope
         from documents d
         left join companies c on c.id = d.company_id
         left join lateral (
           select e.id, e.status, e.average_confidence, e.extraction_version,
                  e.stage_2_config_source, e.stage_3_config_scope
             from extraction_results e
            where e.document_id = d.id
            order by e.created_at desc
            limit 1
         ) er on true
        order by d.created_at desc`
    );
    snapshot._refs.documents = docs.rows;
    console.error('[export] documents metadata: ' + docs.rows.length + ' rows');

    // ---- 配置表全量 ----
    const stats = [];
    for (const t of tables) {
      const r = await client.query(`select * from "${t}"`);
      snapshot[t] = r.rows;
      const bytes = Buffer.byteLength(JSON.stringify(r.rows), 'utf8');
      stats.push({ table: t, rows: r.rows.length, bytes });
      console.error(
        '  ✓ ' + t.padEnd(26) + String(r.rows.length).padStart(6) + ' rows  ' + fmtBytes(bytes)
      );
    }

    snapshot._meta = {
      source: 'azure-dev',
      exportedTables: tables,
      excludedTables: ['system_configs', 'users', 'roles', 'regions', 'cities'],
      tableStats: stats,
      documentCount: docs.rows.length,
    };

    const json = JSON.stringify(snapshot);
    const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
    const b64 = gz.toString('base64');

    console.error('');
    console.error('[export] JSON   : ' + fmtBytes(Buffer.byteLength(json, 'utf8')));
    console.error('[export] gzip   : ' + fmtBytes(gz.length));
    console.error('[export] base64 : ' + fmtBytes(b64.length) + '  (' + b64.length + ' chars)');

    if (MODE === 'probe') {
      console.error('');
      console.error('[export] PROBE 模式結束 —— 未輸出資料。');
      console.error('[export] 實際匯出：SNAPSHOT_MODE=export node export-azure-config-snapshot.js');
      return;
    }

    if (MODE !== 'export') {
      console.error('[export] 未知模式：' + MODE + '（僅接受 probe / export）');
      process.exit(1);
    }

    // 資料走 stdout，診斷訊息全走 stderr，便於呼叫端分離解析。
    process.stdout.write('<<<SNAPSHOT_BEGIN>>>\n');
    process.stdout.write(b64);
    process.stdout.write('\n<<<SNAPSHOT_END>>>\n');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('[export] FAILED: ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
