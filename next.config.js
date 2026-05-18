/** @type {import('next').NextConfig} */

// Phase 7A — production security headers.
//
// CSP intentionally kept relaxed (no script-src lockdown) because:
//   1. Next.js inlines runtime <script>s with per-build hashes; setting a
//      strict script-src in next.config breaks every navigation. The right
//      home for a strict CSP is the Next experimental nonce middleware,
//      tracked for a future phase.
//   2. The widget is embeddable on third-party venue sites; their CSP
//      governs *their* page, but the /widget/* route itself must not
//      ship X-Frame-Options: DENY (handled below — global headers exclude
//      that route, and frame-ancestors stays permissive for /widget/*).
//
// All other modern headers (X-Content-Type-Options, Referrer-Policy,
// Permissions-Policy, HSTS in production) ship on every response.

const isProd = process.env.NODE_ENV === 'production'

const BASE_SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    // Disable powerful APIs by default; widget never needs them.
    value: [
      'camera=()',
      'microphone=()',
      'geolocation=()',
      'payment=()',
      'usb=()',
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
      // Catch-all — strict frame protections + every base/HSTS header.
      {
        source: '/:path*',
        headers: [
          ...BASE_SECURITY_HEADERS,
          ...PROD_ONLY_HEADERS,
          ...NON_WIDGET_FRAME_HEADERS,
        ],
      },
      // Widget config API — base/HSTS only; CORS is per-route in handler.
      {
        source: '/api/widget/:path*',
        headers: [...BASE_SECURITY_HEADERS, ...PROD_ONLY_HEADERS],
      },
      // Embeddable widget UI route — overrides CSP frame-ancestors so
      // third-party sites can iframe it.
      {
        source: '/widget/:path*',
        headers: [...BASE_SECURITY_HEADERS, ...PROD_ONLY_HEADERS, ...WIDGET_FRAME_HEADERS],
      },
    ]
  },
}

module.exports = nextConfig
