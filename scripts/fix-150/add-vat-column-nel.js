/**
 * @fileoverview FIX-150：VAT 獨立成欄，並只讓 NEL 填入
 * @description
 *   四項變更必須同一次完成，缺一則情況更糟：
 *
 *   1. `data_templates` 的 `Logistics Cost - Inbound Template (Full List)` 新增 `vat` 欄位。
 *   2. `data_templates` 的 `Logistics Cost - Outbound Template (Full List)` 新增 `vat` 欄位。
 *      🔴 這兩張是**共用模板**：Inbound 有 13 組映射、Outbound 有 30 組映射綁定，
 *      新增欄位會讓所有共用公司的匯出各多一欄（未設規則者為空）。
 *      兩張都要動，是因為帶 `vat_7` 的 89 份 NEL 文件分佈於兩張模板（Inbound 13、
 *      Outbound 59，另 17 份尚未加入任何實例）—— 只加一張會漏掉另一半。
 *
 *   3. `template_field_mappings` 的 NEL Inbound：新增 `vat <- vat_7`，
 *      並自 `handling` 的公式移除 `{vat_7}`。
 *   4. `template_field_mappings` 的 NEL Outbound：新增 `vat <- vat_7`，
 *      並自 `handling_charge` 的公式移除 `{vat_7}`。
 *
 *   若只新增規則而不從公式移除，同一筆 VAT 會在 `vat` 與 `handling` 兩處重複計算。
 *   若只移除而不新增欄位，VAT 金額會完全消失 —— 比現況更差。
 *
 *   **為何只改 NEL**：實查 Azure DEV，89 份帶 `vat_7` 的文件全部屬於
 *   `Nippon Express Logistics`，NEHK 一份都沒有。掛在 NEHK 名下的 Outbound 映射雖有
 *   `handling_charge <- {vat_7}+{handling_charge}`，但 NEHK 欄位集根本沒有 `vat_7`，
 *   屬 FIX-128 同型的死 key，本次不處理。
 *
 *   欄位刻意命名為 `vat` 而非 `vat_7`：FIX-143 已查證該發票 1617 / 65323 ≈ 2.5%，
 *   標籤與實際稅率並不一致，欄位名不宜綁定特定稅率。
 *
 *   ⚠️ 這兩張表都沒有 rollback 機制，故採三段式 gated 流程：
 *     node add-vat-column-nel.js inspect   # 只讀，印出現況
 *     node add-vat-column-nel.js dryrun    # 只讀，印出 before/after
 *     node add-vat-column-nel.js write     # 實際寫入（單一交易 + 數量閘 + 樂觀鎖）
 *
 *   ⚠️ 改設定不回溯既有的模板實例列，需重新匹配才會反映。動手前後請各跑一次
 *      scripts/check-orphan-charge-keys.js 與 scripts/snapshot-template-values.js 比對。
 *
 *   本檔為 node 14 相容的 CommonJS（Azure Kudu 的 node 是 v14.19.2，且 runner 映像
 *   不含 tsx，見 memory feedback_azure_runner_excludes_scripts_tsx）。
 *
 * @module scripts/fix-150/add-vat-column-nel
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

var crypto = require('crypto');
var Client = require(process.env.PG_MODULE_PATH || 'pg').Client;

var MODE = process.argv[2] || 'inspect';
var COMPANY = 'Nippon Express Logistics';
var TEMPLATES = [
  { key: 'Inbound', name: 'Logistics Cost - Inbound Template (Full List)', formulaTarget: 'handling' },
  { key: 'Outbound', name: 'Logistics Cost - Outbound Template (Full List)', formulaTarget: 'handling_charge' },
];
var VAT_FIELD = 'vat';
var VAT_LABEL = 'VAT';
var VAT_SOURCE = 'vat_7';

var CONN = process.env.DATABASE_URL || '';
var IS_LOCAL = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);
var client = new Client({ connectionString: CONN, ssl: IS_LOCAL ? false : { rejectUnauthorized: false } });

/** 只取主機名 —— 絕不印出帳密（H4） */
function dbHost() {
  var m = CONN.match(/@([^/:?]+)/);
  return m ? m[1] : '(未知)';
}

