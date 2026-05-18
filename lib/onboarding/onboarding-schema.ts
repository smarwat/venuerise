import { z } from 'zod'

/**
 * Phase 6C — onboarding payload schema.
 *
 * The shape a newly authenticated user POSTs to /api/onboarding/create-workspace.
 * Defaults intentionally lean "premium wedding venue" so that minimal-input
 * sign-ups still get a usable workspace (AI persona name, tone, KB rows,
 * tour availability, etc. all fall back to sensible values).
 *
 * Validation rules:
 *   - venue_name required, 1–100 chars
 *   - capacity_min >= 1, capacity_max >= capacity_min
 *   - base_price >= 0
 *   - timezone nonempty
 *   - style_tags / amenities each capped at 20 entries
 *
 * Returning the full discriminator object (vs a transform) so the API route
 * can hand the parsed object straight to the service layer without re-validation.
 */

const MAX_ARRAY_LEN = 20

export const OnboardingPayloadSchema = z
  .object({
    venue_name: z.string().min(1).max(100),
    description: z
      .string()
      .max(2000)
      .default('A premium wedding and event venue.'),
    capacity_min: z.number().int().min(1).default(50),
    capacity_max: z.number().int().min(1).default(250),
    base_price: z.number().min(0).default(15000),
    price_per_guest: z.number().min(0).optional().nullable(),
    timezone: z.string().min(1).default('America/Chicago'),
    ai_persona_name: z.string().min(1).max(50).default('Sophia'),
    ai_tone: z.string().min(1).max(50).default('warm_luxury'),
    style_tags: z.array(z.string().min(1).max(40)).max(MAX_ARRAY_LEN).default([]),
    amenities: z.array(z.string().min(1).max(40)).max(MAX_ARRAY_LEN).default([]),
  })
  .superRefine((d, ctx) => {
    if (d.capacity_max < d.capacity_min) {
      ctx.addIssue({
        code: 'custom',
        message: 'capacity_max must be greater than or equal to capacity_min',
        path: ['capacity_max'],
      })
    }
  })

export type OnboardingPayload = z.infer<typeof OnboardingPayloadSchema>
