/**
 * @fileoverview 將 Azure DEV 的模板欄位映射設定同步到本機（以 Azure 為準）
 * @description
 *   本專案的設定資料在兩個環境各自獨立：Azure DEV 是使用者實際維護的那一份，
 *   本機常年落後。要在本機重現使用者回報的問題，設定必須先對齊，否則測到的
 *   是另一組規則。
 *
 *   同步的是 `template_field_mappings` 全表，並連帶補齊它引用、但本機沒有的
 *   `companies`（外鍵前置依賴，不補則那幾筆映射建不起來）。
 *
 *   **只新增與更新，永不刪除**。本機獨有的映射一律保留並在報告中列出 ——
 *   「以 Azure 為準」指的是補齊與覆蓋，不是把本機清空重灌。
 *
 *   用法分兩段，因為本機連不到 Azure 的私有 PostgreSQL：
 *
 *     # 1. 在 Azure 容器內匯出（上傳本檔至 Kudu /home 後執行）
 *     node sync-template-mappings.js export /home/tfm-export.json
 *
 *     # 2. 下載該 JSON 後，在本機同步
 *     node scripts/sync-template-mappings.js inspect <匯出的.json>
 *     node scripts/sync-template-mappings.js dryrun  <匯出的.json>
 *     node scripts/sync-template-mappings.js write   <匯出的.json>
 *
 *   `write` 會先把本機全表存成 `<匯出的.json>.local-backup.json` 作為唯一還原
 *   依據，再於**單一交易**內寫入，任一筆的 rowCount 不符即整批 ROLLBACK。
 *
 *   ⚠️ `created_by` / `created_by_id` 屬環境專屬中繼資料，不跨環境搬運。Azure 用
 *      `system-user-prod`，該帳號本機不存在而欄位又是 NOT NULL，故一律改對映到
 *      本機既有公司最常用的建立者。
 *
 *   ⚠️ 新增公司會讓日後上傳的文件有機會被識別成這幾間 —— 這是與 Azure 對齊的
 *      必然結果，但屬行為改變，執行前請確認 dryrun 列出的公司清單。
 *
 *   本檔為 node 14 相容的 CommonJS（Azure Kudu 的 node 是 v14.19.2，且 runner
 *   映像不含 tsx，見 memory feedback_azure_runner_excludes_scripts_tsx）。
 *
 * @module scripts/sync-template-mappings
 * @since FIX-150
 * @lastModified 2026-07-31
 */
'use strict';

try {
  var path = require('path');
  var dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
  dotenv.config({ path: path.join(__dirname, '..', '.env.local'), override: true });
} catch (e) {
  /* Azure 容器內無 dotenv，環境變數已由平台提供 */
}

var fs = require('fs');
var Client = require(process.env.PG_MODULE_PATH || 'pg').Client;

var MODE = process.argv[2] || 'inspect';
var FILE = process.argv[3];

var CONN = process.env.DATABASE_URL || '';
var IS_LOCAL = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);

/** companies 需要搬運的欄位（排除環境專屬的 first_seen_document_id / default_template_id） */
var CO_COLS = ['id', 'name', 'code', 'display_name', 'type', 'status', 'source', 'name_variants',
  'identification_patterns', 'merged_into_id', 'logo_url', 'contact_email', 'description',
  'priority', 'default_confidence', 'created_by_id', 'created_at', 'updated_at'];

/** template_field_mappings 中屬於「設定」的欄位；時間戳與建立者不算 */
var TFM_COLS = ['data_template_id', 'scope', 'company_id', 'document_format_id',
  'name', 'description', 'mappings', 'priority', 'is_active'];

var JSON_COLS = { mappings: 1 };
var ARRAY_COLS = { name_variants: 1, identification_patterns: 1 };
var ENUM_CASTS = {
  type: 'CompanyType', status: 'CompanyStatus', source: 'CompanySource',
  scope: 'TemplateFieldMappingScope',
};

/** 參數化查詢無法自行推斷 enum 與陣列型別，需明確轉型 */
function cast(f) {
  if (JSON_COLS[f]) return '::jsonb';
  if (ARRAY_COLS[f]) return '::text[]';
  if (ENUM_CASTS[f]) return '::"' + ENUM_CASTS[f] + '"';
  return '';
}
function val(f, v) {
  if (JSON_COLS[f]) return JSON.stringify(v);
  if (ARRAY_COLS[f]) return v || [];
  return v;
}
var norm = function (v) { return JSON.stringify(v === undefined ? null : v); };
var label = function (x) {
  return (x._template_name || '(無模板)') + ' ｜ ' + (x._company_name || 'GLOBAL') +
    (x.is_active ? '' : ' [停用]');
};

function usage() {
  console.log('用法：');
  console.log('  node sync-template-mappings.js export <outfile>              # 在 Azure 容器內執行');
  console.log('  node sync-template-mappings.js inspect|dryrun|write <infile> # 在本機執行');
  process.exitCode = 1;
}

// ============================================================================
// export —— 在 Azure 端執行
// ============================================================================

