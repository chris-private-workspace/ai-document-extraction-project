/**
 * 孤兒費用欄位掃描（FIX-150 第一層防護）
 *
 * 🔴 唯讀 —— 只有 SELECT，不寫入資料庫。
 *
 * 找出「該公司費用欄位集有定義、提取結果實際有值、卻沒有任何啟用中的映射規則引用」
 * 的來源 key。這些費用已經被正確提取，但在模板實例上無聲蒸發 —— 不會報錯、
 * 不會出現在 validation_errors，只是那一格永遠空白。
 *
 * 成因見 FIX-150：一個目標欄位只能綁一組來源，當同一家公司的不同發票版面產生
 * 不同的來源 key 時，改動映射去接住 A，就會讓 B 失去唯一去處。改動當下若只重跑
 * A 那份文件，B 的損失不會被看見。
 *
 * 用法：
 *   node scripts/check-orphan-charge-keys.js
 *   node scripts/check-orphan-charge-keys.js --company=Nippon
 *   node scripts/check-orphan-charge-keys.js --save=orphans-before.json
 *   node scripts/check-orphan-charge-keys.js --baseline=orphans-before.json
 *
 * 改設定的標準流程：
 *   1. 改動前  --save=before.json
 *   2. 改動 + 重新匹配模板實例
 *   3. 改動後  --baseline=before.json   ← 出現「新增孤兒」即代表打破了既有映射
 *
 * ⚠️ 只計入該公司 field_definition_sets 定義的費用欄位。發票通用欄位
 *    （invoice_date / total_amount / subtotal / invoice_number 等）本就不該進費用模板，
 *    納入統計會產生大量誤報並把日期當金額加總。
 *
 * ⚠️ Azure 執行：runner 映像不含 scripts/，需先上傳至 Kudu /home 再以 node 執行
 *    （見 memory feedback_azure_runner_excludes_scripts_tsx）。
 */
'use strict';

// 本機需從 .env 取 DATABASE_URL；Azure 容器由平台注入且映像不含 dotenv，故以 try/catch 包住。
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

const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const COMPANY_FILTER = argOf('company');
const SAVE_TO = argOf('save');
const BASELINE = argOf('baseline');

// SSL 依連線目標自動判斷：本機 docker 的 PostgreSQL 不支援 SSL，Azure 私有端點需要。
const CONN = process.env.DATABASE_URL || '';
const IS_LOCAL = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);

/** 收集一條映射規則消費的所有來源 key（DIRECT 的 sourceField + FORMULA 內每個 {key}） */
function referencedKeys(rule) {
  const keys = [];
  if (rule.transformType === 'FORMULA' && rule.transformParams && rule.transformParams.formula) {
    const re = /\{([A-Za-z0-9_]+)\}/g;
    let m;
    while ((m = re.exec(rule.transformParams.formula)) !== null) keys.push(m[1]);
  }
  if (rule.sourceField) keys.push(rule.sourceField);
  return keys;
}

/** 提取結果的欄位值可能是純量或 {value,...} 物件；非數字與 0 一律不計 */
function numericValue(raw) {
  let v = raw && typeof raw === 'object' ? raw.value : raw;
  if (typeof v === 'string') v = parseFloat(v.replace(/,/g, ''));
  return typeof v === 'number' && isFinite(v) && v !== 0 ? v : null;
}

const client = new Client({
  connectionString: CONN,
  ssl: IS_LOCAL ? false : { rejectUnauthorized: false },
});

const companies = new Map(); // companyId -> { name, defKeys, referenced, extracted, maps }
const ensure = (id, name) => {
  if (!companies.has(id)) {
    companies.set(id, { name: name || id, defKeys: new Map(), referenced: new Set(), extracted: new Map(), maps: [] });
  }
  const e = companies.get(id);
  if (name) e.name = name;
  return e;
};

