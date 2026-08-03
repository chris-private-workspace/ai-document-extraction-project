/**
 * @fileoverview FIX-158 問題二 — 補上 CEVA LTD 缺少的四個欄位定義（三段式 gated）
 * @description
 *   `CEVA LOGISTICS (HONG KONG) LTD`（companyId 0d02b680-…）的 template field mapping
 *   引用了四個 key，但該公司的欄位定義集裡都沒有：
 *     handling      ← destination_truck_servicing_fee
 *     ebs           ← emergency_fuel_surcharge
 *     gate_charge   ← destination_gate_fee
 *     cfs           ← destination_cfs_charges
 *   欄位沒有定義 → 不會進 Stage 3 prompt → 模型不會抽取 → 規則永遠取不到值。
 *   使用者 2026-08-03 確認這些費用會出現在 CEVA 發票上，因此補定義而非刪規則。
 *
 *   **aliases 的取捨**（使用者授權由 AI 判斷，2026-08-03）：
 *   CEVA 現有欄位的 aliases 有一致模式 —— 皆為「X at Destination」格式，對應發票的
 *   另一種版面（資料佐證：同一筆 THC 在庫中同時以 "DESTINATION THC - TERMINAL HANDLING
 *   CHARGE" ×34 與 "Terminal Handling Charge at Destination" ×6 兩種寫法出現）。
 *   新欄位沿用此模式，並依全庫旁證補充業界通用寫法。
 *
 *   ⚠️ `destination_truck_servicing_fee` 刻意只給一個 alias —— CEVA 已有 `ftl_freight_truck`，
 *   若放寬泛的 "Truck" 字樣會與之互搶（FIX-150 的教訓）。
 *
 *   ⚠️ 僅改 LTD（0d02b680）一間。`CEVA LOGISTICS (HONG KONG) LIMITED`（7448b7c5）雖有
 *   同型斷鏈，但它已有 `cfs` 與 `gate_charge` 欄位，補 destination_* 版本會製造語意重複
 *   —— 使用者 2026-08-03 決定本次不動該間。
 *
 *   依 CLAUDE.md §不可逆資料操作紀律採 inspect / dryrun / write 三段式，
 *   write 具備前置快照、單一交易、數量閘、樂觀鎖、冪等。
 *
 * @module scripts/fix-158-ceva-add-field-definitions
 * @since FIX-158
 * @lastModified 2026-08-03
 *
 * @usage
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/fix-158-ceva-add-field-definitions.ts inspect
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/fix-158-ceva-add-field-definitions.ts dryrun
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/fix-158-ceva-add-field-definitions.ts write
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

/** 目標：CEVA LOGISTICS (HONG KONG) LTD 的欄位定義集 */
const TARGET_SET_ID = 'f13aaf3b-ec74-4750-8036-a27dbb554792';
const EXPECTED_COMPANY_ID = '0d02b680-165b-4cfd-8c1b-7ebfa6da8424';

interface FieldDef {
  key: string;
  label: string;
  aliases?: string[];
  category: string;
  dataType: string;
  required: boolean;
  fieldType: string;
}

/** 屬性沿用該欄位集既有 17 個欄位的一致寫法：charges / currency / lineItem */
const NEW_FIELDS: FieldDef[] = [
  {
    key: 'emergency_fuel_surcharge',
    label: 'Emergency Fuel Surcharge',
    aliases: ['EBS', 'Emergency Bunker Surcharge', 'Emergency Fuel Surcharge at Destination'],
    category: 'charges',
    dataType: 'currency',
    required: false,
    fieldType: 'lineItem',
  },
  {
    key: 'destination_cfs_charges',
    label: 'Destination CFS Charges',
    aliases: ['CFS Charges at Destination', 'CFS Charges', 'Container Freight Station Charge at Destination'],
    category: 'charges',
    dataType: 'currency',
    required: false,
    fieldType: 'lineItem',
  },
  {
    key: 'destination_gate_fee',
    label: 'Destination Gate Fee',
    aliases: ['Gate Fee at Destination', 'Gate Charge at Destination', 'Gate Charge'],
    category: 'charges',
    dataType: 'currency',
    required: false,
    fieldType: 'lineItem',
  },
  {
    key: 'destination_truck_servicing_fee',
    label: 'Destination Truck Servicing Fee',
    // 刻意只給一個：CEVA 已有 ftl_freight_truck，放寬泛的 Truck 字樣會互搶
    aliases: ['Truck Servicing Fee at Destination'],
    category: 'charges',
    dataType: 'currency',
    required: false,
    fieldType: 'lineItem',
  },
];

type Mode = 'inspect' | 'dryrun' | 'write';

async function readTarget() {
  return prisma.fieldDefinitionSet.findUnique({ where: { id: TARGET_SET_ID } });
}

