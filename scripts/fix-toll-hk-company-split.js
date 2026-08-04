#!/usr/bin/env node
/**
 * @fileoverview Toll 香港實體從泰國記錄中拆出（資料層修正）
 * @module scripts/fix-toll-hk-company-split
 * @since 2026-08-04
 * @lastModified 2026-08-04
 *
 * 背景
 * ----
 * `normalizeCompanyName`（stage-1-company.service.ts:618）會移除括號內容與
 * LTD/LIMITED 等後綴，於是：
 *
 *     Toll Global Forwarding (Thailand) Limited  →  toll global forwarding
 *     Toll Global Forwarding (Hong Kong) Ltd     →  toll global forwarding
 *
 * 兩個不同法律實體正規化後相等，全部落到既有的
 * `Toll Global Forwarder Limited` 一筆記錄，共用同一組 mapping 與欄位定義集。
 *
 * 這是現行邏輯，2026-08-03 / 08-04 的提取仍在複現。
 *
 * 修正策略（使用者 2026-08-04 選定「方案 B：資料層拆分」）
 * ----
 * 不動正規化規則（避免影響已正常運作的 CEVA / DHL 歸併），改為：
 *   1. 建立香港實體的獨立公司記錄，name 對齊發票原文
 *   2. 把香港印法寫進其 nameVariants
 *
 * 為何有效：`resolveCompanyId` 的 Step 2a 用 `nameVariants has <原文>` 與
 * `name equals <原文>`（大小寫不敏感）做**精確**匹配，且**早於** Step 2b 的
 * 正規化匹配。命中 2a 就不會走到 2b —— 而 2b 是 `orderBy createdAt asc`，
 * 新公司在那裡永遠搶不過既有的泰國記錄。
 *
 * ⚠️ 已知殘留風險：GPT 對公司名的輸出並不穩定（同一份文件兩次跑出
 * `CO., LTD.` 與 `CO.,LTD.` 兩種寫法）。若日後出現本腳本未涵蓋的結構性變體
 * （非單純大小寫差異），仍會落回 Step 2b。屆時應把該印法補進 nameVariants，
 * 而非放寬正規化規則。
 *
 * 用法（三段式 gated，見 CLAUDE.md §不可逆資料操作紀律）
 * ----
 *   node scripts/fix-toll-hk-company-split.js inspect
 *   node scripts/fix-toll-hk-company-split.js dryrun
 *   node scripts/fix-toll-hk-company-split.js write
 *   node scripts/fix-toll-hk-company-split.js write --reassign
 *
 * `--reassign` 為**額外**步驟：把既有已歸到泰國記錄、但發票原文為香港的
 * 文件改指到新公司。預設不執行 —— 它是超出「建記錄」範圍的資料變更。
 * ⚠️ 改 company_id **不會**重新提取，既有 extraction 內容維持原樣。
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');
const fs = require('fs');

// ============================================================================
// 目標定義
// ============================================================================

/** 香港實體的正式名稱 —— 對齊發票原文（已觀察，2 份文件） */
const HK_NAME = 'Toll Global Forwarding (Hong Kong) Ltd';

/**
 * 香港實體的 nameVariants。
 *
 *  [觀察] = 實際在發票上看過的印法
 *  [推導] = 依常見縮寫慣例補的，尚未在本庫任何文件出現過
 *
 * 大小寫變體不需列入 —— Step 2a 的 `name equals` 為大小寫不敏感。
 * 這裡只補「結構性」差異（Ltd/Limited、Hong Kong/HK）。
 */
const HK_VARIANTS = [
  'Toll Global Forwarding (Hong Kong) Ltd',      // [觀察] ×2
  'Toll Global Forwarding (Hong Kong) Limited',  // [推導] Ltd → Limited
  'Toll Global Forwarding (HK) Ltd',             // [推導] Hong Kong → HK
  'Toll Global Forwarding (HK) Limited',         // [推導] 兩者併用
];

/** 既有記錄（泰國實體目前寄居於此），用名稱查找、不寫死主鍵 */
const EXISTING_NAME = 'Toll Global Forwarder Limited';

