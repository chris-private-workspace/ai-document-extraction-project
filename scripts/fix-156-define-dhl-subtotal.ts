/**
 * @fileoverview FIX-156 — 在 DHL 的 COMPANY Stage 3 prompt 補上 subtotal 定義（三段式 gated）
 * @description
 *   `DHL Express - Stage 3 (multi-shipment detail table)`（COMPANY，`mergeStrategy = OVERRIDE`）
 *   完全取代 GLOBAL prompt，而它的 systemPrompt 與 userPromptTemplate **從未提及 subtotal**。
 *   模型僅從 JSON schema 得知有此欄位，卻無任何取值依據，於是每次自行推斷 ——
 *   同一張發票 `HKGIR02794867` 取出三種值：11,484.60（運費小計，漏掉燃油附加費）／
 *   14,929.98（正確）／null。
 *
 *   更棘手的是 systemPrompt 的 line item 規則要求「Ignore "Service Sub Total ..."」，
 *   那是為了防止聚合列被當成行項而重複計費（CHANGE-113／FIX-152），
 *   但模型把它一併套用到 `fields.subtotal`，因而避開發票上真正的小計。
 *
 *   本腳本補上明確定義（使用者 2026-08-02 拍板）：
 *     subtotal = 所有費用合計（含燃油附加費）、不含稅，等於 lineItems[].amount 總和。
 *
 *   ⚠️ 影響範圍僅 DHL Express —— 本筆為 COMPANY scope 且 `mergeStrategy = OVERRIDE`，
 *   GLOBAL 與其他 5 筆 COMPANY prompt 皆不受影響。
 *
 *   依 CLAUDE.md §不可逆資料操作紀律採 inspect / dryrun / write 三段式，
 *   write 具備前置快照、單一交易、數量閘、樂觀鎖、冪等。
 *
 * @module scripts/fix-156-define-dhl-subtotal
 * @since FIX-156
 * @lastModified 2026-08-02
 *
 * @usage
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/fix-156-define-dhl-subtotal.ts inspect
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/fix-156-define-dhl-subtotal.ts dryrun
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/fix-156-define-dhl-subtotal.ts write
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

/** 目標配置：DHL Express 的 COMPANY scope Stage 3 prompt */
const TARGET_CONFIG_ID = 'change113-dhl-stage3-001';
const EXPECTED_COMPANY_ID = 'eedf4065-653b-4fd0-8bfb-f71c78bb2ae5';

/** systemPrompt 的插入錨點 —— 新段落置於 General 之前（內容規則先於格式規則） */
const SYSTEM_ANCHOR = '## General';

const SYSTEM_ADDITION = `## Amount summary

- subtotal: the sum of ALL charges you emitted as line items, including fuel
  surcharges, before tax. It must equal the total of your lineItems[].amount.
- The instruction to ignore "Service Sub Total" applies to LINE ITEMS only. It does
  not mean fields.subtotal should be left empty, nor computed from a subset of the
  charges (for example freight without fuel surcharge).

`;

/** 用來判斷是否已套用（冪等） */
const IDEMPOTENCY_MARKER = '## Amount summary';

/** userPromptTemplate：必抽欄位補上 subtotal */
const USER_OLD = '1. Invoice basics: invoice number, invoice date, currency, total amount';
const USER_NEW = '1. Invoice basics: invoice number, invoice date, currency, subtotal, total amount';

type Mode = 'inspect' | 'dryrun' | 'write';

async function readTarget() {
  return prisma.promptConfig.findUnique({ where: { id: TARGET_CONFIG_ID } });
}

/** 印出與 subtotal 有關的行，讓變更前後的差異一眼可見 */
function printSubtotalMentions(label: string, systemPrompt: string, userPrompt: string) {
  console.log(`  --- ${label} ---`);
  let found = 0;
  for (const [name, text] of [
    ['systemPrompt', systemPrompt],
    ['userPromptTemplate', userPrompt],
  ] as const) {
    text.split('\n').forEach((line, i) => {
      if (/sub[_ ]?total/i.test(line)) {
        found++;
        console.log(`    ${name} 第 ${String(i + 1).padStart(3)} 行 | ${line.trim()}`);
      }
    });
  }
  if (found === 0) console.log('    （兩者皆未提及 subtotal）');
}