function doExport(outFile) {
  var client = new Client({ connectionString: CONN, ssl: IS_LOCAL ? false : { rejectUnauthorized: false } });
  var payload = {};
  return client
    .connect()
    .then(function () {
      return client.query(
        'SELECT tfm.*, co.name AS _company_name, dt.name AS _template_name' +
        '  FROM template_field_mappings tfm' +
        '  LEFT JOIN companies co ON co.id = tfm.company_id' +
        '  LEFT JOIN data_templates dt ON dt.id = tfm.data_template_id' +
        ' ORDER BY tfm.created_at'
      );
    })
    .then(function (r) {
      payload.mappings = r.rows;
      console.log('映射 ' + r.rows.length + ' 筆');
      var ids = {};
      r.rows.forEach(function (x) { if (x.company_id) ids[x.company_id] = 1; });
      // 連同全部被引用的公司一起帶走 —— 本機缺哪幾間由同步端判斷，匯出端不預設
      return client.query('SELECT ' + CO_COLS.join(', ') + ' FROM companies WHERE id = ANY($1)', [Object.keys(ids)]);
    })
    .then(function (r) {
      payload.companies = r.rows;
      console.log('被引用的公司 ' + r.rows.length + ' 間');
      fs.writeFileSync(outFile, JSON.stringify(payload));
      console.log('已寫入 ' + outFile);
      return client.end();
    });
}

// ============================================================================
// inspect / dryrun / write —— 在本機執行
// ============================================================================

