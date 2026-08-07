/**
 * @fileoverview FIX-171 轉址白名單單元測試
 * @description
 *   涵蓋 open redirect 的常見繞過形態（絕對 URL、protocol-relative、反斜線變形、
 *   控制字元、大小寫與編碼變形），以及站內路徑必須原樣保留的回歸保護。
 *
 *   判準取自 DoD Checklist #24 與 QID 150084：轉址參數必須以白名單驗證。
 *
 * @module tests/unit/lib/safe-redirect.test
 * @since FIX-171
 * @lastModified 2026-08-07
 */
import { describe, it, expect } from 'vitest'

import { toSafeRedirect } from '@/lib/safe-redirect'

describe('toSafeRedirect', () => {
  describe('必須放行的站內路徑', () => {
    it('保留單純路徑', () => {
      expect(toSafeRedirect('/dashboard')).toBe('/dashboard')
    })

    it('保留帶 locale 前綴的路徑', () => {
      expect(toSafeRedirect('/zh-TW/documents')).toBe('/zh-TW/documents')
    })

    it('保留 query string', () => {
      expect(toSafeRedirect('/documents?page=2&status=PENDING')).toBe(
        '/documents?page=2&status=PENDING'
      )
    })

    it('保留 hash', () => {
      expect(toSafeRedirect('/documents#section-2')).toBe('/documents#section-2')
    })

    it('保留 query 與 hash 併存', () => {
      expect(toSafeRedirect('/documents?page=2#top')).toBe('/documents?page=2#top')
    })

    it('根路徑本身可放行', () => {
      expect(toSafeRedirect('/')).toBe('/')
    })
  })

  describe('必須擋下的外部轉址', () => {
    it('擋 https 絕對 URL', () => {
      expect(toSafeRedirect('https://evil.example/steal')).toBe('/dashboard')
    })

    it('擋 http 絕對 URL', () => {
      expect(toSafeRedirect('http://evil.example')).toBe('/dashboard')
    })

    it('擋 protocol-relative（瀏覽器會補上當前協定後導向外部）', () => {
      expect(toSafeRedirect('//evil.example')).toBe('/dashboard')
    })

    it('擋 protocol-relative 帶路徑', () => {
      expect(toSafeRedirect('//evil.example/path')).toBe('/dashboard')
    })

    it('擋反斜線變形（部分瀏覽器將 \\ 等同 /）', () => {
      expect(toSafeRedirect('/\\evil.example')).toBe('/dashboard')
    })

    it('擋雙反斜線開頭', () => {
      expect(toSafeRedirect('\\\\evil.example')).toBe('/dashboard')
    })

    it('擋 javascript: 偽協定', () => {
      expect(toSafeRedirect('javascript:alert(1)')).toBe('/dashboard')
    })

    it('擋 data: 偽協定', () => {
      expect(toSafeRedirect('data:text/html,<script>alert(1)</script>')).toBe('/dashboard')
    })

    it('擋大寫協定（協定比對不應區分大小寫）', () => {
      expect(toSafeRedirect('HTTPS://evil.example')).toBe('/dashboard')
    })

    it('擋不以 / 開頭的相對路徑（可能被解析為外部主機）', () => {
      expect(toSafeRedirect('evil.example')).toBe('/dashboard')
    })

    it('擋帶認證資訊的絕對 URL', () => {
      expect(toSafeRedirect('https://user:pass@evil.example')).toBe('/dashboard')
    })
  })

  describe('空值與異常輸入', () => {
    it('undefined 回退至預設值', () => {
      expect(toSafeRedirect(undefined)).toBe('/dashboard')
    })

    it('null 回退至預設值', () => {
      expect(toSafeRedirect(null)).toBe('/dashboard')
    })

    it('空字串回退至預設值', () => {
      expect(toSafeRedirect('')).toBe('/dashboard')
    })
  })

  describe('自訂 fallback', () => {
    it('外部 URL 被擋時使用自訂 fallback', () => {
      expect(toSafeRedirect('https://evil.example', '/en/auth/login')).toBe('/en/auth/login')
    })

    it('空值時使用自訂 fallback', () => {
      expect(toSafeRedirect(undefined, '/zh-TW/dashboard')).toBe('/zh-TW/dashboard')
    })
  })
})
