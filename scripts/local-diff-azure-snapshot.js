/**
 * Azure 快照 vs 本地 DB 差異報告（CHANGE-108 Phase 1）
 *
 * 🔴 唯讀 —— 只有 SELECT，不寫入本地任何資料。
 *
 * 讀 export-azure-config-snapshot.js 產出的快照 JSON，與本地 DB 逐表比對：
 *   僅 Azure 有 / 僅本地有 / 同 id 但內容不同
 *
 * 2026-06-15 的本地→Azure 匯入保留了 id，故兩邊共有記錄的 id 相同，逐筆 id 比對有意義。
 *
 * 「內容不同」比對時排除跨環境必然不同的欄位（owner / 時間戳），否則全部記錄都會被判為不同。
 *
 * 用法：
 *   $env:DATABASE_URL='postgresql://postgres:postgres@localhost:5433/ai_document_extraction'
 *   node scripts/local-diff-azure-snapshot.js <snapshot.json> [--detail=table1,table2]
 */
'use strict';
const fs = require('fs');
const { Client } = require('pg');

// 跨環境必然不同、不構成實質差異的欄位
const IGNORE_COLS = new Set([
  'created_at',
  'updated_at',
  'created_by',
  'created_by_id',
  'updated_by',
  'exported_by',
  'exported_at',
]);

const snapshotPath = process.argv[2];
const detailArg = (process.argv.find((a) => a.startsWith('--detail=')) || '').split('=')[1] || '';
const DETAIL_TABLES = detailArg.split(',').map((s) => s.trim()).filter(Boolean);

function bar(ch) {
  return new Array(96).join(ch || '=');
}

/** 穩定序列化：排序 key、排除忽略欄位，用於同 id 的內容比對 */
function stableKey(row) {
  const keys = Object.keys(row).filter((k) => !IGNORE_COLS.has(k)).sort();
  const o = {};
  for (const k of keys) {
    const v = row[k];
    // Date（本地 pg 回傳）與 ISO 字串（快照經 JSON 往返）需正規化到同一形式
    o[k] = v instanceof Date ? v.toISOString() : v;
  }
  return JSON.stringify(o);
}

/** 找出同 id 記錄的差異欄位清單 */
function diffFields(azureRow, localRow) {
  const cols = new Set(
    [...Object.keys(azureRow), ...Object.keys(localRow)].filter((k) => !IGNORE_COLS.has(k))
  );
  const diffs = [];
  for (const c of cols) {
    const a = azureRow[c] instanceof Date ? azureRow[c].toISOString() : azureRow[c];
    const l = localRow[c] instanceof Date ? localRow[c].toISOString() : localRow[c];
    if (JSON.stringify(a) !== JSON.stringify(l)) diffs.push(c);
  }
  return diffs;
}

/** 取記錄的可讀標籤（報告用） */
function label(row) {
  return row.name || row.code || row.company_name || row.format_name || row.ref_number || row.id;
}

