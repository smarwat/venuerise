/**
 * Phase 9T — Playwright runtime QA configuration.
 *
 * Scope is **core operator workflows only** — see the per-file spec
 * docs for what each suite covers. Static UI + fetch-route scanners
 * still ship (Phase 9S); these tests prove the same surfaces actually
 * work in a real browser.
 *
 * Auth: tests assume a `storageState` JSON at `.auth/admin.json`.
 * Generate it locally once via `npx playwright codegen` (see
 * `docs/RUNBOOK.md` § Phase 9T) — we deliberately do NOT add a
 * test-auth route to production code.
 *
 * Env (read at test boot):
 *   E2E_BASE_URL                Default http://localhost:3000.
 *   E2E_ADMIN_EMAIL             Used only by helpers/auth.ts comments.
 *   E2E_ADMIN_PASSWORD          Same.
 *   E2E_VENUE_ID                Optional — only when a spec needs a
 *                               known venue id for cross-tenant probes.
 *   E2E_ALLOW_STRIPE            "1" to allow real Stripe checkout
 *                               assertions. Off by default.
 */
import { defineConfig, devices } from '@playwright/test'

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

export default defineConfig({
  testDir: './tests/e2e',
  // The bulk of the suite is read-mostly + DB writes scoped to the
  // `E2E ` prefix. Running serially per worker keeps the audit feed
  // and rate-limit buckets readable across runs.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // 1 retry locally to soak up the occasional realtime flake; 2 on CI
  // because the dashboard renders a lot of cards.
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    storageState: '.auth/admin.json',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Don't auto-start the dev server. Operators run `npm run dev` in
  // another terminal; auto-start tends to clobber an existing server
  // and we want the auth flow to be intentional.
})
