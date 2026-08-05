#!/usr/bin/env node
/**
 * FIX-162 A 類（選項 2）：合併 RICOH/SBS 定義集中兩個語意相同的欄位。
 *
 * 問題：
 *   `air_local_charge_usa_origin` 與 `air_local_charge_in_usa_origin_charge` 指同一筆費用
 *   （發票上只有一行 `(AIR) LOCAL CHARGE IN USA`），兩者都沒有 aliases，模型無從區分，
 *   於是**兩個都填**。而 mapping 的 handling_at_origin 是兩者相加（FIX-158 的修法），
 *   造成重複計費 —— 5 份文件實測重複 7,712.80。
 *
 * 本腳本做什麼：
 *   移除 `air_local_charge_in_usa_origin_charge`，把它的 label 併入保留者的 aliases。
 *   保留 `air_local_charge_usa_origin`（其 label「(Air) Local Charge in USA (Origin Charge)」
 *   更貼近發票原文）。
 *
 * 🔴 刻意**不動** mapping：
 *   handling_at_origin 的公式 `{air_local_charge_usa_origin} + {air_local_charge_in_usa_origin_charge}`
 *   保持原樣。這是有意的向後相容設計 ——
 *     · 未來提取：被移除的 key 不再出現，公式等於「只取保留的 key」，結果正確
 *     · 既有結果：仍帶著兩個 key，公式照舊取得到值，不會突然漏帳
 *   若同時把公式改成 DIRECT，那些「只填了被移除 key」的舊文件會立刻變成漏帳
 *   （全母體模擬：2 份）。
 *
 * ⚠️ 不回溯：既有 5 份的重複計費不會因此消失，要修正它們必須重新提取
 *    （會覆蓋 extraction_results，系統無處理歷史）。本腳本刻意不做那一步。
 *
 * 用法（三段式，§不可逆資料操作紀律）：
 *   node scripts/fix-162-merge-ricoh-duplicate-field.js inspect
 *   node scripts/fix-162-merge-ricoh-duplicate-field.js dryrun
 *   node scripts/fix-162-merge-ricoh-duplicate-field.js write
 *
 * @since FIX-162
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'node_modules/dotenv')).config({ path: path.join(ROOT, '.env'), quiet: true });
const { Client } = require(path.join(ROOT, 'node_modules/pg'));

const MODE = process.argv[2];
const SET_ID = '548326fa-5981-4e1b-9c98-19d0358a32a4';   // SBS INTERNATIONAL LOGISTICS - 自訂費用欄位集
const COMPANY_ID = '2bad90a8-2611-4c85-bb5a-2e381a1487f4';
const KEEP = 'air_local_charge_usa_origin';
const DROP = 'air_local_charge_in_usa_origin_charge';

/**
 * 併入保留者的 aliases。
 * 第一項是被移除者的 label（確保既有寫法仍被辨識）；
 * 第二項是發票上的實際寫法 —— aliases 會進 Stage 3 prompt，給模型一個明確的對應。
 */
const ADD_ALIASES = ['Air local charge in usa origin charge', 'Local Charge in USA'];

const SNAPSHOT_DIR = path.join(ROOT, '.tmp-fix162');
const log = (s) => process.stdout.write(s + '\n');

async function load(client) {
  const { rows } = await client.query(
    `SELECT id, name, company_id, fields, updated_at, is_active
       FROM field_definition_sets WHERE id = $1`,
    [SET_ID]
  );
  if (rows.length !== 1) throw new Error(`找不到定義集 ${SET_ID}（取得 ${rows.length} 筆）`);
  const s = rows[0];
  if (s.company_id !== COMPANY_ID) {
    throw new Error(`定義集的 company_id 是 ${s.company_id}，與預期的 RICOH/SBS 不符 —— 中止`);
  }
  if (!Array.isArray(s.fields)) throw new Error('fields 不是陣列 —— 結構與預期不符，中止');
  return s;
}

/** 冪等：已是目標狀態則回傳 changed=false */
function apply(fields) {
  const next = JSON.parse(JSON.stringify(fields));
  const keep = next.find((f) => f.key === KEEP);
  const dropIdx = next.findIndex((f) => f.key === DROP);

  if (!keep) throw new Error(`保留目標 ${KEEP} 不存在於定義集 —— 中止`);

  if (dropIdx === -1) {
    // 已移除過；確認 aliases 也已併入
    const missing = ADD_ALIASES.filter((a) => !(keep.aliases ?? []).includes(a));
    if (missing.length === 0) return { next, changed: false, removed: null, addedAliases: [] };
    keep.aliases = [...(keep.aliases ?? []), ...missing];
    return { next, changed: true, removed: null, addedAliases: missing };
  }

  const dropped = next[dropIdx];
  // 安全檢查：兩者的語意屬性必須一致，否則不是「重複定義」
  for (const attr of ['category', 'dataType', 'fieldType']) {
    if (dropped[attr] !== keep[attr]) {
      throw new Error(`${DROP} 與 ${KEEP} 的 ${attr} 不同（${dropped[attr]} vs ${keep[attr]}）—— 可能不是重複定義，中止`);
    }
  }

  const addedAliases = ADD_ALIASES.filter((a) => !(keep.aliases ?? []).includes(a));
  keep.aliases = [...(keep.aliases ?? []), ...addedAliases];
  next.splice(dropIdx, 1);
  return { next, changed: true, removed: dropped, addedAliases };
}

