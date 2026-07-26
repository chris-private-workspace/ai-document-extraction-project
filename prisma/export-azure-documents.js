/**
 * Azure DEV → 本地：文件處理記錄匯出（CHANGE-108 Phase 3）
 *
 * 🔴 嚴格唯讀 —— 只有 SELECT，不含任何寫入路徑。
 *
 * 匯出指定狀態的文件及其完整處理鏈，供本地重現 Azure 端的提取問題：
 *   documents / ocr_results / extraction_results / processing_queues / document_processing_stages
 *
 * 一併帶回 regions + cities：documents.city_code 對 cities 是 NOT NULL + RESTRICT，
 * 本地缺該城市就插不進去，故匯入端需先補齊（本地 10 城 / 4 region，Azure 可能更多）。
 *
 * 模式（SNAPSHOT_MODE）：
 *   probe（預設）— 印狀態分布、用到的 city_code、各表筆數與預估大小，不輸出資料
 *   export       — 輸出 gzip + base64 到 stdout
 *
 * 篩選：
 *   DOC_STATUSES — 逗號分隔的 documents.status，預設為異常狀態（REF_MATCH_FAILED,
 *                  OCR_FAILED, OCR_PROCESSING, UPLOADED）
 *   DOC_OFFSET / DOC_LIMIT — 分頁，供資料量過大時分塊匯出（extraction_results 的
 *                  stage_*_result / gpt_response 為肥 JSON，單批過大會超出 Kudu stdout）
 */
'use strict';
const zlib = require('zlib');
const { Client } = require('pg');

const MODE = process.env.SNAPSHOT_MODE || 'probe';
const DEFAULT_STATUSES = ['REF_MATCH_FAILED', 'OCR_FAILED', 'OCR_PROCESSING', 'UPLOADED'];
const STATUSES = (process.env.DOC_STATUSES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const USE_STATUSES = STATUSES.length > 0 ? STATUSES : DEFAULT_STATUSES;
const OFFSET = parseInt(process.env.DOC_OFFSET || '0', 10);
const LIMIT = parseInt(process.env.DOC_LIMIT || '0', 10); // 0 = 不限

// 子表：全部以 document_id 關聯，CASCADE from documents
const CHILD_TABLES = [
  'ocr_results',
  'extraction_results',
  'processing_queues',
  'document_processing_stages',
];

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
    console.error('[docs] DATABASE_URL not set — abort');
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveSsl(),
    connectionTimeoutMillis: 30000,
    statement_timeout: 180000,
  });
  await client.connect();

  try {
    const v = await client.query('select version()');
    console.error('[docs] ' + v.rows[0].version.split(',')[0]);
    console.error('[docs] mode=' + MODE + '  statuses=' + USE_STATUSES.join(','));
    console.error('[docs] offset=' + OFFSET + '  limit=' + (LIMIT || '(無)'));

    // ---- 全庫狀態分布（參考）----
    const dist = await client.query(
      'select status::text as status, count(*)::int as n from documents group by 1 order by 2 desc'
    );
    console.error('');
    console.error('[docs] 全庫 documents 狀態分布：');
    for (const r of dist.rows) {
      const hit = USE_STATUSES.indexOf(r.status) >= 0 ? ' ← 選取' : '';
      console.error('  ' + String(r.n).padStart(6) + '  ' + r.status + hit);
    }

    // ---- 目標文件 id ----
    let idSql =
      'select id from documents where status::text = any($1) order by created_at desc offset ' +
      OFFSET;
    if (LIMIT > 0) idSql += ' limit ' + LIMIT;
    const idRes = await client.query(idSql, [USE_STATUSES]);
    const docIds = idRes.rows.map((r) => r.id);
    console.error('');
    console.error('[docs] 選取文件數：' + docIds.length);

    if (docIds.length === 0) {
      console.error('[docs] 無符合條件的文件 — 結束');
      return;
    }

    const snapshot = { _meta: {}, _refs: {} };

    // ---- reference data：regions + cities（匯入端補齊用）----
    snapshot._refs.regions = (await client.query('select * from regions')).rows;
    snapshot._refs.cities = (await client.query('select * from cities')).rows;
    console.error(
      '[docs] Azure regions=' + snapshot._refs.regions.length +
      '  cities=' + snapshot._refs.cities.length
    );

    // ---- documents ----
    const docs = await client.query('select * from documents where id = any($1)', [docIds]);
    snapshot.documents = docs.rows;

    // 這批文件用到的 city_code（匯入端據此檢查是否需補城市）
    const usedCities = [...new Set(docs.rows.map((d) => d.city_code).filter(Boolean))];
    snapshot._meta.usedCityCodes = usedCities;
    console.error('[docs] 用到的 city_code：' + usedCities.join(', '));

    const stats = [{ table: 'documents', rows: docs.rows.length, bytes: Buffer.byteLength(JSON.stringify(docs.rows), 'utf8') }];
    console.error('');
    console.error(
      '  ✓ ' + 'documents'.padEnd(28) + String(docs.rows.length).padStart(6) + ' rows  ' +
      fmtBytes(stats[0].bytes)
    );

    // ---- 子表 ----
    for (const t of CHILD_TABLES) {
      const r = await client.query(`select * from "${t}" where document_id = any($1)`, [docIds]);
      snapshot[t] = r.rows;
      const bytes = Buffer.byteLength(JSON.stringify(r.rows), 'utf8');
      stats.push({ table: t, rows: r.rows.length, bytes });
      console.error(
        '  ✓ ' + t.padEnd(28) + String(r.rows.length).padStart(6) + ' rows  ' + fmtBytes(bytes)
      );
    }

    snapshot._meta.source = 'azure-dev';
    snapshot._meta.statuses = USE_STATUSES;
    snapshot._meta.offset = OFFSET;
    snapshot._meta.limit = LIMIT;
    snapshot._meta.documentIds = docIds;
    snapshot._meta.childTables = CHILD_TABLES;
    snapshot._meta.tableStats = stats;

    const json = JSON.stringify(snapshot);
    const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
    const b64 = gz.toString('base64');

    console.error('');
    console.error('[docs] JSON   : ' + fmtBytes(Buffer.byteLength(json, 'utf8')));
    console.error('[docs] gzip   : ' + fmtBytes(gz.length));
    console.error('[docs] base64 : ' + fmtBytes(b64.length) + '  (' + b64.length + ' chars)');

    if (MODE === 'probe') {
      console.error('');
      console.error('[docs] PROBE 結束 —— 未輸出資料。');
      console.error('[docs] 實際匯出：SNAPSHOT_MODE=export node export-azure-documents.js');
      return;
    }
    if (MODE !== 'export') {
      console.error('[docs] 未知模式：' + MODE);
      process.exit(1);
    }

    process.stdout.write('<<<SNAPSHOT_BEGIN>>>\n');
    process.stdout.write(b64);
    process.stdout.write('\n<<<SNAPSHOT_END>>>\n');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('[docs] FAILED: ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
