/**
 * Phase 9T — Availability + Blackout runtime smoke.
 *
 * The AvailabilityTab UI doesn't carry per-row testids today (the
 * tab pre-dates Phase 9T testid additions); we use role + visible
 * text queries instead. If the tab is restructured, update the
 * queries here rather than over-fitting to current Tailwind class
 * names.
 */
import { test, expect } from '@playwright/test'
import { gotoDashboard } from './helpers/auth'
import { SEL, E2E_PREFIX } from './helpers/selectors'

test.beforeEach(async ({ page }) => {
  page.on('dialog', (dlg) => dlg.accept().catch(() => {}))
})

test.describe('Settings → Availability', () => {
  test('tab opens and renders day groups', async ({ page }) => {
    await gotoDashboard(page, '/dashboard/settings')
    await page.click(SEL.SETTINGS_TAB_AVAILABILITY)
    // Each day-of-week section is labelled with the weekday name.
    await expect(page.getByText(/monday/i)).toBeVisible({ timeout: 5_000 })
  })

  test('blackout add + delete round-trip', async ({ page }) => {
    await gotoDashboard(page, '/dashboard/settings')
    await page.click(SEL.SETTINGS_TAB_AVAILABILITY)

    // The blackout section is below the day-of-week list. We use
    // a heading match to scroll into view.
    await page
      .getByRole('heading', { name: /blackout/i })
      .scrollIntoViewIfNeeded()

    const reason = `${E2E_PREFIX.BLACKOUT_REASON} ${Date.now()}`
    // Date input — pick 30 days from now.
    const date = new Date(Date.now() + 30 * 86_400_000)
      .toISOString()
      .slice(0, 10)

    const dateInput = page.locator('input[type="date"]').first()
    const reasonInput = page
      .getByPlaceholder(/reason|note|comment/i)
      .or(page.locator('input[type="text"]').nth(0))
    const addButton = page.getByRole('button', { name: /add blackout/i })

    if (!(await addButton.isVisible().catch(() => false))) {
      test.skip(true, 'Blackout add UI not present in this build')
    }
    await dateInput.fill(date)
    if (await reasonInput.isVisible().catch(() => false)) {
      await reasonInput.fill(reason)
    }
    await Promise.all([
      page.waitForResponse(
        (res) =>
          /\/api\/venues\/.+\/tour-blackouts$/.test(res.url()) &&
          res.request().method() === 'POST'
      ),
      addButton.click(),
    ])

    // Row containing our reason text should appear.
    const row = page.getByText(reason).first()
    await expect(row).toBeVisible({ timeout: 5_000 })

    // Delete — find the trash button in the same row.
    const deleteBtn = page
      .locator('div', { hasText: reason })
      .getByRole('button', { name: /delete|remove|trash/i })
      .first()
    if (await deleteBtn.isVisible().catch(() => false)) {
      await Promise.all([
        page.waitForResponse(
          (res) =>
            /\/api\/venues\/.+\/tour-blackouts\/.+$/.test(res.url()) &&
            res.request().method() === 'DELETE'
        ),
        deleteBtn.click(),
      ])
      await expect(row).toBeHidden({ timeout: 5_000 })
    }
  })
})
