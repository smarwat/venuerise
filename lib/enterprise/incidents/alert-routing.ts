import 'server-only'
import * as Sentry from '@sentry/nextjs'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import {
  DEFAULT_ALERT_ROUTES,
  severityAtLeast,
} from '@/lib/enterprise/incidents/policy'
import type {
  AlertChannel,
  AlertDeliveryStatus,
  IncidentRecord,
} from '@/lib/enterprise/incidents/types'

/**
 * Phase 9L — Incident alert routing.
 *
 * Sends a CONCISE alert payload to the configured channels.
 * Env-gated end-to-end:
 *
 *   - `INCIDENT_ALERTS_ENABLED=true` is the master toggle. When
 *     not set to a truthy value, every channel returns
 *     `skipped_disabled` and no network calls fire.
 *   - `INCIDENT_SLACK_WEBHOOK_URL` enables Slack delivery.
 *   - `INCIDENT_PAGERDUTY_ROUTING_KEY` enables PagerDuty.
 *   - Sentry breadcrumb/capture uses the existing
 *     `@sentry/nextjs` SDK that is initialised earlier in the
 *     app lifecycle; no additional env var is required, but the
 *     master toggle still applies.
 *
 * Honesty rules:
 *   - The alert payload includes ONLY the operator-readable
 *     fields: id, title, severity, status, category, source,
 *     created time, dashboard URL. Full message bodies +
 *     customer content NEVER leave the building.
 *   - Webhook URLs and routing keys are NEVER returned, NEVER
 *     logged, NEVER stored in `incident_alert_deliveries`. The
 *     stored `target` is the operator-readable label only.
 *   - Failures are caught, recorded as `failed` with a short
 *     sanitised error string, and never throw.
 *
 * The helper records each attempt in
 * `incident_alert_deliveries` (best-effort) AND appends a
 * timeline event (best-effort via the helper here, fire-and-
 * forget at the call site).
 */

const SLACK_LABEL = '#incident-alerts'
const PAGERDUTY_LABEL = 'venuerise-platform'
const SENTRY_LABEL = 'venuerise (issues)'

function alertsEnabled(): boolean {
  const v = process.env.INCIDENT_ALERTS_ENABLED
  if (!v) return false
  return v.toLowerCase() === 'true' || v === '1'
}

function dashboardUrl(): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? null
  if (!base) return null
  return `${base.replace(/\/+$/, '')}/dashboard/settings/billing`
}

function buildPayload(incident: IncidentRecord): Record<string, unknown> {
  // Buyer-/operator-safe alert body. NEVER includes description
  // free text from the operator (could carry sensitive
  // context); only the title + structural identifiers.
  return {
    incident_id: incident.id,
    title: incident.title,
    severity: incident.severity,
    status: incident.status,
    category: incident.category,
    source: incident.source,
    detected_at: incident.detectedAt,
    opened_at: incident.openedAt,
    dashboard_url: dashboardUrl(),
  }
}

function sanitiseError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.slice(0, 200)
  }
  return String(err).slice(0, 200)
}

async function recordDelivery(
  incidentId: string,
  channel: AlertChannel,
  status: AlertDeliveryStatus['outcome'],
  target: string | null,
  error: string | null
): Promise<void> {
  try {
    const supabase = createServiceClient()
    const { error: insErr } = await supabase
      .from('incident_alert_deliveries')
      .insert({
        incident_id: incidentId,
        channel,
        status,
        target,
        error,
        metadata: {},
      })
    if (insErr) {
      log.warn(
        { err: insErr, incidentId, channel, status },
        'incident_alert_delivery.insert_failed'
      )
    }
  } catch (err) {
    log.warn({ err }, 'incident_alert_delivery.unexpected')
  }
}

// ── Slack ────────────────────────────────────────────────────────────────

