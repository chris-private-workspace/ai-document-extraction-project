/**
 * @fileoverview Vitest 測試框架配置（Story 22-5）
 * @description
 *   單元 / 整合測試配置。E2E 由 Playwright（tests/e2e）處理，不在此範圍。
 *   - environment 預設 node（安全 / 服務 / middleware 測試）；
 *     需要 DOM 的測試在檔案頂端用 `// @vitest-environment happy-dom` 指定
 *     （vitest 3.0+ 已移除 environmentMatchGlobs）。
 *   - path alias（@/*）由 vite-tsconfig-paths 解析。
 *   - coverage 採 istanbul（Windows 相容性較佳）。
 *
 * @module vitest.config
 * @since Epic 22 - Story 22-5
 * @lastModified 2026-06-12
 */
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  // @/* alias 直接映射 src（vite-tsconfig-paths 在 vitest 4.x 未生效，改用原生 resolve.alias）
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: [
      'tests/unit/**/*.{test,spec}.{ts,tsx}',
      'tests/integration/**/*.{test,spec}.{ts,tsx}',
    ],
    exclude: ['node_modules', 'dist', '.next', 'tests/e2e/**'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    pool: 'forks', // Windows + Prisma mock 相容
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: [
        'src/services/**/*.ts',
        'src/middlewares/**/*.ts',
        'src/lib/**/*.ts',
        'src/app/api/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.spec.ts',
        'tests/**',
        'prisma/migrations/**',
        '.next/**',
        'node_modules/**',
        'messages/**',
        '**/*.gen.ts',
        '**/index.ts',
      ],
      // ⚠️ 6 大安全測試（AC4-AC8）完成前覆蓋率未達標。
      // CI 的 tests.yml（AC9）待測試寫完才建立並 enforce，故此 threshold 目前不會 block。
      thresholds: {
        lines: 60,
        branches: 50,
        functions: 60,
        statements: 60,
      },
    },
  },
})
