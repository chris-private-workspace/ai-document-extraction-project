/**
 * @fileoverview FIX-150：收窄 NEHK 的 bl_fee alias，並讓 nehk_bl_fee 有去處
 * @description
 *   兩項變更必須同一次完成，缺一則情況更糟：
 *
 *   1. `Nippon Express Logistics (HK) - 自訂費用欄位集` 的 `bl_fee` aliases 清空。
 *      現值 ["B/L FEE","BL FEE"] 會與 `nehk_bl_fee` 的 "NEHK B/L FEE" 混淆 —— aliases
 *      直接注入 Stage 3 prompt（stage-3-extraction.service.ts:1279-1301），GPT 看到
 *      兩個都帶 "B/L FEE" 的候選而搖擺，實測 28 份 NEHK 文件中 2 份錯填 bl_fee、
 *      1 份兩者都填。確定性回填不受影響（matchLabel 的長度閘擋掉了 6 字元的 "bl fee"）。
 *
 *   2. NEHK Inbound 的 `docs_fee` 來源由 `bl_fee` 改為 `nehk_bl_fee`。
 *      收窄 alias 後 bl_fee 將不再有值，若不改這條規則，docs_fee 會完全空轉，而
 *      nehk_bl_fee（26 份 / 17,680）仍無去處 —— 比現況更差。
 *
 *   NEHK 是純進口公司（出口 0 份 / 進口 41 份），只用 Inbound 模板，故不動 Outbound。
 *
 *   ⚠️ 這兩張表都沒有 rollback 機制，故採三段式 gated 流程：
 *     node narrow-nehk-blfee-alias.js inspect   # 只讀，印出現況
 *     node narrow-nehk-blfee-alias.js dryrun    # 只讀，印出 before/after
 *     node narrow-nehk-blfee-alias.js write     # 實際寫入（單一交易 + 數量閘 + 樂觀鎖）
 *
 *   ⚠️ 改設定不回溯既有提取結果。已錯配的文件需重新處理才會更正；模板實例需重新
 *      匹配才會反映。動手前後請各跑一次 scripts/check-orphan-charge-keys.js 比對。
 *
 *   本檔為 node 14 相容的 CommonJS（Azure Kudu 的 node 是 v14.19.2，且 runner 映像
 *   不含 tsx，見 memory feedback_azure_runner_excludes_scripts_tsx）。
 *
 * @module scripts/fix-150/narrow-nehk-blfee-alias
 * @since FIX-150
 * @lastModified 2026-07-31
 */
try {
  var path = require('path');
  var dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
  dotenv.config({ path: path.join(__dirname, '..', '..', '.env.local'), override: true });
} catch (e) {
  /* Azure 容器內無 dotenv，環境變數已由平台提供 */
}

var Client = require(process.env.PG_MODULE_PATH || 'pg').Client;

var MODE = process.argv[2] || 'inspect';
var NEHK = '7b6a2886-945e-4ea2-8463-0ec6fc2c71c7';
var DEFSET = 'Nippon Express Logistics (HK) - 自訂費用欄位集';

var CONN = process.env.DATABASE_URL || '';
var IS_LOCAL = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);
var client = new Client({ connectionString: CONN, ssl: IS_LOCAL ? false : { rejectUnauthorized: false } });

var plan = { defset: null, mapping: null };

