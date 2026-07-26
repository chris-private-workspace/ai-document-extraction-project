/**
 * Azure 文件記錄 → 本地：異常文件處理鏈匯入（CHANGE-108 Phase 3）
 *
 * 🔴 只寫本地。安全閘強制 DATABASE_URL 指向 localhost，並明確拒絕 Azure 主機。
 * 🔴 預設 DRY-RUN（交易 ROLLBACK）。加 --apply 才 COMMIT。
 *
 * 語意：純新增 —— 不刪除本地任何既有文件，只把 Azure 的異常文件補進來。
 * id 若已存在則跳過（ON CONFLICT DO NOTHING）並報告。
 * 因為不刪任何資料，本階段不需備份。
 *
 * 前置條件：Phase 2 已完成（company_id / template_instance_id 指向的記錄必須已存在）。
 *
 * FK 處理：
 *   - uploaded_by → users（RESTRICT）  → 改指本地 admin
 *   - forwarder_id → forwarders（未同步）→ 設 null
 *   - workflow_execution_id → workflow_executions（未同步）→ 設 null
 *   - city_code → cities（NOT NULL + RESTRICT）→ 不可設 null，缺城市即中止並列出
 *   - company_id / template_instance_id / document_id → Phase 2 已同步，原樣保留
 *
 * ⚠️ Blob 原始檔不在本次範圍：documents.blob_name 指向 Azure Storage 的私有容器，
 *    本地 Azurite 沒有這些檔案，故文件詳情頁的原始檔預覽/下載會失效。
 *    提取結果與處理鏈資料完整，診斷不受影響。
 *
 * 用法：
 *   $env:DATABASE_URL='postgresql://postgres:postgres@localhost:5433/ai_document_extraction'
 *   node scripts/local-import-azure-documents.js <azure-documents.json> [--apply]
 */
'use strict';
const fs = require('fs');
const { Client } = require('pg');

/** 匯入順序：documents 先，子表後（皆以 document_id 關聯） */
const PLAN = [
  {
    table: 'documents',
    setAdmin: ['uploaded_by'],
    setNull: ['forwarder_id', 'workflow_execution_id'],
  },
  { table: 'ocr_results', setAdmin: [], setNull: [] },
  { table: 'extraction_results', setAdmin: [], setNull: ['forwarder_id'] },
  { table: 'processing_queues', setAdmin: [], setNull: [] },
  { table: 'document_processing_stages', setAdmin: [], setNull: [] },
];

const APPLY = process.argv.includes('--apply');
const snapshotPath = process.argv[2];

function bar(ch) {
  return new Array(96).join(ch || '=');
}

