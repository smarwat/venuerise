/**
 * Phase 8B — fixture pool for the demo-mode "Send test inquiry" button.
 *
 * Each generator call returns a fresh widget payload with a unique email
 * (timestamp + random suffix) so the live widget intake creates a brand-
 * new lead every click — exercising the real AI qualification + follow-
 * up flow rather than mocking. Names + messages cycle from small fixed
 * pools so the demo feels coherent without being repetitive.
 *
 * Plain TS, no `server-only` — the button lives in a client bundle.
 */

const NAMES: readonly string[] = [
  'Sophia Miller',
  'Emma Carter',
  'Olivia Bennett',
  'Maya Thompson',
  'Hannah Lewis',
  'Charlotte Reed',
  'Amelia Brooks',
]

const MESSAGES: readonly string[] = [
  'We are looking for a romantic garden wedding venue with space for dinner and dancing.',
  'We love the greenhouse look and want to know if you have fall dates available.',
  'Can you send information about pricing, catering, and tour availability?',
  "We are planning an intimate dinner reception for ~120 guests and would love to see the space.",
  'Do you offer all-inclusive packages? We want something turnkey for late spring.',
]

const MS_DAY = 24 * 60 * 60 * 1000

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randIntInclusive(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export interface DemoInquiryPayload {
  venue_id: string
  name: string
  email: string
  phone: string
  event_date: string // YYYY-MM-DD
  guest_count: number
  budget: number
  message: string
}

/**
 * Build a realistic, unique widget payload for the demo button. The
 * email always carries the `demo+live-` prefix so the Phase 8A reset
 * helper can clean it up if desired (matches `demo+%@venuerise.test`).
 */
export function buildDemoInquiry(venueId: string): DemoInquiryPayload {
  const name = pick(NAMES)
  const message = pick(MESSAGES)
  // 4–14 months from now, snapped to a date.
  const daysAhead = randIntInclusive(120, 420)
  // Budgets in 1k increments, $18k–$42k.
  const budget = randIntInclusive(18, 42) * 1000
  // Guests in steps of 5, 80–240.
  const guest_count = randIntInclusive(16, 48) * 5
  // Stable but unique per click. Always falls into the demo+ pattern so
  // the Phase 8A reset (`email LIKE 'demo+%@venuerise.test'`) sweeps it up.
  const stamp = Date.now().toString(36)
  const suffix = Math.random().toString(36).slice(2, 6)
  const email = `demo+live-${stamp}-${suffix}@venuerise.test`

  return {
    venue_id: venueId,
    name,
    email,
    phone: '5555550100',
    event_date: isoDate(new Date(Date.now() + daysAhead * MS_DAY)),
    guest_count,
    budget,
    message,
  }
}
