// Sentry — Edge runtime (middleware and edge functions).
//
// VenueRise's `middleware.ts` runs in the edge runtime. The edge bundle is
// much smaller than the Node SDK and intentionally has fewer integrations.
import * as Sentry from '@sentry/nextjs'
import { sentryBeforeSend } from './lib/observability/sentry'

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: !!process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  release:
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.NEXT_PUBLIC_APP_VERSION ??
    'development',
  tracesSampleRate: Number(process.env.SENTRY_TRACES ?? 0.1),
  sendDefaultPii: false,
  beforeSend: sentryBeforeSend,
  debug: process.env.SENTRY_DEBUG === '1',
})