function writeSnapshot(config: unknown): string {
  const dir = path.resolve(__dirname, '../.snapshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `fix-156-dhl-prompt-before-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
  return file;
}

async function main() {
  const mode = (process.argv[2] ?? '') as Mode;
  if (!['inspect', 'dryrun', 'write'].includes(mode)) {
    console.error('用法: fix-156-define-dhl-subtotal.ts <inspect|dryrun|write>');
    process.exit(2);
  }

  console.log(`=== FIX-156 — 模式: ${mode} ===\n`);

  const config = await readTarget();
  if (!config) {
    throw new Error(`找不到 prompt config: ${TARGET_CONFIG_ID}`);
  }

  // 身分驗證：確認改到的是 DHL 的那一筆，而非同名或被改掛的配置
  if (config.companyId !== EXPECTED_COMPANY_ID) {
    throw new Error(
      `companyId 不符：預期 ${EXPECTED_COMPANY_ID}，實際 ${config.companyId} —— ` +
        '目標配置可能已被改掛到其他公司。中止。',
    );
  }
  if (config.scope !== 'COMPANY') {
    throw new Error(`scope 不符：預期 COMPANY，實際 ${config.scope} —— 中止`);
  }

  console.log('=== 目標配置 ===');
  console.log(`  id            : ${config.id}`);
  console.log(`  name          : ${config.name}`);
  console.log(`  promptType    : ${config.promptType}`);
  console.log(`  scope         : ${config.scope}  companyId=${config.companyId}`);
  console.log(`  mergeStrategy : ${config.mergeStrategy}  ← OVERRIDE 表示完全取代 GLOBAL`);
  console.log(`  isActive      : ${config.isActive}  version=${config.version}`);
  console.log(`  updatedAt     : ${config.updatedAt.toISOString()}`);
  console.log('');
  printSubtotalMentions(
    '現況：prompt 中提到 subtotal 的地方',
    config.systemPrompt ?? '',
    config.userPromptTemplate ?? '',
  );

  if (mode === 'inspect') {
    console.log('\n=== inspect 完成（未做任何寫入）===');
    return;
  }

  const curSystem = config.systemPrompt ?? '';
  const curUser = config.userPromptTemplate ?? '';

  // 冪等：已套用則無動作
  if (curSystem.includes(IDEMPOTENCY_MARKER)) {
    console.log('\n=== 已是目標狀態（systemPrompt 已含 Amount summary 段落），無動作 ===');
    return;
  }

  // 數量閘（字串層）：兩個錨點各須恰好出現一次
  const anchorCount = curSystem.split(SYSTEM_ANCHOR).length - 1;
  if (anchorCount !== 1) {
    throw new Error(
      `systemPrompt 中的錨點 "${SYSTEM_ANCHOR}" 預期出現 1 次，實際 ${anchorCount} 次 —— 中止，需人工確認`,
    );
  }
  const userCount = curUser.split(USER_OLD).length - 1;
  if (userCount !== 1) {
    throw new Error(
      `userPromptTemplate 中的原句預期出現 1 次，實際 ${userCount} 次 —— 中止，需人工確認`,
    );
  }

  const newSystem = curSystem.replace(SYSTEM_ANCHOR, SYSTEM_ADDITION + SYSTEM_ANCHOR);
  const newUser = curUser.replace(USER_OLD, USER_NEW);

  console.log('\n=== 待執行變更 ===');
  console.log('  [1] promptConfig.update :: systemPrompt');
  console.log(`      於 "${SYSTEM_ANCHOR}" 之前插入 Amount summary 段落`);
  console.log(`      字元數: ${curSystem.length} -> ${newSystem.length}`);
  console.log('  [2] promptConfig.update :: userPromptTemplate');
  console.log(`      原: ${USER_OLD}`);
  console.log(`      新: ${USER_NEW}`);
  console.log(`  [3] version: ${config.version} -> ${config.version + 1}`);
  console.log(`      樂觀鎖比對 updated_at = ${config.updatedAt.toISOString()}`);

  console.log('');
  printSubtotalMentions('變更後：prompt 中提到 subtotal 的地方', newSystem, newUser);

  console.log('\n⚠️  影響範圍：僅 DHL Express（COMPANY scope + OVERRIDE），其他公司不受影響。');
  console.log('   既有提取結果不回溯，僅後續處理的文件生效。');

  if (mode === 'dryrun') {
    console.log('\n=== dryrun 完成（未做任何寫入）===');
    return;
  }

  const snapshotFile = writeSnapshot(config);
  console.log(`\n=== 前置快照已寫入: ${snapshotFile} ===`);

  await prisma.$transaction(async (tx) => {
    const r = await tx.promptConfig.updateMany({
      // 樂觀鎖：讀取當下的 updated_at 必須未變
      where: { id: TARGET_CONFIG_ID, updatedAt: config.updatedAt },
      data: {
        systemPrompt: newSystem,
        userPromptTemplate: newUser,
        version: config.version + 1,
      },
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
  console.log('\n=== 寫入後現況 ===');
  console.log(`  version   : ${after?.version}`);
  console.log(`  updatedAt : ${after?.updatedAt.toISOString()}`);
  printSubtotalMentions(
    '寫入後',
    after?.systemPrompt ?? '',
    after?.userPromptTemplate ?? '',
  );
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
