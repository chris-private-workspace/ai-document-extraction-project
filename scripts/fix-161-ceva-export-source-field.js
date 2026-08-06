#!/usr/bin/env node
/**
 * FIX-161: 修正 CEVA Outbound mapping 中兩條把 targetField 名誤填為 sourceField 的規則。
 *
 * 問題：
 *   `cfs_charge ← cfs` 與 `gate_charge ← gate_charge` 的 sourceField 用的是
 *   **Inbound 模板的 targetField 名**，不是 CEVA 欄位定義集裡的 key。CEVA 定義集
 *   （f13aaf3b-ec74-4750-8036-a27dbb554792，21 個 key）沒有 `cfs` 也沒有 `gate_charge`，
 *   Stage 3 不可能產出這兩個 key，兩條規則因此在 31/31 列全部落空。
 *
 * 依據（不是憑名稱猜）：
 *   同公司的 Inbound mapping（cmrwu7bqb001101miqgc5e989）已經是正確寫法 ——
 *     gate_charge ← destination_gate_fee
 *     cfs         ← destination_cfs_charges
 *   且這兩個目標 key 在 Outbound 這批 31 份發票中確實有值（各 1 筆，80.00 / 200.00），
 *   目前**沒有任何規則引用**，屬 FIX-160 記錄的「錢無去處」。改指後同時解掉兩個徵狀。
 *
 * 用法（三段式，§不可逆資料操作紀律）：
 *   node scripts/fix-161-ceva-export-source-field.js inspect   只讀，印出現況
 *   node scripts/fix-161-ceva-export-source-field.js dryrun    只讀，印出 before/after
 *   node scripts/fix-161-ceva-export-source-field.js write     實際寫入
 *
 * write 具備：前置快照 / 單一交易 / 數量閘 / 樂觀鎖 / 冪等
 *
 * @since FIX-161
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'node_modules/dotenv')).config({ path: path.join(ROOT, '.env'), quiet: true });
const { Client } = require(path.join(ROOT, 'node_modules/pg'));

const MODE = process.argv[2];
const MAPPING_ID = 'cmrin1af9000101r6gsv3674m';   // CEVA - export to logistics template mapping (Full List)
const COMPANY_ID = '0d02b680-165b-4cfd-8c1b-7ebfa6da8424';

/** 要修的兩條規則：rule id → 新的 sourceField */
const CHANGES = [
  { ruleId: 'ygE34j36XKWZlFKAairrD', targetField: 'cfs_charge', from: 'cfs', to: 'destination_cfs_charges' },
  { ruleId: '-KB5_t9yRdWmvr6jBP_fR', targetField: 'gate_charge', from: 'gate_charge', to: 'destination_gate_fee' },
];

const SNAPSHOT_DIR = path.join(ROOT, '.tmp-fix161');

function log(s) { process.stdout.write(s + '\n'); }

async function load(client) {
  const { rows } = await client.query(
    `SELECT id, name, company_id, data_template_id, mappings, updated_at, is_active
       FROM template_field_mappings WHERE id = $1`,
    [MAPPING_ID]
  );
  if (rows.length !== 1) throw new Error(`找不到 mapping ${MAPPING_ID}（取得 ${rows.length} 筆）`);
  const m = rows[0];
  if (m.company_id !== COMPANY_ID) {
    throw new Error(`mapping 的 company_id 是 ${m.company_id}，與預期的 CEVA ${COMPANY_ID} 不符 —— 中止`);
  }
  return m;
}

/** 回傳 { next, applied, already } —— 冪等：已是目標狀態者不重複改 */
function apply(mappings) {
  const next = JSON.parse(JSON.stringify(mappings));
  const applied = [];
  const already = [];
  for (const c of CHANGES) {
    const r = next.find((x) => x.id === c.ruleId);
    if (!r) throw new Error(`規則 ${c.ruleId} 不存在於 mappings —— 中止`);
    if (r.targetField !== c.targetField) {
      throw new Error(`規則 ${c.ruleId} 的 targetField 是 ${r.targetField}，預期 ${c.targetField} —— 中止`);
    }
    if (r.sourceField === c.to) { already.push(c); continue; }
    if (r.sourceField !== c.from) {
      throw new Error(`規則 ${c.ruleId} 的 sourceField 是 ${r.sourceField}，預期 ${c.from} 或 ${c.to} —— 中止`);
    }
    r.sourceField = c.to;
    applied.push(c);
  }
  return { next, applied, already };
}