export async function sendSlackIncidentAlert(
  incident: IncidentRecord
): Promise<AlertDeliveryStatus> {
  const attemptedAt = new Date().toISOString()
  if (!alertsEnabled()) {
    await recordDelivery(
      incident.id,
      'slack',
      'skipped_disabled',
      SLACK_LABEL,
      null
    )
    return {
      channel: 'slack',
      outcome: 'skipped_disabled',
      target: SLACK_LABEL,
      error: null,
      attemptedAt,
    }
  }
  const url = process.env.INCIDENT_SLACK_WEBHOOK_URL
  if (!url) {
    await recordDelivery(
      incident.id,
      'slack',
      'skipped_unconfigured',
      SLACK_LABEL,
      null
    )
    return {
      channel: 'slack',
      outcome: 'skipped_unconfigured',
      target: SLACK_LABEL,
      error: null,
      attemptedAt,
    }
  }
  try {
    const payload = buildPayload(incident)
    const text = `*[${incident.severity.toUpperCase()}] ${incident.title}*\nstatus: \`${incident.status}\` · category: \`${incident.category}\` · source: \`${incident.source}\``
    const body = {
      text,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `id: \`${incident.id}\` · detected: ${incident.detectedAt}${payload.dashboard_url ? ` · <${String(payload.dashboard_url)}|open dashboard>` : ''}`,
            },
          ],
        },
      ],
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = `slack:${res.status}`
      await recordDelivery(incident.id, 'slack', 'failed', SLACK_LABEL, err)
      return {
        channel: 'slack',
        outcome: 'failed',
        target: SLACK_LABEL,
        error: err,
        attemptedAt,
      }
    }
    await recordDelivery(incident.id, 'slack', 'sent', SLACK_LABEL, null)
    return {
      channel: 'slack',
      outcome: 'sent',
      target: SLACK_LABEL,
      error: null,
      attemptedAt,
    }
  } catch (err) {
    const message = sanitiseError(err)
    await recordDelivery(incident.id, 'slack', 'failed', SLACK_LABEL, message)
    log.warn({ err }, 'slack_incident_alert.unexpected')
    return {
      channel: 'slack',
      outcome: 'failed',
      target: SLACK_LABEL,
      error: message,
      attemptedAt,
    }
  }
}

// ── PagerDuty ────────────────────────────────────────────────────────────

export async function sendPagerDutyIncidentAlert(
  incident: IncidentRecord
): Promise<AlertDeliveryStatus> {
  const attemptedAt = new Date().toISOString()
  if (!alertsEnabled()) {
    await recordDelivery(
      incident.id,
      'pagerduty',
      'skipped_disabled',
      PAGERDUTY_LABEL,
      null
    )
    return {
      channel: 'pagerduty',
      outcome: 'skipped_disabled',
      target: PAGERDUTY_LABEL,
      error: null,
      attemptedAt,
    }
  }
  const routingKey = process.env.INCIDENT_PAGERDUTY_ROUTING_KEY
  if (!routingKey) {
    await recordDelivery(
      incident.id,
      'pagerduty',
      'skipped_unconfigured',
      PAGERDUTY_LABEL,
      null
    )
    return {
      channel: 'pagerduty',
      outcome: 'skipped_unconfigured',
      target: PAGERDUTY_LABEL,
      error: null,
      attemptedAt,
    }
  }
  try {
    const pdSeverity =
      incident.severity === 'sev1'
        ? 'critical'
        : incident.severity === 'sev2'
          ? 'error'
          : incident.severity === 'sev3'
            ? 'warning'
            : 'info'
    const body = {
      routing_key: routingKey,
      event_action: 'trigger',
      dedup_key: incident.id,
      payload: {
        summary: `[${incident.severity.toUpperCase()}] ${incident.title}`,
        source: 'venuerise',
        severity: pdSeverity,
        component: incident.category,
        group: incident.source,
        custom_details: buildPayload(incident),
      },
    }
    const res = await fetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = `pagerduty:${res.status}`
      await recordDelivery(
        incident.id,
        'pagerduty',
        'failed',
        PAGERDUTY_LABEL,
        err
      )
      return {
        channel: 'pagerduty',
        outcome: 'failed',
        target: PAGERDUTY_LABEL,
        error: err,
        attemptedAt,
      }
    }
    await recordDelivery(
      incident.id,
      'pagerduty',
      'sent',
      PAGERDUTY_LABEL,
      null
    )
    return {
      channel: 'pagerduty',
      outcome: 'sent',
      target: PAGERDUTY_LABEL,
      error: null,
      attemptedAt,
    }
  } catch (err) {
    const message = sanitiseError(err)
    await recordDelivery(
      incident.id,
      'pagerduty',
      'failed',
      PAGERDUTY_LABEL,
      message
    )
    log.warn({ err }, 'pagerduty_incident_alert.unexpected')
    return {
      channel: 'pagerduty',
      outcome: 'failed',
      target: PAGERDUTY_LABEL,
      error: message,
      attemptedAt,
    }
  }
}

