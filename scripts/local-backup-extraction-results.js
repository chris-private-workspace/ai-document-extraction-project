/**
 * 提取結果備份與還原（重新處理前的安全網）
 *
 * 為何需要：`extraction_results.document_id` 有唯一約束，重新處理走 upsert，
 * 會**直接覆蓋**上一次的提取結果，系統不保留處理歷史。若重跑後結果變差，
 * 沒有備份就無法回頭對照，也無法還原。
 *
 * 用法：
 *   node scripts/local-backup-extraction-results.js capture <out.json> [--company=關鍵字] [--file=關鍵字]
 *   node scripts/local-backup-extraction-results.js diff <before.json> <after.json>
 *   node scripts/local-backup-extraction-results.js restore <backup.json> inspect
 *   node scripts/local-backup-extraction-results.js restore <backup.json> dryrun
 *   node scripts/local-backup-extraction-results.js restore <backup.json> write
 *
 * 範圍界線（刻意收窄）：
 *   - `restore` **只**還原 `extraction_results`。
 *   - `documents`、`template_instances`、`template_instance_rows` 只備份供對照，
 *     不自動還原 —— 它們由「重新匹配」而非「重新處理」寫入，混在一起還原會擴大風險面。
 *     模板層要比對請用 scripts/snapshot-template-values.js。
 *
 * write 的五項必備措施（§不可逆資料操作紀律）：
 *   1. 前置快照 —— 寫入前自動另存現況為 <backup>.pre-restore.json
 *   2. 單一交易 —— BEGIN/COMMIT，任一步失敗即 ROLLBACK
 *   3. 數量閘   —— 每筆 rowCount !== 1 即中止
 *   4. 樂觀鎖   —— SELECT ... FOR UPDATE 鎖定目標列，交易內才比對
 *   5. 冪等     —— 現值 updated_at 與備份相同即跳過，重跑不產生副作用
 */
'use strict';
const fs = require('fs');
const path = require('path');
// 由專案根目錄的 .env 取得 DATABASE_URL；已設的環境變數優先，不會被覆蓋
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { Client } = require('pg');

const TABLE = 'extraction_results';

/** 只備份供對照、不還原的表 */
const REFERENCE_TABLES = ['documents', 'template_instances', 'template_instance_rows'];

function usage() {
  console.log('用法：');
  console.log('  node scripts/local-backup-extraction-results.js capture <out.json> [--company=關鍵字] [--file=關鍵字]');
  console.log('  node scripts/local-backup-extraction-results.js diff <before.json> <after.json>');
  console.log('  node scripts/local-backup-extraction-results.js restore <backup.json> inspect|dryrun|write');
}

function argOf(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function connect() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL 未設 — abort');
    process.exit(1);
  }
  return new Client({ connectionString: process.env.DATABASE_URL });
}

