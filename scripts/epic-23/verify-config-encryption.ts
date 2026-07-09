/**
 * @fileoverview Story 23.1 step 2 驗證 — 共用加密模組行為保真
 * @description
 *   1. 新值 encrypt→decrypt round-trip（含中文/長字串）。
 *   2. 用抽出的模組解密 DB 裡既有 isEncrypted SystemConfig，確認舊格式相容（不印明文，只報長度）。
 * @module scripts/epic-23/verify-config-encryption
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import {
  encryptConfigValue,
  decryptConfigValue,
} from '../../src/lib/config-encryption';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  // 1. round-trip
  const samples = ['test-secret-value', 'sk-abc123XYZ==/+key', '中文憑證測試 🔐 with spaces'];
  let rtOk = 0;
  for (const s of samples) {
    const enc = encryptConfigValue(s);
    const dec = decryptConfigValue(enc);
    const parts = enc.split(':').length;
    console.log(`[verify] round-trip ${dec === s ? 'OK' : 'FAIL'} (格式 ${parts} 段, len=${s.length})`);
    if (dec === s) rtOk++;
  }

  // 2. 既有加密 SystemConfig 解密（舊格式相容）
  const encRows = await prisma.systemConfig.findMany({
    where: { isEncrypted: true },
    select: { key: true, value: true },
  });
  console.log(`[verify] DB 既有 isEncrypted SystemConfig: ${encRows.length} 筆`);
  let decOk = 0;
  let decFail = 0;
  for (const r of encRows) {
    try {
      const dec = decryptConfigValue(r.value as unknown as string);
      const segs = (r.value as unknown as string).split(':').length;
      console.log(`[verify]   ${r.key}: 解密 OK (格式 ${segs} 段, 明文 len=${dec.length})`);
      decOk++;
    } catch (e) {
      console.log(`[verify]   ${r.key}: 解密 FAIL — ${e instanceof Error ? e.message : e}`);
      decFail++;
    }
  }

  console.log(`\n[verify] 總結: round-trip ${rtOk}/${samples.length}；DB 解密 ${decOk} OK / ${decFail} FAIL`);
  console.log('[verify] 註：DB 解密以「當前 CONFIG_ENCRYPTION_KEY」為準；key 不符即 FAIL（非模組錯誤）。');
  await prisma.$disconnect();
  // 只 gate round-trip（模組正確性）；DB 解密結果視 key 而定，僅供資訊
  if (rtOk !== samples.length) process.exit(1);
}

main().catch(async (e) => {
  console.error('[verify] 失敗:', e);
  await prisma.$disconnect();
  process.exit(1);
});