function doSync(inFile, mode) {
  var exported = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  if (!exported.mappings || !exported.companies) {
    console.log('🔴 輸入檔缺少 mappings 或 companies —— 請確認來自本腳本的 export 模式');
    process.exitCode = 1;
    return Promise.resolve();
  }
  var client = new Client({ connectionString: CONN, ssl: IS_LOCAL ? false : { rejectUnauthorized: false } });
  var plan = { companies: [], inserts: [], updates: [] };
  var localCreator = null;
  var abort = false;
  function fail(m) { console.log('🔴 ' + m + ' —— 中止'); process.exitCode = 1; abort = true; }

  return client
    .connect()
    .then(function () {
      console.log('模式: ' + mode + '   目標: ' + CONN.replace(/.*@/, '').replace(/\?.*/, ''));
      console.log('來源: ' + exported.mappings.length + ' 筆映射 / ' + exported.companies.length + ' 間公司（' + inFile + '）');
      console.log('');
      return client.query(
        'SELECT created_by_id, count(*) AS n FROM companies GROUP BY created_by_id ORDER BY count(*) DESC LIMIT 1'
      );
    })
    .then(function (r) {
      if (!r.rows.length) return fail('本機沒有任何公司，無從推斷建立者');
      localCreator = r.rows[0].created_by_id;
      console.log('=== 0. 建立者對映 ===');
      console.log('  來源的 created_by → ' + localCreator + '（本機 ' + r.rows[0].n + ' 間公司皆用此值）');
      return client.query('SELECT id FROM users WHERE id = $1', [localCreator]);
    })
    .then(function (r) {
      if (abort) return null;
      if (!r.rows.length) return fail('建立者 ' + localCreator + ' 不存在於 users');
      return client.query('SELECT id FROM companies WHERE id = ANY($1)',
        [exported.companies.map(function (x) { return x.id; })]);
    })
    .then(function (r) {
      if (abort || !r) return null;
      var have = {};
      r.rows.forEach(function (x) { have[x.id] = 1; });
      plan.companies = exported.companies.filter(function (x) { return !have[x.id]; });
      console.log('');
      console.log('=== 1. companies（外鍵前置依賴）===');
      if (!plan.companies.length) console.log('  本機皆已存在，無待新增項目');
      plan.companies.forEach(function (x) { console.log('  ➕ ' + x.name + '  [' + x.status + ']'); });

      return client.query(
        'SELECT tfm.*, dt.name AS _template_name, co.name AS _company_name' +
        '  FROM template_field_mappings tfm' +
        '  LEFT JOIN data_templates dt ON dt.id = tfm.data_template_id' +
        '  LEFT JOIN companies co ON co.id = tfm.company_id'
      );
    })
    .then(function (r) {
      if (abort || !r) return null;
      var local = {};
      r.rows.forEach(function (x) { local[x.id] = x; });
      exported.mappings.forEach(function (a) {
        var l = local[a.id];
        if (!l) { plan.inserts.push(a); return; }
        var diff = TFM_COLS.filter(function (f) { return norm(a[f]) !== norm(l[f]); });
        if (diff.length) { a._diff = diff; plan.updates.push(a); }
      });
      var srcIds = {};
      exported.mappings.forEach(function (x) { srcIds[x.id] = 1; });
      var localOnly = r.rows.filter(function (x) { return !srcIds[x.id]; });

      console.log('');
      console.log('=== 2. template_field_mappings（本機現有 ' + r.rows.length + ' 筆）===');
      console.log('  ➕ 新增 ' + plan.inserts.length + '：');
      plan.inserts.forEach(function (x) { console.log('      ' + label(x) + '  ' + (x.mappings || []).length + ' 條'); });
      console.log('  ✏️ 更新 ' + plan.updates.length + '：');
      plan.updates.forEach(function (x) { console.log('      ' + label(x) + '  差異：' + x._diff.join(', ')); });
      console.log('  ⏸️ 本機獨有、保留不動 ' + localOnly.length + '：');
      localOnly.forEach(function (x) { console.log('      ' + label(x) + '  id=' + x.id); });

      console.log('');
      if (!plan.companies.length && !plan.inserts.length && !plan.updates.length) {
        console.log('無待變更項目（已同步）。');
        return null;
      }
      console.log('合計：公司 +' + plan.companies.length + ' ｜ 映射 +' + plan.inserts.length +
        ' / 改 ' + plan.updates.length + ' / 保留 ' + localOnly.length);

      if (mode !== 'write') {
        console.log('（' + mode + ' 模式，未寫入）');
        if (mode === 'dryrun') console.log('確認無誤後執行: node scripts/sync-template-mappings.js write ' + inFile);
        return null;
      }

      var backup = inFile + '.local-backup.json';
      fs.writeFileSync(backup, JSON.stringify({ capturedAt: new Date().toISOString(), rowCount: r.rows.length, rows: r.rows }));
      console.log('');
      console.log('=== 前置快照（唯一還原依據）===');
      console.log('  本機 ' + r.rows.length + ' 筆完整內容 → ' + backup);
      console.log('');
      console.log('開始寫入（單一交易）...');

      return client
        .query('BEGIN')
        .then(function () {
          return plan.companies.reduce(function (p, co) {
            return p.then(function () {
              var vals = CO_COLS.map(function (f) { return f === 'created_by_id' ? localCreator : val(f, co[f]); });
              var ph = CO_COLS.map(function (f, i) { return '$' + (i + 1) + cast(f); });
              return client
                .query('INSERT INTO companies (' + CO_COLS.join(', ') + ') VALUES (' + ph.join(', ') + ')', vals)
                .then(function (res) {
                  if (res.rowCount !== 1) throw new Error('公司「' + co.name + '」預期新增 1 列，實際 ' + res.rowCount);
                  console.log('  ✅ 公司：' + co.name);
                });
            });
          }, Promise.resolve());
        })
        .then(function () {
          var cols = ['id'].concat(TFM_COLS, ['created_by', 'created_at', 'updated_at']);
          return plan.inserts.reduce(function (p, m) {
            return p.then(function () {
              var vals = cols.map(function (f) {
                if (f === 'created_by') return localCreator;
                if (f === 'updated_at') return new Date();
                return val(f, m[f]);
              });
              var ph = cols.map(function (f, i) { return '$' + (i + 1) + cast(f); });
              return client
                .query('INSERT INTO template_field_mappings (' + cols.join(', ') + ') VALUES (' + ph.join(', ') + ')', vals)
                .then(function (res) {
                  if (res.rowCount !== 1) throw new Error('映射「' + m.name + '」預期新增 1 列，實際 ' + res.rowCount);
                  console.log('  ✅ 新增：' + m.name);
                });
            });
          }, Promise.resolve());
        })
        .then(function () {
          return plan.updates.reduce(function (p, m) {
            return p.then(function () {
              var sets = TFM_COLS.map(function (f, i) { return f + ' = $' + (i + 1) + cast(f); });
              var vals = TFM_COLS.map(function (f) { return val(f, m[f]); });
              vals.push(m.id);
              return client
                .query('UPDATE template_field_mappings SET ' + sets.join(', ') +
                  ', updated_at = NOW() WHERE id = $' + vals.length, vals)
                .then(function (res) {
                  if (res.rowCount !== 1) throw new Error('映射「' + m.name + '」預期更新 1 列，實際 ' + res.rowCount);
                  console.log('  ✅ 更新：' + m.name);
                });
            });
          }, Promise.resolve());
        })
        .then(function () { return client.query('COMMIT'); })
        .then(function () {
          console.log('已提交。');
          return client.query('SELECT count(*) FROM template_field_mappings');
        })
        .then(function (res) {
          console.log('');
          console.log('本機現為 ' + res.rows[0].count + ' 筆（來源 ' + exported.mappings.length + ' 筆）');
          console.log('請重新執行 inspect 確認雙向差異為 0。');
        })
        .catch(function (e) {
          console.log('🔴 寫入失敗，回滾: ' + e.message);
          process.exitCode = 1;
          return client.query('ROLLBACK');
        });
    })
    .then(function () { return client.end(); });
}

// ============================================================================

var run = null;
if (MODE === 'export' && FILE) run = doExport(FILE);
else if (['inspect', 'dryrun', 'write'].indexOf(MODE) >= 0 && FILE) run = doSync(FILE, MODE);
else usage();

if (run) {
  run.catch(function (e) {
    console.log('ERROR: ' + e.message);
    process.exitCode = 1;
  });
}
