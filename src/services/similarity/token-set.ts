/**
 * @fileoverview 公司名 token-set 相似度工具（CHANGE-103 Phase 2 組件 2）
 * @description
 *   在既有字元級 Levenshtein（./levenshtein）之外，提供「以 token 集合」判斷公司名是否
 *   為同一公司的工具。核心概念：
 *   - `coreTokens(normalized)` = 正規化名的 token 集合，**減去 generic 詞**（純地區詞，如
 *     hong/kong/hk），只留公司「專有名」token。
 *   - 分層決策（{@link classifyCompanyMatch}）：core 集合**相等** → 自動配（AUTO）；
 *     一方為另一方的**嚴格子集**（即某一方多出專有 token） → 灰帶（GRAY，需人工審核）；
 *     否則 → 無關（NONE）。
 *
 *   設計取向（CHANGE-103 §Phase 2 定案 D1 保守）：只在 core 完全相等時自動配對，任何額外
 *   專有 token 一律送灰帶人工把關，把誤併風險降到最低。generic-strip 只在本工具層進行，
 *   **不修改 `normalizeCompanyName`**，避免影響既有 normalize-equal 配對與學習安全閘。
 *
 *   ⚠️ CHANGE-105（2026-07-16）：`office` / `branch` 由 generic 改列「營運單位區分詞」——
 *   移出 {@link GENERIC_COMPANY_TOKENS}。業務認定「X Office」與「X Ltd」可能是不同法人／
 *   計費實體，故不再自動吸收：core 因多出 office/branch 而變子集 → 落 GRAY → PENDING 人工
 *   確認，而非 AUTO 併入。純地區詞（hong/kong/hk）與法定後綴仍視為同實體、照常吸收。
 *
 *   輸入約定：本工具的函式接收「已由 `normalizeCompanyName` 正規化後」的字串
 *   （小寫、去括號內容 / 法定後綴、空白分隔）。呼叫端先正規化再傳入。
 *
 * @module src/services/similarity/token-set
 * @since CHANGE-103 Phase 2 (2026-07-16)
 * @lastModified 2026-07-16
 */

/**
 * Generic 公司名 token（純地區詞）——計算 core token 時剔除。
 * @description
 *   這些詞不是公司的「專有名」，同一公司常帶不同組合（(HK) / Hong Kong），剔除後才能讓
 *   「CEVA Logistics」與「CEVA Logistics Hong Kong」的 core 相等。
 *   法定後綴（ltd/limited/operations/...）已由 `normalizeCompanyName` 先行去除，不在此列。
 *   ⚠️ 專有分支詞（pacific / richasia / asia 等）**不**列入，以免把不同實體誤判為同一公司。
 *   ⚠️ CHANGE-105：`office` / `branch` 亦**不**列入（營運單位可能是不同法人／計費實體）——
 *   「X Office」與「X Ltd」不再自動吸收為同一公司，改落 GRAY 人工審核。
 */
export const GENERIC_COMPANY_TOKENS: ReadonlySet<string> = new Set([
  'hong',
  'kong',
  'hongkong',
  'hk',
  'warehouse',
  'terminal',
  'group',
  'holdings',
  'holding',
  'international',
  'intl',
  'global',
  'the',
]);

/** 公司名配對分層結果 */
export type CompanyMatchTier = 'AUTO' | 'GRAY' | 'NONE';

/**
 * 把（已正規化的）公司名切成 token 陣列（去空白、去空字串）。
 * @param normalized - 已由 normalizeCompanyName 正規化的字串
 */
export function tokenizeCompanyName(normalized: string): string[] {
  if (!normalized) return [];
  return normalized.split(/\s+/).filter(Boolean);
}

/**
 * 計算 core token 集合（token 集合減去 {@link GENERIC_COMPANY_TOKENS}）。
 * @param normalized - 已正規化的公司名
 * @returns 專有名 token 的 Set（可能為空）
 */
export function coreTokens(normalized: string): Set<string> {
  return new Set(
    tokenizeCompanyName(normalized).filter((t) => !GENERIC_COMPANY_TOKENS.has(t))
  );
}

/** 兩個集合是否相等（同大小且元素全含） */
export function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** a 是否為 b 的子集（a ⊆ b） */
export function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Jaccard 相似度（交集 / 聯集），0–1。僅供觀察 / 除錯用，配對決策以
 * {@link classifyCompanyMatch} 為準。
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 分層判斷候選公司名與既有公司名是否為同一公司（CHANGE-103 Phase 2 組件 2，D1 保守）。
 *
 * @param candidateNorm - 候選（GPT 讀到的）已正規化公司名
 * @param existingNorm - 既有公司的已正規化名（可傳 name 或某個 nameVariant）
 * @returns
 *   - `'AUTO'`：core token 集合相等 → 可自動配到既有公司
 *   - `'GRAY'`：一方 core 為另一方的嚴格子集（某方多出專有 token） → 灰帶，建 PENDING 人工審核
 *   - `'NONE'`：core 為空、或無子集關係 → 視為無關（不由本工具配對）
 */
export function classifyCompanyMatch(
  candidateNorm: string,
  existingNorm: string
): CompanyMatchTier {
  const xCore = coreTokens(candidateNorm);
  const cCore = coreTokens(existingNorm);

  // 任一方無專有 token（如僅由 generic 詞組成）→ 不足以判定，交回既有 Levenshtein / 正規化路徑
  if (xCore.size === 0 || cCore.size === 0) return 'NONE';

  if (setsEqual(xCore, cCore)) return 'AUTO';

  // 一方 core 為另一方嚴格子集 → 某方多出專有 token（如 +pacific / +ricon）→ 灰帶
  if (isSubset(cCore, xCore) || isSubset(xCore, cCore)) return 'GRAY';

  return 'NONE';
}
