import 'server-only'
import pino, { type LoggerOptions } from 'pino'

/**
 * Centralized structured logger for the VenueRise server runtime (Phase 5A).
 *
 * Why pino:
 *   - JSON output by default → directly ingestable by Vercel / Fly / Datadog /
 *     OpenSearch / Loki without a transformer.
 *   - Sync-by-default in the absence of a transport → no event-loop surprises
 *     in serverless / edge-adjacent runtimes.
 *   - Built-in field redaction for safe accidental-key handling.
 *
 * Call shape (note: pino reverses console's arg order):
 *   log.info({ leadId, venueId }, 'lead.created')
 *   log.warn({ route: '/api/widget', reason }, 'widget.request.skipped')
 *   log.error({ err }, 'jobs.followup.failed')
 *
 * Marked `server-only` so an accidental client import fails the build —
 * pino pulls in Node-only APIs and we never want logs in the browser bundle.
 */

const isDev = process.env.NODE_ENV === 'development'

/**
 * Default log level by environment.
 * Override at runtime with LOG_LEVEL=debug|info|warn|error|silent.
 */
function resolveLevel(): LoggerOptions['level'] {
  const env = (process.env.LOG_LEVEL ?? '').trim().toLowerCase()
  if (
    env === 'fatal' ||
    env === 'error' ||
    env === 'warn' ||
    env === 'info' ||
    env === 'debug' ||
    env === 'trace' ||
    env === 'silent'
  ) {
    return env
  }
  return isDev ? 'debug' : 'info'
}

/**
 * Redact paths.
 *
 * Pino's redact is path-based (with `*` wildcard for one level), not value-
 * based. We list:
 *   1. common header fields that might appear if someone logs an entire
 *      request/response,
 *   2. common credential field names that might appear on err.config / err.req
 *      objects from SDK exceptions,
 *   3. the literal env-var names from .env.example so that
 *      `log.info(process.env, '...')` (never do this) is still safe,
 *   4. one-level wildcards under common containers (`headers.*`, `*.*`) for
 *      defense in depth.
 *
 * Anything that ends up at a path we didn't list (e.g. inside a deeply nested
 * object) won't be auto-redacted — so always pass small, intentional payloads.
 */
const redactPaths = [
  // Header names that may contain secrets
  'authorization',
  'cookie',
  'headers.authorization',
  'headers.cookie',
  'headers["x-venuerise-signature"]',
  'headers["svix-signature"]',
  'headers["svix-id"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-venuerise-signature"]',
  'req.headers["svix-signature"]',
  'request.headers.authorization',
  'request.headers.cookie',

  // Common credential field names (top-level and one-level nested)
  'token',
  'secret',
  'password',
  'apiKey',
  'api_key',
  'access_token',
  'refresh_token',
  'session_token',
  '*.token',
  '*.secret',
  '*.password',
  '*.apiKey',
  '*.api_key',
  '*.access_token',
  '*.refresh_token',
  '*.session_token',

  // Literal env-var names — defends against accidental `log.info(process.env, …)`.
  'INTERNAL_API_SECRET',
  'ANTHROPIC_API_KEY',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'UPSTASH_REDIS_REST_TOKEN',
  '*.INTERNAL_API_SECRET',
  '*.ANTHROPIC_API_KEY',
  '*.RESEND_API_KEY',
  '*.RESEND_WEBHOOK_SECRET',
  '*.SUPABASE_SERVICE_ROLE_KEY',
  '*.UPSTASH_REDIS_REST_TOKEN',
]

export const log = pino({
  level: resolveLevel(),
  // Stable per-process base — keeps every line tagged with the app + env so
  // log routers can filter without log-line surgery.
  base: {
    app: 'venuerise',
    env: process.env.NODE_ENV ?? 'unknown',
  },
  // ISO timestamps are friendlier than the default unix-ms for human eyes.
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
    remove: false,
  },
  // Pretty output is intentionally NOT auto-enabled — adding `pino-pretty`
  // would balloon the install and lose machine-parseability. Pipe locally:
  //   npm run dev | npx pino-pretty
  // if you want colorized logs in dev.
})

export type Logger = typeof log