/** nanoid 相容的 21 字元 id（既有規則的 id 皆為此形態） */
var ALPHABET = 'useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict';
function newRuleId() {
  var bytes = crypto.randomBytes(21);
  var id = '';
  for (var i = 0; i < 21; i++) id += ALPHABET[bytes[i] % ALPHABET.length];
  return id;
}

/**
 * 自純加總公式中移除某個來源 token。
 * 僅接受「只含大括號、字母數字底線、加號、空白」的公式 —— 出現其他運算子即中止，
 * 避免在未預期的語法上做字串手術。
 */
function dropToken(formula, token) {
  if (!/^[\s{}\w+]+$/.test(formula)) return { ok: false, reason: '公式含非加總語法，拒絕自動修改' };
  var parts = formula.split('+').map(function (p) { return p.trim(); }).filter(function (p) { return p.length; });
  var kept = parts.filter(function (p) { return p !== '{' + token + '}'; });
  if (kept.length === parts.length) return { ok: false, reason: '公式中找不到 {' + token + '}' };
  if (!kept.length) return { ok: false, reason: '移除後公式為空' };
  var next = kept.join(' + ');
  if (next.indexOf(token) >= 0) return { ok: false, reason: '移除後仍殘留 ' + token };
  return { ok: true, formula: next };
}

var plan = { templates: [], mappings: [] };
var abort = false;

function fail(msg) {
  console.log('🔴 ' + msg + ' —— 中止');
  process.exitCode = 1;
  abort = true;
}

