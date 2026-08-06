/**
 * 費用落地對帳（FIX-150 第一層防護）
 *
 * 🔴 唯讀 —— 只有 SELECT，不寫入資料庫。
 *
 * 回答一個問題：**這張發票上提取到的費用，有多少沒有進到模板？**
 *
 * 對每份文件比對兩個總額：
 *   A = 提取結果中「已定義為費用欄位」且有值的金額總和
 *   B = 該文件模板實例列上所有數值欄位的總和
 * 差額 A − B 即為未落地的金額。再從「金額未單獨出現、也非任何欄位值」的 key 中
 * 找出嫌疑者，金額恰等於差額時標為高信心。
 *
 * 成因見 FIX-150：一個目標欄位只能綁一組來源，當同一家公司的不同發票版面產生
 * 不同的來源 key 時，改動映射去接住 A，就會讓 B 失去唯一去處。改動當下若只重跑
 * A 那份文件，B 的損失不會被看見。
 *
 * 用法：
 *   node scripts/check-orphan-charge-keys.js
 *   node scripts/check-orphan-charge-keys.js --company=Nippon
 *   node scripts/check-orphan-charge-keys.js --save=before.json
 *   node scripts/check-orphan-charge-keys.js --baseline=before.json
 *   node scripts/check-orphan-charge-keys.js --docs        （逐份文件列出，非僅公司彙總）
 *
 * 改設定的標準流程：
 *   1. 改動前  --save=before.json
 *   2. 改動 + 重新匹配模板實例
 *   3. 改動後  --baseline=before.json   ← 漏額變大即代表打破了既有映射
 *
 * ── 為何用總額對帳而非「有沒有規則引用」──────────────────────────
 *
 * 初版用「該公司的映射有沒有引用此 key」判定，對 5 個宣稱的孤兒誤判了 4 個：映射的
 * company_id **不是**套用與否的決定因素，掛在 A 公司名下的映射實際會套用到 B 公司的
 * 文件上（實測 NEL 的出口文件套用了掛在 NEHK 名下的 Outbound 映射）。
 *
 * 改按「文件實際落在的模板」收集規則後又太寬鬆 —— 已合併公司留下的 active 映射也會
 * 被算進來，讓真正沒去處的 key 看起來有人要。而「金額是否單獨出現在某欄位」這個事實
 * 訊號，對加總型規則（handling_at_origin = seal + handling）系統性失效。
 *
 * 總額對帳不需要知道哪組規則生效：被加總的錢仍在 B 裡，沒落地的錢一定不在。
 *
 * ⚠️ 差額為負代表模板總額大於提取總額，通常是同一筆錢被兩條規則各算一次（重複計算），
 *    亦一併回報。
 *
 * ⚠️ 差額反映的是「模板實例列當下的內容」，不等於「映射規則現在是否正確」。實例列是
 *    快照，改設定不會回溯既有列 —— 設定改好但尚未重新匹配的文件，會被計為漏接。
 *    因此比對前務必先重新匹配，否則會把過期快照誤讀為映射缺陷。
 *
 * ⚠️ 只計入 field_definition_sets 定義的費用欄位。發票通用欄位（invoice_date /
 *    total_amount / subtotal 等）本就不該進費用模板，納入會把日期當金額加總。
 *
 * ⚠️ Azure 執行：**改用 `prisma/check-orphan-charge-keys.js`**（判準相同，已驗證數字逐項一致）。
 *    以 `RUN_ORPHAN_CHECK=inspect` 於容器啟動時執行，見 runbook §20。
 *
 *    🔴 本處原寫「上傳至 Kudu /home 再以 node 執行」—— **那條路行不通**。2026-08-06 實測：
 *    Kudu `/api/command` 跑在 sidecar，working directory `/app` 不存在，也拿不到 app 容器的
 *    `node_modules/pg`。要讀 DB 只能做成 `prisma/*.js` + gated 旗標（Dockerfile 整包 COPY prisma/）。
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
const SHOW_DOCS = process.argv.includes('--docs');
const EPSILON = 0.01;

const CONN = process.env.DATABASE_URL || '';
const IS_LOCAL = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);

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

async function main() {
  await client.connect();

  // 模板的數值欄位清單 —— 只有這些才計入 B（排除 shipment_number 等字串欄位）
  const numericFields = new Map(); // dataTemplateId -> Set(fieldName)
  const templates = await client.query('SELECT id, fields FROM data_templates');
  for (const t of templates.rows) {
    numericFields.set(
      t.id,
      new Set((t.fields || []).filter((f) => f.dataType === 'number').map((f) => f.name))
    );
  }

  const defKeys = new Map(); // companyId -> Map(key -> label)
  const defs = await client.query('SELECT company_id, fields FROM field_definition_sets');
  for (const row of defs.rows) {
    if (!defKeys.has(row.company_id)) defKeys.set(row.company_id, new Map());
    const m = defKeys.get(row.company_id);
    for (const f of row.fields || []) if (f.key) m.set(f.key, f.label || f.key);
  }

  // 每份文件在每個模板的最新一列
  const rowsByDoc = new Map(); // documentId -> [{templateId, values}]
  const instRows = await client.query(
    `SELECT DISTINCT ON (doc.id, ti.data_template_id)
            doc.id AS document_id, ti.data_template_id, tir.field_values
       FROM template_instance_rows tir
       JOIN template_instances ti ON ti.id = tir.template_instance_id
       JOIN documents doc ON doc.id = ANY(tir.source_document_ids)
      ORDER BY doc.id, ti.data_template_id, tir.created_at DESC`
  );
  for (const row of instRows.rows) {
    if (!rowsByDoc.has(row.document_id)) rowsByDoc.set(row.document_id, []);
    rowsByDoc.get(row.document_id).push({ templateId: row.data_template_id, values: row.field_values || {} });
  }

  const extractions = await client.query(
    `SELECT DISTINCT ON (er.document_id) er.document_id, d.file_name, d.company_id, co.name AS company, er.field_mappings
       FROM extraction_results er
       JOIN documents d ON d.id = er.document_id
       LEFT JOIN companies co ON co.id = d.company_id
      WHERE er.field_mappings IS NOT NULL AND d.company_id IS NOT NULL
      ORDER BY er.document_id, er.created_at DESC`
  );

  const byCompany = new Map();
  const docFindings = [];
  let scanned = 0;
  let noTemplateRow = 0;

  for (const doc of extractions.rows) {
    if (COMPANY_FILTER && !(doc.company || '').toLowerCase().includes(COMPANY_FILTER.toLowerCase())) continue;
    const defined = defKeys.get(doc.company_id);
    if (!defined) continue;
    const docRows = rowsByDoc.get(doc.document_id) || [];
    if (!docRows.length) {
      noTemplateRow += 1;
      continue; // 尚未加入任何實例，無從判定
    }
    scanned += 1;

    // A：提取到的費用總額
    const charges = [];
    for (const [key, raw] of Object.entries(doc.field_mappings || {})) {
      if (!defined.has(key)) continue;
      const v = numericValue(raw);
      if (v !== null) charges.push({ key, label: defined.get(key), amount: v });
    }
    if (!charges.length) continue;
    const extractedTotal = charges.reduce((s, ch) => s + ch.amount, 0);

    // B：每個模板各自算，取差額絕對值最小者 —— 一份文件可能同時落在多個模板，
    // 取最貼合的那個，避免因套錯模板而誤報。
    let best = null;
    for (const r of docRows) {
      const allowed = numericFields.get(r.templateId) || new Set();
      let sum = 0;
      const values = [];
      for (const [f, raw] of Object.entries(r.values)) {
        if (!allowed.has(f)) continue;
        const n = numericValue(raw);
        if (n !== null) { sum += n; values.push(n); }
      }
      const diff = extractedTotal - sum;
      if (!best || Math.abs(diff) < Math.abs(best.diff)) best = { diff, templateSum: sum, values };
    }
    if (!best) continue;

    if (Math.abs(best.diff) < EPSILON) continue; // 完全對上

    // 嫌疑者：金額未單獨出現在該列任何欄位的 key（被加總者通常也不會單獨出現，
    // 故僅作提示，金額恰等於差額時才標為高信心）
    const suspects = charges
      .filter((ch) => !best.values.some((v) => Math.abs(v - ch.amount) < EPSILON))
      .map((ch) => ({ ...ch, exact: Math.abs(ch.amount - best.diff) < EPSILON }))
      .sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0) || b.amount - a.amount);

    docFindings.push({
      file: doc.file_name,
      company: doc.company,
      extractedTotal,
      templateSum: best.templateSum,
      diff: best.diff,
      suspects: suspects.slice(0, 5),
    });

    const key = doc.company;
    if (!byCompany.has(key)) byCompany.set(key, { company: key, docs: 0, missing: 0, duplicated: 0, keys: new Map() });
    const cs = byCompany.get(key);
    cs.docs += 1;
    if (best.diff > 0) cs.missing += best.diff;
    else cs.duplicated += -best.diff;
    for (const s of suspects.filter((x) => x.exact)) {
      const k = cs.keys.get(s.key) || { key: s.key, label: s.label, docs: 0, amount: 0 };
      k.docs += 1;
      k.amount += s.amount;
      cs.keys.set(s.key, k);
    }
  }

  const findings = [...byCompany.values()]
    .map((c) => ({ ...c, keys: [...c.keys.values()].sort((a, b) => b.amount - a.amount) }))
    .sort((a, b) => b.missing - a.missing);

  report(findings, docFindings, scanned, noTemplateRow);

  if (SAVE_TO) {
    fs.writeFileSync(
      SAVE_TO,
      JSON.stringify({ capturedAt: new Date().toISOString(), filter: COMPANY_FILTER || null, findings }, null, 2)
    );
    console.log(`\n基線已存至 ${SAVE_TO}`);
  }
  if (BASELINE) compareWithBaseline(findings, BASELINE);

  await client.end();
}

function report(findings, docFindings, scanned, noTemplateRow) {
  console.log(`對帳 ${scanned} 份文件` + (COMPANY_FILTER ? `（公司篩選：${COMPANY_FILTER}）` : ''));
  console.log(`另有 ${noTemplateRow} 份尚未加入任何模板實例，無從判定，已略過`);
  console.log('');

  if (!findings.length) {
    console.log('✅ 所有文件的費用總額都與模板總額吻合，沒有漏接。');
    return;
  }

  console.log('=== 費用未落地（提取總額 − 模板總額）===');
  let totalMissing = 0;
  let totalDup = 0;
  for (const f of findings) {
    totalMissing += f.missing;
    totalDup += f.duplicated;
    console.log('');
    console.log(
      `  ${f.company}   ${f.docs} 份有差額` +
        (f.missing > EPSILON ? `   🔴 漏 ${f.missing.toFixed(2)}` : '') +
        (f.duplicated > EPSILON ? `   ⚠️ 多算 ${f.duplicated.toFixed(2)}` : '')
    );
    for (const k of f.keys) {
      console.log(`     可定位：${k.key} "${k.label}"   ${k.docs} 份 / ${k.amount.toFixed(2)}`);
    }
  }
  console.log('');
  console.log(`=== 合計：漏 ${totalMissing.toFixed(2)}、多算 ${totalDup.toFixed(2)} ===`);
  console.log('（「可定位」為金額恰等於該份差額的欄位；其餘差額多為多筆合成，需逐份檢視）');

  if (SHOW_DOCS) {
    console.log('');
    console.log('=== 逐份文件 ===');
    for (const d of docFindings.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 40)) {
      console.log(
        `  ${d.file}  [${d.company}]  提取=${d.extractedTotal.toFixed(2)} 模板=${d.templateSum.toFixed(2)} ` +
          `差額=${d.diff.toFixed(2)}`
      );
      if (d.suspects.length) {
        console.log(
          '     嫌疑：' + d.suspects.map((s) => `${s.key}=${s.amount}${s.exact ? ' ←恰等於差額' : ''}`).join(', ')
        );
      }
    }
  }
}

function compareWithBaseline(current, baselinePath) {
  const base = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const before = new Map((base.findings || []).map((f) => [f.company, f]));
  const after = new Map(current.map((f) => [f.company, f]));

  console.log('');
  console.log(`=== 與基線比對（${base.capturedAt}）===`);
  const worsened = [];
  const improved = [];
  for (const [company, a] of after) {
    const b = before.get(company);
    const was = b ? b.missing : 0;
    if (a.missing - was > EPSILON) worsened.push({ company, was, now: a.missing });
    else if (was - a.missing > EPSILON) improved.push({ company, was, now: a.missing });
  }
  for (const [company, b] of before) {
    if (!after.has(company) && b.missing > EPSILON) improved.push({ company, was: b.missing, now: 0 });
  }

  if (worsened.length) {
    console.log('');
    console.log('  🔴 漏接金額增加 —— 本次改動打破了既有映射：');
    for (const w of worsened) console.log(`     ${w.company}  ${w.was.toFixed(2)} → ${w.now.toFixed(2)}`);
    process.exitCode = 1; // 供 CI／腳本串接判斷
  }
  if (improved.length) {
    console.log('');
    console.log('  ✅ 漏接金額減少：');
    for (const i of improved) console.log(`     ${i.company}  ${i.was.toFixed(2)} → ${i.now.toFixed(2)}`);
  }
  if (!worsened.length && !improved.length) console.log('  漏接金額與基線一致，本次改動未造成新的漏接。');
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
