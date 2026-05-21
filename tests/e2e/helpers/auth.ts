/**
 * Phase 9T — Auth helpers.
 *
 * We deliberately do NOT add a test-auth API route to production
 * code. Instead, every spec assumes a Playwright `storageState`
 * file at `.auth/admin.json`. Operators generate it once per
 * workstation with the steps in `docs/RUNBOOK.md` § Phase 9T.
 *
 * If the storage state is missing, Playwright will start the
 * suite from an unauthenticated session and every navigation to
 * `/dashboard/*` will redirect to `/login`. Specs detect that
 * early and fail with a clear message rather than time out on
 * missing UI.
 */
import { type Page, expect } from '@playwright/test'

/** Throw fast when storageState didn't actually authenticate us.
 *  Call this at the top of every spec that needs the dashboard. */
export async function assertAuthenticated(page: Page): Promise<void> {
  // If we land at /login after navigating to a dashboard route,
  // the storageState is stale or missing.
  if (page.url().includes('/login')) {
    throw new Error(
      'E2E auth missing: .auth/admin.json did not produce a logged-in session. ' +
        'Re-run `npx playwright codegen` and save state — see docs/RUNBOOK.md § Phase 9T.'
    )
  }
}

/** Goto a dashboard path with the auth sanity check baked in. */
export async function gotoDashboard(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await expect(page).not.toHaveURL(/\/login/, { timeout: 5_000 })
  await assertAuthenticated(page)
}
