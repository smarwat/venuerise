/**
 * Next.js instrumentation hook (Phase 5C).
 *
 * Loaded by Next 16 at server boot (Node) and at every edge function
 * cold-start. `register()` is the canonical place to wire APM SDKs.
 *
 * We dynamic-import the right Sentry config per runtime so we don't
 * pull the Node SDK into the edge bundle (or vice versa).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}

/**
 * Optional: re-export Sentry's `onRequestError` so Next 16's built-in
 * request-error pipeline forwards uncaught route exceptions to Sentry
 * without us wrapping every handler manually.
 */
export { captureRequestError as onRequestError } from '@sentry/nextjs'
