/** @type {import('next').NextConfig} */

// Phase 7A — production security headers.
// Phase 9E — added Content-Security-Policy-Report-Only telemetry,
//            expanded Permissions-Policy to cover bluetooth, and
//            documented the dedicated /api/security/csp-report sink.
//
// ── ENFORCED HEADERS ─────────────────────────────────────────────────────
// Every response carries:
//   - X-Content-Type-Options: nosniff
//   - Referrer-Policy: strict-origin-when-cross-origin
//   - Permissions-Policy: powerful APIs disabled by default
//   - Strict-Transport-Security: production only (would brick local dev)
//   - X-Frame-Options: SAMEORIGIN (catch-all; widget route omits it)
//   - Content-Security-Policy: frame-ancestors only (Phase 7A enforcement)
//
// ── REPORT-ONLY HEADER (Phase 9E) ────────────────────────────────────────
// A SEPARATE Content-Security-Policy-Report-Only header carries the
// fuller directive set. Browsers honour it for telemetry but DO NOT
// block resources — every violation hits `/api/security/csp-report`
// instead. This lets the operator see what a future enforced CSP
// would have broken before flipping the switch.
//
// We deliberately ship two distinct CSP headers (enforced
// `frame-ancestors` + report-only fuller set) because RFC 7231 +
// CSP3 allow multiple Content-Security-Policy and
// Content-Security-Policy-Report-Only headers; browsers union them.
// The split keeps the enforced surface narrow (frame protection only)
// and the report-only surface aspirational (eventual lockdown target).
//
// CSP intentionally keeps `'unsafe-inline'` + `'unsafe-eval'` for now:
//   1. Next.js inlines runtime <script>s with per-build hashes; setting
//      a strict script-src in next.config breaks every navigation. The
//      right home for a strict CSP is the experimental nonce
//      middleware (future phase).
//   2. Tailwind + Radix inject inline styles.
//
// The widget is embeddable on third-party venue sites; we omit both
// the enforced CSP frame-ancestors lockdown AND the report-only header
// on /widget/* because we cannot anticipate what every embedding
// page's resources look like.

const isProd = process.env.NODE_ENV === 'production'

// ── Supabase host derivation ─────────────────────────────────────────────
// Read at config time (Node runtime) so the CSP connect-src directive
// includes the project-specific Supabase host + its websocket origin.
// Falls back to '*.supabase.co' / '*.supabase.in' wildcards when the
// env var is missing — keeps local dev quiet on a missing
// NEXT_PUBLIC_SUPABASE_URL.
function deriveSupabaseConnectSources() {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!raw) {
    return [
      'https://*.supabase.co',
      'wss://*.supabase.co',
      'https://*.supabase.in',
      'wss://*.supabase.in',
    ]
  }
  try {
    const u = new URL(raw)
    return [
      `${u.protocol}//${u.host}`,
      `wss://${u.host}`,
    ]
  } catch {
    return ['https://*.supabase.co', 'wss://*.supabase.co']
  }
}

const SUPABASE_CONNECT = deriveSupabaseConnectSources()

// Report-only CSP. Aspirational — every directive describes what an
// eventual enforced policy would look like. Violations hit the report
// endpoint; nothing breaks.
const REPORT_ONLY_CSP = [
  `default-src 'self'`,
  // Next.js + framer-motion + Recharts ship inline scripts; we keep
  // 'unsafe-inline' + 'unsafe-eval' here so the report stream isn't
  // dominated by framework noise. A future phase replaces these with
  // per-request nonces via experimental middleware.
  `script-src 'self' 'unsafe-inline' 'unsafe-eval'`,
  // Tailwind / Radix / framer-motion inject inline styles.
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data: blob: https:`,
  `font-src 'self' data:`,
  // Browser-side connects: Supabase REST + Realtime websocket.
  // Anthropic + Resend + Stripe API are server-side only and don't
  // need a connect-src entry. Sentry's browser SDK posts to
  // ingest.sentry.io; we allow it conservatively.
  `connect-src 'self' ${SUPABASE_CONNECT.join(' ')} https://*.ingest.sentry.io https://*.ingest.us.sentry.io`,
  // Stripe Checkout + Billing Portal load in iframes during card
  // entry; allow them so report-only doesn't flag legitimate flow.
  `frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://checkout.stripe.com https://billing.stripe.com`,
  // No plugins.
  `object-src 'none'`,
  `base-uri 'self'`,
  // Form posts: dashboard self + Stripe Checkout/Portal redirects.
  `form-action 'self' https://checkout.stripe.com https://billing.stripe.com`,
  // Reporting destination. Modern browsers prefer the `report-to`
  // group; older browsers fall back to `report-uri`. Both point at
  // the same anonymous telemetry endpoint.
  `report-uri /api/security/csp-report`,
  `report-to csp-endpoint`,
].join('; ')

