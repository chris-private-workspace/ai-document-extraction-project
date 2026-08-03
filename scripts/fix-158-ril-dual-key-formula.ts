/**
 * @fileoverview FIX-158 問題一 — RIL 的 handling_at_origin 改為 FORMULA 同時接兩個 key（三段式 gated）
 * @description
 *   `SBS INTERNATIONAL LOGISTICS - 自訂費用欄位集` 同時定義了兩個語意相同的欄位：
 *     air_local_charge_usa_origin            "(Air) Local Charge in USA (Origin Charge)"
 *     air_local_charge_in_usa_origin_charge  "Air local charge in usa origin charge"
 *   兩者都沒有 aliases，模型無從判斷該用哪個，於是每次自行決定。而 mapping 只引用後者，
 *   模型填前者時該規則取不到值 —— 實測 RIL_RCIM250313_22084 因此短少 1,355.07。
 *
 *   本腳本把該規則由 DIRECT 改為 FORMULA，兩個 key 都接。同一時間只會有一個有值，
 *   相加不會造成重複計費。**不動欄位定義** —— 依 §樣本 ≠ 母體 紀律，不因「看起來重複」
 *   就刪除既有定義。
 *
 *   ⚠️ 影響範圍僅 `template_field_mappings` 的單一一筆的單一一條規則。
 *
 *   依 CLAUDE.md §不可逆資料操作紀律採 inspect / dryrun / write 三段式，
 *   write 具備前置快照、單一交易、數量閘、樂觀鎖、冪等。
 *
 * @module scripts/fix-158-ril-dual-key-formula
 * @since FIX-158
 * @lastModified 2026-08-03
 *
 * @usage
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/fix-158-ril-dual-key-formula.ts inspect
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/fix-158-ril-dual-key-formula.ts dryrun
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/fix-158-ril-dual-key-formula.ts write
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/** 目標：SBS INTERNATIONAL LOGISTICS - Logistics Cost - Inbound Template (Full List) */
const TARGET_MAPPING_ID = 'cmrn8gbe1000101mlw86c4baw';
const EXPECTED_COMPANY_ID = '2bad90a8-2611-4c85-bb5a-2e381a1487f4';
const TARGET_RULE_ID = '1cwj_bz-628yROh9Rzo1t';

const KEY_A = 'air_local_charge_usa_origin';
const KEY_B = 'air_local_charge_in_usa_origin_charge';
const NEW_FORMULA = `{${KEY_A}} + {${KEY_B}}`;

interface MappingRule {
  id?: string;
  order?: number;
  isRequired?: boolean;
  description?: string;
  sourceField?: string;
  targetField?: string;
  transformType?: string;
  transformParams?: { formula?: string } | null;
}

type Mode = 'inspect' | 'dryrun' | 'write';

async function readTarget() {
  return prisma.templateFieldMapping.findUnique({ where: { id: TARGET_MAPPING_ID } });
}

