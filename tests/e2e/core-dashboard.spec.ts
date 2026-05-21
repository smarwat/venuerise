/**
 * Phase 9T — Core dashboard runtime QA.
 *
 * Covers the end-to-end "I create a lead and move it through the
 * pipeline" workflow. Anything more ambitious (AI generation,
 * realtime updates, drag-and-drop reordering) is deliberately out
 * of scope — those need dedicated suites.
 */
import { test, expect } from '@playwright/test'
import { gotoDashboard } from './helpers/auth'
import { SEL, E2E_PREFIX } from './helpers/selectors'

// Tag every console error so the test reporter shows where a failure
// originated. We do NOT install a blanket allowlist — see the
// per-page filter inside beforeEach.
test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text()
      // Narrow allowlist — known noisy upstream warnings only.
      if (
        text.includes('hydrat') &&
        text.includes('extension')
      ) {
        // Browser-extension hydration noise. Not our bug.
        return
      }
      errors.push(`console.error: ${text}`)
    }
  })
  // Surface collected errors on test failure.
  ;(page as unknown as { __e2eErrors?: string[] }).__e2eErrors = errors
})

test.afterEach(async ({ page }, info) => {
  if (info.status === 'failed') {
    const errors = (page as unknown as { __e2eErrors?: string[] }).__e2eErrors
    if (errors?.length) {
      console.error('Runtime errors captured during failing test:', errors)
    }
  }
})

test.describe('Core dashboard', () => {
  test('overview loads + key cards render', async ({ page }) => {
    await gotoDashboard(page, '/dashboard')
    // Page header is the simplest "did the dashboard layout render"
    // signal. Anything more specific (specific card text) drifts
    // with copy changes.
    await expect(page.locator('h1, h2').first()).toBeVisible()
  })

  test('command palette opens via keyboard shortcut', async ({ page }) => {
    await gotoDashboard(page, '/dashboard')
    // Cmd/Ctrl+K — the CommandPalette listens on both via its
    // mod-key handler.
    const isMac = process.platform === 'darwin'
    await page.keyboard.press(isMac ? 'Meta+K' : 'Control+K')
    // The palette mounts a dialog with a search input; we tolerate
    // a few markup choices rather than a strict testid (palette UI
    // has changed shape across phases).
    await expect(
      page.getByPlaceholder(/search|find/i).or(page.getByRole('dialog'))
    ).toBeVisible({ timeout: 4_000 })
  })

  test('create a lead via Add Lead modal → drawer opens → close strips url', async ({
    page,
  }) => {
    await gotoDashboard(page, '/dashboard/leads')

    const email = `e2e-${Date.now()}@venuerise-e2e.test`
    const name = `${E2E_PREFIX.LEAD} ${Date.now()}`

    await page.click(SEL.ADD_LEAD_BUTTON)
    await expect(page.locator(SEL.ADD_LEAD_MODAL)).toBeVisible()

    await page.fill(SEL.LEAD_NAME_INPUT, name)
    await page.fill(SEL.LEAD_EMAIL_INPUT, email)
    // Event date: 90 days from now in YYYY-MM-DD.
    const eventDate = new Date(Date.now() + 90 * 86_400_000)
      .toISOString()
      .slice(0, 10)
    await page.fill(SEL.LEAD_EVENT_DATE_INPUT, eventDate)
    await page.fill(SEL.LEAD_GUEST_COUNT_INPUT, '150')
    await page.fill(SEL.LEAD_BUDGET_INPUT, '25000')
    await page.fill(SEL.LEAD_NOTES_INPUT, 'Created by Phase 9T E2E suite')

    // Submit and wait for the POST round-trip.
    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/leads') && res.request().method() === 'POST'
      ),
      page.click(SEL.LEAD_SUBMIT_BUTTON),
    ])
    await expect(page.locator(SEL.ADD_LEAD_MODAL)).toBeHidden()

    // The new card should appear on the board. We narrow by the
    // unique email so we never collide with a real lead.
    const card = page.locator(SEL.KANBAN_CARD_BY_EMAIL(email))
    await expect(card).toBeVisible({ timeout: 5_000 })

    // Open the drawer.
    await card.click()
    await expect(page.locator(SEL.LEAD_DETAIL_DRAWER)).toBeVisible()
    await expect(page).toHaveURL(/lead=/)

    // Close via the backdrop (matches the close-button behavior).
    await page.locator(SEL.LEAD_DRAWER_BACKDROP_CLOSE).click()
    await expect(page.locator(SEL.LEAD_DETAIL_DRAWER)).toBeHidden()
    await expect(page).not.toHaveURL(/lead=/)
  })
})