async function getColumnTypes(client, table) {
  const { rows } = await client.query(
    `select column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table]
  );
  const map = {};
  for (const r of rows) map[r.column_name] = r.data_type;
  return map;
}

async function resolveOwnerId(client) {
  const r = await client.query(
    'select id, email from users where is_global_admin = true order by created_at asc limit 1'
  );
  if (r.rows[0]) return r.rows[0];
  const r2 = await client.query('select id, email from users order by created_at asc limit 1');
  if (r2.rows[0]) return r2.rows[0];
  throw new Error('本地 DB 找不到任何 user 可作為 uploaded_by（請先跑 seed）');
}

async function main() {
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    console.error('用法：node scripts/local-import-azure-documents.js <azure-documents.json> [--apply]');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL || '';
  if (!url) {
    console.error('DATABASE_URL 未設 — abort');
    process.exit(1);
  }
  if (/postgres\.database\.azure\.com/i.test(url)) {
    console.error('🔴 安全閘：DATABASE_URL 指向 Azure —— 本腳本只允許寫入本地，中止。');
    process.exit(1);
  }
  if (!/@(localhost|127\.0\.0\.1)[:/]/i.test(url)) {
    console.error('🔴 安全閘：DATABASE_URL 不是 localhost / 127.0.0.1 —— 中止。');
    process.exit(1);
  }

  const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    console.log(bar());
    console.log('=== CHANGE-108 Phase 3：Azure 異常文件記錄匯入 ===');
    console.log('=== 模式：' + (APPLY ? '🔴 實際寫入（--apply）' : '🟢 DRY-RUN（結束時 ROLLBACK）') + ' ===');
    console.log(bar());
    console.log('');
    console.log('  來源狀態  : ' + snap._meta.statuses.join(', '));
    console.log('  文件數    : ' + snap.documents.length);

    const owner = await resolveOwnerId(client);
    console.log('  uploaded_by → ' + owner.email);

    // ---------- 前置檢查 1：city_code（NOT NULL + RESTRICT，無法設 null）----------
    const localCities = new Set(
      (await client.query('select code from cities')).rows.map((r) => r.code)
    );
    const needCities = [...new Set(snap.documents.map((d) => d.city_code).filter(Boolean))];
    const missingCities = needCities.filter((c) => !localCities.has(c));
    console.log('');
    console.log('  【前置檢查】');
    console.log('  city_code 需要：' + needCities.join(', '));
    if (missingCities.length > 0) {
      console.log('  🔴 本地 cities 缺少：' + missingCities.join(', '));
      console.log('     documents.city_code 是 NOT NULL + RESTRICT，無法設 null。');
      console.log('     請先在本地補建這些城市（Azure cities 共 ' + (snap._refs.cities || []).length + ' 個可參考），中止。');
      process.exit(1);
    }
    console.log('  ✓ city_code 全部存在於本地');

    // ---------- 前置檢查 2：Phase 2 是否已完成 ----------
    const needCompanies = [...new Set(snap.documents.map((d) => d.company_id).filter(Boolean))];
    const localCompanies = new Set(
      (await client.query('select id from companies')).rows.map((r) => r.id)
    );
    const missingCompanies = needCompanies.filter((c) => !localCompanies.has(c));
    if (missingCompanies.length > 0) {
      console.log('  🔴 本地缺少 ' + missingCompanies.length + ' 家公司（Phase 2 未完成？）');
      for (const c of missingCompanies.slice(0, 5)) console.log('      ' + c);
      console.log('     請先執行 Phase 2（local-import-azure-snapshot.js --apply），中止。');
      process.exit(1);
    }
    console.log('  ✓ company_id 全部存在（' + needCompanies.length + ' 家，Phase 2 已生效）');

    const needInstances = [...new Set(snap.documents.map((d) => d.template_instance_id).filter(Boolean))];
    if (needInstances.length > 0) {
      const localInstances = new Set(
        (await client.query('select id from template_instances')).rows.map((r) => r.id)
      );
      const missingInstances = needInstances.filter((c) => !localInstances.has(c));
      if (missingInstances.length > 0) {
        console.log('  ⚠️  ' + missingInstances.length + ' 個 template_instance_id 本地不存在 → 將設 null');
        PLAN[0].setNull.push('template_instance_id');
      } else {
        console.log('  ✓ template_instance_id 全部存在（' + needInstances.length + ' 個）');
      }
    }

    // ---------- 交易 ----------
    await client.query('BEGIN');

    const beforeDocs = (await client.query('select count(*)::int as n from documents')).rows[0].n;

    console.log('');
    console.log(bar());
    console.log('=== 插入（純新增，id 衝突則跳過）===');
    console.log(bar());
    console.log('');

    const skippedByConflict = [];
    for (const spec of PLAN) {
      const rows = snap[spec.table] || [];
      if (rows.length === 0) {
        console.log('  − ' + spec.table.padEnd(30) + '快照無資料，略過');
        continue;
      }
      const colTypes = await getColumnTypes(client, spec.table);
      let inserted = 0;

      for (const src of rows) {
        const row = Object.assign({}, src);
        for (const c of spec.setAdmin) if (c in row) row[c] = owner.id;
        for (const c of spec.setNull) if (c in row) row[c] = null;

        const cols = Object.keys(row).filter((k) => k in colTypes);
        const values = cols.map((c) => {
          const v = row[c];
          if (v === null || v === undefined) return null;
          const t = colTypes[c];
          if (t === 'jsonb' || t === 'json') return JSON.stringify(v);
          return v;
        });
        const res = await client.query(
          `insert into "${spec.table}" (${cols.map((c) => `"${c}"`).join(', ')}) ` +
            `values (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) on conflict do nothing`,
          values
        );
        if (res.rowCount === 0) skippedByConflict.push({ table: spec.table, id: row.id });
        inserted += res.rowCount;
      }

      const mark = inserted === rows.length ? '✓' : '⚠️';
      console.log(
        '  ' + mark + ' ' + spec.table.padEnd(30) + String(inserted).padStart(5) + ' / ' +
        String(rows.length).padStart(5) + ' 筆新增'
      );
    }

    if (skippedByConflict.length > 0) {
      console.log('');
      console.log('  ⚠️  因 id/唯一鍵已存在而跳過 ' + skippedByConflict.length + ' 筆：');
      for (const s of skippedByConflict.slice(0, 8)) {
        console.log('      ' + s.table + '  ' + s.id);
      }
      if (skippedByConflict.length > 8) {
        console.log('      … 其餘 ' + (skippedByConflict.length - 8) + ' 筆略');
      }
    }

    // ---------- 驗證 ----------
    console.log('');
    console.log(bar());
    console.log('=== 驗證 ===');
    console.log(bar());
    console.log('');

    const afterDocs = (await client.query('select count(*)::int as n from documents')).rows[0].n;
    console.log('  documents 總數：' + beforeDocs + ' → ' + afterDocs + '（+' + (afterDocs - beforeDocs) + '）');

    // 匯入文件的狀態分布
    const ids = snap._meta.documentIds;
    const dist = await client.query(
      `select d.status::text as status, count(*)::int as n,
              count(er.id)::int as with_extraction
         from documents d
         left join extraction_results er on er.document_id = d.id
        where d.id = any($1)
        group by 1 order by 2 desc`,
      [ids]
    );
    console.log('');
    console.log('  匯入文件的狀態分布：');
    for (const r of dist.rows) {
      console.log(
        '  ' + String(r.n).padStart(5) + '  ' + r.status.padEnd(20) +
        ' 有提取結果：' + r.with_extraction
      );
    }

    // FK 完整性：匯入文件的 company 應可解析
    const fk = await client.query(
      `select count(*)::int as total,
              count(c.id)::int as company_ok,
              count(*) filter (where d.company_id is null)::int as company_null
         from documents d left join companies c on c.id = d.company_id
        where d.id = any($1)`,
      [ids]
    );
    const f = fk.rows[0];
    console.log('');
    console.log(
      '  ✓ 公司關聯：' + f.company_ok + ' 筆可解析 / ' + f.company_null + ' 筆為 null / 共 ' + f.total + ' 筆'
    );

    // 抽樣：REF_MATCH_FAILED 文件的錯誤訊息（診斷起點）
    const sample = await client.query(
      `select d.id, d.file_name, d.status::text as status, d.error_message,
              c.name as company_name, er.average_confidence
         from documents d
         left join companies c on c.id = d.company_id
         left join extraction_results er on er.document_id = d.id
        where d.id = any($1) and d.status::text = 'REF_MATCH_FAILED'
        order by d.created_at desc limit 5`,
      [ids]
    );
    if (sample.rows.length > 0) {
      console.log('');
      console.log('  【REF_MATCH_FAILED 抽樣（診斷起點）】');
      for (const r of sample.rows) {
        console.log('  · ' + String(r.file_name).slice(0, 56));
        console.log(
          '      公司=' + String(r.company_name || '(無)').slice(0, 36) +
          '  信心度=' + (r.average_confidence != null ? r.average_confidence : '-')
        );
        if (r.error_message) console.log('      錯誤：' + String(r.error_message).slice(0, 70));
      }
    }

    console.log('');
    console.log(bar());
    if (!APPLY) {
      await client.query('ROLLBACK');
      console.log('=== 🟢 DRY-RUN 結束 —— 已 ROLLBACK，本地資料未改動 ===');
      console.log('=== 實際套用：加 --apply ===');
    } else {
      await client.query('COMMIT');
      console.log('=== ✅ COMMIT 完成 —— Azure 異常文件已匯入本地 ===');
      console.log('=== ⚠️ Blob 原始檔不在本地 Azurite，文件預覽/下載會失效（提取資料完整）===');
    }
    console.log(bar());
  } catch (e) {
    try {
      await client.query('ROLLBACK');
      console.error('\n🔴 已 ROLLBACK（本地資料未改動）');
    } catch (_) {
      /* 交易可能已結束 */
    }
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('FAILED: ' + (e && e.message ? e.message : String(e)));
  process.exitCode = 1;
});
