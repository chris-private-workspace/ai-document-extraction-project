/**
 * @fileoverview Vitest 全域測試設定（Story 22-5）
 * @description
 *   全域 mock 與 hooks。預設 node 環境；DOM/組件測試相關（@testing-library cleanup）
 *   待組件測試導入時再於對應檔案或此處條件式加入。
 *
 * @module tests/setup
 * @since Epic 22 - Story 22-5
 * @lastModified 2026-06-12
 */
import { afterEach, beforeAll, vi } from 'vitest'

// 全域 mock：next/navigation（避免 server-only 導航 API 在測試環境報錯）
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

// 全域 mock：next-intl（翻譯函數回傳 key 本身，避免載入訊息檔）
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}))

beforeAll(() => {
  // 測試專用環境變數（不可用於生產）
  process.env.AUTH_SECRET = 'test-secret-do-not-use-in-prod'
})

afterEach(() => {
  vi.clearAllMocks()
})
