/**
 * @fileoverview FIX-149：修正 DHL Express 的 template field mapping
 * @description
 *   把 fuel surcharge 併入 express worldwide 的金額，並讓 doc / nondoc 分別對應
 *   doc fee 與 freight。只改 `template_field_mappings.mappings` 這一個 JSON 欄位，
 *   不動程式碼、schema、欄位定義集，也不碰其他公司。
 *
 *   ⚠️ `template_field_mappings` 沒有 rollback 機制，因此採三段式 gated 流程：
 *     node update-dhl-charge-mapping.js inspect   # 只讀，印出現況
 *     node update-dhl-charge-mapping.js dryrun    # 只讀，印出 before/after diff
 *     node update-dhl-charge-mapping.js write     # 實際寫入（單一交易 + 數量閘）
 *
 *   `write` 前會把現況完整印出來當作還原依據 —— 這是唯一的 rollback 手段。
 *
 *   本檔為 node 14 相容的 CommonJS（Azure 容器內 Kudu 的 node 是 v14.19.2，
 *   且 runner 映像不含 tsx，見 memory feedback_azure_runner_excludes_scripts_tsx）。
 *
 * @module scripts/fix-149/update-dhl-charge-mapping
 * @since FIX-149
 * @lastModified 2026-07-31
 */
// 本機執行需要從 .env 取 DATABASE_URL；Azure 容器由平台注入環境變數且映像不含
// dotenv，因此以 try/catch 包住 —— 兩種環境用同一支腳本。
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

/** 修正後 freight 的公式（fuel surcharge 併入 express worldwide） */
var FREIGHT_FORMULA = '{express_worldwide_nondoc} + {fuel_surcharge}';

/** freight 那條的新說明（保留 CHANGE-113 的脈絡，並記錄本次為何改變假設） */
var FREIGHT_DESC =
  'FIX-149：fuel surcharge 併入主運費，不再單獨成欄（使用者 2026-07-31 指示）。' +
  'CHANGE-113 原假設「同一 shipment 只會有 doc 或 nondoc 其中一種」故將兩者都加總進 freight；' +
  '本次改為 doc 走 doc fee、nondoc 走 freight，該假設不再適用。' +
  '仍用 FORMULA 而非 DIRECT：FORMULA 對缺值與 null 一律視為 0，' +
  '不受「來源 key 是缺席還是存在但為 null」影響。';

/** doc fee 那條的說明 */
var DOCFEE_DESC =
  'FIX-149：EXPRESS WORLDWIDE doc 整筆對應 doc fee（使用者 2026-07-31 指示）。' +
  '原先 doc 被加總進 freight，屬錯配。';

/**
 * 目標映射：模板名 → 如何由「現況」推導出「修正後」
 *
 * @description
 *   刻意不寫成整批替換的靜態陣列 —— 實際的 mapping 項目除了
 *   targetField / sourceField / transformType / transformParams 之外，還帶
 *   `id`（如 `eedf4065-i-1`，公司 ID 前 8 碼 + i/e + 序號）、`order`、
 *   `isRequired`、`description`。整批替換會把這四項連同 CHANGE-113 留下的
 *   設計理由一起抹掉，且 `id`/`order` 是否被下游依賴無法從此處確認。
 *   因此改為在現況上做精確增修。
 */
var PLAN = {
  'Logistics Cost - Inbound Template (Full List)': {
    idPrefix: 'i',
    docFeeTarget: 'docs_fee',
    dropTargets: ['fuel_surcharge_at_origin'],
  },
  'Logistics Cost - Outbound Template (Full List)': {
    idPrefix: 'e',
    docFeeTarget: 'document_fee',
    dropTargets: [],
  },
};

/**
 * 由現況推導修正後的 mappings（保留既有項目的 id / order / isRequired）
 *
 * @param current - 現況 mappings 陣列
 * @param plan - 該模板的變更計畫
 * @param companyId - 公司 ID（新項目的 id 前綴用）
 * @returns 修正後的 mappings 陣列
 */
function buildMappings(current, plan, companyId) {
  var shortId = String(companyId).slice(0, 8);
  var result = [];
  var maxOrder = -1;
  var hasFreight = false;
  var hasDocFee = false;

  (current || []).forEach(function (m) {
    if (plan.dropTargets.indexOf(m.targetField) !== -1) return; // 移除

    var next = JSON.parse(JSON.stringify(m)); // 保留 id / order / isRequired
    if (m.targetField === 'freight') {
      next.sourceField = 'express_worldwide_nondoc';
      next.transformType = 'FORMULA';
      next.transformParams = { formula: FREIGHT_FORMULA };
      next.description = FREIGHT_DESC;
      hasFreight = true;
    }
    if (m.targetField === plan.docFeeTarget) {
      next.sourceField = 'express_worldwide_doc';
      next.transformType = 'DIRECT';
      next.transformParams = null;
      next.description = DOCFEE_DESC;
      hasDocFee = true;
    }
    if (typeof next.order === 'number' && next.order > maxOrder) maxOrder = next.order;
    result.push(next);
  });

  if (!hasFreight) {
    maxOrder += 1;
    result.push({
      id: shortId + '-' + plan.idPrefix + '-' + maxOrder,
      order: maxOrder,
      isRequired: false,
      description: FREIGHT_DESC,
      sourceField: 'express_worldwide_nondoc',
      targetField: 'freight',
      transformType: 'FORMULA',
      transformParams: { formula: FREIGHT_FORMULA },
    });
  }
  if (!hasDocFee) {
    maxOrder += 1;
    result.push({
      id: shortId + '-' + plan.idPrefix + '-' + maxOrder,
      order: maxOrder,
      isRequired: false,
      description: DOCFEE_DESC,
      sourceField: 'express_worldwide_doc',
      targetField: plan.docFeeTarget,
      transformType: 'DIRECT',
      transformParams: null,
    });
  }
  return result;
}

