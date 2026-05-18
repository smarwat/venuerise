// Sentry — server (Node) runtime.
//
// Loaded by `instrumentation.ts` when NEXT_RUNTIME === 'nodejs'.
// Safe to ship without SENTRY_DSN: init() with `dsn: undefined` is a no-op.
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
  // Conservative trace sampling for cost control. Override via SENTRY_TRACES.
  tracesSampleRate: Number(process.env.SENTRY_TRACES ?? 0.1),
  // PII is already scrubbed by `sentryBeforeSend`; keep this off as defense
  // in depth so the SDK doesn't auto-add the user IP or default IPs from
  // `request.headers["x-forwarded-for"]`.
  sendDefaultPii: false,
  // beforeSend gets every event before transport — last line of redaction.
  beforeSend: sentryBeforeSend,
  // Quieter in dev unless explicitly opted in (SENTRY_DEBUG=1).
  debug: process.env.SENTRY_DEBUG === '1',
})
