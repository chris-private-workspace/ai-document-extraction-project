/**
 * @fileoverview Vitest 地基 smoke test（Story 22-5）
 * @description
 *   驗證 Vitest 框架在本專案可運作：基本 assertion、globals、
 *   以及 vite-tsconfig-paths 對 `@/*` alias 的解析（Tech Spec 標記的
 *   Vitest × Next.js 15 相容性風險點）。
 *
 * @module tests/unit/smoke
 * @since Epic 22 - Story 22-5
 */
import { describe, it, expect } from 'vitest'

describe('Vitest 地基 smoke test', () => {
  it('執行基本 assertion（globals 可用）', () => {
    expect(1 + 1).toBe(2)
  })

  it('解析 @/ path alias 並載入專案模組', async () => {
    // 透過 vite-tsconfig-paths 解析 @/*；i18n/config 為純 TS、無 server-only 依賴
    const { defaultLocale, locales } = await import('@/i18n/config')
    expect(defaultLocale).toBe('en')
    expect(locales).toContain('zh-TW')
  })
})