function describe(list) {
  return (list || [])
    .map(function (m) {
      var f = m.transformParams && m.transformParams.formula ? '  formula=' + m.transformParams.formula : '';
      return '      ' + m.targetField + ' <- ' + m.sourceField + ' [' + m.transformType + ']' + f;
    })
    .join('\n');
}

// SSL 依連線目標自動判斷：本機 docker 的 PostgreSQL 不支援 SSL，Azure 私有端點需要。
// 刻意不用環境變數控制 —— 忘記設定會得到一個與 SSL 無關的錯誤訊息，難以聯想。
var CONN = process.env.DATABASE_URL || '';
var IS_LOCAL = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);

var client = new Client({
  connectionString: CONN,
  ssl: IS_LOCAL ? false : { rejectUnauthorized: false },
});

client
  .connect()
  .then(function () {
    return client.query(
      "SELECT tfm.id, tfm.name, tfm.is_active, tfm.mappings, tfm.company_id," +
        "       dt.name AS template_name, dt.fields AS template_fields" +
        "  FROM template_field_mappings tfm" +
        "  JOIN data_templates dt ON dt.id = tfm.data_template_id" +
        " WHERE tfm.company_id IN (SELECT id FROM companies WHERE name ILIKE '%DHL%')" +
        " ORDER BY dt.name"
    );
  })
  .then(function (res) {
    var rows = res.rows;
    console.log('模式: ' + MODE);
    console.log('找到 ' + rows.length + ' 筆 DHL template field mapping\n');

    var planned = [];
    rows.forEach(function (row) {
      var plan = PLAN[row.template_name];
      console.log('=== ' + row.template_name + ' ===');
      console.log('  mapping: ' + row.name + '  (active=' + row.is_active + ')');
      console.log('  現況:');
      console.log(describe(row.mappings) || '      (無)');

      if (!plan) {
        console.log('  → 不在本次修正範圍，跳過\n');
        return;
      }

      var next = buildMappings(row.mappings, plan, row.company_id);

      // 防呆：目標欄位必須真的存在於該模板，否則寫進去會靜默失效
      var names = (row.template_fields || []).map(function (f) { return f.name; });
      var missing = next
        .map(function (m) { return m.targetField; })
        .filter(function (t) { return names.indexOf(t) === -1; });
      if (missing.length) {
        console.log('  🔴 目標欄位不存在於模板: ' + missing.join(', ') + ' —— 中止');
        process.exitCode = 1;
        return;
      }

      console.log('  修正後:');
      console.log(describe(next));

      if (JSON.stringify(row.mappings) === JSON.stringify(next)) {
        console.log('  → 已是目標狀態，無需變更\n');
        return;
      }
      console.log('  → 需要變更（保留既有項目的 id/order/isRequired）\n');
      planned.push({ id: row.id, name: row.name, mappings: next });
    });

    if (process.exitCode === 1) {
      console.log('因目標欄位缺失而中止，未寫入任何資料。');
      return client.end();
    }

    if (MODE !== 'write') {
      console.log('待變更 ' + planned.length + ' 筆。（' + MODE + ' 模式，未寫入）');
      if (MODE === 'dryrun' && planned.length) {
        console.log('確認無誤後執行: node ' + __filename.split(/[\\/]/).pop() + ' write');
      }
      return client.end();
    }

    if (!planned.length) {
      console.log('無待變更項目，未寫入。');
      return client.end();
    }
    // 數量閘：本 FIX 最多只該動 2 筆（Inbound + Outbound）
    if (planned.length > 2) {
      console.log('🔴 待變更筆數 ' + planned.length + ' 超過預期上限 2，中止以免誤傷');
      process.exitCode = 1;
      return client.end();
    }

    console.log('開始寫入 ' + planned.length + ' 筆（單一交易）...');
    return client
      .query('BEGIN')
      .then(function () {
        return planned.reduce(function (chain, p) {
          return chain.then(function () {
            return client
              .query('UPDATE template_field_mappings SET mappings = $1::jsonb, updated_at = NOW() WHERE id = $2', [
                JSON.stringify(p.mappings),
                p.id,
              ])
              .then(function (r) {
                if (r.rowCount !== 1) throw new Error('預期更新 1 列，實際 ' + r.rowCount + '（' + p.name + '）');
                console.log('  ✅ ' + p.name);
              });
          });
        }, Promise.resolve());
      })
      .then(function () { return client.query('COMMIT'); })
      .then(function () { console.log('已提交。'); return client.end(); })
      .catch(function (e) {
        console.log('🔴 寫入失敗，回滾: ' + e.message);
        process.exitCode = 1;
        return client.query('ROLLBACK').then(function () { return client.end(); });
      });
  })
  .catch(function (e) {
    console.log('ERROR: ' + e.message);
    process.exitCode = 1;
    try { client.end(); } catch (_) { /* 連線已關閉 */ }
  });