// ── Sentry ───────────────────────────────────────────────────────────────

export async function sendSentryBreadcrumbOrCapture(
  incident: IncidentRecord
): Promise<AlertDeliveryStatus> {
  const attemptedAt = new Date().toISOString()
  if (!alertsEnabled()) {
    await recordDelivery(
      incident.id,
      'sentry',
      'skipped_disabled',
      SENTRY_LABEL,
      null
    )
    return {
      channel: 'sentry',
      outcome: 'skipped_disabled',
      target: SENTRY_LABEL,
      error: null,
      attemptedAt,
    }
  }
  try {
    const level: Sentry.SeverityLevel =
      incident.severity === 'sev1' || incident.severity === 'sev2'
        ? 'error'
        : 'warning'
    Sentry.withScope((scope) => {
      scope.setTag('incident_id', incident.id)
      scope.setTag('incident_severity', incident.severity)
      scope.setTag('incident_status', incident.status)
      scope.setTag('incident_source', incident.source)
      scope.setLevel(level)
      // Use captureMessage so the Sentry inbox carries a
      // deduplicable record. We do NOT pass the incident
      // description (could contain operator-pasted PII).
      Sentry.captureMessage(`[${incident.severity}] ${incident.title}`)
    })
    await recordDelivery(incident.id, 'sentry', 'sent', SENTRY_LABEL, null)
    return {
      channel: 'sentry',
      outcome: 'sent',
      target: SENTRY_LABEL,
      error: null,
      attemptedAt,
    }
  } catch (err) {
    const message = sanitiseError(err)
    await recordDelivery(
      incident.id,
      'sentry',
      'failed',
      SENTRY_LABEL,
      message
    )
    log.warn({ err }, 'sentry_incident_alert.unexpected')
    return {
      channel: 'sentry',
      outcome: 'failed',
      target: SENTRY_LABEL,
      error: message,
      attemptedAt,
    }
  }
}

// ── Roll-up ──────────────────────────────────────────────────────────────

/**
 * Iterate the DEFAULT_ALERT_ROUTES matrix; for each route whose
 * min-severity threshold the incident meets, attempt delivery
 * via the matching channel helper.
 *
 * Always returns one status per ROUTE (even when skipped) so
 * the caller can record the full attempt list in the timeline.
 */
export async function routeIncidentAlert(
  incident: IncidentRecord
): Promise<AlertDeliveryStatus[]> {
  const out: AlertDeliveryStatus[] = []
  for (const route of DEFAULT_ALERT_ROUTES) {
    if (!severityAtLeast(incident.severity, route.minSeverity)) {
      out.push({
        channel: route.channel,
        outcome: 'skipped_severity',
        target: route.targetLabel,
        error: null,
        attemptedAt: new Date().toISOString(),
      })
      continue
    }
    if (route.channel === 'slack') {
      out.push(await sendSlackIncidentAlert(incident))
    } else if (route.channel === 'pagerduty') {
      out.push(await sendPagerDutyIncidentAlert(incident))
    } else if (route.channel === 'sentry') {
      out.push(await sendSentryBreadcrumbOrCapture(incident))
    }
  }
  return out
}
