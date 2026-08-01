/**
 * @fileoverview FIX-143 收尾：把本機 Nippon `vat_7` 的 fieldType 由 lineItem 改為 standard
 * @description
 *   FIX-143 只在 Azure DEV 執行（見該文件 §執行方式），本機未同步：
 *
 *     Azure DEV : vat_7.fieldType = 'standard'  ✅
 *     本機      : vat_7.fieldType = 'lineItem'  ❌
 *
 *   `lineItem` 型欄位只有兩條填值路徑，且兩條都限定明細行（prompt 的 charge field keys
 *   清單 + `backfillLineItemCharges`）。Nippon 的 VAT 印在總金額下方的 summary 區，
 *   不會出現在 lineItems，因此該欄位在本機永遠取不到值。
 *
 *   ⚠️ **不因為「Azure 改了所以本機也要改」就動手**。`lineItem` ↔ `standard` 是會反轉
 *      方向的修正：若 VAT 其實印在明細行內（CEVA / DSV / Toll 即如此），改為 standard
 *      會讓該欄位退出確定性回填，反而弄壞正常運作的欄位。故 `inspect` 模式一併輸出
 *      本機的 VAT 位置證據（lineItems 有無 VAT 項、subtotal + vat 是否閉合到 total），
 *      必須先確認證據支持「VAT 在 summary 區」才可進入 write。
 *      見 memory feedback_same_type_claim_needs_data_check。
 *
 *   ⚠️ `field_definition_sets` 無 audit log、無 rollback 機制，故採三段式 gated 流程：
 *     node scripts/fix-143/sync-local-vat7-fieldtype.js inspect   # 只讀，印現況 + 證據
 *     node scripts/fix-143/sync-local-vat7-fieldtype.js dryrun    # 只讀，印 before/after
 *     node scripts/fix-143/sync-local-vat7-fieldtype.js write     # 實際寫入
 *
 *   write 帶五項保護：前置快照（唯一還原依據）／單一交易／數量閘／樂觀鎖／冪等。
 *
 *   ⚠️ 改設定不回溯既有提取結果。已提取的文件需**重新處理**才會取得 VAT；
 *      而重新處理會**覆蓋**上一次的提取結果（`extraction_results.document_id` 唯一約束，
 *      系統無提取歷史 —— 見 CHANGE-114）。重跑前請先確認不會銷毀診斷用的唯一證據。
 *
 *   本檔為 node 14 相容的 CommonJS。
 *
 * @module scripts/fix-143/sync-local-vat7-fieldtype
 * @since FIX-143（收尾：本機同步）
 * @lastModified 2026-08-01
 */
try {
  var path = require('path');
  var dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
  dotenv.config({ path: path.join(__dirname, '..', '..', '.env.local'), override: true });
} catch (e) {
  /* 容器內無 dotenv，環境變數由平台提供 */
}

var fs = require('fs');
var nodePath = require('path');
var Client = require(process.env.PG_MODULE_PATH || 'pg').Client;

var MODE = process.argv[2] || 'inspect';
var VALID_MODES = ['inspect', 'dryrun', 'write'];
var DEFSET_NAME = 'Nippon Express Logistics - 自訂費用欄位集';
var TARGET_KEY = 'vat_7';
var FROM_TYPE = 'lineItem';
var TO_TYPE = 'standard';

if (VALID_MODES.indexOf(MODE) < 0) {
  console.error('🔴 模式須為 inspect / dryrun / write，收到: ' + MODE);
  process.exit(1);
}

var CONN = process.env.DATABASE_URL || '';
var IS_LOCAL = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);
var client = new Client({
  connectionString: CONN,
  ssl: IS_LOCAL ? false : { rejectUnauthorized: false },
});

function hostOf(c) {
  var m = c.match(/@([^/:]+)/);
  return m ? m[1] : '(未知)';
}
function num(v) {
  if (v === null || v === undefined) return null;
  var n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}
function fieldValue(fm, key) {
  var e = fm && fm[key];
  if (e === null || e === undefined) return null;
  return num(typeof e === 'object' ? e.value : e);
}

var plan = null;

