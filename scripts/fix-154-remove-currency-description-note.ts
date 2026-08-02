/**
 * @fileoverview FIX-154 方案 E — 移除 GLOBAL Currency Rule 中的 description 幣別註記（三段式 gated）
 * @description
 *   `V3.1 Stage 3 - Field Extraction`（GLOBAL）的 systemPrompt 有一條 Currency Rule，
 *   要求在沒有 HKD 金額時「把原幣別註明在 description」。該規則自稱 company-specific，
 *   卻掛在 GLOBAL scope，於是**所有非 HKD 發票**的行項描述都被加上幣別後綴
 *   （如 `"THC (THB)"`），破壞 Stage 3 費用回填的 label 比對。
 *
 *   **本腳本只刪除該句的後半段**，保留「優先取 HKD 值」——
 *   後者是混幣發票決定 `amount` 取哪個金額的依據，屬真實需求（使用者 2026-08-02 確認）。
 *
 *   移除是安全的：幣別已由發票層級 `standardFields.currency` 承載，
 *   `ExchangeRateConverterService` 讀的正是該欄位（`exchange-rate-converter.service.ts:85`），
 *   全專案無任何程式碼解析 description 中的幣別註記。
 *
 *   依 CLAUDE.md §不可逆資料操作紀律採 inspect / dryrun / write 三段式，
 *   write 具備前置快照、單一交易、數量閘、樂觀鎖、冪等。
 *
 * @module scripts/fix-154-remove-currency-description-note
 * @since FIX-154
 * @lastModified 2026-08-02
 *
 * @usage
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/fix-154-remove-currency-description-note.ts inspect
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/fix-154-remove-currency-description-note.ts dryrun
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/fix-154-remove-currency-description-note.ts write
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

/** 目標配置：GLOBAL 的 Stage 3 欄位提取 prompt */
const TARGET_CONFIG_ID = 'cmo197zi9000cnsxgcjg5dh8v';

/**
 * 待替換的原句（完整比對，避免誤傷）。
 * 找不到即中止 —— 內容可能已被他人改過，不盲目套用。
 */
const OLD_SENTENCE =
  '- If a given line has no HKD amount, then fall back to the original-currency amount and note the original currency in the "description".';

/** 替換後：保留 fall back 行為，移除 description 註記要求 */
const NEW_SENTENCE =
  '- If a given line has no HKD amount, then fall back to the original-currency amount.';

type Mode = 'inspect' | 'dryrun' | 'write';

async function readTarget() {
  const config = await prisma.promptConfig.findUnique({
    where: { id: TARGET_CONFIG_ID },
  });
  return config;
}

/** 印出 systemPrompt 中 Currency Rule 的完整段落 */
function printCurrencyRule(systemPrompt: string) {
  const lines = systemPrompt.split('\n');
  const start = lines.findIndex((l) => /Currency Rule/i.test(l));
  if (start < 0) {
    console.log('  （systemPrompt 中找不到 Currency Rule 段落）');
    return;
  }
  for (let i = start; i < Math.min(lines.length, start + 8); i++) {
    const marker = lines[i].includes('note the original currency') ? ' <== 待移除' : '';
    console.log(`    ${String(i + 1).padStart(3)} | ${lines[i]}${marker}`);
  }
}

function writeSnapshot(config: unknown): string {
  const dir = path.resolve(__dirname, '../.snapshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `fix-154-prompt-before-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
  return file;
}

async function main() {
  const mode = (process.argv[2] ?? '') as Mode;
  if (!['inspect', 'dryrun', 'write'].includes(mode)) {
    console.error('用法: fix-154-remove-currency-description-note.ts <inspect|dryrun|write>');
    process.exit(2);
  }

  console.log(`=== FIX-154 方案 E — 模式: ${mode} ===\n`);

  const config = await readTarget();
  if (!config) {
    throw new Error(`找不到 prompt config: ${TARGET_CONFIG_ID}`);
  }

  console.log('=== 目標配置 ===');
  console.log(`  id          : ${config.id}`);
  console.log(`  promptType  : ${config.promptType}`);
  console.log(`  scope       : ${config.scope}  companyId=${config.companyId}`);
  console.log(`  isActive    : ${config.isActive}  version=${config.version}`);
  console.log(`  updatedAt   : ${config.updatedAt.toISOString()}`);
  console.log('\n=== systemPrompt 的 Currency Rule 段落（現況）===');
  printCurrencyRule(config.systemPrompt ?? '');

  if (mode === 'inspect') {
    console.log('\n=== inspect 完成（未做任何寫入）===');
    return;
  }

  const current = config.systemPrompt ?? '';
  const occurrences = current.split(OLD_SENTENCE).length - 1;

  // 冪等：已是目標狀態則無動作
  if (occurrences === 0) {
    if (current.includes(NEW_SENTENCE)) {
      console.log('\n=== 已是目標狀態（該句已移除），無動作 ===');
      return;
    }
    throw new Error(
      '在 systemPrompt 中找不到預期的原句，且不是已修復狀態 —— ' +
        '內容可能已被他人修改。中止，請重新 inspect 後人工確認。',
    );
  }

  // 數量閘（字串層）：預期恰好出現一次
  if (occurrences !== 1) {
    throw new Error(`預期原句出現 1 次，實際 ${occurrences} 次 —— 中止，需人工確認`);
  }

  const updated = current.replace(OLD_SENTENCE, NEW_SENTENCE);

  console.log('\n=== 待執行變更 ===');
  console.log('  [1] promptConfig.update :: systemPrompt');
  console.log(`      移除: ...${OLD_SENTENCE.slice(-60)}`);
  console.log(`      改為: ...${NEW_SENTENCE.slice(-60)}`);
  console.log(`      version: ${config.version} -> ${config.version + 1}`);
  console.log(`      樂觀鎖比對 updated_at = ${config.updatedAt.toISOString()}`);
  console.log(`      字元數: ${current.length} -> ${updated.length}`);

  console.log('\n=== 變更後的 Currency Rule 段落 ===');
  printCurrencyRule(updated);

  console.log('\n⚠️  影響範圍：此為 GLOBAL 配置，所有公司的 Stage 3 提取都會套用。');
  console.log('   既有提取結果不受影響（不回溯），僅後續處理的文件生效。');

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
      data: { systemPrompt: updated, version: config.version + 1 },
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
  printCurrencyRule(after?.systemPrompt ?? '');
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
