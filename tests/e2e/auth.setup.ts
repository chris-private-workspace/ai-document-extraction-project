/**
 * @fileoverview E2E 認證 setup（Epic 23 - Story 23.2）
 * @description
 *   登入一次 dev 模式帳號（任意 email → auth.ts 自動賦予 isGlobalAdmin + 全權限），
 *   把 session cookie 存成 storageState 供各 spec 復用，避免每個 test 重複登入。
 *
 *   登入表單於 dev 模式為 DevLoginForm（僅 #email）；若切至 LoginForm（含 #password），
 *   一併填入（dev 模式 authorize 不驗密碼，任意值即可）。
 *
 * @module tests/e2e/auth.setup
 * @since Epic 23 - Story 23.2
 */

import { test as setup } from '@playwright/test'
import path from 'path'

const authFile = path.join(__dirname, '.auth', 'user.json')

setup('authenticate as global admin (dev mode)', async ({ page }) => {
  await page.goto('/en/auth/login')

  await page.locator('#email').fill('e2e-admin@example.com')

  const password = page.locator('#password')
  if ((await password.count()) > 0) {
    await password.fill('dev')
  }

  // DevLoginForm 與 LoginForm 皆以 form 內 submit 按鈕提交
  await page.locator('form').locator('button[type="submit"]').first().click()

  // 登入成功後導向 dashboard（i18n router 會補 locale 前綴）
  await page.waitForURL('**/dashboard**', { timeout: 60_000 })

  await page.context().storageState({ path: authFile })
})