client
  .connect()
  .then(function () {
    console.log('模式: ' + MODE);
    console.log('連線: ' + hostOf(CONN) + (IS_LOCAL ? '  [本機]' : '  [遠端]'));
    console.log('');
    console.log('=== 1. 欄位定義集現況 ===');
    return client.query(
      'SELECT id, name, company_id, is_active, fields, updated_at' +
        '  FROM field_definition_sets WHERE name = $1',
      [DEFSET_NAME]
    );
  })
  .then(function (res) {
    // 數量閘 1：欄位定義集必須剛好 1 筆
    if (res.rows.length !== 1) {
      console.log('🔴 預期剛好 1 個「' + DEFSET_NAME + '」，實際 ' + res.rows.length + ' 個 —— 中止');
      process.exitCode = 1;
      return null;
    }

    var row = res.rows[0];
    var fields = row.fields || [];
    var targets = fields.filter(function (f) { return f.key === TARGET_KEY; });

    // 數量閘 2：目標欄位必須剛好 1 個
    if (targets.length !== 1) {
      console.log('🔴 預期剛好 1 個 `' + TARGET_KEY + '` 欄位，實際 ' + targets.length + ' 個 —— 中止');
      process.exitCode = 1;
      return null;
    }

    var target = targets[0];
    var current = target.fieldType || 'standard';
    var lineItemCount = fields.filter(function (f) {
      return (f.fieldType || 'standard') === 'lineItem';
    }).length;

    console.log('  定義集 id : ' + row.id);
    console.log('  欄位總數  : ' + fields.length + '（其中 lineItem 型 ' + lineItemCount + '）');
    console.log('  ' + TARGET_KEY + ' : label="' + target.label + '"  fieldType=' + current +
                '  aliases=' + JSON.stringify(target.aliases || []));
    console.log('');

    // 冪等：已是目標狀態則不需變更
    if (current === TO_TYPE) {
      console.log('✅ ' + TARGET_KEY + ' 已是 ' + TO_TYPE + '，無需變更（冪等）');
    } else if (current !== FROM_TYPE) {
      console.log('🔴 ' + TARGET_KEY + ' 目前為 "' + current + '"，非預期的 "' + FROM_TYPE + '" —— 中止');
      process.exitCode = 1;
      return null;
    } else {
      console.log('→ 待變更：' + TARGET_KEY + '.fieldType  ' + FROM_TYPE + ' → ' + TO_TYPE);
      var nextFields = fields.map(function (f) {
        if (f.key !== TARGET_KEY) return f;
        var copy = JSON.parse(JSON.stringify(f));
        copy.fieldType = TO_TYPE;
        return copy;
      });
      plan = {
        id: row.id,
        updatedAt: row.updated_at,
        beforeFields: fields,
        nextFields: nextFields,
        beforeTarget: target,
      };
    }

    // ── 前提驗證：本機的 VAT 究竟印在哪？
    console.log('');
    console.log('=== 2. 前提驗證：VAT 在 summary 區還是明細行？ ===');
    return client.query(
      'SELECT d.file_name, er.field_mappings, er.stage_3_result->\'lineItems\' AS li, er.created_at' +
        '  FROM documents d JOIN extraction_results er ON er.document_id = d.id' +
        '  WHERE d.company_id = $1 ORDER BY er.created_at DESC',
      [res.rows[0].company_id]
    );
  })
  .then(function (res) {
    if (!res) return null;

    var total = res.rows.length;
    var withVat = 0;
    var vatInLineItems = 0;
    var closes = 0;
    var samples = [];

    res.rows.forEach(function (r) {
      var fm = r.field_mappings || {};
      var items = r.li || [];

      var vat = fieldValue(fm, TARGET_KEY);
      var hasVat = vat !== null && vat !== 0;
      if (hasVat) withVat++;

      var vatItems = items.filter(function (it) {
        return /\bvat\b|\btax\b|稅/i.test(String(it.description || '') + ' ' + String(it.category || ''));
      });
      if (vatItems.length) vatInLineItems++;

      var sub = fieldValue(fm, 'subtotal');
      var tot = fieldValue(fm, 'total_amount');
      // 關鍵判準：subtotal + vat == total → VAT 是 summary 區的獨立加項
      var closed = sub !== null && tot !== null && vat !== null &&
                   Math.abs(sub + vat - tot) < 0.02;
      if (closed && hasVat) closes++;

      if (hasVat && samples.length < 5) {
        var entry = fm[TARGET_KEY];
        samples.push({
          file: r.file_name,
          vat: vat,
          source: (entry && entry.source) || '(無)',
          confidence: (entry && entry.confidence) !== undefined ? entry.confidence : '(無)',
          sub: sub,
          tot: tot,
          closed: closed,
          vatItemCount: vatItems.length,
        });
      }
    });

    console.log('  該公司提取結果   : ' + total + ' 份');
    console.log('  ' + TARGET_KEY + ' 取到非零值 : ' + withVat + ' 份');
    console.log('  明細行含 VAT 項  : ' + vatInLineItems + ' 份   ← 若 > 0，改為 standard 會弄壞回填');
    console.log('  subtotal+vat=total : ' + closes + ' 份   ← 若 > 0，證明 VAT 是 summary 區的獨立加項');
    console.log('');
    samples.forEach(function (s) {
      console.log('  · ' + s.file);
      console.log('      ' + TARGET_KEY + '=' + s.vat + '  source=' + s.source + '  信心度=' + s.confidence);
      console.log('      subtotal=' + s.sub + '  total=' + s.tot +
                  '  閉合=' + (s.closed ? '是' : '否') + '  明細行 VAT 項=' + s.vatItemCount);
    });

    console.log('');
    console.log('  判定: ' +
      (vatInLineItems === 0
        ? '✅ 明細行無任何 VAT 項 —— 改為 standard 不會失去既有回填'
        : '🔴 明細行有 VAT 項（' + vatInLineItems + ' 份）—— 改為 standard 有風險，請人工複核'));

    if (!plan) return null;

    // ── dryrun / write
    console.log('');
    console.log('=== 3. 變更計畫 ===');
    console.log('  before: ' + JSON.stringify(plan.beforeTarget));
    var afterTarget = plan.nextFields.filter(function (f) { return f.key === TARGET_KEY; })[0];
    console.log('  after : ' + JSON.stringify(afterTarget));

    if (MODE !== 'write') {
      console.log('');
      console.log('（' + MODE + ' 模式，未寫入。確認無誤後執行 write）');
      return null;
    }

    if (vatInLineItems > 0) {
      console.log('');
      console.log('🔴 明細行存在 VAT 項，write 已中止 —— 需先人工確認 VAT 的實際位置');
      process.exitCode = 1;
      return null;
    }

    // 前置快照（唯一還原依據）
    var snapDir = nodePath.join(__dirname, 'snapshots');
    if (!fs.existsSync(snapDir)) fs.mkdirSync(snapDir, { recursive: true });
    var snapPath = nodePath.join(snapDir, 'local-vat7-before.json');
    fs.writeFileSync(
      snapPath,
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          host: hostOf(CONN),
          fieldDefinitionSetId: plan.id,
          name: DEFSET_NAME,
          updatedAt: plan.updatedAt,
          restoreHint: '把 fields 整段寫回該 id 即可還原',
          fields: plan.beforeFields,
        },
        null,
        2
      )
    );
    console.log('');
    console.log('  前置快照已寫出: ' + snapPath);

    // 單一交易 + 樂觀鎖 + rowCount 閘
    console.log('');
    console.log('=== 4. 寫入 ===');
    return client
      .query('BEGIN')
      .then(function () {
        return client.query(
          'UPDATE field_definition_sets SET fields = $1, updated_at = NOW()' +
            '  WHERE id = $2 AND updated_at = $3',
          [JSON.stringify(plan.nextFields), plan.id, plan.updatedAt]
        );
      })
      .then(function (r) {
        if (r.rowCount !== 1) {
          throw new Error('樂觀鎖失敗：rowCount=' + r.rowCount + '（預期 1）—— 期間可能已被他人修改');
        }
        return client.query('COMMIT');
      })
      .then(function () {
        console.log('  ✅ 已提交（rowCount=1）');
        // 回讀驗證
        return client.query('SELECT fields FROM field_definition_sets WHERE id = $1', [plan.id]);
      })
      .then(function (r) {
        var f = (r.rows[0].fields || []).filter(function (x) { return x.key === TARGET_KEY; })[0];
        var li = (r.rows[0].fields || []).filter(function (x) {
          return (x.fieldType || 'standard') === 'lineItem';
        }).length;
        console.log('  回讀: ' + TARGET_KEY + '.fieldType=' + (f.fieldType || 'standard') +
                    '  lineItem 型欄位數=' + li);
        console.log('');
        console.log('⚠️ 改設定不回溯既有提取結果 —— 需重新處理文件才會取得 VAT。');
        console.log('   但重新處理會覆蓋上一次的提取結果（無版本歷史，見 CHANGE-114）。');
      })
      .catch(function (e) {
        console.error('🔴 寫入失敗，執行 ROLLBACK: ' + e.message);
        process.exitCode = 1;
        return client.query('ROLLBACK').catch(function () {});
      });
  })
  .catch(function (e) {
    console.error('🔴 錯誤: ' + e.message);
    process.exitCode = 1;
  })
  .then(function () {
    return client.end();
  });