async function main() {
  if (!['inspect', 'dryrun', 'write'].includes(MODE)) {
    log('用法: node scripts/fix-162-merge-ricoh-duplicate-field.js inspect|dryrun|write');
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const s = await load(client);
    log(`定義集 ${s.id}`);
    log(`  ${s.name}`);
    log(`  company_id = ${s.company_id}`);
    log(`  updated_at = ${s.updated_at.toISOString()}`);
    log(`  欄位 ${s.fields.length} 個`);

    if (MODE === 'inspect') {
      log('\n兩個目標欄位的現況：');
      for (const k of [KEEP, DROP]) {
        const f = s.fields.find((x) => x.key === k);
        log(`\n  ${k === KEEP ? '✅ 保留' : '🔴 移除'}  ${k}`);
        log(f ? JSON.stringify(f, null, 2).split('\n').map((l) => '     ' + l).join('\n') : '     （不存在）');
      }
      log('\n將併入保留者的 aliases：');
      for (const a of ADD_ALIASES) log(`     "${a}"`);
      log('\n⚠️ 本腳本不動 template_field_mappings —— 公式保留對兩個 key 的引用以相容既有結果。');
      return;
    }

    const { next, changed, removed, addedAliases } = apply(s.fields);
    if (!changed) {
      log('\n沒有需要變更的項目（冪等：重跑不產生副作用）。');
      return;
    }

    const keepAfter = next.find((f) => f.key === KEEP);
    log('\n變更內容：');
    if (removed) {
      log(`  🔴 移除欄位 ${DROP}`);
      log(`       label: ${removed.label}`);
    }
    log(`  🔧 ${KEEP} 的 aliases：`);
    log(`       before: ${JSON.stringify(s.fields.find((f) => f.key === KEEP).aliases ?? [])}`);
    log(`       after : ${JSON.stringify(keepAfter.aliases)}`);
    log(`  欄位總數 ${s.fields.length} → ${next.length}`);

    if (MODE === 'dryrun') {
      log('\n[dryrun] 不寫入。');
      return;
    }

    // ---- write ----
    if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const stamp = s.updated_at.toISOString().replace(/[:.]/g, '-');
    const snapPath = path.join(SNAPSHOT_DIR, `fielddefset-${SET_ID}-${stamp}.json`);
    fs.writeFileSync(snapPath, JSON.stringify(s, null, 2), 'utf8');
    log(`\n[write] 前置快照 → ${snapPath}`);

    await client.query('BEGIN');
    try {
      const res = await client.query(
        `UPDATE field_definition_sets
            SET fields = $1::jsonb, updated_at = NOW()
          WHERE id = $2 AND updated_at = $3`,
        [JSON.stringify(next), SET_ID, s.updated_at]
      );
      if (res.rowCount !== 1) {
        throw new Error(`數量閘：預期更新 1 筆，實際 ${res.rowCount} 筆（樂觀鎖失敗＝期間有人改過）—— 回滾`);
      }
      await client.query('COMMIT');
      log(`[write] ✅ 已更新 1 筆`);
    } catch (e) {
      await client.query('ROLLBACK');
      log(`[write] 🔴 已回滾：${e.message}`);
      throw e;
    }

    const after = await load(client);
    log('\n覆核：');
    log(`  ${DROP} 是否已移除：${after.fields.some((f) => f.key === DROP) ? '🔴 仍在' : '✅ 已移除'}`);
    const ka = after.fields.find((f) => f.key === KEEP);
    log(`  ${KEEP} aliases：${JSON.stringify(ka?.aliases ?? [])}`);
    log(`  欄位總數：${after.fields.length}`);
    log(`  updated_at = ${after.updated_at.toISOString()}`);
    log('');
    log('⚠️ 不回溯：既有 extraction_results 仍帶著兩個 key，那 5 份的重複計費不會消失。');
    log('   未來重新提取的文件才會只產出一個 key。mapping 未動，兩種資料都能取到值。');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  log(`FAILED: ${e.message}`);
  process.exit(1);
});
