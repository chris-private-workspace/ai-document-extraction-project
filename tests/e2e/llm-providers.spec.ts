/**
 * @fileoverview LLM Provider + 模型管理 E2E（Epic 23 - Story 23.2）
 * @description
 *   以 globalAdmin（dev 模式）走查 Story 23.2 完整流程：
 *   新增 provider → 進其模型管理子頁 → 新增／編輯（改標籤 + 停用 isEnabled）／刪除模型
 *   → 返回並刪除 provider（清理）。資料寫真 DB，故用唯一 timestamp 名並於末尾清理。
 *
 * @module tests/e2e/llm-providers.spec
 * @since Epic 23 - Story 23.2
 */

import { test, expect } from '@playwright/test'

test('LLM provider and model management CRUD flow', async ({ page }) => {
  test.setTimeout(180_000)

  const suffix = String(Date.now()).slice(-8)
  const providerName = `E2E Provider ${suffix}`
  const modelKey = `e2e-model-${suffix}`
  const modelLabel = `E2E Model ${suffix}`
  const modelLabelEdited = `${modelLabel} (edited)`

  // --- 1. Provider 管理頁 ---
  await page.goto('/en/admin/llm-providers')
  await expect(page.getByRole('heading', { name: 'LLM Providers' })).toBeVisible()

  // --- 2. 新增 provider（type 預設 AZURE_OPENAI，憑證留空）---
  await page.getByRole('button', { name: 'Add Provider' }).click()
  const providerDialog = page.getByRole('dialog')
  await expect(providerDialog).toBeVisible()
  await providerDialog.getByLabel('Name', { exact: true }).fill(providerName)
  await providerDialog.getByRole('button', { name: 'Save' }).click()

  // dialog 關閉、列表出現新 provider
  await expect(providerDialog).toBeHidden()
  const providerRow = page.getByRole('row').filter({ hasText: providerName })
  await expect(providerRow).toBeVisible()

  // --- 3. 進該 provider 的模型管理子頁（列 row 內唯一的 link = Manage models）---
  await providerRow.getByRole('link').first().click()
  await expect(page).toHaveURL(/\/admin\/llm-providers\/[^/]+\/models/)
  await expect(page.getByRole('heading', { name: /Models/ })).toBeVisible()
  await expect(page.getByText('No models configured')).toBeVisible()

  // --- 4. 新增 model（modelKey + label；maxTokens 有預設 8192）---
  await page.getByRole('button', { name: 'Add Model' }).click()
  const modelDialog = page.getByRole('dialog')
  await expect(modelDialog).toBeVisible()
  await modelDialog.getByLabel('Model Key').fill(modelKey)
  await modelDialog.getByLabel('Label', { exact: true }).fill(modelLabel)
  await modelDialog.getByRole('button', { name: 'Save' }).click()
  await expect(modelDialog).toBeHidden()

  const modelRow = page.getByRole('row').filter({ hasText: modelKey })
  await expect(modelRow).toBeVisible()
  await expect(modelRow).toContainText(modelLabel)
  await expect(modelRow).toContainText('Enabled')

  // --- 5. 編輯 model：改 label + 停用 isEnabled ---
  await modelRow.getByRole('button', { name: 'Edit' }).click()
  const editDialog = page.getByRole('dialog')
  await expect(editDialog).toBeVisible()
  await editDialog.getByLabel('Label', { exact: true }).fill(modelLabelEdited)
  await editDialog.getByRole('switch', { name: 'Enabled' }).click() // on → off
  await editDialog.getByRole('button', { name: 'Save' }).click()
  await expect(editDialog).toBeHidden()

  const editedRow = page.getByRole('row').filter({ hasText: modelKey })
  await expect(editedRow).toContainText(modelLabelEdited)
  await expect(editedRow).toContainText('Disabled')

  // --- 6. 刪除 model ---
  await editedRow.getByRole('button', { name: 'Delete' }).click()
  const confirmDialog = page.getByRole('alertdialog')
  await expect(confirmDialog).toBeVisible()
  await confirmDialog.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByRole('row').filter({ hasText: modelKey })).toHaveCount(0)

  // --- 7. 清理：返回 provider 列表並刪除 provider ---
  await page.getByRole('link', { name: /Back to providers/ }).click()
  await expect(page.getByRole('heading', { name: 'LLM Providers' })).toBeVisible()
  const cleanupRow = page.getByRole('row').filter({ hasText: providerName })
  await cleanupRow.getByRole('button', { name: 'Delete' }).click()
  const providerConfirm = page.getByRole('alertdialog')
  await expect(providerConfirm).toBeVisible()
  await providerConfirm.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByRole('row').filter({ hasText: providerName })).toHaveCount(0)
})