/**
 * 🔴 泰國實體的 nameVariants —— 這一段是第一次 write 之後補上的，原因見下。
 *
 * 首次只建香港記錄就上線，泰國文件立刻被搶走：
 *
 *   normalizeCompanyName('Toll Global Forwarding (Thailand) Limited') = 'toll global forwarding'
 *   normalizeCompanyName('Toll Global Forwarding (Hong Kong) Ltd')    = 'toll global forwarding'  ← 新建
 *   normalizeCompanyName('Toll Global Forwarder Limited')             = 'toll global forwarder'   ← 舊記錄，不相等
 *
 * 泰國文件原本靠 Step 3 的相似度才歸到舊記錄（舊記錄名是 Forwar**der**，
 * 與發票的 Forwar**ding** 正規化後不等）。新香港記錄一出現，Step 2b 的
 * 正規化相等就先命中它 —— 而 2b 早於 3。
 *
 * 修法：讓兩個實體都在 **Step 2a**（nameVariants 精確比對）就分流完成，
 * 根本不進入 2b。故泰國印法必須同步寫進既有記錄的 nameVariants。
 */
const TH_VARIANTS = [
  'Toll Global Forwarding (Thailand) Limited', // [觀察] ×5
  'Toll Global Forwarding (Thailand) Ltd',     // [推導] Limited → Ltd
];

/** 判定「這份文件其實是香港實體」的依據：Stage 1 讀到的發票原文 */
const HK_ISSUER_PATTERNS = ['%(Hong Kong)%', '%(HK)%'];

const SCRATCH = path.join(__dirname, '..', '.tmp-toll-split');

// ============================================================================
// 工具
// ============================================================================

const mode = process.argv[2];
const doReassign = process.argv.includes('--reassign');

if (!['inspect', 'dryrun', 'write'].includes(mode)) {
  console.error('用法: node scripts/fix-toll-hk-company-split.js inspect|dryrun|write [--reassign]');
  process.exit(1);
}

function gate(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`數量閘失敗：${label} 期望 ${expected} 列，實際 ${actual} 列 —— 中止並回滾`);
  }
}

function line() {
  console.log('─'.repeat(78));
}

// ============================================================================
// 查詢
// ============================================================================

async function loadState(client) {
  const existing = await client.query(
    `SELECT id, name, code, status, name_variants, created_at, updated_at
       FROM companies WHERE name = $1`,
    [EXISTING_NAME]
  );

  const hk = await client.query(
    `SELECT id, name, code, status, name_variants, created_at, updated_at
       FROM companies WHERE name = $1`,
    [HK_NAME]
  );

  // 歸屬對帳（雙向）：只看這兩筆 Toll 記錄底下的文件，依發票原文判定應歸何處。
  //   原文含 (Hong Kong)/(HK) → 香港記錄；其餘 → 既有（泰國）記錄。
  // 之所以要雙向：首次 write 只建香港記錄時，泰國文件曾被 Step 2b 搶到香港，
  // 那批錯誤資料同樣需要回正。
  let reconcile = { rows: [] };
  let stayingCount = 0;

  if (existing.rows[0]) {
    const scopeIds = [existing.rows[0].id];
    if (hk.rows[0]) scopeIds.push(hk.rows[0].id);

    const all = await client.query(
      `SELECT d.id         AS document_id,
              d.file_name,
              e.id         AS extraction_id,
              e.created_at AS extracted_at,
              e.company_id AS current_company_id,
              c.name       AS current_company,
              ((e.stage_1_ai_details::jsonb ->> 'response')::jsonb
                 -> 'documentIssuer' ->> 'name') AS issuer
         FROM extraction_results e
         JOIN documents d ON d.id = e.document_id
         JOIN companies c ON c.id = e.company_id
        WHERE e.company_id = ANY($1::text[])
          AND left(trim(e.stage_1_ai_details::jsonb ->> 'response'), 1) = '{'
        ORDER BY e.created_at`,
      [scopeIds]
    );

    const hkId = hk.rows[0]?.id ?? null;
    const thId = existing.rows[0].id;
    const isHk = (s) => /\(\s*(hong kong|hk)\s*\)/i.test(s ?? '');

    for (const r of all.rows) {
      const expectedId = isHk(r.issuer) ? hkId : thId;
      // 香港記錄尚未建立時，香港文件無處可去 —— 不列入待修正，交由建立步驟先完成
      if (!expectedId) continue;
      if (r.current_company_id !== expectedId) {
        reconcile.rows.push({ ...r, expected_company_id: expectedId });
      } else {
        stayingCount += 1;
      }
    }
  }

  return {
    existing: existing.rows[0] ?? null,
    hk: hk.rows[0] ?? null,
    misgrouped: reconcile.rows,
    stayingCount,
  };
}

