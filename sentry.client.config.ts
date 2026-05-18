// Sentry — browser runtime.
//
// Loaded automatically by `@sentry/nextjs` when present at project root.
// Trace sampling is lower than the server because each browser session
// would otherwise be its own trace.
import * as Sentry from '@sentry/nextjs'
import { sentryBeforeSend } from './lib/observability/sentry'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN ?? process.env.SENTRY_DSN,
  enabled: !!(process.env.NEXT_PUBLIC_SENTRY_DSN ?? process.env.SENTRY_DSN),
  environment: process.env.NODE_ENV,
  release:
    process.env.NEXT_PUBLIC_APP_VERSION ?? 'development',
  tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES ?? 0.01),
  // Browser never sees credentials — but redact anyway for defense in depth.
  sendDefaultPii: false,
  beforeSend: sentryBeforeSend,
  debug: false,
})
