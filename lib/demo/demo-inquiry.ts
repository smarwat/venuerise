/**
 * Phase 8B/8C — fixture pool for the demo-mode widget button.
 *
 * Each generator call returns a fresh widget payload with a unique email
 * (timestamp + random suffix) so the live widget intake creates a brand-
 * new lead every click — exercising the real AI qualification + follow-
 * up flow rather than mocking.
 *
 * Phase 8C: variants. The button now exposes three preset first-message
 * tones so a founder can demo distinct AI replies in sequence. Each
 * variant has its own budget + guest band tuned to feel realistic for
 * the scenario.
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

export type DemoInquiryVariant = 'garden' | 'greenhouse' | 'package'

interface VariantConfig {
  label: string
  message: string
  budgetMinThousands: number
  budgetMaxThousands: number
  guestMin: number
  guestMax: number
}

/**
 * Source of truth for the three variant payloads. Exported as a const so
 * the button UI can render labels from it without re-declaring.
 */
export const DEMO_INQUIRY_VARIANTS: Record<DemoInquiryVariant, VariantConfig> = {
  garden: {
    label: 'Garden venue inquiry',
    message:
      'We are looking for a romantic garden wedding venue with space for dinner and dancing.',
    budgetMinThousands: 18,
    budgetMaxThousands: 30,
    guestMin: 90,
    guestMax: 180,
  },
  greenhouse: {
    label: 'Greenhouse vibe',
    message:
      'We love the greenhouse look and want to know if you have fall dates available.',
    budgetMinThousands: 22,
    budgetMaxThousands: 42,
    guestMin: 120,
    guestMax: 240,
  },
  package: {
    label: 'All-inclusive package question',
    message:
      'Can you send information about pricing, catering, and tour availability? We are hoping for an all-inclusive package.',
    budgetMinThousands: 25,
    budgetMaxThousands: 50,
    guestMin: 100,
    guestMax: 220,
  },
}

export const DEMO_INQUIRY_VARIANT_ORDER: readonly DemoInquiryVariant[] = [
  'garden',
  'greenhouse',
  'package',
] as const

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
 * Build a realistic, unique widget payload for the demo button.
 *
 * `variant` is optional — when omitted (e.g. older Phase 8B callers),
 * one is picked at random so existing call sites keep working without
 * changes. The email always carries the `demo+live-` prefix so the
 * Phase 8A reset helper sweeps it up.
 */
export function buildDemoInquiry(
  venueId: string,
  variant?: DemoInquiryVariant
): DemoInquiryPayload {
  const v: DemoInquiryVariant = variant ?? pick(DEMO_INQUIRY_VARIANT_ORDER)
  const config = DEMO_INQUIRY_VARIANTS[v]

  const name = pick(NAMES)
  // 4–14 months from now, snapped to a date.
  const daysAhead = randIntInclusive(120, 420)
  // Budgets in 1k increments within the variant's band.
  const budget = randIntInclusive(config.budgetMinThousands, config.budgetMaxThousands) * 1000
  // Guests in steps of 5 within the variant's band.
  const guestSteps = Math.floor(config.guestMin / 5)
  const guestStepsMax = Math.floor(config.guestMax / 5)
  const guest_count = randIntInclusive(guestSteps, guestStepsMax) * 5
  // Stable but unique per click. Always falls into the demo+ pattern so
  // the Phase 8A reset (`email LIKE 'demo+%@venuerise.test'`) sweeps it up.
  const stamp = Date.now().toString(36)
  const suffix = Math.random().toString(36).slice(2, 6)
  const email = `demo+live-${v}-${stamp}-${suffix}@venuerise.test`

  return {
    venue_id: venueId,
    name,
    email,
    phone: '5555550100',
    event_date: isoDate(new Date(Date.now() + daysAhead * MS_DAY)),
    guest_count,
    budget,
    message: config.message,
  }
}
