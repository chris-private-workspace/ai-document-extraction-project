/**
 * @fileoverview i18n 完整性檢查腳本
 * @description
 *   檢查 TypeScript 常量定義是否有對應的 i18n 翻譯
 *   - 解析 PROMPT_TYPES 等常量
 *   - 對照 messages/ 下的翻譯文件
 *   - 報告缺失的翻譯 key
 *
 * @usage
 *   npm run i18n:check
 *
 * @module scripts/check-i18n-completeness
 * @since CHANGE-026
 * @lastModified 2026-02-03
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// 配置：常量與 i18n 的映射規則
// ============================================================

interface MappingRule {
  /** 常量來源文件 */
  sourceFile: string;
  /** 常量名稱 */
  constantName: string;
  /** 對應的 i18n 文件（不含 locale） */
  i18nFile: string;
  /** i18n 中的路徑前綴 */
  i18nKeyPrefix: string;
  /** 如何從常量值提取 key */
  keyExtractor: (value: string) => string;
}

const MAPPING_RULES: MappingRule[] = [
  {
    sourceFile: 'src/types/prompt-config.ts',
    constantName: 'PROMPT_TYPES',
    i18nFile: 'promptConfig.json',
    i18nKeyPrefix: 'types',
    keyExtractor: (value) => value, // 直接使用 value
  },
  // 可以繼續添加其他映射規則
];

const SUPPORTED_LOCALES = ['en', 'zh-TW', 'zh-CN'];

/**
 * 三語言同步檢查配置（CHANGE-088 新增）
 *
 * 對指定 namespace 的 key 子樹，驗證 en / zh-TW / zh-CN 的 leaf key 集合完全一致。
 *
 * 為何用「三語言同步」而非「常量 key ↔ i18n」逐一解析：
 *   本批由顯示常量（PERMISSION_INFO_MAP、REJECTION_REASONS、SYSTEM_VARIABLES 等）
 *   改 i18n 而來，這些常量結構異構（computed property key `[PERMISSIONS.X]`、陣列、
 *   不同欄位來源），逐一解析 TS 成本高且易碎。改以三語言同步作為治理 gate：
 *   next-intl 缺某語言 key 會 fallback（不報錯），故「三語言不同步」才是真實洩漏風險。
 */
interface LocaleSyncCheck {
  /** i18n 文件（不含 locale） */
  i18nFile: string;
  /** 要檢查的 key 子樹前綴 */
  keyPrefix: string;
  /** 用途說明 */
  description: string;
}

