/**
 * Phase 9T — Knowledge Base CRUD runtime QA.
 *
 * Mirrors the Phase 9T-alt QA checklist in docs/BILLING-QA.md.
 * Every row created carries the `E2E ` prefix so the afterEach
 * cleanup can find + remove it.
 */
import { test, expect } from '@playwright/test'
import { gotoDashboard } from './helpers/auth'
import { SEL, E2E_PREFIX } from './helpers/selectors'
import { cleanupKnowledgeEntriesByPrefix } from './helpers/seed'

// Auto-accept native confirms for delete actions.
test.beforeEach(async ({ page }) => {
  page.on('dialog', (dlg) => dlg.accept().catch(() => {}))
})

test.afterEach(async ({ page }) => {
  // Best-effort cleanup — never fail the run if a delete fails.
  await cleanupKnowledgeEntriesByPrefix(page, E2E_PREFIX.KB_TITLE).catch(
    () => {}
  )
})

test.describe('Settings → Knowledge Base', () => {
  test('add, edit, toggle, delete', async ({ page }) => {
    await gotoDashboard(page, '/dashboard/settings')
    await page.click(SEL.SETTINGS_TAB_KB)

    const title = `${E2E_PREFIX.KB_TITLE} ${Date.now()}`
    const initialContent =
      'Guests may park in the north lot for weekend tours.'
    const updatedContent = `${initialContent} Garage opens at 9am.`

    // Add
    await page.click(SEL.KB_ADD_BUTTON)
    await page.fill(SEL.KB_DRAFT_TITLE_INPUT, title)
    await page.fill(SEL.KB_DRAFT_CONTENT_INPUT, initialContent)
    await Promise.all([
      page.waitForResponse(
        (res) =>
          /\/api\/venues\/.+\/knowledge$/.test(res.url()) &&
          res.request().method() === 'POST'
      ),
      page.click(SEL.KB_DRAFT_SAVE_BUTTON),
    ])

    const row = page.locator(SEL.KB_ROW_BY_TITLE(title))
    await expect(row).toBeVisible({ timeout: 5_000 })

    // Edit content
    await row.locator(SEL.KB_ROW_EDIT).click()
    const editTextarea = page.locator(
      `[data-testid="kb-row"][data-kb-title="${title}"] textarea`
    )
    await editTextarea.fill(updatedContent)
    await Promise.all([
      page.waitForResponse(
        (res) =>
          /\/api\/venues\/.+\/knowledge\/.+$/.test(res.url()) &&
          res.request().method() === 'PATCH'
      ),
      page
        .locator(`[data-testid="kb-row"][data-kb-title="${title}"]`)
        .locator(SEL.KB_ROW_SAVE_EDIT)
        .click(),
    ])
    await expect(row).toContainText(updatedContent.slice(0, 30))

    // Toggle inactive
    await Promise.all([
      page.waitForResponse(
        (res) =>
          /\/api\/venues\/.+\/knowledge\/.+$/.test(res.url()) &&
          res.request().method() === 'PATCH'
      ),
      row.locator(SEL.KB_ROW_TOGGLE).click(),
    ])
    await expect(row).toHaveAttribute('data-kb-active', 'false')
    await expect(row).toContainText(/disabled/i)

    // Toggle back active
    await Promise.all([
      page.waitForResponse(
        (res) =>
          /\/api\/venues\/.+\/knowledge\/.+$/.test(res.url()) &&
          res.request().method() === 'PATCH'
      ),
      row.locator(SEL.KB_ROW_TOGGLE).click(),
    ])
    await expect(row).toHaveAttribute('data-kb-active', 'true')

    // Delete (dialog auto-accept via beforeEach)
    await Promise.all([
      page.waitForResponse(
        (res) =>
          /\/api\/venues\/.+\/knowledge\/.+$/.test(res.url()) &&
          res.request().method() === 'DELETE'
      ),
      row.locator(SEL.KB_ROW_DELETE).click(),
    ])
    await expect(row).toBeHidden({ timeout: 5_000 })
  })

  test('rejects empty content with inline validation', async ({ page }) => {
    await gotoDashboard(page, '/dashboard/settings')
    await page.click(SEL.SETTINGS_TAB_KB)
    await page.click(SEL.KB_ADD_BUTTON)

    // Title only — content empty. Save should stay disabled.
    await page.fill(SEL.KB_DRAFT_TITLE_INPUT, `${E2E_PREFIX.KB_TITLE} draft`)
    await expect(page.locator(SEL.KB_DRAFT_SAVE_BUTTON)).toBeDisabled()
  })
})
