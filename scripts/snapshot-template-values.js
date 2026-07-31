/**
 * 模板實例欄位值快照與前後對照（FIX-150 第一層防護）
 *
 * 🔴 唯讀 —— 只有 SELECT，唯一的寫入是輸出快照 JSON 檔。
 *
 * 用途：改動 template field mapping 前後各擷取一次全公司的模板欄位值，逐份文件逐欄位
 * 比對。重點在標示「改動前有值、改動後變空」的欄位 —— 那就是「修 A 打破 B」的訊號。
 *
 * FIX-150 的回歸正是這樣發生的：2026-07-25 為了讓某一份文件的 DO fee 落地而改了
 * 映射來源，當場只重跑那一份、確認通過，但同一個目標欄位原本承載的 B/L fee 從此
 * 失去去處，橫跨另外四份文件無聲消失。有了前後對照，這種損失在改動當下就會現形。
 *
 * 用法：
 *   node scripts/snapshot-template-values.js capture before.json
 *   node scripts/snapshot-template-values.js capture before.json --company=Nippon
 *   （改動映射 → 在介面重新匹配模板實例）
 *   node scripts/snapshot-template-values.js capture after.json
 *   node scripts/snapshot-template-values.js diff before.json after.json
 *
 * 對照的鍵為「文件 + 模板」並取該組合下最新的一列 —— 因此改動後重新匹配即使產生了
 * 新的模板實例，仍能與改動前的舊實例正確對上。
 *
 * ⚠️ 改設定不會回溯既有的模板實例列，必須重新匹配後才擷取 after，否則對照無意義。
 *
 * ⚠️ Azure 執行：runner 映像不含 scripts/，需先上傳至 Kudu /home 再以 node 執行
 *    （見 memory feedback_azure_runner_excludes_scripts_tsx）。
 */
'use strict';

try {
  const path = require('path');
  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
  dotenv.config({ path: path.join(__dirname, '..', '.env.local'), override: true });
} catch (e) {
  /* Azure 容器內無 dotenv，環境變數已由平台提供 */
}

const fs = require('fs');
const { Client } = require(process.env.PG_MODULE_PATH || 'pg');

const MODE = process.argv[2];
const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const CONN = process.env.DATABASE_URL || '';
const IS_LOCAL = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);

/** 空字串、null、0 一律視為「無值」—— 模板欄位在這三種狀態下畫面上都是空白 */
const isEmpty = (v) => v === null || v === undefined || v === '' || v === 0 || v === '0';

function usage() {
  console.log('用法：');
  console.log('  node scripts/snapshot-template-values.js capture <outfile> [--company=關鍵字]');
  console.log('  node scripts/snapshot-template-values.js diff <before.json> <after.json>');
  process.exitCode = 1;
}