const LOCALE_SYNC_CHECKS: LocaleSyncCheck[] = [
  { i18nFile: 'documentPreview.json', keyPrefix: 'fieldsPanel.categories', description: 'CHANGE-088 DEFAULT_CATEGORIES（提取欄位類別）' },
  { i18nFile: 'systemSettings.json', keyPrefix: 'config', description: 'CHANGE-088 EFFECT_TYPE_INFO / CONFIG_CATEGORY_INFO' },
  { i18nFile: 'review.json', keyPrefix: 'rejection', description: 'CHANGE-088 REJECTION_REASONS（規則建議拒絕原因）' },
  { i18nFile: 'reports.json', keyPrefix: 'auditReport', description: 'CHANGE-088 AUDIT_REPORT_TYPES / REPORT_JOB_STATUSES' },
  { i18nFile: 'promptConfig.json', keyPrefix: 'variables', description: 'CHANGE-088 SYSTEM_VARIABLES（Prompt 系統變數）' },
  { i18nFile: 'admin.json', keyPrefix: 'permissions', description: 'CHANGE-088 PERMISSION_INFO_MAP / PERMISSION_CATEGORIES' },
  // CHANGE-089 Batch A：新增 namespace（整檔三語言同步，keyPrefix='' 檢查整個檔案）
  { i18nFile: 'documentSource.json', keyPrefix: '', description: 'CHANGE-089 文件來源模組（整檔）' },
  { i18nFile: 'dataRetention.json', keyPrefix: '', description: 'CHANGE-089 資料保留模組（整檔）' },
  { i18nFile: 'integrations.json', keyPrefix: '', description: 'CHANGE-089 Outlook/SharePoint 整合模組（整檔）' },
  { i18nFile: 'changeHistory.json', keyPrefix: '', description: 'CHANGE-089 變更歷史模組（整檔）' },
  { i18nFile: 'ruleSimulation.json', keyPrefix: '', description: 'CHANGE-089 規則模擬模組（整檔）' },
  // CHANGE-089 Batch A：既有 namespace 新增子樹
  { i18nFile: 'confidence.json', keyPrefix: 'badge', description: 'CHANGE-089 confidence 等級徽章' },
  { i18nFile: 'formats.json', keyPrefix: 'formatAnalysis', description: 'CHANGE-089 格式分析模組' },
  { i18nFile: 'rules.json', keyPrefix: 'ruleReview', description: 'CHANGE-089 規則建議審核' },
  { i18nFile: 'rules.json', keyPrefix: 'ruleVersion', description: 'CHANGE-089 規則版本' },
  // CHANGE-089 Batch B–D（波 1）：既有 namespace 大量新增分散子樹，改以整檔三語言同步治理
  { i18nFile: 'admin.json', keyPrefix: '', description: 'CHANGE-089 Batch B admin 模組（整檔）' },
  { i18nFile: 'review.json', keyPrefix: '', description: 'CHANGE-089 Batch C review 模組（整檔）' },
  { i18nFile: 'rules.json', keyPrefix: '', description: 'CHANGE-089 Batch C rules 模組（整檔）' },
  { i18nFile: 'historicalData.json', keyPrefix: '', description: 'CHANGE-089 Batch D historicalData 模組（整檔）' },
  { i18nFile: 'documentPreview.json', keyPrefix: '', description: 'CHANGE-089 Batch D documentPreview 模組（整檔）' },
  // CHANGE-089 Batch E/F（波 2）：既有 namespace 殘留 + 新增 cityAccess，整檔三語言同步
  { i18nFile: 'escalation.json', keyPrefix: '', description: 'CHANGE-089 Batch E escalation 模組（整檔）' },
  { i18nFile: 'companies.json', keyPrefix: '', description: 'CHANGE-089 Batch E companies/forwarders 模組（整檔）' },
  { i18nFile: 'formats.json', keyPrefix: '', description: 'CHANGE-089 Batch E formats 模組（整檔）' },
  { i18nFile: 'reports.json', keyPrefix: '', description: 'CHANGE-089 Batch E/F reports 模組（整檔）' },
  { i18nFile: 'dashboard.json', keyPrefix: '', description: 'CHANGE-089 Batch F dashboard 模組（整檔）' },
  { i18nFile: 'navigation.json', keyPrefix: '', description: 'CHANGE-089 Batch F navigation/layout 模組（整檔）' },
  { i18nFile: 'systemSettings.json', keyPrefix: '', description: 'CHANGE-089 Batch E systemSettings 模組（整檔）' },
  { i18nFile: 'cityAccess.json', keyPrefix: '', description: 'CHANGE-089 Batch F 跨城市存取模組（新增，整檔）' },
  // Epic 23 - Story 23.2：LLM Provider 管理後台（新增，整檔三語言同步）
  { i18nFile: 'llmProviders.json', keyPrefix: '', description: 'Epic 23 Story 23.2 LLM Provider 管理模組（整檔）' },
];

// ============================================================
// 工具函數
// ============================================================

/**
 * 從 TypeScript 文件中提取常量的 key（改進版）
 */
