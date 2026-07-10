/**
 * @fileoverview Playwright E2E 測試配置（Epic 23 - Story 23.2）
 * @description
 *   本專案首個 E2E 框架。以 dev 模式啟動本 worktree 的 Next.js dev server
 *   （非復用既有 3200，避免跑到其他 worktree 的 code），並先執行 auth.setup 登入
 *   globalAdmin（dev 模式：任意 email 即獲全權限），把 session 存成 storageState
 *   供各 spec 復用。
 *
 *   前置：
 *   - worktree 需有可用 `.env`（連 DB + Azure AD 未配 → dev 認證模式生效）
 *   - Docker PostgreSQL（ai-doc-extraction-db, 5433）需運行
 *   - Playwright chromium 已安裝
 *
 * @module playwright.config
 * @since Epic 23 - Story 23.2
 */

import { defineConfig, devices } from '@playwright/test'

/** E2E dev server 端口（可用 E2E_PORT 覆蓋；預設冷門端口避免與 3200 衝突） */
const PORT = Number(process.env.E2E_PORT ?? 3319)
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests/e2e',
  // 流程 spec 有狀態依賴（建立→操作→清理），序列化執行
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    navigationTimeout: 60_000,
    actionTimeout: 20_000,
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'tests/e2e/.auth/user.json',
      },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    // 繞過 package.json dev script 寫死的 3200；dev 模式由 NODE_ENV=development（next dev 預設）觸發
    command: `npx next dev --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    // webServer.env 注入 process.env，優先於 .env 檔（next 不覆蓋既有 process.env）。
    env: {
      // 覆蓋複製自主 repo .env 的 AUTH_URL/NEXTAUTH_URL（指向 3200），
      // 否則登入後 NextAuth redirect 到 E2E server 以外的位址（ERR_CONNECTION_REFUSED）。
      AUTH_URL: BASE_URL,
      NEXTAUTH_URL: BASE_URL,
      AUTH_TRUST_HOST: 'true',
      // 清空 Azure AD 憑證 → isAzureADConfigured()=false → 恢復 dev 認證模式：
      // login 頁顯示 DevLoginForm（僅 email），auth.ts 對 dev-user-1 自動賦予 isGlobalAdmin。
      AZURE_AD_CLIENT_ID: '',
      AZURE_AD_CLIENT_SECRET: '',
      AZURE_AD_TENANT_ID: '',
    },
  },
})
