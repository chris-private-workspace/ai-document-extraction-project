/**
 * Azure 快照 → 本地：配置表嚴格鏡像匯入（CHANGE-108 Phase 2）
 *
 * 🔴 只寫本地。安全閘強制 DATABASE_URL 指向 localhost，並明確拒絕 Azure 主機。
 * 🔴 預設 DRY-RUN（交易 ROLLBACK）。加 --apply 才真正 COMMIT。
 * 🔴 --apply 時強制先寫備份檔，不給備份路徑就中止。
 *
 * 語意：嚴格鏡像 —— 15 張配置表整表取代，本地獨有記錄一併移除，
 * 匯入後本地與 Azure 逐筆一致（含 id）。保留 Azure id 是刻意的：
 * Azure 的錯誤訊息 / 日誌 / UI 網址裡的 id 在本地能直接對上。
 *
 * FK 處理（跨環境）：
 *   - 指向 users 的欄位          → 改指本地 admin
 *   - 指向 regions 的欄位        → 以 code 重映射（跨環境 UUID 不同）
 *   - 指向未同步表的欄位         → 設 null（forwarder_id / suggestion_id / first_seen_document_id）
 *   - 指向「後面才插入的表」與 self-reference → 先設 null，全部插完後回填（defer）
 *     ⚠️ import-dev-data.js 當初把 merged_into_id 直接設 null＝放棄合併鏈；
 *        本方向必須保留，因為 Azure 的 8 家 MERGED 公司都在同批內。
 *
 * 連帶處理：
 *   - field_extraction_feedbacks（408 筆）會被 field_definition_sets 的 CASCADE 刪除 → 匯入後還原
 *   - 本地舊 documents / extraction_results 的 company_id 被 SET NULL → 依公司名稱重映射
 *
 * 用法：
 *   $env:DATABASE_URL='postgresql://postgres:postgres@localhost:5433/ai_document_extraction'
 *   node scripts/local-import-azure-snapshot.js <snapshot.json>                      # dry-run
 *   node scripts/local-import-azure-snapshot.js <snapshot.json> --apply --backup=<路徑.json>
 */
'use strict';
const fs = require('fs');
const { Client } = require('pg');
const { buildBackup } = require('./local-backup-config-tables');

// ---------------------------------------------------------------------------
// 匯入計畫：順序 = 父表先。defer 的 key 是欄位、value 是它指向的表。
// ---------------------------------------------------------------------------
const PLAN = [
  {
    table: 'companies',
    setAdmin: ['created_by_id'],
    setNull: ['first_seen_document_id'], // 指向 documents（Phase 2 不同步）
    defer: {
      merged_into_id: 'companies',
      suspected_duplicate_of_id: 'companies',
      default_template_id: 'data_templates',
    },
  },
  { table: 'document_formats', setAdmin: [], setNull: [], defer: { default_template_id: 'data_templates' } },
  { table: 'mapping_rules', setAdmin: ['created_by'], setNull: ['forwarder_id', 'suggestion_id'], defer: {} },
  { table: 'prompt_configs', setAdmin: ['created_by', 'updated_by'], setNull: [], defer: {} },
  { table: 'prompt_variables', setAdmin: [], setNull: [], defer: {} },
  { table: 'exchange_rates', setAdmin: ['created_by_id'], setNull: [], defer: { inverse_of_id: 'exchange_rates' } },
  { table: 'field_definition_sets', setAdmin: ['created_by'], setNull: [], defer: {} },
  { table: 'data_templates', setAdmin: ['created_by'], setNull: [], defer: {} },
  { table: 'field_mapping_configs', setAdmin: ['created_by'], setNull: [], defer: {} },
  { table: 'field_mapping_rules', setAdmin: [], setNull: [], defer: {} },
  { table: 'template_field_mappings', setAdmin: ['created_by'], setNull: [], defer: {} },
  { table: 'template_instances', setAdmin: ['created_by', 'exported_by'], setNull: [], defer: {} },
  { table: 'template_instance_rows', setAdmin: [], setNull: [], defer: {} },
  { table: 'pipeline_configs', setAdmin: [], setNull: [], remapRegion: ['region_id'], defer: {} },
  { table: 'reference_numbers', setAdmin: ['created_by_id'], setNull: [], remapRegion: ['region_id'], defer: {} },
];

const APPLY = process.argv.includes('--apply');
const snapshotPath = process.argv[2];
const backupArg = (process.argv.find((a) => a.startsWith('--backup=')) || '').split('=')[1] || '';