async function main() {
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    console.error('用法：node scripts/local-diff-azure-snapshot.js <snapshot.json> [--detail=t1,t2]');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL 未設 — abort');
    process.exit(1);
  }

  const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const tables = snap._meta.exportedTables;

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    console.log(bar());
    console.log('=== CHANGE-108 Phase 1：Azure DEV vs 本地 差異報告（唯讀）===');
    console.log(bar());
    console.log('');
    console.log('  快照來源      : ' + snap._meta.source);
    console.log('  Azure 文件數  : ' + snap._meta.documentCount);
    console.log('  排除的表      : ' + snap._meta.excludedTables.join(', '));
    const lv = await client.query('select version()');
    console.log('  本地 DB       : ' + lv.rows[0].version.split(',')[0]);
    console.log('');

    console.log(bar());
    console.log('=== 逐表差異總覽 ===');
    console.log(bar());
    console.log('');
    console.log(
      '  ' +
        '表'.padEnd(26) +
        'Azure'.padStart(7) +
        '本地'.padStart(7) +
        '僅Azure'.padStart(9) +
        '僅本地'.padStart(8) +
        '同id異內容'.padStart(12)
    );
    console.log('  ' + bar('-').slice(0, 70));

    const results = [];
    for (const t of tables) {
      const azureRows = snap[t] || [];
      const localRes = await client.query(`select * from "${t}"`);
      const localRows = localRes.rows;

      const aById = new Map(azureRows.map((r) => [r.id, r]));
      const lById = new Map(localRows.map((r) => [r.id, r]));

      const onlyAzure = azureRows.filter((r) => !lById.has(r.id));
      const onlyLocal = localRows.filter((r) => !aById.has(r.id));
      const changed = [];
      for (const [id, aRow] of aById) {
        const lRow = lById.get(id);
        if (lRow && stableKey(aRow) !== stableKey(lRow)) {
          changed.push({ id, azure: aRow, local: lRow, fields: diffFields(aRow, lRow) });
        }
      }

      results.push({ table: t, azureRows, localRows, onlyAzure, onlyLocal, changed });
      console.log(
        '  ' +
          t.padEnd(26) +
          String(azureRows.length).padStart(7) +
          String(localRows.length).padStart(7) +
          String(onlyAzure.length).padStart(9) +
          String(onlyLocal.length).padStart(8) +
          String(changed.length).padStart(12)
      );
    }

    // ---- 僅本地有的記錄：整表取代會失去這些（備份可還原）----
    console.log('');
    console.log(bar());
    console.log('=== ⚠️ 僅本地有的記錄（整表取代後會消失，備份可還原）===');
    console.log(bar());
    for (const r of results) {
      if (r.onlyLocal.length === 0) continue;
      console.log('');
      console.log('  ' + r.table + '（' + r.onlyLocal.length + ' 筆）');
      const show = r.onlyLocal.slice(0, 12);
      for (const row of show) {
        console.log('      ' + String(row.id).padEnd(28) + String(label(row)).slice(0, 58));
      }
      if (r.onlyLocal.length > show.length) {
        console.log('      … 其餘 ' + (r.onlyLocal.length - show.length) + ' 筆略');
      }
    }

    // ---- 同 id 但內容不同：Azure 端的就地修補都落在這裡 ----
    console.log('');
    console.log(bar());
    console.log('=== 🔴 同 id 但內容不同（Azure 就地修補的痕跡）===');
    console.log(bar());
    for (const r of results) {
      if (r.changed.length === 0) continue;
      console.log('');
      console.log('  ' + r.table + '（' + r.changed.length + ' 筆）');
      const show = r.changed.slice(0, 10);
      for (const c of show) {
        console.log(
          '      ' + String(c.id).padEnd(28) + String(label(c.azure)).slice(0, 40)
        );
        console.log('          差異欄位：' + c.fields.join(', '));
      }
      if (r.changed.length > show.length) {
        console.log('      … 其餘 ' + (r.changed.length - show.length) + ' 筆略');
      }
    }

    // ---- 指定表的逐筆細節 ----
    for (const t of DETAIL_TABLES) {
      const r = results.find((x) => x.table === t);
      if (!r) {
        console.log('\n  ⚠️ --detail 指定的表不在快照內：' + t);
        continue;
      }
      console.log('');
      console.log(bar());
      console.log('=== 細節：' + t + ' ===');
      console.log(bar());
      console.log('');
      console.log('  【僅 Azure 有】' + r.onlyAzure.length + ' 筆');
      for (const row of r.onlyAzure) {
        console.log('      ' + String(row.id).padEnd(28) + String(label(row)).slice(0, 56));
      }
      console.log('');
      console.log('  【同 id 異內容】' + r.changed.length + ' 筆');
      for (const c of r.changed) {
        console.log('      ' + String(c.id).padEnd(28) + String(label(c.azure)).slice(0, 40));
        console.log('          ' + c.fields.join(', '));
      }
    }

    // ---- Azure 文件清單摘要（Phase 3 挑選用）----
    console.log('');
    console.log(bar());
    console.log('=== Azure 文件狀態分布（Phase 3 挑選參考）===');
    console.log(bar());
    console.log('');
    const byStatus = new Map();
    for (const d of snap._refs.documents) {
      const k = d.status + ' / ' + (d.extraction_status || 'no-extraction');
      byStatus.set(k, (byStatus.get(k) || 0) + 1);
    }
    for (const [k, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
      console.log('  ' + String(n).padStart(5) + '  ' + k);
    }

    console.log('');
    console.log(bar());
    console.log('=== 報告結束（未寫入本地任何資料）===');
    console.log(bar());
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('FAILED: ' + (e && e.message ? e.message : String(e)));
  process.exitCode = 1;
});