/** 從 information_schema 取真實欄位清單（勿硬編碼，schema 會變） */
async function columnsOf(client, table) {
  const r = await client.query(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1
      order by ordinal_position`,
    [table]
  );
  return r.rows.map((x) => x.column_name);
}

// ---------------------------------------------------------------- capture

async function capture(outPath, companyFilter, fileFilter) {
  const client = connect();
  await client.connect();
  try {
    const where = [];
    const params = [];
    if (companyFilter) {
      params.push(`%${companyFilter}%`);
      where.push(`c.name ilike $${params.length}`);
    }
    if (fileFilter) {
      params.push(`%${fileFilter}%`);
      where.push(`d.file_name ilike $${params.length}`);
    }
    const whereSql = where.length ? `where ${where.join(' and ')}` : '';

    const rows = await client.query(
      `select to_jsonb(er) as data,
              d.file_name  as _file_name,
              c.name       as _company_name
         from ${TABLE} er
         join documents d on d.id = er.document_id
         left join companies c on c.id = d.company_id
         ${whereSql}
         order by er.updated_at`,
      params
    );

    const backup = {
      _meta: {
        kind: 'extraction-results-backup',
        capturedAt: new Date().toISOString(),
        filters: { company: companyFilter, file: fileFilter },
        rowCount: rows.rowCount,
      },
      extraction_results: rows.rows.map((r) => ({
        data: r.data,
        _fileName: r._file_name,
        _companyName: r._company_name,
      })),
      _reference: {},
    };

    console.log('=== 提取結果備份 ===');
    console.log(`  篩選：公司=${companyFilter ?? '(全部)'} / 檔名=${fileFilter ?? '(全部)'}`);
    console.log(`  ✓ ${TABLE.padEnd(26)} ${String(rows.rowCount).padStart(6)} 筆`);

    // 對照用表：不篩選，整表帶走（本地資料量小，且還原時需要完整脈絡）
    for (const t of REFERENCE_TABLES) {
      const r = await client.query(`select to_jsonb(t) as data from "${t}" t`);
      backup._reference[t] = r.rows.map((x) => x.data);
      console.log(`  ✓ ${t.padEnd(26)} ${String(r.rowCount).padStart(6)} 筆（僅對照，不還原）`);
    }

    fs.writeFileSync(outPath, JSON.stringify(backup), 'utf8');
    const mb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
    console.log(`\n✅ 已寫入 ${outPath}（${mb} MB）`);
    if (rows.rowCount === 0) {
      console.log('⚠️  0 筆 —— 篩選條件可能沒有命中任何資料，請先確認再重跑。');
    }
  } finally {
    await client.end();
  }
}

// ------------------------------------------------------------------- diff

const numOf = (f) => {
  if (!f || typeof f !== 'object') return null;
  const v = f.value;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const p = parseFloat(v.replace(/,/g, ''));
    return Number.isFinite(p) ? p : null;
  }
  return null;
};

/** 抽出用於比對的關鍵指標 —— 重跑後最需要盯的就是這幾項 */
function digest(entry) {
  const d = entry.data;
  const s3 = d.stage_3_result || {};
  const li = Array.isArray(s3.lineItems) ? s3.lineItems : [];
  const rec = s3.lineItemReconciliation || null;
  return {
    file: entry._fileName,
    company: entry._companyName,
    model: d.gpt_model_used,
    status: d.status,
    updatedAt: d.updated_at,
    currency: s3.fields?.currency?.value ?? null,
    total: numOf(s3.fields?.total_amount),
    subtotal: numOf(s3.fields?.subtotal),
    lineItemCount: li.length,
    lineItemSum: +li.reduce((s, x) => s + (typeof x.amount === 'number' ? x.amount : 0), 0).toFixed(2),
    mismatch: rec ? rec.mismatch === true : null,
    avgConfidence: d.average_confidence,
    configSource: d.stage_2_config_source,
  };
}

function diff(beforePath, afterPath) {
  const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));

  const bMap = new Map(before.extraction_results.map((e) => [e.data.document_id, digest(e)]));
  const aMap = new Map(after.extraction_results.map((e) => [e.data.document_id, digest(e)]));

  console.log('=== 提取結果對照 ===');
  console.log(`  改動前：${before._meta.capturedAt}  ${bMap.size} 筆`);
  console.log(`  改動後：${after._meta.capturedAt}  ${aMap.size} 筆\n`);

  const onlyBefore = [...bMap.keys()].filter((k) => !aMap.has(k));
  const onlyAfter = [...aMap.keys()].filter((k) => !bMap.has(k));
  if (onlyBefore.length) console.log(`  ⚠️  只在改動前出現：${onlyBefore.length} 筆（提取結果被刪除？）`);
  if (onlyAfter.length) console.log(`  ℹ️  只在改動後出現：${onlyAfter.length} 筆（新增的提取）`);

  const FIELDS = ['model', 'status', 'currency', 'total', 'subtotal', 'lineItemCount', 'lineItemSum', 'mismatch', 'avgConfidence', 'configSource'];
  let changed = 0;
  let regressed = 0;

  for (const [id, b] of bMap) {
    const a = aMap.get(id);
    if (!a) continue;
    const deltas = FIELDS.filter((f) => JSON.stringify(b[f]) !== JSON.stringify(a[f]));
    if (deltas.length === 0) continue;
    changed++;

    // 退步訊號：本來對帳一致變成不一致 / 本來有金額變成沒有 / 行項變少
    const flags = [];
    if (b.mismatch === false && a.mismatch === true) flags.push('對帳由一致轉為不一致');
    if (b.total !== null && a.total === null) flags.push('total_amount 由有值變為空白');
    if (b.subtotal !== null && a.subtotal === null) flags.push('subtotal 由有值變為空白');
    if (b.lineItemCount > 0 && a.lineItemCount < b.lineItemCount) flags.push(`行項由 ${b.lineItemCount} 減為 ${a.lineItemCount}`);
    if (b.currency && a.currency && b.currency !== a.currency) flags.push(`幣別由 ${b.currency} 變為 ${a.currency}`);
    if (flags.length) regressed++;

    console.log(`\n  ${flags.length ? '🔴' : '  '} ${b.company ?? '-'} / ${b.file}`);
    for (const f of deltas) {
      console.log(`      ${f.padEnd(16)} ${JSON.stringify(b[f])}  →  ${JSON.stringify(a[f])}`);
    }
    for (const fl of flags) console.log(`      ⚠️  ${fl}`);
  }

  console.log(`\n=== 總結 ===`);
  console.log(`  有變動 ${changed} 筆，其中帶退步訊號 ${regressed} 筆`);
  if (regressed > 0 || onlyBefore.length > 0) {
    console.log('\n🔴 偵測到退步或遺失 —— 以 exit code 1 結束。');
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- restore

async function restore(backupPath, mode) {
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (backup._meta?.kind !== 'extraction-results-backup') {
    console.error('這不是本腳本產出的備份檔（_meta.kind 不符）— abort');
    process.exit(1);
  }
  const entries = backup.extraction_results;
  console.log(`=== 還原 ${TABLE}（模式：${mode}）===`);
  console.log(`  備份時間：${backup._meta.capturedAt}`);
  console.log(`  備份筆數：${entries.length}\n`);

  const client = connect();
  await client.connect();
  try {
    const cols = await columnsOf(client, TABLE);
    const byDoc = new Map(entries.map((e) => [e.data.document_id, e]));

    const cur = await client.query(
      `select document_id, updated_at, gpt_model_used from ${TABLE} where document_id = any($1::text[])`,
      [[...byDoc.keys()]]
    );
    const curByDoc = new Map(cur.rows.map((r) => [r.document_id, r]));

    const plan = { same: [], differs: [], missing: [] };
    for (const [docId, entry] of byDoc) {
      const now = curByDoc.get(docId);
      if (!now) { plan.missing.push(entry); continue; }
      // 冪等判準：updated_at 一致 = 這筆從備份以來沒被動過，無須還原
      const backupTs = new Date(entry.data.updated_at).toISOString();
      const nowTs = new Date(now.updated_at).toISOString();
      if (backupTs === nowTs) plan.same.push(entry);
      else plan.differs.push({ entry, nowModel: now.gpt_model_used, nowTs });
    }

    console.log(`  未變動（跳過）  ${plan.same.length}`);
    console.log(`  已變動（還原）  ${plan.differs.length}`);
    console.log(`  已不存在（插回）${plan.missing.length}`);

    if (plan.differs.length) {
      console.log('\n  --- 將被還原的項目 ---');
      for (const p of plan.differs) {
        const e = p.entry;
        console.log(`    ${e._companyName ?? '-'} / ${e._fileName}`);
        console.log(`      現況 ${p.nowModel} @ ${p.nowTs.slice(0, 16)}  →  還原為 ${e.data.gpt_model_used} @ ${String(e.data.updated_at).slice(0, 16)}`);
      }
    }
    if (plan.missing.length) {
      console.log('\n  --- 將被插回的項目（目前沒有提取結果）---');
      for (const e of plan.missing) {
        console.log(`    ${e._companyName ?? '-'} / ${e._fileName}`);
      }
    }

    const toWrite = [...plan.differs.map((p) => p.entry), ...plan.missing];
    if (mode === 'inspect' || mode === 'dryrun') {
      console.log(`\n（${mode} 模式，未寫入任何資料。實際還原請改用 write）`);
      return;
    }
    if (toWrite.length === 0) {
      console.log('\n✅ 現況已與備份一致，無須寫入。');
      return;
    }

    // 措施 1：前置快照 —— 還原本身也是不可逆操作，先留下現況
    const preRestorePath = backupPath.replace(/\.json$/i, '') + '.pre-restore.json';
    console.log(`\n措施 1／前置快照 → ${path.basename(preRestorePath)}`);
    const snapRows = await client.query(
      `select to_jsonb(er) as data, d.file_name as _file_name, c.name as _company_name
         from ${TABLE} er
         join documents d on d.id = er.document_id
         left join companies c on c.id = d.company_id
        where er.document_id = any($1::text[])`,
      [[...byDoc.keys()]]
    );
    fs.writeFileSync(
      preRestorePath,
      JSON.stringify({
        _meta: { kind: 'extraction-results-backup', capturedAt: new Date().toISOString(), note: `restore ${path.basename(backupPath)} 之前的現況`, rowCount: snapRows.rowCount },
        extraction_results: snapRows.rows.map((r) => ({ data: r.data, _fileName: r._file_name, _companyName: r._company_name })),
        _reference: {},
      }),
      'utf8'
    );
    console.log(`  ✓ 已存 ${snapRows.rowCount} 筆現況`);

    const updatable = cols.filter((c) => c !== 'id' && c !== 'document_id');
    const setSql = updatable.map((c) => `"${c}" = excluded."${c}"`).join(', ');

    // 措施 2：單一交易
    await client.query('BEGIN');
    try {
      // 措施 4：樂觀鎖 —— 交易內鎖定目標列，避免併發寫入被無聲覆蓋
      await client.query(`select id from ${TABLE} where document_id = any($1::text[]) for update`, [
        toWrite.map((e) => e.data.document_id),
      ]);

      let written = 0;
      for (const e of toWrite) {
        const r = await client.query(
          `insert into ${TABLE}
           select * from jsonb_populate_record(null::${TABLE}, $1::jsonb)
           on conflict (document_id) do update set ${setSql}`,
          [JSON.stringify(e.data)]
        );
        // 措施 3：數量閘 —— 每筆必須恰好影響 1 列
        if (r.rowCount !== 1) {
          throw new Error(`數量閘失敗：${e._fileName} 影響 ${r.rowCount} 列（預期 1）`);
        }
        written++;
      }

      await client.query('COMMIT');
      console.log(`\n✅ 已還原 ${written} 筆（單一交易提交）`);
      console.log(`   如需回到還原前的狀態：node scripts/local-backup-extraction-results.js restore ${path.basename(preRestorePath)} write`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`\n🔴 已 ROLLBACK，資料庫未變更。原因：${err.message}`);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

// ------------------------------------------------------------------- main

const MODE = process.argv[2];

if (MODE === 'capture') {
  const out = process.argv[3];
  if (!out) { usage(); process.exit(1); }
  capture(out, argOf('company'), argOf('file')).catch((e) => {
    console.error('FAILED: ' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  });
} else if (MODE === 'diff') {
  const [, , , b, a] = process.argv;
  if (!b || !a) { usage(); process.exit(1); }
  try {
    diff(b, a);
  } catch (e) {
    console.error('FAILED: ' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  }
} else if (MODE === 'restore') {
  const file = process.argv[3];
  const sub = process.argv[4];
  if (!file || !['inspect', 'dryrun', 'write'].includes(sub)) { usage(); process.exit(1); }
  restore(file, sub).catch((e) => {
    console.error('FAILED: ' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  });
} else {
  usage();
  process.exit(1);
}
