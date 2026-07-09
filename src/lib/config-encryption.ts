/**
 * @fileoverview 系統配置憑證加密（AES-256-GCM / CONFIG_ENCRYPTION_KEY）— 共用模組
 * @description
 *   從 `system-config.service` 抽出的共用 GCM 加解密（FIX-070：隨機鹽 + 舊格式相容），
 *   供 app（system-config、Epic 23 LlmGateway）與播種腳本共用，杜絕重複實作（審視 §3）。
 *   - `encryptConfigValue`：加密（隨機 salt/iv；格式 `salt:iv:authTag:cipher`，皆 hex）
 *   - `decryptConfigValue`：解密（**fail-closed**，失敗即拋 `ConfigEncryptionError` — 供 gateway 憑證解密）
 *   - `tryDecryptConfigValue`：fail-open 包裝（失敗記錄並回原值 — 保留 system-config 既有讀取行為）
 *   金鑰來自環境變數 `CONFIG_ENCRYPTION_KEY`（缺失/過短即 fail-closed）。
 *
 * @module src/lib/config-encryption
 * @since Epic 23 - Story 23.1（抽自 system-config.service，Epic 6 / FIX-070）
 * @lastModified 2026-07-09
 *
 * @remarks 演算法/格式/scrypt 參數與抽出前**逐字一致**，既有加密的 SystemConfig 值可繼續解密。
 *   零 `@/` 依賴（僅 `node:crypto` + env）→ 可被 app 與編譯種子相對 import。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/** 加密演算法 */
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

/**
 * 舊版靜態鹽值（FIX-070 前的固定派生鹽）。
 * 僅用於「向後相容解密」既有以舊格式（IV:AuthTag:Data，3 段）儲存的密文；
 * 新加密一律改用每次隨機產生的鹽並隨密文儲存（見 encryptConfigValue）。
 */
const LEGACY_ENCRYPTION_SALT = 'config-salt';

/** 隨機鹽長度（位元組） */
const SALT_LENGTH = 16;

/** 加密相關錯誤（金鑰缺失/過短、密文格式錯誤、解密失敗） */
export class ConfigEncryptionError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'ConfigEncryptionError';
  }
}

/**
 * 取得系統配置加密金鑰。
 * 缺金鑰或長度不足即 fail-closed，絕不以硬編碼預設 fallback。
 * @throws ConfigEncryptionError（MISSING_ENCRYPTION_KEY / INVALID_ENCRYPTION_KEY）
 */
function getConfigEncryptionKey(): string {
  const key = process.env.CONFIG_ENCRYPTION_KEY;
  if (!key) {
    throw new ConfigEncryptionError(
      'CONFIG_ENCRYPTION_KEY environment variable is not set. Configure it before storing or reading encrypted values.',
      'MISSING_ENCRYPTION_KEY',
    );
  }
  if (key.length < 32) {
    throw new ConfigEncryptionError(
      'CONFIG_ENCRYPTION_KEY must be at least 32 characters long.',
      'INVALID_ENCRYPTION_KEY',
    );
  }
  return key;
}

/**
 * 使用 scrypt 衍生加密金鑰。
 * @param salt 派生鹽（新密文用隨機鹽；舊密文相容路徑用 LEGACY_ENCRYPTION_SALT）
 */
function deriveKey(salt: string | Buffer): Buffer {
  return scryptSync(getConfigEncryptionKey(), salt, 32);
}

/**
 * 加密值（FIX-070：每次隨機鹽並隨密文儲存）。
 * @returns 格式 `Salt:IV:AuthTag:EncryptedData`（皆 hex）
 */
export function encryptConfigValue(value: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(salt);
  const iv = randomBytes(16);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

  let encrypted = cipher.update(value, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `${salt.toString('hex')}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * 解密值（**fail-closed**：格式/解密失敗即拋 ConfigEncryptionError）。
 * FIX-070 向後相容：同時支援新 4 段（Salt:IV:AuthTag:Data）與舊 3 段（IV:AuthTag:Data）格式。
 */
export function decryptConfigValue(encrypted: string): string {
  const parts = encrypted.split(':');

  let saltForKey: string | Buffer;
  let ivHex: string;
  let authTagHex: string;
  let data: string;

  if (parts.length === 4) {
    // 新格式：Salt:IV:AuthTag:Data
    [, ivHex, authTagHex, data] = parts;
    saltForKey = Buffer.from(parts[0], 'hex');
  } else if (parts.length === 3) {
    // 舊格式：IV:AuthTag:Data（FIX-070 前，固定靜態鹽）
    [ivHex, authTagHex, data] = parts;
    saltForKey = LEGACY_ENCRYPTION_SALT;
  } else {
    throw new ConfigEncryptionError('Invalid encrypted value format', 'INVALID_FORMAT');
  }

  if (!ivHex || !authTagHex || !data) {
    throw new ConfigEncryptionError('Invalid encrypted value format', 'INVALID_FORMAT');
  }

  const key = deriveKey(saltForKey);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv, {
    authTagLength: 16, // GCM tag 固定 16 bytes（加密端 getAuthTag 產生）；拒絕較短 tag（Semgrep gcm-no-tag-length）
  });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * fail-open 解密（保留 system-config 既有 `decryptIfNeeded` 行為）：
 * 解密失敗時記錄並回傳原值。
 * ⚠️ 僅供既有 system-config 讀取路徑；**gateway/憑證解密請用 `decryptConfigValue`（fail-closed）**，
 *    避免把亂碼當金鑰送出（審視 §3 的 fail-open 缺口）。
 */
export function tryDecryptConfigValue(value: string, isEncrypted: boolean): string {
  if (isEncrypted && value) {
    try {
      return decryptConfigValue(value);
    } catch {
      console.error('Failed to decrypt config value');
      return value;
    }
  }
  return value;
}