function report(state) {
  line();
  console.log('【現況】');
  line();

  if (state.existing) {
    console.log(`既有記錄  : ${state.existing.name}`);
    console.log(`   id     : ${state.existing.id}`);
    console.log(`   code   : ${state.existing.code ?? '(無)'}   status: ${state.existing.status}`);
    console.log(`   variants: ${(state.existing.name_variants ?? []).join(' || ') || '(空)'}`);
  } else {
    console.log(`🔴 找不到既有記錄「${EXISTING_NAME}」—— 資料與預期不符，請先查證`);
  }

  console.log('');
  if (state.hk) {
    console.log(`香港記錄  : 已存在 ✅`);
    console.log(`   id     : ${state.hk.id}   status: ${state.hk.status}`);
    console.log(`   variants: ${(state.hk.name_variants ?? []).join(' || ') || '(空)'}`);
  } else {
    console.log(`香港記錄  : 尚未建立（本次將新增「${HK_NAME}」）`);
  }

  console.log('');
  console.log(`歸屬待修正的提取結果: ${state.misgrouped.length} 筆`);
  for (const r of state.misgrouped) {
    const to = r.expected_company_id === state.hk?.id ? HK_NAME : EXISTING_NAME;
    console.log(`   ${r.extracted_at.toISOString().slice(0, 16)}  ${r.file_name}`);
    console.log(`       發票原文: ${r.issuer}`);
    console.log(`       ${r.current_company}  →  ${to}`);
  }
  console.log('');
  console.log(`歸屬已正確的提取結果: ${state.stayingCount} 筆`);
  line();
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 未設定');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const state = await loadState(client);
    report(state);

    if (mode === 'inspect') {
      console.log('（inspect 只讀，未做任何變更）');
      return;
    }

    // 冪等：已存在且 variants 已齊 → 無事可做
    const needCreate = !state.hk;
    const curVariants = state.hk ? (state.hk.name_variants ?? []) : [];
    const lower = new Set(curVariants.map((v) => String(v).toLowerCase()));
    const missingVariants = HK_VARIANTS.filter((v) => !lower.has(v.toLowerCase()));

    // 泰國側：既有記錄也必須在 Step 2a 精確命中，否則會被香港記錄從 2b 搶走
    if (!state.existing) throw new Error(`找不到既有記錄「${EXISTING_NAME}」`);
    const thCur = state.existing.name_variants ?? [];
    const thLower = new Set(thCur.map((v) => String(v).toLowerCase()));
    const missingTh = TH_VARIANTS.filter((v) => !thLower.has(v.toLowerCase()));

    console.log('【計畫】');
    line();
    if (needCreate) {
      console.log(`1. 新增公司「${HK_NAME}」（status=ACTIVE）`);
      console.log(`   nameVariants: ${HK_VARIANTS.length} 項`);
      HK_VARIANTS.forEach((v) => console.log(`      - ${v}`));
    } else if (missingVariants.length) {
      console.log(`1. 公司已存在，補 ${missingVariants.length} 項 nameVariants（只增不減）`);
      missingVariants.forEach((v) => console.log(`      + ${v}`));
    } else {
      console.log('1. 公司已存在且 nameVariants 已齊 —— 跳過（冪等）');
    }

    if (missingTh.length) {
      console.log(`1b. 既有記錄「${EXISTING_NAME}」補 ${missingTh.length} 項泰國 nameVariants`);
      console.log('    （必要：否則泰國文件會被香港記錄從 Step 2b 搶走）');
      missingTh.forEach((v) => console.log(`      + ${v}`));
    } else {
      console.log('1b. 既有記錄的泰國 nameVariants 已齊 —— 跳過（冪等）');
    }

    // 1c. 交叉污染清除
    //
    // CHANGE-103 的學習迴路（learnNameVariant）會在匹配成立時把 GPT 這次的印法
    // 回寫進該公司的 nameVariants。當文件被**歸錯**時，錯誤印法就跟著寫進錯誤的
    // 公司 —— 實測到香港記錄被寫入了 'Toll Global Forwarding (Thailand) Limited'。
    //
    // 留著它，泰國發票日後會在 Step 2a 精確命中香港記錄。必須移除。
    const hkPollution = (state.hk?.name_variants ?? []).filter((v) => /thailand/i.test(v));
    const thPollution = (state.existing?.name_variants ?? []).filter((v) =>
      /\(\s*(hong kong|hk)\s*\)/i.test(v)
    );

    if (hkPollution.length || thPollution.length) {
      console.log('1c. 🔴 清除交叉污染的 nameVariants（學習迴路在誤歸當下寫入的）');
      hkPollution.forEach((v) => console.log(`      − 香港記錄移除: ${v}`));
      thPollution.forEach((v) => console.log(`      − 既有記錄移除: ${v}`));
    } else {
      console.log('1c. 無交叉污染 —— 跳過');
    }

    if (doReassign) {
      const toHk = state.misgrouped.filter((r) => r.expected_company_id === state.hk?.id).length;
      const toTh = state.misgrouped.length - toHk;
      console.log(`2. --reassign：依發票原文重新歸屬 ${state.misgrouped.length} 筆（雙向）`);
      console.log(`   → ${HK_NAME}: ${toHk} 筆`);
      console.log(`   → ${EXISTING_NAME}: ${toTh} 筆`);
      console.log('   ⚠️ 改 company_id 不會重新提取，既有 extraction 內容不變');
    } else {
      console.log(`2. 既有 ${state.misgrouped.length} 筆歸屬**不動**（未帶 --reassign）`);
    }
    line();

    if (mode === 'dryrun') {
      console.log('（dryrun 只讀，未做任何變更。確認無誤後以 write 執行）');
      return;
    }

    // ---- write ----
    const hasPollution = hkPollution.length > 0 || thPollution.length > 0;
    if (!needCreate && !missingVariants.length && !missingTh.length && !hasPollution && !doReassign) {
      console.log('已是目標狀態，無需寫入。');
      return;
    }

    // 措施 1：前置快照（唯一還原依據）
    if (!fs.existsSync(SCRATCH)) fs.mkdirSync(SCRATCH, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapPath = path.join(SCRATCH, `before-${stamp}.json`);
    fs.writeFileSync(snapPath, JSON.stringify(state, null, 2));
    console.log(`前置快照已寫入: ${snapPath}`);

    // 措施 2：單一交易
    await client.query('BEGIN');
    try {
      let hkId = state.hk?.id;

      if (needCreate) {
        const creator = await client.query(
          `SELECT created_by_id FROM companies WHERE name = $1`,
          [EXISTING_NAME]
        );
        if (!creator.rows.length) throw new Error(`取不到既有記錄的 created_by_id`);

        const ins = await client.query(
          `INSERT INTO companies
             (id, name, display_name, code, type, status, source,
              name_variants, priority, default_confidence,
              created_by_id, created_at, updated_at)
           VALUES
             (gen_random_uuid()::text, $1, $1, NULL, 'FORWARDER', 'ACTIVE', 'MANUAL',
              $2::text[], 0, 0.8, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           RETURNING id`,
          [HK_NAME, HK_VARIANTS, creator.rows[0].created_by_id]
        );
        gate(ins.rowCount, 1, '新增香港公司'); // 措施 3：數量閘
        hkId = ins.rows[0].id;
        console.log(`✅ 已建立公司 ${HK_NAME} → ${hkId}`);
      } else if (missingVariants.length) {
        // 措施 4：樂觀鎖（updated_at 必須與讀取當下相同）
        const upd = await client.query(
          `UPDATE companies
              SET name_variants = (
                    SELECT array_agg(DISTINCT v)
                      FROM unnest(coalesce(name_variants, '{}'::text[]) || $2::text[]) AS v
                  ),
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND updated_at = $3`,
          [state.hk.id, missingVariants, state.hk.updated_at]
        );
        gate(upd.rowCount, 1, '補 nameVariants（樂觀鎖）');
        console.log(`✅ 已補 ${missingVariants.length} 項 nameVariants`);
      }

      if (missingTh.length) {
        // 措施 4：樂觀鎖
        const updTh = await client.query(
          `UPDATE companies
              SET name_variants = (
                    SELECT array_agg(DISTINCT v)
                      FROM unnest(coalesce(name_variants, '{}'::text[]) || $2::text[]) AS v
                  ),
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND updated_at = $3`,
          [state.existing.id, missingTh, state.existing.updated_at]
        );
        gate(updTh.rowCount, 1, '補泰國 nameVariants（樂觀鎖）');
        console.log(`✅ 既有記錄已補 ${missingTh.length} 項泰國 nameVariants`);
      }

      // 1c：清除交叉污染（在補 variants 之後跑，確保移除的不會又被加回）
      if (hkPollution.length) {
        const c1 = await client.query(
          `UPDATE companies
              SET name_variants = array(
                    SELECT v FROM unnest(coalesce(name_variants, '{}'::text[])) AS v
                     WHERE v <> ALL($2::text[])
                  ),
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [state.hk.id, hkPollution]
        );
        gate(c1.rowCount, 1, '清除香港記錄的污染 variants');
        console.log(`✅ 香港記錄已移除 ${hkPollution.length} 項污染 variants`);
      }
      if (thPollution.length) {
        const c2 = await client.query(
          `UPDATE companies
              SET name_variants = array(
                    SELECT v FROM unnest(coalesce(name_variants, '{}'::text[])) AS v
                     WHERE v <> ALL($2::text[])
                  ),
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [state.existing.id, thPollution]
        );
        gate(c2.rowCount, 1, '清除既有記錄的污染 variants');
        console.log(`✅ 既有記錄已移除 ${thPollution.length} 項污染 variants`);
      }

      if (doReassign && state.misgrouped.length) {
        // 依 expected_company_id 分組 —— 雙向都可能有（香港被留在泰國、泰國被搶到香港）
        const byTarget = new Map();
        for (const r of state.misgrouped) {
          const t = r.expected_company_id;
          if (!byTarget.has(t)) byTarget.set(t, { docIds: [], extIds: [] });
          byTarget.get(t).docIds.push(r.document_id);
          byTarget.get(t).extIds.push(r.extraction_id);
        }

        for (const [targetId, g] of byTarget) {
          const label = targetId === hkId ? HK_NAME : EXISTING_NAME;

          const u1 = await client.query(
            `UPDATE documents SET company_id = $1, updated_at = CURRENT_TIMESTAMP
              WHERE id = ANY($2::text[])`,
            [targetId, g.docIds]
          );
          gate(u1.rowCount, g.docIds.length, `documents 重新歸屬 → ${label}`);

          const u2 = await client.query(
            `UPDATE extraction_results SET company_id = $1, updated_at = CURRENT_TIMESTAMP
              WHERE id = ANY($2::text[])`,
            [targetId, g.extIds]
          );
          gate(u2.rowCount, g.extIds.length, `extraction_results 重新歸屬 → ${label}`);

          console.log(`✅ → ${label}：${g.docIds.length} 份文件 / ${g.extIds.length} 筆提取結果`);
        }
      }

      await client.query('COMMIT');
      console.log('\n交易已提交。');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('\n🔴 寫入失敗，已回滾:', e.message);
      console.error(`   還原依據: ${snapPath}`);
      process.exitCode = 1;
      return;
    }

    // 事後複查
    const after = await loadState(client);
    console.log('');
    console.log('【寫入後複查】');
    report(after);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