function extractConstantKeys(filePath: string, constantName: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8');

  // 找到常量開始的位置
  const constStart = content.indexOf(`export const ${constantName}`);
  if (constStart === -1) {
    console.warn(`Warning: Could not find constant ${constantName} in ${filePath}`);
    return [];
  }

  // 找到常量結束的位置（} as const 或 };）
  let braceCount = 0;
  let started = false;
  let endPos = constStart;

  for (let i = constStart; i < content.length; i++) {
    const char = content[i];
    if (char === '{') {
      braceCount++;
      started = true;
    } else if (char === '}') {
      braceCount--;
      if (started && braceCount === 0) {
        endPos = i + 1;
        break;
      }
    }
  }

  const constantBody = content.substring(constStart, endPos);

  // 提取所有頂層 key（例如 ISSUER_IDENTIFICATION:）
  // 使用更精確的正則表達式
  const keys: string[] = [];
  const lines = constantBody.split('\n');

  for (const line of lines) {
    // 匹配類似 "  KEY_NAME: {" 的模式
    const match = line.match(/^\s+([A-Z][A-Z0-9_]*)\s*:\s*\{/);
    if (match) {
      keys.push(match[1]);
    }
  }

  return keys;
}

/**
 * 從 i18n JSON 文件中提取指定路徑下的 key
 */
function extractI18nKeys(filePath: string, keyPrefix: string): string[] {
  if (!fs.existsSync(filePath)) {
    console.warn(`Warning: i18n file not found: ${filePath}`);
    return [];
  }

  const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  // 根據 keyPrefix 導航到正確的位置
  const parts = keyPrefix.split('.');
  let current = content;

  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = current[part];
    } else {
      console.warn(`Warning: Key prefix "${keyPrefix}" not found in ${filePath}`);
      return [];
    }
  }

  if (typeof current !== 'object') {
    return [];
  }

  return Object.keys(current);
}

/**
 * 檢查單個映射規則
 */
function checkMappingRule(rule: MappingRule): {
  rule: MappingRule;
  missingByLocale: Record<string, string[]>;
  extraByLocale: Record<string, string[]>;
} {
  const sourceKeys = extractConstantKeys(
    path.join(process.cwd(), rule.sourceFile),
    rule.constantName
  );

  console.log(`   發現常量 keys: ${sourceKeys.join(', ')}`);

  const missingByLocale: Record<string, string[]> = {};
  const extraByLocale: Record<string, string[]> = {};

  for (const locale of SUPPORTED_LOCALES) {
    const i18nPath = path.join(process.cwd(), 'messages', locale, rule.i18nFile);
    const i18nKeys = extractI18nKeys(i18nPath, rule.i18nKeyPrefix);

    // 找出缺失的翻譯（在常量中但不在 i18n 中）
    const missing = sourceKeys.filter(
      (key) => !i18nKeys.includes(rule.keyExtractor(key))
    );

    // 找出多餘的翻譯（在 i18n 中但不在常量中）
    const extra = i18nKeys.filter(
      (i18nKey) => !sourceKeys.some((key) => rule.keyExtractor(key) === i18nKey)
    );

    if (missing.length > 0) {
      missingByLocale[locale] = missing;
    }
    if (extra.length > 0) {
      extraByLocale[locale] = extra;
    }
  }

  return { rule, missingByLocale, extraByLocale };
}

/**
 * 遞迴提取 JSON 物件子樹的所有 leaf key 路徑（點分隔）
 */
function flattenLeafKeys(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') {
    return prefix ? [prefix] : [];
  }
  const result: string[] = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result.push(...flattenLeafKeys(value, keyPath));
    } else {
      result.push(keyPath);
    }
  }
  return result;
}

/**
 * 導航到 JSON 的指定 keyPrefix 子樹（找不到回傳 undefined）
 */
