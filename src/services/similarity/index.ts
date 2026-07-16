/**
 * @fileoverview 相似度算法模組入口
 * @description
 *   匯出所有相似度計算相關功能：
 *   - Levenshtein 字串相似度
 *   - 數值相似度
 *   - 日期格式相似度
 *
 * @module src/services/similarity
 * @since Epic 4 - Story 4.3
 * @lastModified 2025-12-19
 */

// Levenshtein 字串相似度
export {
  levenshteinDistance,
  levenshteinSimilarity,
  calculateSimilarityWithThreshold,
  findSimilarStrings,
} from './levenshtein';

// 數值相似度
export {
  parseNumericValue,
  numericSimilarity,
  isPossiblyNumeric,
  detectNumericTransformPattern,
  formatNumericValue,
} from './numeric-similarity';

// 日期格式相似度
export {
  dateSimilarity,
  isPossiblyDate,
  detectDateFormatPattern,
  formatDate,
  getSupportedDateFormats,
} from './date-similarity';

// 公司名 token-set 相似度（CHANGE-103 Phase 2 組件 2）
export {
  GENERIC_COMPANY_TOKENS,
  tokenizeCompanyName,
  coreTokens,
  setsEqual,
  isSubset,
  jaccardSimilarity,
  classifyCompanyMatch,
  type CompanyMatchTier,
} from './token-set';