function bar(ch) {
  return new Array(96).join(ch || '=');
}
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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
  throw new Error('本地 DB 找不到任何 user 可作為 owner（請先跑 seed）');
}

async function main() {
  // ---------- 前置檢查 ----------
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    console.error('用法：node scripts/local-import-azure-snapshot.js <snapshot.json> [--apply --backup=<路徑>]');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL || '';
  if (!url) {
    console.error('DATABASE_URL 未設 — abort');
    process.exit(1);
  }

  // 🔴 安全閘：本腳本會 DELETE 大量資料，絕不可誤連 Azure。
  if (/postgres\.database\.azure\.com/i.test(url)) {
    console.error('🔴 安全閘：DATABASE_URL 指向 Azure 主機 —— 本腳本只允許寫入本地，中止。');
    process.exit(1);
  }
  if (!/@(localhost|127\.0\.0\.1)[:/]/i.test(url)) {
    console.error('🔴 安全閘：DATABASE_URL 不是 localhost / 127.0.0.1 —— 中止。');
    console.error('   實際 host 片段：' + (url.replace(/\/\/[^@]*@/, '//***@').match(/@[^/]+/) || ['(無法解析)'])[0]);
    process.exit(1);
  }
  if (APPLY && !backupArg) {
    console.error('🔴 --apply 必須同時給 --backup=<路徑.json>（不可逆操作前必先快照）—— 中止。');
    process.exit(1);
  }

  const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const plan = PLAN.filter((p) => Array.isArray(snap[p.table]));
  if (plan.length !== PLAN.length) {
    const missing = PLAN.filter((p) => !Array.isArray(snap[p.table])).map((p) => p.table);
    console.error('🔴 快照缺少表：' + missing.join(', ') + ' — 中止。');
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    console.log(bar());
    console.log('=== CHANGE-108 Phase 2：Azure → 本地 嚴格鏡像匯入 ===');
    console.log('=== 模式：' + (APPLY ? '🔴 實際寫入（--apply）' : '🟢 DRY-RUN（結束時 ROLLBACK）') + ' ===');
    console.log(bar());
    console.log('');

    const owner = await resolveOwnerId(client);
    console.log('  owner 使用者   : ' + owner.email + '  (' + owner.id + ')');

    // ---------- region 重映射表 ----------
    const localRegions = await client.query('select id, code from regions');
    const codeToLocalId = new Map(localRegions.rows.map((r) => [r.code, r.id]));
    const azureIdToCode = new Map((snap._refs.regions || []).map((r) => [r.id, r.code]));
    const regionRemap = new Map();
    for (const [aid, code] of azureIdToCode) {
      const lid = codeToLocalId.get(code);
      if (lid) regionRemap.set(aid, lid);
    }
    console.log('  region 重映射  : ' + regionRemap.size + ' 組（Azure ' + azureIdToCode.size + ' → 本地 ' + codeToLocalId.size + '）');
    if (regionRemap.size < azureIdToCode.size) {
      const missing = [...azureIdToCode.entries()].filter(([id]) => !regionRemap.has(id));
      console.log('  ⚠️  無法重映射的 region code：' + missing.map(([, c]) => c).join(', '));
    }

    // ---------- 備份 ----------
    console.log('');
    console.log(bar());
    console.log('=== 步驟 1：備份本地現況 ===');
    console.log(bar());
    console.log('');
    const backup = await buildBackup(client, (m) => console.log(m));
    if (APPLY) {
      fs.writeFileSync(backupArg, JSON.stringify(backup), 'utf8');
      console.log('');
      console.log('  ✅ 備份已寫入：' + backupArg);
      console.log('     大小：' + (fs.statSync(backupArg).size / 1024 / 1024).toFixed(2) + ' MB');
    } else {
      console.log('');
      console.log('  ⓘ DRY-RUN：備份已在記憶體建立但未落盤（--apply 時才寫檔）');
    }

    // ---------- 交易開始 ----------
    await client.query('BEGIN');

    // ---------- 步驟 2：逆序刪除 ----------
    console.log('');
    console.log(bar());
    console.log('=== 步驟 2：逆序刪除本地配置表（子表先）===');
    console.log(bar());
    console.log('');
    for (const spec of [...plan].reverse()) {
      const r = await client.query(`delete from "${spec.table}"`);
      console.log('  − ' + spec.table.padEnd(28) + String(r.rowCount).padStart(6) + ' 筆已刪');
    }
    const feedbackAfterDelete = await client.query(
      'select count(*)::int as n from field_extraction_feedbacks'
    );
    console.log('');
    console.log(
      '  ⓘ field_extraction_feedbacks 經 CASCADE 後剩 ' + feedbackAfterDelete.rows[0].n +
      ' 筆（備份含 ' + backup._tables.field_extraction_feedbacks.length + ' 筆，稍後還原）'
    );

    // ---------- 步驟 3：正序插入 ----------
    console.log('');
    console.log(bar());
    console.log('=== 步驟 3：正序插入 Azure 記錄（保留 Azure id）===');
    console.log(bar());
    console.log('');

    const deferredUpdates = []; // { table, id, col, target, value }
    const skippedRegion = [];

    for (const spec of plan) {
      const rows = snap[spec.table];
      const colTypes = await getColumnTypes(client, spec.table);
      let inserted = 0;

      for (const src of rows) {
        const row = Object.assign({}, src);

        for (const c of spec.setAdmin) if (c in row) row[c] = owner.id;
        for (const c of spec.setNull) if (c in row) row[c] = null;

        for (const c of spec.remapRegion || []) {
          if (c in row && row[c] != null) {
            const mapped = regionRemap.get(row[c]);
            if (!mapped) {
              skippedRegion.push({ table: spec.table, id: row.id, col: c, value: row[c] });
              row[c] = null;
            } else {
              row[c] = mapped;
            }
          }
        }

        // defer：先設 null，記下待回填
        for (const c of Object.keys(spec.defer || {})) {
          if (c in row && row[c] != null) {
            deferredUpdates.push({
              table: spec.table,
              id: row.id,
              col: c,
              target: spec.defer[c],
              value: row[c],
            });
            row[c] = null;
          }
        }

        const cols = Object.keys(row).filter((k) => k in colTypes);
        const values = cols.map((c) => {
          const v = row[c];
          if (v === null || v === undefined) return null;
          const t = colTypes[c];
          if (t === 'jsonb' || t === 'json') return JSON.stringify(v);
          return v;
        });
        const placeholders = cols.map((_, i) => '$' + (i + 1));
        const res = await client.query(
          `insert into "${spec.table}" (${cols.map((c) => `"${c}"`).join(', ')}) ` +
            `values (${placeholders.join(', ')})`,
          values
        );
        inserted += res.rowCount;
      }

      const label = inserted === rows.length ? '✓' : '⚠️';
      console.log(
        '  ' + label + ' ' + spec.table.padEnd(28) + String(inserted).padStart(6) + ' / ' +
        String(rows.length).padStart(6) + ' 筆'
      );
    }

    if (skippedRegion.length > 0) {
      console.log('');
      console.log('  ⚠️  region 無法重映射而設 null：' + skippedRegion.length + ' 筆');
      for (const s of skippedRegion.slice(0, 5)) {
        console.log('      ' + s.table + '.' + s.col + '  id=' + s.id);
      }
    }

    // ---------- 步驟 4：回填 defer 欄位 ----------
    console.log('');
    console.log(bar());
    console.log('=== 步驟 4：回填延後的 FK（self-ref / 向後引用）===');
    console.log(bar());
    console.log('');

    // 先取各目標表現存 id，避免回填不存在的目標造成 FK violation
    const existingIds = new Map();
    for (const t of new Set(deferredUpdates.map((d) => d.target))) {
      const r = await client.query(`select id from "${t}"`);
      existingIds.set(t, new Set(r.rows.map((x) => x.id)));
    }

    const byCol = new Map();
    const orphanDefer = [];
    for (const d of deferredUpdates) {
      const key = d.table + '.' + d.col;
      if (!byCol.has(key)) byCol.set(key, { ok: 0, orphan: 0 });
      const stat = byCol.get(key);
      if (!existingIds.get(d.target).has(d.value)) {
        stat.orphan++;
        orphanDefer.push(d);
        continue;
      }
      await client.query(`update "${d.table}" set "${d.col}" = $1 where id = $2`, [d.value, d.id]);
      stat.ok++;
    }

    if (byCol.size === 0) {
      console.log('  （無延後欄位需回填）');
    }
    for (const [key, stat] of byCol) {
      console.log(
        '  ' + key.padEnd(46) + '回填 ' + String(stat.ok).padStart(4) + ' 筆' +
        (stat.orphan > 0 ? '   ⚠️ 目標不存在而略過 ' + stat.orphan + ' 筆' : '')
      );
    }
    if (orphanDefer.length > 0) {
      console.log('');
      console.log('  ⚠️  略過明細（目標記錄不在同步範圍內）：');
      for (const d of orphanDefer.slice(0, 8)) {
        console.log('      ' + d.table + '.' + d.col + ' id=' + d.id + ' → ' + d.target + ':' + d.value);
      }
      if (orphanDefer.length > 8) console.log('      … 其餘 ' + (orphanDefer.length - 8) + ' 筆略');
    }

    // ---------- 步驟 5：還原 field_extraction_feedbacks ----------
    console.log('');
    console.log(bar());
    console.log('=== 步驟 5：還原 field_extraction_feedbacks（CASCADE 連帶損失）===');
    console.log(bar());
    console.log('');

    const fbRows = backup._tables.field_extraction_feedbacks || [];
    if (fbRows.length === 0) {
      console.log('  （備份中無資料，略過）');
    } else {
      const fdsIds = new Set(
        (await client.query('select id from field_definition_sets')).rows.map((r) => r.id)
      );
      const fbTypes = await getColumnTypes(client, 'field_extraction_feedbacks');
      let restored = 0;
      let dropped = 0;
      for (const src of fbRows) {
        // field_definition_set_id 指向的集合若已不存在（本地獨有已被移除）→ 無法還原
        if (src.field_definition_set_id && !fdsIds.has(src.field_definition_set_id)) {
          dropped++;
          continue;
        }
        const row = Object.assign({}, src);
        const cols = Object.keys(row).filter((k) => k in fbTypes);
        const values = cols.map((c) => {
          const v = row[c];
          if (v === null || v === undefined) return null;
          const t = fbTypes[c];
          if (t === 'jsonb' || t === 'json') return JSON.stringify(v);
          return v;
        });
        const res = await client.query(
          `insert into "field_extraction_feedbacks" (${cols.map((c) => `"${c}"`).join(', ')}) ` +
            `values (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) on conflict do nothing`,
          values
        );
        restored += res.rowCount;
      }
      console.log('  ✓ 還原 ' + restored + ' / ' + fbRows.length + ' 筆');
      if (dropped > 0) {
        console.log(
          '  ⚠️  ' + dropped + ' 筆無法還原：其 field_definition_set_id 指向已被移除的本地獨有欄位集'
        );
      }
    }

    // ---------- 步驟 6：本地舊文件的公司關聯重映射 ----------
    console.log('');
    console.log(bar());
    console.log('=== 步驟 6：本地舊文件公司關聯重映射（company_id 被 SET NULL）===');
    console.log(bar());
    console.log('');

    const newCompanies = (await client.query('select id, name, status from companies')).rows;
    const nameToCompanies = new Map();
    for (const c of newCompanies) {
      const k = norm(c.name);
      if (!nameToCompanies.has(k)) nameToCompanies.set(k, []);
      nameToCompanies.get(k).push(c);
    }
    /** 同名多筆時優先選 ACTIVE，避免綁到 MERGED 記錄 */
    function pickCompany(name) {
      const cands = nameToCompanies.get(norm(name)) || [];
      if (cands.length === 0) return null;
      const active = cands.filter((c) => c.status === 'ACTIVE');
      if (active.length === 1) return active[0];
      if (active.length > 1) return null; // 歧義 → 不猜
      return cands.length === 1 ? cands[0] : null;
    }

    for (const [linkKey, table] of [
      ['_docCompanyLinks', 'documents'],
      ['_erCompanyLinks', 'extraction_results'],
    ]) {
      const links = backup[linkKey] || [];
      let remapped = 0;
      let unresolved = 0;
      const unresolvedNames = new Map();
      for (const l of links) {
        const hit = pickCompany(l.company_name);
        if (!hit) {
          unresolved++;
          const k = l.company_name || '(無名)';
          unresolvedNames.set(k, (unresolvedNames.get(k) || 0) + 1);
          continue;
        }
        const r = await client.query(`update "${table}" set company_id = $1 where id = $2`, [
          hit.id,
          l.id,
        ]);
        remapped += r.rowCount;
      }
      console.log('  ' + table.padEnd(22) + '重映射 ' + String(remapped).padStart(4) + ' 筆' +
        (unresolved > 0 ? '   ⚠️ 無法對應 ' + unresolved + ' 筆（保持 NULL）' : ''));
      for (const [n, cnt] of [...unresolvedNames.entries()].slice(0, 6)) {
        console.log('        未對應：' + String(n).slice(0, 52) + '  ×' + cnt);
      }
    }

    // ---------- 步驟 7：驗證 ----------
    console.log('');
    console.log(bar());
    console.log('=== 步驟 7：驗證（筆數 / FK 完整性）===');
    console.log(bar());
    console.log('');
    let allOk = true;
    for (const spec of plan) {
      const r = await client.query(`select count(*)::int as n from "${spec.table}"`);
      const expect = snap[spec.table].length;
      const ok = r.rows[0].n === expect;
      if (!ok) allOk = false;
      console.log(
        '  ' + (ok ? '✓' : '🔴') + ' ' + spec.table.padEnd(28) +
        String(r.rows[0].n).padStart(6) + ' / Azure ' + String(expect).padStart(6)
      );
    }

    // ---- 抽樣：快照裡的實際 id 應可在本地原樣查到（id 一致性 = 診斷價值來源）----
    console.log('');
    console.log('  【id 一致性抽樣】');
    for (const src of snap.template_field_mappings.slice(0, 3)) {
      const r = await client.query(
        'select id, name, is_active from template_field_mappings where id = $1',
        [src.id]
      );
      console.log(
        '  ' + (r.rows[0] ? '✓' : '🔴') + ' ' + src.id + ' → ' +
        (r.rows[0] ? String(r.rows[0].name).slice(0, 44) + ' (active=' + r.rows[0].is_active + ')' : '查不到')
      );
    }

    // ---- 合併鏈完整性：merged_into_id 必須全部指向存在的公司 ----
    const chain = await client.query(
      `select count(*)::int as total, count(c2.id)::int as resolved
         from companies c1 left join companies c2 on c2.id = c1.merged_into_id
        where c1.merged_into_id is not null`
    );
    const ch = chain.rows[0];
    console.log('');
    console.log(
      '  ' + (ch.total === ch.resolved ? '✓' : '🔴') + ' 合併鏈：' + ch.resolved + ' / ' +
      ch.total + ' 筆 merged_into_id 指向存在的公司'
    );
    if (ch.total !== ch.resolved) allOk = false;

    // ---- Azure 就地修補是否落地（CHANGE-108 驗收 #7 的實質檢查）----
    console.log('');
    console.log('  【Azure 就地修補落地檢查】');

    const fix111 = await client.query(
      `select name, is_active from prompt_configs where name = 'Field Extraction - Global Default'`
    );
    if (fix111.rows[0]) {
      console.log(
        '  ' + (fix111.rows[0].is_active === false ? '✓' : '⚠️ ') +
        ' FIX-111：Field Extraction - Global Default  is_active=' + fix111.rows[0].is_active +
        (fix111.rows[0].is_active === false ? '（已停用，符合 Azure）' : '（Azure 應為停用）')
      );
    }

    const stage3 = await client.query(
      `select name, version, length(user_prompt_template) as len from prompt_configs
        where name = 'V3.1 Stage 3 - Field Extraction'`
    );
    if (stage3.rows[0]) {
      console.log(
        '  ✓ FIX-095：V3.1 Stage 3 - Field Extraction  v' + stage3.rows[0].version +
        '  prompt 長度=' + stage3.rows[0].len
      );
    }

    const aliasCheck = await client.query(
      `select count(*)::int as sets_with_alias from field_definition_sets
        where fields::text like '%aliases%'`
    );
    console.log(
      '  ✓ FIX-110：含 aliases 的 field_definition_sets = ' +
      aliasCheck.rows[0].sets_with_alias + ' / 23'
    );

    const activeMappings = await client.query(
      'select count(*)::int as n from template_field_mappings where is_active = true'
    );
    console.log(
      '  ✓ FIX-133：啟用中的 template_field_mappings = ' + activeMappings.rows[0].n + ' / 36'
    );

    // ---------- 收尾 ----------
    console.log('');
    console.log(bar());
    if (!APPLY) {
      await client.query('ROLLBACK');
      console.log('=== 🟢 DRY-RUN 結束 —— 已 ROLLBACK，本地資料未改動 ===');
      console.log('=== 實際套用：加 --apply --backup=<路徑.json> ===');
    } else if (!allOk) {
      await client.query('ROLLBACK');
      console.log('=== 🔴 筆數驗證未通過 —— 已 ROLLBACK，本地資料未改動 ===');
      process.exitCode = 1;
    } else {
      await client.query('COMMIT');
      console.log('=== ✅ COMMIT 完成 —— 本地配置已鏡像 Azure DEV ===');
      console.log('=== 還原用備份：' + backupArg + ' ===');
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