function navigateToPrefix(content: unknown, keyPrefix: string): unknown {
  // 空 prefix 代表檢查整個檔案（整個 namespace 三語言同步）
  if (keyPrefix === '') return content;
  const parts = keyPrefix.split('.');
  let current: unknown = content;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * 檢查單個三語言同步規則：以各語言 leaf key 聯集為基準，找出每個語言缺少的 key
 */
function checkLocaleSync(check: LocaleSyncCheck): {
  missingByLocale: Record<string, string[]>;
  total: number;
  missingFile: string[];
} {
  const keysByLocale: Record<string, Set<string>> = {};
  const union = new Set<string>();
  const missingFile: string[] = [];

  for (const locale of SUPPORTED_LOCALES) {
    const i18nPath = path.join(process.cwd(), 'messages', locale, check.i18nFile);
    if (!fs.existsSync(i18nPath)) {
      missingFile.push(locale);
      keysByLocale[locale] = new Set();
      continue;
    }
    const content = JSON.parse(fs.readFileSync(i18nPath, 'utf-8'));
    const subtree = navigateToPrefix(content, check.keyPrefix);
    const leaves = flattenLeafKeys(subtree);
    keysByLocale[locale] = new Set(leaves);
    leaves.forEach((k) => union.add(k));
  }

  const missingByLocale: Record<string, string[]> = {};
  for (const locale of SUPPORTED_LOCALES) {
    const missing = [...union].filter((k) => !keysByLocale[locale].has(k)).sort();
    if (missing.length > 0) {
      missingByLocale[locale] = missing;
    }
  }

  return { missingByLocale, total: union.size, missingFile };
}

// ============================================================
// 主程序
// ============================================================

function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║            i18n 完整性檢查                                 ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  let hasErrors = false;

  for (const rule of MAPPING_RULES) {
    console.log(`\n📋 檢查: ${rule.constantName}`);
    console.log(`   來源: ${rule.sourceFile}`);
    console.log(`   i18n: messages/*/${rule.i18nFile} → ${rule.i18nKeyPrefix}`);
    console.log('   ─────────────────────────────────────────');

    const result = checkMappingRule(rule);

    // 報告缺失的翻譯
    const hasMissing = Object.keys(result.missingByLocale).length > 0;
    if (hasMissing) {
      hasErrors = true;
      console.log('\n   ❌ 缺失的翻譯:');
      for (const [locale, keys] of Object.entries(result.missingByLocale)) {
        console.log(`      [${locale}]`);
        for (const key of keys) {
          console.log(`        - ${result.rule.i18nKeyPrefix}.${key}`);
        }
      }
    }

    // 報告多餘的翻譯（警告，非錯誤）
    const hasExtra = Object.keys(result.extraByLocale).length > 0;
    if (hasExtra) {
      console.log('\n   ⚠️  多餘的翻譯（可能是舊的、未清理）:');
      for (const [locale, keys] of Object.entries(result.extraByLocale)) {
        console.log(`      [${locale}]`);
        for (const key of keys) {
          console.log(`        - ${result.rule.i18nKeyPrefix}.${key}`);
        }
      }
    }

    if (!hasMissing && !hasExtra) {
      console.log('\n   ✅ 所有翻譯完整');
    }
  }

  // 三語言同步檢查（CHANGE-088）
  for (const check of LOCALE_SYNC_CHECKS) {
    console.log(`\n🌐 三語言同步: messages/*/${check.i18nFile} → ${check.keyPrefix}`);
    console.log(`   ${check.description}`);
    console.log('   ─────────────────────────────────────────');

    const result = checkLocaleSync(check);

    if (result.missingFile.length > 0) {
      hasErrors = true;
      console.log(`   ❌ 缺少語言文件: ${result.missingFile.join(', ')}`);
    }

    const hasMissing = Object.keys(result.missingByLocale).length > 0;
    if (hasMissing) {
      hasErrors = true;
      console.log(`   ❌ 三語言 key 不同步（聯集共 ${result.total} 個 leaf key）:`);
      for (const [locale, keys] of Object.entries(result.missingByLocale)) {
        console.log(`      [${locale}] 缺少 ${keys.length} 個:`);
        for (const key of keys.slice(0, 10)) {
          console.log(`        - ${check.keyPrefix}.${key}`);
        }
        if (keys.length > 10) {
          console.log(`        ... 及其他 ${keys.length - 10} 個`);
        }
      }
    } else if (result.missingFile.length === 0) {
      console.log(`   ✅ 三語言 key 集合一致（${result.total} 個 leaf key）`);
    }
  }

  console.log('\n');
  console.log('════════════════════════════════════════════════════════════');

  if (hasErrors) {
    console.log('❌ 檢查失敗：有缺失的翻譯，請更新 messages/ 文件');
    process.exit(1);
  } else {
    console.log('✅ 檢查通過：所有 i18n 翻譯完整');
    process.exit(0);
  }
}

main();