async function main() {
  if (!['inspect', 'dryrun', 'write'].includes(MODE)) {
    log('用法: node scripts/fix-161-ceva-export-source-field.js inspect|dryrun|write');
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const m = await load(client);
    log(`mapping ${m.id}`);
    log(`  ${m.name}`);
    log(`  company_id = ${m.company_id}`);
    log(`  updated_at = ${m.updated_at.toISOString()}`);
    log(`  is_active  = ${m.is_active}`);
    log(`  規則 ${m.mappings.length} 條`);

    if (MODE === 'inspect') {
      log('\n目前的規則：');
      for (const r of m.mappings) {
        const src = r.transformType === 'FORMULA' ? (r.transformParams?.formula ?? '?') : r.sourceField;
        const hit = CHANGES.find((c) => c.ruleId === r.id);
        log(`  ${hit ? '🔴' : '  '} ${String(r.targetField).padEnd(30)} ← ${src}`);
        if (hit) log(`       ↑ 本腳本會改為 ← ${hit.to}`);
      }
      return;
    }

    const { next, applied, already } = apply(m.mappings);

    log('\n變更內容：');
    if (already.length) {
      for (const c of already) log(`  ✅ 已是目標狀態，跳過： ${c.targetField} ← ${c.to}`);
    }
    for (const c of applied) {
      log(`  🔧 ${c.targetField}`);
      log(`       before: ← ${c.from}`);
      log(`       after : ← ${c.to}`);
    }
    if (applied.length === 0) {
      log('\n沒有需要變更的項目（冪等：重跑不產生副作用）。');
      return;
    }

    if (MODE === 'dryrun') {
      log(`\n[dryrun] 不寫入。將變更 ${applied.length} 條規則。`);
      return;
    }

    // ---- write ----
    // 1) 前置快照：唯一的還原依據
    if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const stamp = m.updated_at.toISOString().replace(/[:.]/g, '-');
    const snapPath = path.join(SNAPSHOT_DIR, `mapping-${MAPPING_ID}-${stamp}.json`);
    fs.writeFileSync(snapPath, JSON.stringify(m, null, 2), 'utf8');
    log(`\n[write] 前置快照 → ${snapPath}`);

    // 2) 單一交易 + 3) 數量閘 + 4) 樂觀鎖
    await client.query('BEGIN');
    try {
      const res = await client.query(
        `UPDATE template_field_mappings
            SET mappings = $1::jsonb, updated_at = NOW()
          WHERE id = $2 AND updated_at = $3`,
        [JSON.stringify(next), MAPPING_ID, m.updated_at]
      );
      if (res.rowCount !== 1) {
        throw new Error(`數量閘：預期更新 1 筆，實際 ${res.rowCount} 筆（樂觀鎖失敗＝期間有人改過）—— 回滾`);
      }
      await client.query('COMMIT');
      log(`[write] ✅ 已更新 1 筆，變更 ${applied.length} 條規則`);
    } catch (e) {
      await client.query('ROLLBACK');
      log(`[write] 🔴 已回滾：${e.message}`);
      throw e;
    }

    // 5) 覆核
    const after = await load(client);
    log('\n覆核：');
    for (const c of CHANGES) {
      const r = after.mappings.find((x) => x.id === c.ruleId);
      const ok = r && r.sourceField === c.to;
      log(`  ${ok ? '✅' : '🔴'} ${c.targetField} ← ${r ? r.sourceField : '(規則消失)'}`);
    }
    log(`  updated_at = ${after.updated_at.toISOString()}`);
    log(`\n⚠️ 設定變更不回溯：既有的提取結果與模板實例列不會自動更新，需重新匹配才反映。`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  log(`FAILED: ${e.message}`);
  process.exit(1);
});