function writeSnapshot(record: unknown): string {
  const dir = path.resolve(__dirname, '../.snapshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `fix-158-ril-mapping-before-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
  return file;
}

async function main() {
  const mode = (process.argv[2] ?? '') as Mode;
  if (!['inspect', 'dryrun', 'write'].includes(mode)) {
    console.error('用法: fix-158-ril-dual-key-formula.ts <inspect|dryrun|write>');
    process.exit(2);
  }

  console.log(`=== FIX-158 問題一 — 模式: ${mode} ===\n`);

  const record = await readTarget();
  if (!record) throw new Error(`找不到 template field mapping: ${TARGET_MAPPING_ID}`);

  // 身分驗證：確認改到的是預期那間公司的那一筆
  if (record.companyId !== EXPECTED_COMPANY_ID) {
    throw new Error(
      `companyId 不符：預期 ${EXPECTED_COMPANY_ID}，實際 ${record.companyId} —— 中止`,
    );
  }
  if (record.scope !== 'COMPANY') {
    throw new Error(`scope 不符：預期 COMPANY，實際 ${record.scope} —— 中止`);
  }

  const rules: MappingRule[] = Array.isArray(record.mappings)
    ? (record.mappings as unknown as MappingRule[])
    : [];

  console.log('=== 目標記錄 ===');
  console.log(`  id         : ${record.id}`);
  console.log(`  name       : ${record.name}`);
  console.log(`  scope      : ${record.scope}  companyId=${record.companyId}`);
  console.log(`  isActive   : ${record.isActive}   規則數 ${rules.length}`);
  console.log(`  updatedAt  : ${record.updatedAt.toISOString()}`);

  const idx = rules.findIndex((r) => r.id === TARGET_RULE_ID);
  if (idx < 0) {
    throw new Error(`在 mappings 中找不到規則 id=${TARGET_RULE_ID} —— 中止，需人工確認`);
  }
  const rule = rules[idx];

  console.log('\n=== 目標規則（現況）===');
  console.log(JSON.stringify(rule, null, 4));

  // 順帶檢查：兩個 key 是否真的都存在於該公司的欄位定義
  const sets = await prisma.fieldDefinitionSet.findMany({
    where: { companyId: EXPECTED_COMPANY_ID },
    select: { name: true, fields: true },
  });
  const definedKeys = new Set<string>();
  for (const s of sets) {
    for (const f of (Array.isArray(s.fields) ? s.fields : []) as Array<{ key?: string }>) {
      if (f?.key) definedKeys.add(f.key);
    }
  }
  console.log('\n=== 兩個來源 key 在欄位定義中的狀態 ===');
  for (const k of [KEY_A, KEY_B]) {
    console.log(`  ${definedKeys.has(k) ? '✅ 已定義' : '🔴 未定義'}  ${k}`);
  }
  if (!definedKeys.has(KEY_A) || !definedKeys.has(KEY_B)) {
    throw new Error('兩個 key 必須都已定義，否則新公式會引用不存在的欄位 —— 中止');
  }

  if (mode === 'inspect') {
    console.log('\n=== inspect 完成（未做任何寫入）===');
    return;
  }

  // 冪等：已是目標狀態則無動作
  if (rule.transformType === 'FORMULA' && rule.transformParams?.formula === NEW_FORMULA) {
    console.log('\n=== 已是目標狀態（規則已為預期的 FORMULA），無動作 ===');
    return;
  }

  // 數量閘（結構層）：目標規則必須恰好一條
  const matches = rules.filter((r) => r.id === TARGET_RULE_ID);
  if (matches.length !== 1) {
    throw new Error(`預期規則 id 出現 1 次，實際 ${matches.length} 次 —— 中止`);
  }
  if (rule.targetField !== 'handling_at_origin') {
    throw new Error(`規則的 targetField 預期為 handling_at_origin，實際 ${rule.targetField} —— 中止`);
  }

  const newRules = rules.map((r, i) =>
    i === idx
      ? {
          ...r,
          sourceField: KEY_A,
          transformType: 'FORMULA',
          transformParams: { formula: NEW_FORMULA },
        }
      : r,
  );

  console.log('\n=== 待執行變更 ===');
  console.log('  templateFieldMapping.update :: mappings（僅該條規則）');
  console.log(`      sourceField    : ${rule.sourceField}  ->  ${KEY_A}`);
  console.log(`      transformType  : ${rule.transformType}  ->  FORMULA`);
  console.log(`      transformParams: ${JSON.stringify(rule.transformParams)}  ->  {"formula":"${NEW_FORMULA}"}`);
  console.log(`      其餘 ${rules.length - 1} 條規則不變`);
  console.log(`      樂觀鎖比對 updated_at = ${record.updatedAt.toISOString()}`);
  console.log('\n=== 變更後的規則 ===');
  console.log(JSON.stringify(newRules[idx], null, 4));

  console.log('\n⚠️  影響範圍：僅此一筆 mapping 的此一條規則，其他公司與模板不受影響。');
  console.log('   既有 template instance 列不會自動更新，需重新匹配才反映。');

  if (mode === 'dryrun') {
    console.log('\n=== dryrun 完成（未做任何寫入）===');
    return;
  }

  const snapshotFile = writeSnapshot(record);
  console.log(`\n=== 前置快照已寫入: ${snapshotFile} ===`);

  await prisma.$transaction(async (tx) => {
    const r = await tx.templateFieldMapping.updateMany({
      // 樂觀鎖
      where: { id: TARGET_MAPPING_ID, updatedAt: record.updatedAt },
      data: { mappings: newRules as never },
    });
    // 數量閘
    if (r.count !== 1) {
      throw new Error(
        `數量閘失敗：影響 ${r.count} 列（預期 1）。可能是併發修改導致樂觀鎖不匹配 —— 交易回滾。`,
      );
    }
  });

  console.log('=== 交易提交完成 ===');

  const after = await readTarget();
  const afterRules = (Array.isArray(after?.mappings) ? after?.mappings : []) as unknown as MappingRule[];
  const afterRule = afterRules.find((r) => r.id === TARGET_RULE_ID);
  console.log('\n=== 寫入後現況 ===');
  console.log(`  updatedAt : ${after?.updatedAt.toISOString()}`);
  console.log(`  規則數    : ${afterRules.length}（變更前 ${rules.length}）`);
  console.log(JSON.stringify(afterRule, null, 4));
}

main()
  .catch((e) => {
    console.error('FAILED:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
