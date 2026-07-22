/**
 * @fileoverview Template mapping 來源欄位 key 解析與未知 key 判定
 * @description
 *   FIX-128 的共用純函數：從映射規則中抽取「會從 row 讀取的來源欄位 key」，
 *   並判定哪些 key 不在已知欄位集合中（拼錯 / 欄位不存在 → 公式該項永遠為 0）。
 *
 *   三個使用端共用同一套規則，確保判定一致：
 *   - 執行時（template-matching-engine）：對照當次 row 的實際 keys
 *   - 儲存時（template-field-mappings API）：對照該 scope 解析出的欄位定義
 *   - 編輯時（FormulaEditor）：對照前端載入的可用欄位清單
 *
 * @module src/lib/template-mapping-source-keys
 * @since FIX-128
 * @lastModified 2026-07-22
 */

import type {
  FieldTransformType,
  TransformParams,
  FormulaTransformParams,
} from '@/types/template-field-mapping';

/**
 * 變數佔位符模式 {field_name}（與 transform/formula.transform.ts 一致）
 */
const FORMULA_VARIABLE_PATTERN = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/**
 * 動態合成欄位前綴 —— 這些 key 依文件內容在執行時動態產生
 * （li_* 為 lineItem 分類展平、_ref_* 為參考編號注入），
 * 不在欄位定義中、且缺席不代表拼錯，一律豁免未知 key 判定。
 */
const SYNTHETIC_SOURCE_PREFIXES = ['li_', '_ref_'] as const;

/**
 * 判定 key 是否為動態合成欄位（豁免未知 key 判定）
 */
export function isSyntheticSourceKey(key: string): boolean {
  return SYNTHETIC_SOURCE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * 抽取公式中引用的所有變數 key（去重、保持出現順序）
 */
export function extractFormulaKeys(formula: string): string[] {
  const keys: string[] = [];
  for (const match of formula.matchAll(FORMULA_VARIABLE_PATTERN)) {
    if (!keys.includes(match[1])) keys.push(match[1]);
  }
  return keys;
}

/**
 * 抽取單條映射規則「會從 row 讀取」的來源欄位 key
 *
 * @description
 *   - FORMULA：公式中的所有 `{key}`（sourceField 在公式模式下不直接參與計算）
 *   - AGGREGATE：讀 lineItems 而非 row，sourceField 為分類名 → 回空（不參與判定）
 *   - 其餘（DIRECT / LOOKUP / CONCAT / SPLIT / CUSTOM）：規則的 sourceField
 */
export function collectRuleSourceKeys(rule: {
  transformType: FieldTransformType;
  sourceField: string;
  transformParams?: TransformParams;
}): string[] {
  if (rule.transformType === 'AGGREGATE') return [];

  if (rule.transformType === 'FORMULA') {
    const formula = (rule.transformParams as FormulaTransformParams | null)?.formula;
    return formula ? extractFormulaKeys(formula) : [];
  }

  return rule.sourceField ? [rule.sourceField] : [];
}

/**
 * 判定規則引用的來源 key 中，哪些不在已知集合中
 *
 * @param rule - 映射規則
 * @param knownKeys - 已知的來源欄位 key 集合（欄位定義 / 標準欄位 / 當次 row keys）
 * @returns 未知 key 清單（已豁免動態合成欄位；空陣列 = 無問題）
 */
export function findUnknownRuleSourceKeys(
  rule: {
    transformType: FieldTransformType;
    sourceField: string;
    transformParams?: TransformParams;
  },
  knownKeys: ReadonlySet<string>
): string[] {
  return collectRuleSourceKeys(rule).filter(
    (key) => !knownKeys.has(key) && !isSyntheticSourceKey(key)
  );
}