const REPORT_TO_HEADER = JSON.stringify({
  group: 'csp-endpoint',
  max_age: 10886400, // 18 weeks
  endpoints: [{ url: '/api/security/csp-report' }],
  include_subdomains: true,
})

const BASE_SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    // Disable powerful APIs by default; widget never needs them.
    // Phase 9E — added bluetooth=() to match the prompt's baseline.
    value: [
      'camera=()',
      'microphone=()',
      'geolocation=()',
      'payment=()',
      'usb=()',
      'bluetooth=()',
      'fullscreen=(self)',
    ].join(', '),
  },
]

// HSTS only in production — local dev over http would brick the site.
const PROD_ONLY_HEADERS = isProd
  ? [
      {
        key: 'Strict-Transport-Security',
        value: 'max-age=63072000; includeSubDomains; preload',
      },
    ]
  : []

// Frame protections. The embeddable widget needs `frame-ancestors *`, so we
// apply X-Frame-Options + CSP frame-ancestors selectively below.
const NON_WIDGET_FRAME_HEADERS = [
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
]

const WIDGET_FRAME_HEADERS = [
  // Intentionally permissive — venue websites embed the widget cross-origin.
  // CSP frame-ancestors * is the modern equivalent of removing XFO; we omit
  // X-Frame-Options entirely on this path so legacy browsers also allow it.
  { key: 'Content-Security-Policy', value: 'frame-ancestors *' },
]

// Phase 9E — report-only CSP applied only on non-widget surfaces. The
// widget is third-party-embeddable; we can't anticipate what every
// embedding page's resources look like, and we'd rather not poison
// the report feed with cross-origin embed noise.
const REPORT_ONLY_HEADERS = [
  { key: 'Content-Security-Policy-Report-Only', value: REPORT_ONLY_CSP },
  { key: 'Report-To', value: REPORT_TO_HEADER },
]

const nextConfig = {
  reactStrictMode: true,

  async headers() {
    // Header precedence in Next.js: when multiple `source` patterns match,
    // the LAST matching rule wins for any header key it defines. So put the
    // catch-all FIRST and the widget overrides LAST — that way `/widget/*`
    // and `/api/widget/*` get the base/HSTS headers from the catch-all and
    // then override Content-Security-Policy (frame-ancestors).
    //
    // Note: modern browsers prefer CSP `frame-ancestors` over the legacy
    // `X-Frame-Options` header when both are present, so the SAMEORIGIN
    // value carried over from the catch-all on widget responses is harmless.
    return [
      // Catch-all — strict frame protections + every base/HSTS header +
      // Phase 9E report-only CSP telemetry.
      {
        source: '/:path*',
        headers: [
          ...BASE_SECURITY_HEADERS,
          ...PROD_ONLY_HEADERS,
          ...NON_WIDGET_FRAME_HEADERS,
          ...REPORT_ONLY_HEADERS,
        ],
      },
      // Widget config API — base/HSTS only; CORS is per-route in handler.
      // No report-only CSP: see comment on REPORT_ONLY_HEADERS.
      {
        source: '/api/widget/:path*',
        headers: [...BASE_SECURITY_HEADERS, ...PROD_ONLY_HEADERS],
      },
      // Embeddable widget UI route — overrides CSP frame-ancestors so
      // third-party sites can iframe it. No report-only CSP either.
      {
        source: '/widget/:path*',
        headers: [...BASE_SECURITY_HEADERS, ...PROD_ONLY_HEADERS, ...WIDGET_FRAME_HEADERS],
      },
    ]
  },
}

module.exports = nextConfig
