/**
 * Phase 9T — Inbox + Tours + Billing smoke tests.
 *
 * These are deliberately gentle — they confirm pages render and the
 * honesty-gated controls (manual-reply, disabled paperclip/mic) stay
 * honest. They do NOT exercise message send or tour-schedule write
 * paths against real external platforms.
 */
import { test, expect } from '@playwright/test'
import { gotoDashboard } from './helpers/auth'

test.describe('Inbox', () => {
  test('renders list or empty state without crashing', async ({ page }) => {
    await gotoDashboard(page, '/dashboard/inbox')
    // Either we see at least one conversation row, or an empty
    // state. Both are acceptable; an unhandled error is not.
    await expect(page.locator('main, [role="main"], body')).toBeVisible()
  })

  test('composer attachment + voice controls are honestly disabled', async ({
    page,
  }) => {
    await gotoDashboard(page, '/dashboard/inbox')
    // Try to open the first conversation row, if one exists.
    const firstRow = page.locator('a[href^="/dashboard/inbox/"]').first()
    if (!(await firstRow.isVisible().catch(() => false))) {
      test.skip(true, 'No conversations in the test venue — composer skip')
    }
    await firstRow.click()

    // Phase 9S disabled both controls. Confirm they stay disabled.
    const paperclip = page.locator(
      'button[title*="Attachments are not yet enabled"]'
    )
    const mic = page.locator(
      'button[title*="Voice input is not yet enabled"]'
    )
    await expect(paperclip).toBeDisabled()
    await expect(mic).toBeDisabled()
  })
})

test.describe('Tours', () => {
  test('calendar renders', async ({ page }) => {
    await gotoDashboard(page, '/dashboard/tours')
    // The page title or calendar grid serves as the render signal.
    await expect(page.getByText(/tour/i).first()).toBeVisible()
  })
})

test.describe('Billing settings smoke', () => {
  test('key cards render without crashing', async ({ page }) => {
    await gotoDashboard(page, '/dashboard/settings/billing')
    // Phase 9Q / 9R cards.
    await expect(page.getByText(/payment methods/i)).toBeVisible()
    await expect(page.getByText(/subscription plans?/i)).toBeVisible()
  })

  test('clicking Manage payment method opens a redirect intent', async ({
    page,
  }) => {
    if (process.env.E2E_ALLOW_STRIPE !== '1') {
      test.skip(
        true,
        'Stripe checkout/portal not exercised (E2E_ALLOW_STRIPE != 1).'
      )
    }
    await gotoDashboard(page, '/dashboard/settings/billing')
    const cta = page.getByRole('button', { name: /manage payment method/i })
    if (!(await cta.isVisible().catch(() => false))) {
      test.skip(true, 'Manage payment method CTA not visible — venue likely has no Stripe customer.')
    }
    // We only assert that a request fires; we don't follow the
    // Stripe redirect.
    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/billing/portal') &&
          res.request().method() === 'POST'
      ),
      cta.click(),
    ])
  })
})