client
  .connect()
  .then(function () {
    return client.query(
      'SELECT id, name, fields, updated_at FROM field_definition_sets WHERE company_id = $1 AND name = $2',
      [NEHK, DEFSET]
    );
  })
  .then(function (res) {
    console.log('模式: ' + MODE);
    console.log('');
    console.log('=== 1. 欄位定義集 ===');
    if (res.rows.length !== 1) {
      console.log('🔴 預期剛好 1 筆欄位定義集，實際 ' + res.rows.length + ' 筆 —— 中止');
      process.exitCode = 1;
      return null;
    }
    var row = res.rows[0];
    var fields = row.fields || [];
    var bl = null;
    var nehk = null;
    fields.forEach(function (f) {
      if (f.key === 'bl_fee') bl = f;
      if (f.key === 'nehk_bl_fee') nehk = f;
    });
    if (!bl || !nehk) {
      console.log('🔴 找不到 bl_fee 或 nehk_bl_fee —— 中止');
      process.exitCode = 1;
      return null;
    }
    console.log('  bl_fee       "' + bl.label + '"  aliases=' + JSON.stringify(bl.aliases || []));
    console.log('  nehk_bl_fee  "' + nehk.label + '"  aliases=' + JSON.stringify(nehk.aliases || []));

    if (!(bl.aliases || []).length) {
      console.log('  → bl_fee aliases 已為空，無需變更');
    } else {
      console.log('  → 變更：bl_fee aliases ' + JSON.stringify(bl.aliases) + ' → []');
      var nextFields = fields.map(function (f) {
        if (f.key !== 'bl_fee') return f;
        var copy = JSON.parse(JSON.stringify(f));
        copy.aliases = [];
        return copy;
      });
      plan.defset = { id: row.id, fields: nextFields, updatedAt: row.updated_at, before: bl.aliases };
    }

    return client.query(
      'SELECT tfm.id, tfm.name, tfm.mappings, tfm.updated_at, dt.name AS tname' +
        '  FROM template_field_mappings tfm' +
        '  JOIN data_templates dt ON dt.id = tfm.data_template_id' +
        " WHERE tfm.company_id = $1 AND dt.name ILIKE '%Inbound%' AND tfm.is_active = true",
      [NEHK]
    );
  })
  .then(function (res) {
    if (!res) return null;
    console.log('');
    console.log('=== 2. NEHK Inbound 映射 ===');
    if (res.rows.length !== 1) {
      console.log('🔴 預期剛好 1 筆啟用中的 Inbound 映射，實際 ' + res.rows.length + ' 筆 —— 中止');
      process.exitCode = 1;
      return null;
    }
    var row = res.rows[0];
    var rules = row.mappings || [];
    var docsFee = null;
    rules.forEach(function (m) { if (m.targetField === 'docs_fee') docsFee = m; });
    if (!docsFee) {
      console.log('🔴 找不到 docs_fee 規則 —— 中止');
      process.exitCode = 1;
      return null;
    }
    console.log('  現況：docs_fee <- ' + docsFee.sourceField + ' [' + docsFee.transformType + ']');

    // 防呆：nehk_bl_fee 不得已被**其他**規則消費，否則會造成同一筆錢兩處落地。
    // 需排除 docs_fee 自己 —— 寫入後它正是預期的消費者，否則重跑會誤判為衝突。
    var consumers = rules.filter(function (m) {
      if (m.targetField === 'docs_fee') return false;
      var f = m.transformParams && m.transformParams.formula ? m.transformParams.formula : m.sourceField;
      return String(f).indexOf('nehk_bl_fee') >= 0;
    });
    if (consumers.length) {
      console.log('  🔴 nehk_bl_fee 已被其他規則消費（' +
        consumers.map(function (m) { return m.targetField; }).join(', ') + '）—— 中止，避免重複計算');
      process.exitCode = 1;
      return null;
    }

    if (docsFee.sourceField === 'nehk_bl_fee') {
      console.log('  → 已是目標狀態，無需變更');
    } else {
      console.log('  → 變更：docs_fee <- nehk_bl_fee [DIRECT]');
      var next = rules.map(function (m) {
        if (m.targetField !== 'docs_fee') return m;
        var copy = JSON.parse(JSON.stringify(m));
        copy.sourceField = 'nehk_bl_fee';
        copy.transformType = 'DIRECT';
        copy.transformParams = null;
        copy.description =
          'FIX-150：改由 nehk_bl_fee 供給（使用者 2026-07-31 決定）。' +
          '原 sourceField 為 bl_fee，但 NEHK 全部 28 份文件的原文皆為「NEHK B/L FEE - FCL」，' +
          '會命中 nehk_bl_fee；bl_fee 僅在 GPT 混淆時誤填（2 份），本次已同步清空其 aliases。';
        return copy;
      });
      plan.mapping = { id: row.id, name: row.name, mappings: next, updatedAt: row.updated_at, before: docsFee.sourceField };
    }

    console.log('');
    if (!plan.defset && !plan.mapping) {
      console.log('無待變更項目。');
      return null;
    }
    console.log('待變更：' + (plan.defset ? '欄位定義集 1 筆 ' : '') + (plan.mapping ? '映射 1 筆' : ''));

    if (MODE !== 'write') {
      console.log('（' + MODE + ' 模式，未寫入）');
      if (MODE === 'dryrun') console.log('確認無誤後執行: node ' + __filename.split(/[\\/]/).pop() + ' write');
      return null;
    }

    console.log('');
    console.log('=== 前置快照（唯一還原依據）===');
    if (plan.defset) console.log('  bl_fee.aliases = ' + JSON.stringify(plan.defset.before));
    if (plan.mapping) console.log('  docs_fee.sourceField = ' + JSON.stringify(plan.mapping.before));
    console.log('');
    console.log('開始寫入（單一交易，樂觀鎖）...');

    return client
      .query('BEGIN')
      .then(function () {
        if (!plan.defset) return null;
        return client
          .query(
            'UPDATE field_definition_sets SET fields = $1::jsonb, updated_at = NOW()' +
              ' WHERE id = $2 AND updated_at = $3',
            [JSON.stringify(plan.defset.fields), plan.defset.id, plan.defset.updatedAt]
          )
          .then(function (r) {
            if (r.rowCount !== 1) throw new Error('欄位定義集預期更新 1 列，實際 ' + r.rowCount + '（可能已被他人修改）');
            console.log('  ✅ 欄位定義集：bl_fee aliases 已清空');
          });
      })
      .then(function () {
        if (!plan.mapping) return null;
        return client
          .query(
            'UPDATE template_field_mappings SET mappings = $1::jsonb, updated_at = NOW()' +
              ' WHERE id = $2 AND updated_at = $3',
            [JSON.stringify(plan.mapping.mappings), plan.mapping.id, plan.mapping.updatedAt]
          )
          .then(function (r) {
            if (r.rowCount !== 1) throw new Error('映射預期更新 1 列，實際 ' + r.rowCount + '（可能已被他人修改）');
            console.log('  ✅ 映射：docs_fee <- nehk_bl_fee');
          });
      })
      .then(function () { return client.query('COMMIT'); })
      .then(function () {
        console.log('已提交。');
        console.log('');
        console.log('後續必要步驟：');
        console.log('  1. 重新處理 NEHK 已錯配的文件（改設定不回溯既有提取結果）');
        console.log('  2. 重新匹配模板實例');
        console.log('  3. 跑 check-orphan-charge-keys.js --baseline=<動手前的基線> 確認漏額下降');
      })
      .catch(function (e) {
        console.log('🔴 寫入失敗，回滾: ' + e.message);
        process.exitCode = 1;
        return client.query('ROLLBACK');
      });
  })
  .then(function () { return client.end(); })
  .catch(function (e) {
    console.log('ERROR: ' + e.message);
    process.exitCode = 1;
    try { client.end(); } catch (_) { /* 連線已關閉 */ }
  });