async function capture(outFile, companyFilter) {
  const client = new Client({
    connectionString: CONN,
    ssl: IS_LOCAL ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  // source_document_ids 為陣列（合併列可對應多份文件），以 ANY 展開成每文件一列。
  // DISTINCT ON (文件, 模板) 取最新一列 —— 改動後即使換了新實例也能與改動前對上。
  const params = [];
  let where = '';
  if (companyFilter) {
    params.push(`%${companyFilter}%`);
    where = ' WHERE co.name ILIKE $1';
  }
  const res = await client.query(
    `SELECT DISTINCT ON (doc.id, dt.name)
            doc.id AS document_id, doc.file_name, co.name AS company,
            dt.name AS template_name, ti.name AS instance_name,
            tir.created_at, tir.field_values, tir.transform_diagnostics
       FROM template_instance_rows tir
       JOIN template_instances ti ON ti.id = tir.template_instance_id
       JOIN data_templates dt ON dt.id = ti.data_template_id
       JOIN documents doc ON doc.id = ANY(tir.source_document_ids)
       LEFT JOIN companies co ON co.id = doc.company_id${where}
      ORDER BY doc.id, dt.name, tir.created_at DESC`,
    params
  );

  const rows = {};
  for (const r of res.rows) {
    rows[`${r.document_id}|${r.template_name}`] = {
      file: r.file_name,
      company: r.company,
      template: r.template_name,
      instance: r.instance_name,
      rowCreatedAt: r.created_at.toISOString(),
      values: r.field_values || {},
      diagnostics: r.transform_diagnostics || null,
    };
  }

  const payload = {
    capturedAt: new Date().toISOString(),
    filter: companyFilter || null,
    rowCount: Object.keys(rows).length,
    rows,
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log(`已擷取 ${payload.rowCount} 列（文件 × 模板）→ ${outFile}`);
  if (companyFilter) console.log(`公司篩選：${companyFilter}`);

  const companies = new Set(Object.values(rows).map((r) => r.company));
  console.log(`涵蓋 ${companies.size} 家公司`);
  await client.end();
}

function diff(beforePath, afterPath) {
  const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));

  console.log(`改動前：${before.capturedAt}  ${before.rowCount} 列`);
  console.log(`改動後：${after.capturedAt}  ${after.rowCount} 列`);
  console.log('');

  const lost = [];   // 有值 → 空：最需要注意的
  const gained = []; // 空 → 有值：預期中的修復
  const changed = []; // 值改變
  const missing = []; // 改動後找不到對應列（多半是還沒重新匹配）

  for (const [key, b] of Object.entries(before.rows)) {
    const a = after.rows[key];
    if (!a) {
      missing.push(b);
      continue;
    }
    const fields = new Set([...Object.keys(b.values), ...Object.keys(a.values)]);
    for (const f of fields) {
      const bv = b.values[f];
      const av = a.values[f];
      if (isEmpty(bv) && isEmpty(av)) continue;
      if (isEmpty(av) && !isEmpty(bv)) lost.push({ ...b, field: f, from: bv, to: av });
      else if (isEmpty(bv) && !isEmpty(av)) gained.push({ ...b, field: f, from: bv, to: av });
      else if (JSON.stringify(bv) !== JSON.stringify(av)) changed.push({ ...b, field: f, from: bv, to: av });
    }
  }
  const added = Object.keys(after.rows).filter((k) => !before.rows[k]);

  if (lost.length) {
    console.log('🔴 欄位由有值變為空白 —— 本次改動打破了既有映射：');
    for (const x of lost) console.log(`   ${x.file}  [${short(x.template)}]  ${x.field}: ${fmt(x.from)} → 空`);
    console.log('');
    process.exitCode = 1;
  }
  if (changed.length) {
    console.log('⚠️ 欄位值改變：');
    for (const x of changed) console.log(`   ${x.file}  [${short(x.template)}]  ${x.field}: ${fmt(x.from)} → ${fmt(x.to)}`);
    console.log('');
  }
  if (gained.length) {
    console.log('✅ 欄位由空白變為有值：');
    for (const x of gained) console.log(`   ${x.file}  [${short(x.template)}]  ${x.field}: 空 → ${fmt(x.to)}`);
    console.log('');
  }
  if (missing.length) {
    console.log(`ℹ️ 改動後找不到對應列（${missing.length}）—— 這些文件可能尚未重新匹配：`);
    for (const x of missing.slice(0, 20)) console.log(`   ${x.file}  [${short(x.template)}]`);
    if (missing.length > 20) console.log(`   ……另有 ${missing.length - 20} 列`);
    console.log('');
  }
  if (added.length) console.log(`ℹ️ 改動後新增 ${added.length} 列（改動前不存在的文件 × 模板組合）`);

  console.log('');
  console.log(
    `=== 摘要：變空 ${lost.length}、值改變 ${changed.length}、變有值 ${gained.length}、` +
      `未對到 ${missing.length}、新增 ${added.length} ===`
  );
  if (!lost.length) console.log('未偵測到「有值變空白」，本次改動沒有打破既有的欄位落點。');
}

const short = (t) => t.replace('Logistics Cost - ', '').replace(' Template (Full List)', '');
const fmt = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));

if (MODE === 'capture') {
  const outFile = process.argv[3];
  if (!outFile) usage();
  else capture(outFile, argOf('company')).catch((e) => {
    console.log('ERROR: ' + e.message);
    process.exitCode = 1;
  });
} else if (MODE === 'diff') {
  const [, , , b, a] = process.argv;
  if (!b || !a) usage();
  else diff(b, a);
} else {
  usage();
}