async function main() {
  await client.connect();

  const maps = await client.query(
    `SELECT tfm.company_id, co.name AS cname, tfm.is_active, tfm.mappings, tfm.updated_at, dt.name AS tname
       FROM template_field_mappings tfm
       LEFT JOIN companies co ON co.id = tfm.company_id
       JOIN data_templates dt ON dt.id = tfm.data_template_id`
  );
  for (const row of maps.rows) {
    const e = ensure(row.company_id, row.cname);
    e.maps.push({ template: row.tname, active: row.is_active, updatedAt: row.updated_at });
    if (!row.is_active) continue; // 停用的規則不消費任何來源
    for (const rule of row.mappings || []) {
      for (const k of referencedKeys(rule)) e.referenced.add(k);
    }
  }

  const defs = await client.query('SELECT company_id, fields FROM field_definition_sets');
  for (const row of defs.rows) {
    const e = ensure(row.company_id);
    for (const f of row.fields || []) if (f.key) e.defKeys.set(f.key, f.label || f.key);
  }

  // 每份文件只取最新一次提取，否則重複處理的文件會被重複計算
  const extractions = await client.query(
    `SELECT DISTINCT ON (er.document_id) d.company_id, er.field_mappings
       FROM extraction_results er
       JOIN documents d ON d.id = er.document_id
      WHERE er.field_mappings IS NOT NULL AND d.company_id IS NOT NULL
      ORDER BY er.document_id, er.created_at DESC`
  );
  for (const row of extractions.rows) {
    const e = ensure(row.company_id);
    for (const [key, raw] of Object.entries(row.field_mappings || {})) {
      const v = numericValue(raw);
      if (v === null) continue;
      const acc = e.extracted.get(key) || { docs: 0, total: 0 };
      acc.docs += 1;
      acc.total += v;
      e.extracted.set(key, acc);
    }
  }

  const findings = [];
  for (const [id, e] of companies) {
    if (!e.maps.length) continue; // 完全沒有映射的公司屬另一種問題，不在本掃描範圍
    if (COMPANY_FILTER && !e.name.toLowerCase().includes(COMPANY_FILTER.toLowerCase())) continue;
    const orphans = [...e.extracted.keys()]
      .filter((k) => e.defKeys.has(k) && !e.referenced.has(k))
      .map((k) => ({ key: k, label: e.defKeys.get(k), ...e.extracted.get(k) }))
      .sort((a, b) => b.total - a.total);
    if (orphans.length) findings.push({ companyId: id, company: e.name, maps: e.maps, orphans });
  }
  findings.sort((a, b) => sumOf(b.orphans) - sumOf(a.orphans));

  report(findings, extractions.rows.length);

  if (SAVE_TO) {
    const payload = { capturedAt: new Date().toISOString(), filter: COMPANY_FILTER || null, findings };
    fs.writeFileSync(SAVE_TO, JSON.stringify(payload, null, 2));
    console.log(`\n基線已存至 ${SAVE_TO}`);
  }
  if (BASELINE) compareWithBaseline(findings, BASELINE);

  await client.end();
}

const sumOf = (orphans) => orphans.reduce((s, o) => s + o.total, 0);

function report(findings, scanned) {
  console.log(`掃描 ${scanned} 份文件的最新提取結果` + (COMPANY_FILTER ? `（公司篩選：${COMPANY_FILTER}）` : ''));
  console.log('');
  if (!findings.length) {
    console.log('✅ 沒有孤兒費用欄位 —— 所有有值的已定義費用欄位都有規則接收。');
    return;
  }
  console.log('=== 孤兒費用欄位（已定義、有值、無啟用規則引用）===');
  let grandTotal = 0;
  let grandKeys = 0;
  for (const f of findings) {
    const sum = sumOf(f.orphans);
    grandTotal += sum;
    grandKeys += f.orphans.length;
    console.log('');
    console.log(`  ${f.company}   [合計 ${sum.toFixed(2)}]`);
    console.log(
      '    映射：' +
        f.maps
          .map((m) => {
            const short = m.template.replace('Logistics Cost - ', '').replace(' Template (Full List)', '');
            return `${short}${m.active ? '' : '[停用]'} 改於 ${m.updatedAt.toISOString().slice(0, 10)}`;
          })
          .join('  /  ')
    );
    for (const o of f.orphans) {
      console.log(`    ${o.key}  "${o.label}"   文件數=${o.docs}  金額=${o.total.toFixed(2)}`);
    }
  }
  console.log('');
  console.log(`=== 合計：${grandKeys} 個孤兒欄位、${findings.length} 家公司、${grandTotal.toFixed(2)} ===`);
}

function compareWithBaseline(current, baselinePath) {
  const base = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const flatten = (findings) => {
    const m = new Map();
    for (const f of findings) for (const o of f.orphans) m.set(`${f.company}|${o.key}`, { ...o, company: f.company });
    return m;
  };
  const before = flatten(base.findings || []);
  const after = flatten(current);

  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));

  console.log('');
  console.log(`=== 與基線比對（${base.capturedAt}）===`);
  if (added.length) {
    console.log('');
    console.log('  🔴 新增孤兒 —— 本次改動讓這些費用失去了去處：');
    for (const k of added) {
      const o = after.get(k);
      console.log(`     ${o.company}  ${o.key} "${o.label}"  文件數=${o.docs}  金額=${o.total.toFixed(2)}`);
    }
    process.exitCode = 1; // 供 CI／腳本串接判斷
  }
  if (removed.length) {
    console.log('');
    console.log('  ✅ 已修復 —— 這些費用現在有規則接收了：');
    for (const k of removed) {
      const o = before.get(k);
      console.log(`     ${o.company}  ${o.key} "${o.label}"  金額=${o.total.toFixed(2)}`);
    }
  }
  if (!added.length && !removed.length) console.log('  孤兒清單與基線一致，本次改動未造成新的漏接。');
}

main().catch((e) => {
  console.log('ERROR: ' + e.message);
  process.exitCode = 1;
  try {
    client.end();
  } catch (_) {
    /* 連線已關閉 */
  }
});
