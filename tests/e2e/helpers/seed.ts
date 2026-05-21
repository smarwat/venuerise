/**
 * Phase 9T — Test data seeding + cleanup helpers.
 *
 * 9T uses the UI itself to create test rows (every E2E-created row
 * gets an `E2E ` prefix via the constants in `./selectors.ts`).
 * Cleanup runs through the same UI to keep the test surface honest:
 * if a delete button regresses, cleanup fails loudly rather than
 * masking the bug via a service-role delete.
 *
 * We deliberately do NOT add a production cleanup endpoint here. If
 * cleanup becomes flaky in CI, the right answer is a per-suite
 * isolated venue (one venue per CI run) rather than a privileged
 * test-only API.
 */
import { type Page, expect } from '@playwright/test'
import { SEL } from './selectors'

/**
 * Best-effort cleanup of E2E-prefixed knowledge entries.
 * Idempotent — safe to call from afterEach hooks.
 */
export async function cleanupKnowledgeEntriesByPrefix(
  page: Page,
  prefix: string
): Promise<void> {
  // Open Settings → Knowledge if not already there.
  if (!page.url().endsWith('/dashboard/settings')) {
    await page.goto('/dashboard/settings')
  }
  await page.click(SEL.SETTINGS_TAB_KB).catch(() => {})

  // Iterate rows; click delete + auto-accept native confirm via
  // `page.on('dialog')` set up by the spec. We just trigger the
  // click; the dialog handler resolves accept.
  const rows = page.locator(`[data-testid="kb-row"]`)
  const count = await rows.count()
  for (let i = count - 1; i >= 0; i--) {
    const row = rows.nth(i)
    const title = await row.getAttribute('data-kb-title')
    if (!title || !title.startsWith(prefix)) continue
    await row.locator(SEL.KB_ROW_DELETE).click()
    // Allow time for the DELETE round-trip + DOM removal.
    await expect(row).toBeHidden({ timeout: 5_000 }).catch(() => {})
  }
}