client
  .connect()
  .then(function () {
    console.log('模式: ' + MODE + '   資料庫主機: ' + dbHost());
    console.log('');
    return client.query("SELECT id, name FROM companies WHERE name = $1 AND status = 'ACTIVE'", [COMPANY]);
  })
  .then(function (res) {
    console.log('=== 0. 公司 ===');
    if (res.rows.length !== 1) return fail('預期剛好 1 間啟用中的「' + COMPANY + '」，實際 ' + res.rows.length + ' 間');
    console.log('  ' + res.rows[0].id + '  ' + res.rows[0].name);
    plan.companyId = res.rows[0].id;

    return client.query(
      'SELECT id, name, fields, updated_at FROM data_templates WHERE name = ANY($1)',
      [TEMPLATES.map(function (t) { return t.name; })]
    );
  })
  .then(function (res) {
    if (abort) return null;
    console.log('');
    console.log('=== 1. 資料模板（data_templates）—— 🔴 共用，影響所有綁定公司 ===');
    if (res.rows.length !== TEMPLATES.length) {
      return fail('預期剛好 ' + TEMPLATES.length + ' 張模板，實際 ' + res.rows.length + ' 張');
    }
    for (var i = 0; i < res.rows.length; i++) {
      var row = res.rows[i];
      var fields = row.fields || [];
      var maxOrder = fields.reduce(function (m, f) { return Math.max(m, Number(f.order) || 0); }, 0);
      var existing = fields.filter(function (f) { return f.name === VAT_FIELD; })[0];
      console.log('  ' + row.name);
      console.log('    欄位數=' + fields.length + '  最大 order=' + maxOrder);
      if (existing) {
        console.log('    → 已有 ' + VAT_FIELD + ' 欄位，無需變更');
        continue;
      }
      var field = { name: VAT_FIELD, label: VAT_LABEL, order: maxOrder + 1, dataType: 'number', isRequired: false };
      console.log('    → 變更：附加 ' + JSON.stringify(field) + '（不動既有 order，避免改變匯出欄序）');
      plan.templates.push({ id: row.id, name: row.name, fields: fields.concat([field]), updatedAt: row.updated_at });
    }

    return client.query(
      'SELECT tfm.id, tfm.name, tfm.mappings, tfm.updated_at, dt.name AS template' +
        '  FROM template_field_mappings tfm' +
        '  JOIN data_templates dt ON dt.id = tfm.data_template_id' +
        ' WHERE tfm.company_id = $1 AND tfm.is_active = true AND dt.name = ANY($2)',
      [plan.companyId, TEMPLATES.map(function (t) { return t.name; })]
    );
  })
  .then(function (res) {
    if (abort || !res) return null;
    console.log('');
    console.log('=== 2. 模板欄位映射（template_field_mappings）—— 只影響 ' + COMPANY + ' ===');

    // 逐模板判斷：真正危險的是「同一張模板有多組啟用映射」（無從得知哪組生效），
    // 而非「少了一組」—— 本機與 Azure 的設定資料獨立，本機可能尚未建立某一組。
    // 缺的那組明白印出並跳過，不擋住其餘變更。
    for (var t = 0; t < TEMPLATES.length; t++) {
      var hits = res.rows.filter(function (r) { return r.template === TEMPLATES[t].name; });
      if (hits.length > 1) {
        return fail('模板「' + TEMPLATES[t].name + '」有 ' + hits.length + ' 組啟用中的 ' + COMPANY + ' 映射，無從判斷哪組生效');
      }
      if (!hits.length) {
        console.log('  ⚠️ 模板「' + TEMPLATES[t].name + '」無啟用中的 ' + COMPANY + ' 映射 —— 跳過（該環境尚未建立）');
      }
    }
    if (!res.rows.length) return fail('找不到任何啟用中的 ' + COMPANY + ' 映射');

    for (var i = 0; i < res.rows.length; i++) {
      var row = res.rows[i];
      var spec = TEMPLATES.filter(function (t2) { return t2.name === row.template; })[0];
      var rules = row.mappings || [];
      console.log('  ' + row.name);
      console.log('    模板=' + row.template + '  規則數=' + rules.length);

      if (rules.some(function (m) { return m.targetField === VAT_FIELD; })) {
        console.log('    → 已有 ' + VAT_FIELD + ' 規則，無需變更');
        continue;
      }

      // 引用 vat_7 的規則必須剛好 1 條，否則移除後可能漏改或改錯
      var refs = rules.filter(function (m) {
        var f = m.transformParams && m.transformParams.formula ? m.transformParams.formula : m.sourceField;
        return String(f).indexOf(VAT_SOURCE) >= 0;
      });
      if (refs.length !== 1) {
        return fail('預期剛好 1 條規則引用 ' + VAT_SOURCE + '，實際 ' + refs.length + ' 條（' +
          refs.map(function (m) { return m.targetField; }).join(', ') + '）');
      }
      var ref = refs[0];
      if (ref.targetField !== spec.formulaTarget) {
        return fail('引用 ' + VAT_SOURCE + ' 的規則目標為 ' + ref.targetField + '，與預期的 ' + spec.formulaTarget + ' 不符');
      }
      var formula = ref.transformParams && ref.transformParams.formula;
      if (!formula) return fail(ref.targetField + ' 不是 FORMULA 型規則，無法移除 token');

      var dropped = dropToken(formula, VAT_SOURCE);
      if (!dropped.ok) return fail(ref.targetField + ' 公式無法安全修改：' + dropped.reason);

      var sample = rules.filter(function (m) { return m.transformType === 'DIRECT'; })[0];
      if (!sample) return fail('找不到可供比照結構的 DIRECT 規則');
      var maxOrder = rules.reduce(function (m, r) { return Math.max(m, Number(r.order) || 0); }, 0);

      var vatRule = JSON.parse(JSON.stringify(sample));
      vatRule.id = newRuleId();
      vatRule.order = maxOrder + 1;
      vatRule.isRequired = false;
      vatRule.sourceField = VAT_SOURCE;
      vatRule.targetField = VAT_FIELD;
      vatRule.transformType = 'DIRECT';
      vatRule.transformParams = null;
      vatRule.description =
        'FIX-150：VAT 獨立成欄（使用者 2026-07-31 決定只改 NEL）。' +
        '原本併入 ' + ref.targetField + ' 的公式，使用者在模板上看不到獨立的 VAT 欄位；' +
        '本次同步自該公式移除 {' + VAT_SOURCE + '}，避免同一筆金額重複計算。';

      var nextRules = rules.map(function (m) {
        if (m.targetField !== ref.targetField) return m;
        var copy = JSON.parse(JSON.stringify(m));
        copy.transformParams = Object.assign({}, copy.transformParams, { formula: dropped.formula });
        return copy;
      }).concat([vatRule]);

      console.log('    → 變更 1：新增 ' + VAT_FIELD + ' <- ' + VAT_SOURCE + ' [DIRECT]');
      console.log('    → 變更 2：' + ref.targetField + ' 公式');
      console.log('              舊: ' + formula);
      console.log('              新: ' + dropped.formula);
      plan.mappings.push({
        id: row.id,
        name: row.name,
        mappings: nextRules,
        updatedAt: row.updated_at,
        before: { targetField: ref.targetField, formula: formula },
      });
    }

    console.log('');
    if (!plan.templates.length && !plan.mappings.length) {
      console.log('無待變更項目。');
      return null;
    }
    console.log('待變更：資料模板 ' + plan.templates.length + ' 張、映射 ' + plan.mappings.length + ' 組');

    if (MODE !== 'write') {
      console.log('（' + MODE + ' 模式，未寫入）');
      if (MODE === 'dryrun') console.log('確認無誤後執行: node ' + __filename.split(/[\\/]/).pop() + ' write');
      return null;
    }

    console.log('');
    console.log('=== 前置快照（唯一還原依據）===');
    plan.templates.forEach(function (t) {
      console.log('  模板「' + t.name + '」原有 ' + (t.fields.length - 1) + ' 個欄位，無 ' + VAT_FIELD + ' —— 還原方式：移除該欄位');
    });
    plan.mappings.forEach(function (m) {
      console.log('  映射「' + m.name + '」');
      console.log('    ' + m.before.targetField + '.formula = ' + JSON.stringify(m.before.formula));
      console.log('    無 ' + VAT_FIELD + ' 規則 —— 還原方式：移除該規則並還原上述公式');
    });
    console.log('');
    console.log('開始寫入（單一交易，樂觀鎖）...');

    return client
      .query('BEGIN')
      .then(function () {
        return plan.templates.reduce(function (p, t) {
          return p.then(function () {
            return client
              .query(
                'UPDATE data_templates SET fields = $1::jsonb, updated_at = NOW() WHERE id = $2 AND updated_at = $3',
                [JSON.stringify(t.fields), t.id, t.updatedAt]
              )
              .then(function (r) {
                if (r.rowCount !== 1) throw new Error('模板「' + t.name + '」預期更新 1 列，實際 ' + r.rowCount + '（可能已被他人修改）');
                console.log('  ✅ 模板「' + t.name + '」新增 ' + VAT_FIELD + ' 欄位');
              });
          });
        }, Promise.resolve());
      })
      .then(function () {
        return plan.mappings.reduce(function (p, m) {
          return p.then(function () {
            return client
              .query(
                'UPDATE template_field_mappings SET mappings = $1::jsonb, updated_at = NOW() WHERE id = $2 AND updated_at = $3',
                [JSON.stringify(m.mappings), m.id, m.updatedAt]
              )
              .then(function (r) {
                if (r.rowCount !== 1) throw new Error('映射「' + m.name + '」預期更新 1 列，實際 ' + r.rowCount + '（可能已被他人修改）');
                console.log('  ✅ 映射「' + m.name + '」已加 ' + VAT_FIELD + ' 規則並清理公式');
              });
          });
        }, Promise.resolve());
      })
      .then(function () { return client.query('COMMIT'); })
      .then(function () {
        console.log('已提交。');
        console.log('');
        console.log('後續必要步驟：');
        console.log('  1. 重新匹配模板實例（改設定不回溯既有實例列）');
        console.log('  2. 跑 check-orphan-charge-keys.js --baseline=<動手前的基線> 確認未新增漏額');
        console.log('  3. 跑 snapshot-template-values.js diff 確認「有值變空白」為 0');
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