function writeSnapshot(record: unknown): string {
  const dir = path.resolve(__dirname, '../.snapshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `fix-158-ceva-fielddefs-before-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
  return file;
}

async function main() {
  const mode = (process.argv[2] ?? '') as Mode;
  if (!['inspect', 'dryrun', 'write'].includes(mode)) {
    console.error('用法: fix-158-ceva-add-field-definitions.ts <inspect|dryrun|write>');
    process.exit(2);
  }

  console.log(`=== FIX-158 問題二 — 模式: ${mode} ===\n`);

  const record = await readTarget();
  if (!record) throw new Error(`找不到 field definition set: ${TARGET_SET_ID}`);

  // 身分驗證
  if (record.companyId !== EXPECTED_COMPANY_ID) {
    throw new Error(`companyId 不符：預期 ${EXPECTED_COMPANY_ID}，實際 ${record.companyId} —— 中止`);
  }

  const existing: FieldDef[] = Array.isArray(record.fields)
    ? (record.fields as unknown as FieldDef[])
    : [];

  console.log('=== 目標欄位定義集 ===');
  console.log(`  id        : ${record.id}`);
  console.log(`  name      : ${record.name}`);
  console.log(`  companyId : ${record.companyId}`);
  console.log(`  isActive  : ${record.isActive}   現有欄位 ${existing.length} 個`);
  console.log(`  updatedAt : ${record.updatedAt.toISOString()}`);

  const existingKeys = new Set(existing.map((f) => f.key));
  const toAdd = NEW_FIELDS.filter((f) => !existingKeys.has(f.key));
  const already = NEW_FIELDS.filter((f) => existingKeys.has(f.key));

  console.log('\n=== 四個目標欄位現況 ===');
  for (const f of NEW_FIELDS) {
    console.log(`  ${existingKeys.has(f.key) ? '✅ 已存在（將跳過）' : '➕ 待新增'}  ${f.key}`);
  }

  // 檢查 alias 是否與既有欄位的 label/alias 撞名（避免互搶）
  console.log('\n=== alias 衝突檢查（與既有 17 個欄位比對）===');
  const takenText = new Map<string, string>();
  for (const f of existing) {
    takenText.set(String(f.label).toLowerCase(), `${f.key}.label`);
    for (const a of f.aliases ?? []) takenText.set(String(a).toLowerCase(), `${f.key}.alias`);
  }
  let conflicts = 0;
  for (const f of toAdd) {
    for (const text of [f.label, ...(f.aliases ?? [])]) {
      const hit = takenText.get(text.toLowerCase());
      if (hit) {
        conflicts++;
        console.log(`  🔴 "${text}"（${f.key}）與既有 ${hit} 重複`);
      }
    }
  }
  if (conflicts === 0) console.log('  ✅ 無衝突');
  else throw new Error(`發現 ${conflicts} 處 alias 衝突 —— 中止，重複的字樣會造成欄位互搶`);

  if (mode === 'inspect') {
    console.log('\n=== inspect 完成（未做任何寫入）===');
    return;
  }

  // 冪等
  if (toAdd.length === 0) {
    console.log('\n=== 四個欄位皆已存在，無動作 ===');
    return;
  }

  const newFields = [...existing, ...toAdd];

  console.log('\n=== 待執行變更 ===');
  console.log(`  fieldDefinitionSet.update :: fields`);
  console.log(`      欄位數 ${existing.length} -> ${newFields.length}（新增 ${toAdd.length}${already.length ? `，跳過已存在 ${already.length}` : ''}）`);
  console.log(`      樂觀鎖比對 updated_at = ${record.updatedAt.toISOString()}`);
  console.log('\n=== 新增的欄位定義 ===');
  for (const f of toAdd) console.log(`  ${JSON.stringify(f)}`);

  console.log('\n⚠️  影響範圍：僅 CEVA LOGISTICS (HONG KONG) LTD 一間的欄位定義集。');
  console.log('   aliases 會進入 Stage 3 prompt，影響後續處理的提取行為。');
  console.log('   既有提取結果與 template instance 列不回溯，需重新處理 / 重新匹配才反映。');

  if (mode === 'dryrun') {
    console.log('\n=== dryrun 完成（未做任何寫入）===');
    return;
  }

  const snapshotFile = writeSnapshot(record);
  console.log(`\n=== 前置快照已寫入: ${snapshotFile} ===`);

  await prisma.$transaction(async (tx) => {
    const r = await tx.fieldDefinitionSet.updateMany({
      where: { id: TARGET_SET_ID, updatedAt: record.updatedAt },
      data: { fields: newFields as never },
    });
    if (r.count !== 1) {
      throw new Error(
        `數量閘失敗：影響 ${r.count} 列（預期 1）。可能是併發修改導致樂觀鎖不匹配 —— 交易回滾。`,
      );
    }
  });

  console.log('=== 交易提交完成 ===');

  const after = await readTarget();
  const afterFields = (Array.isArray(after?.fields) ? after?.fields : []) as unknown as FieldDef[];
  console.log('\n=== 寫入後現況 ===');
  console.log(`  updatedAt : ${after?.updatedAt.toISOString()}`);
  console.log(`  欄位數    : ${afterFields.length}（變更前 ${existing.length}）`);
  for (const f of NEW_FIELDS) {
    const hit = afterFields.find((x) => x.key === f.key);
    console.log(`  ${hit ? '✅' : '🔴'} ${f.key}  aliases=${JSON.stringify(hit?.aliases ?? null)}`);
  }
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
