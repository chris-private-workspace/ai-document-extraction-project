/**
 * 本地配置表備份（CHANGE-108 Phase 2 前置）
 *
 * 🔴 唯讀 —— 只有 SELECT。產出可完整還原的 JSON 快照。
 *
 * 備份範圍 = CHANGE-108 同步的 15 張配置表 + field_extraction_feedbacks。
 * 後者不在同步清單內，但 field_definition_sets 的 CASCADE 會把它連帶刪除
 * （本地 408 筆），故必須一併備份才能還原。
 *
 * 依「不可逆資料操作前必先快照」紀律：整表取代前必須先跑本腳本。
 *
 * 用法：
 *   $env:DATABASE_URL='postgresql://postgres:postgres@localhost:5433/ai_document_extraction'
 *   node scripts/local-backup-config-tables.js <輸出路徑.json>
 *
 * 亦可被 local-import-azure-snapshot.js require 直接呼叫。
 */
'use strict';
const fs = require('fs');
const { Client } = require('pg');

/** 同步清單（與匯入腳本 PLAN 順序一致，父表先） */
const CONFIG_TABLES = [
  'companies',
  'document_formats',
  'mapping_rules',
  'prompt_configs',
  'prompt_variables',
  'exchange_rates',
  'field_definition_sets',
  'data_templates',
  'field_mapping_configs',
  'field_mapping_rules',
  'template_field_mappings',
  'template_instances',
  'template_instance_rows',
  'pipeline_configs',
  'reference_numbers',
];

/** 不在同步清單，但會被 CASCADE 連帶刪除 → 必須備份 */
const COLLATERAL_TABLES = ['field_extraction_feedbacks'];

/**
 * 備份指定 DB 的配置表到物件。
 * @param {import('pg').Client} client 已連線的 client
 * @param {(msg: string) => void} log
 */
async function buildBackup(client, log) {
  const backup = { _meta: { kind: 'local-config-backup' }, _tables: {} };
  const stats = [];

  for (const t of [...CONFIG_TABLES, ...COLLATERAL_TABLES]) {
    const r = await client.query(`select * from "${t}"`);
    backup._tables[t] = r.rows;
    stats.push({ table: t, rows: r.rows.length });
    if (log) log('  ✓ ' + t.padEnd(28) + String(r.rows.length).padStart(6) + ' 筆');
  }

  // 本地舊文件的公司關聯：整表取代會把 company_id 設 NULL（SET NULL），
  // 備份這份對照才能在匯入後依公司名稱重映射，或原樣還原。
  const docLinks = await client.query(
    `select d.id, d.file_name, d.company_id, c.name as company_name
       from documents d left join companies c on c.id = d.company_id
      where d.company_id is not null`
  );
  backup._docCompanyLinks = docLinks.rows;
  if (log) log('  ✓ documents→company 對照        ' + String(docLinks.rows.length).padStart(6) + ' 筆');

  const erLinks = await client.query(
    `select er.id, er.document_id, er.company_id, c.name as company_name
       from extraction_results er left join companies c on c.id = er.company_id
      where er.company_id is not null`
  );
  backup._erCompanyLinks = erLinks.rows;
  if (log) log('  ✓ extraction_results→company    ' + String(erLinks.rows.length).padStart(6) + ' 筆');

  backup._meta.tableStats = stats;
  return backup;
}

async function main() {
  const outPath = process.argv[2];
  if (!outPath) {
    console.error('用法：node scripts/local-backup-config-tables.js <輸出路徑.json>');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL 未設 — abort');
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    console.log('=== 本地配置表備份 ===');
    console.log('');
    const backup = await buildBackup(client, (m) => console.log(m));
    fs.writeFileSync(outPath, JSON.stringify(backup), 'utf8');
    const size = fs.statSync(outPath).size;
    console.log('');
    console.log('✅ 備份完成：' + outPath);
    console.log('   大小：' + (size / 1024 / 1024).toFixed(2) + ' MB');
  } finally {
    await client.end();
  }
}

module.exports = { CONFIG_TABLES, COLLATERAL_TABLES, buildBackup };

if (require.main === module) {
  main().catch((e) => {
    console.error('FAILED: ' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  });
}
