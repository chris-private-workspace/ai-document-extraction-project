/**
 * @fileoverview CHANGE-103 Phase 2 組件 2（token-set 配對）單元測試
 * @description
 *   驗證 classifyCompanyMatch / coreTokens 等以真實 Azure CEVA + DHL 案例校準的行為：
 *   - 明確 CEVA 變體（地區/後綴差異）→ AUTO
 *   - RICHASIA / RICON / OCR 亂碼（多出專有 token）→ GRAY
 *   - DHL 四寫法（FIX-077 迴歸）→ AUTO，零回歸
 *   輸入為「normalizeCompanyName 正規化後」字串（本工具契約）。
 *
 * @module tests/unit/services/token-set.test
 * @since CHANGE-103 Phase 2
 */
import { describe, it, expect } from 'vitest'
import {
  coreTokens,
  setsEqual,
  isSubset,
  jaccardSimilarity,
  classifyCompanyMatch,
} from '@/services/similarity/token-set'

describe('CHANGE-103 Phase 2 組件 2：token-set 工具', () => {
  describe('coreTokens（剔除 generic 純地區詞）', () => {
    it('should strip region words (hong/kong) leaving proprietary tokens', () => {
      expect([...coreTokens('ceva logistics hong kong')].sort()).toEqual([
        'ceva',
        'logistics',
      ])
    })
    it('should keep office/branch as distinguishing tokens (CHANGE-105)', () => {
      expect([...coreTokens('ceva logistics hong kong office')].sort()).toEqual([
        'ceva',
        'logistics',
        'office',
      ])
      expect([...coreTokens('ceva logistics branch')].sort()).toEqual([
        'branch',
        'ceva',
        'logistics',
      ])
    })
    it('should keep proprietary branch words (pacific)', () => {
      expect([...coreTokens('ceva logistics pacific')].sort()).toEqual([
        'ceva',
        'logistics',
        'pacific',
      ])
    })
    it('should return empty set for generic-only (pure region) names', () => {
      expect(coreTokens('hong kong hk').size).toBe(0)
    })
  })

  describe('set helpers', () => {
    it('setsEqual', () => {
      expect(setsEqual(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true)
      expect(setsEqual(new Set(['a']), new Set(['a', 'b']))).toBe(false)
    })
    it('isSubset', () => {
      expect(isSubset(new Set(['a']), new Set(['a', 'b']))).toBe(true)
      expect(isSubset(new Set(['a', 'c']), new Set(['a', 'b']))).toBe(false)
    })
    it('jaccardSimilarity', () => {
      expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1)
      expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['a']))).toBeCloseTo(0.5)
    })
  })

  describe('classifyCompanyMatch（canonical = "ceva logistics"）', () => {
    const canon = 'ceva logistics'

    it.each([
      ['ceva logistics ceva logistics', 'AUTO'], // (HONG KONG) LIMITED（CEVA Logistics）
      ['ceva logistics hong kong', 'AUTO'], // CEVA Logistics Hong Kong Limited
      ['ceva logistics hong kong office', 'GRAY'], // CHANGE-105: office 為區分詞 → 灰帶
      ['ceva logistics office', 'GRAY'], // CHANGE-105: office 為區分詞 → 灰帶
      ['ceva logistics branch', 'GRAY'], // CHANGE-105: branch 為區分詞 → 灰帶
      ['ceva logistics pacific', 'GRAY'], // (RICHASIA) PACIFIC OPERATIONS LIMITED
      ['ceva logistics kong littd', 'GRAY'], // (香港) KONG LITTD（OCR 亂碼）
      ['ricon asia pacific ceva logistics', 'GRAY'], // RICON ...（CEVA LOGISTICS）
    ])('should classify "%s" as %s', (candidate, expected) => {
      expect(classifyCompanyMatch(candidate, canon)).toBe(expected)
    })

    it('should return NONE for a genuinely different company sharing one token', () => {
      expect(classifyCompanyMatch('ceva express', canon)).toBe('NONE')
    })
  })

  describe('DHL 迴歸（FIX-077，全部應 AUTO）', () => {
    const dhl = 'dhl express'
    it.each([
      'dhl express', // DHL EXPRESS (HK) LIMITED / (Hong Kong) Limited / (HK) OPERATIONS LTD. 皆正規化為此
    ])('should AUTO-match normalized "%s"', (candidate) => {
      expect(classifyCompanyMatch(candidate, dhl)).toBe('AUTO')
    })
  })
})
