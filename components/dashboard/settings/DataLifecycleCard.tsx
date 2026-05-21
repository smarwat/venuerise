'use client'

import { useCallback, useState } from 'react'
import {
  Loader2,
  AlertTriangle,
  Download,
  Database,
  Archive,
  Eraser,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'

/**
 * Phase 9D — Data lifecycle controls (admin-only).
 *
 * Three sections in one card:
 *   1. Venue export — POST /api/admin/data-export with an optional
 *      include_audit_events toggle, browser-side JSON download.
 *   2. Lead PII redaction info — explains the redaction endpoint
 *      lives at `/api/admin/leads/[leadId]/redact-pii`. We don't
 *      ship a bulk redaction UI in this phase (one lead at a time
 *      by design — every redaction needs operator intent).
 *   3. Retention posture — static lines describing what gets
 *      retained, what gets archived, what the mirror state is. The
 *      server-rendered billing page passes `auditMirrorEnabled` +
 *      `digestRetentionEnabled` so the card stays a pure client
 *      component without a new admin endpoint.
 *
 * ── COPY POSTURE ─────────────────────────────────────────────────────────
 * Operational language only. No "GDPR compliant" claims, no "SOC 2
 * ready" pitches — those are the operator's call when they look at
 * their own contracts. The card describes what the system does,
 * not what the result legally means.
 */

interface DataLifecycleCardProps {
  /** Server-side env reads, passed down by the billing page. */
  auditMirrorEnabled: boolean
  digestRetentionEnabled: boolean
}

type ExportState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'success'
      generatedAt: string
      sectionCounts: Record<string, number>
      estimatedBytes: number
    }

export default function DataLifecycleCard({
  auditMirrorEnabled,
  digestRetentionEnabled,
}: DataLifecycleCardProps) {
  const [includeAuditEvents, setIncludeAuditEvents] = useState(false)
  const [exportState, setExportState] = useState<ExportState>({ kind: 'idle' })

  const handleExport = useCallback(async () => {
    setExportState({ kind: 'loading' })
    try {
      const res = await fetch('/api/admin/data-export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ include_audit_events: includeAuditEvents }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: unknown; message?: unknown }
          | null
        const code =
          body && typeof body.error === 'string'
            ? body.error
            : `HTTP ${res.status}`
        const detail =
          body && typeof body.message === 'string'
            ? ` — ${body.message}`
            : ''
        setExportState({ kind: 'error', message: `${code}${detail}` })
        return
      }
      const body = (await res.json()) as {
        generated_at: string
        venue_id: string
        summary: {
          section_counts: Record<string, number>
          estimated_bytes: number
        }
        export: unknown
      }
      // Browser-side download. Trigger via a synthetic anchor click;
      // works in every modern browser without needing the operator
      // to grant a clipboard-style permission.
      const blob = new Blob([JSON.stringify(body.export, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const dateSlug = body.generated_at.slice(0, 10)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `venuerise-export-${body.venue_id.slice(0, 8)}-${dateSlug}.json`
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      // Defer revoke a tick — Safari needs the blob alive past
      // the click handler.
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setExportState({
        kind: 'success',
        generatedAt: body.generated_at,
        sectionCounts: body.summary.section_counts,
        estimatedBytes: body.summary.estimated_bytes,
      })
    } catch (err) {
      setExportState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      })
    }
  }, [includeAuditEvents])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
            <Database className="h-4 w-4" />
          </div>
          <div>
            <CardTitle>Data lifecycle</CardTitle>
            <CardSubtitle>
              Export, PII redaction, retention posture. Operational tooling — not legal advice.
            </CardSubtitle>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* ── EXPORT ───────────────────────────────────────────────── */}
        <section className="border-b border-slate-100 pb-5">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Download className="h-4 w-4 text-slate-500" />
            Venue data export
          </div>
          <p className="text-xs text-slate-500">
            JSON snapshot of leads, conversations, messages, tours, AI
            actions, and operational audit feeds — scoped to this venue
            only. Includes message bodies + lead PII (this is an
            owner-requested export).
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleExport}
              disabled={exportState.kind === 'loading'}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {exportState.kind === 'loading' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {exportState.kind === 'loading' ? 'Exporting…' : 'Export venue data'}
            </button>
            <label className="inline-flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={includeAuditEvents}
                onChange={(e) => setIncludeAuditEvents(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300"
              />
              Include enterprise audit events
            </label>
          </div>

          {exportState.kind === 'error' && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <div>
                <div className="font-medium">Export failed</div>
                <div>{exportState.message}</div>
              </div>
            </div>
          )}
          {exportState.kind === 'success' && (
            <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
              <div className="font-medium">
                Export downloaded ({Math.round(exportState.estimatedBytes / 1024).toLocaleString()} KB)
              </div>
              <div className="mt-0.5 text-emerald-800/80">
                Rows:{' '}
                {Object.entries(exportState.sectionCounts)
                  .map(([k, v]) => `${k}=${v.toLocaleString()}`)
                  .join(' · ')}
              </div>
            </div>
          )}
        </section>

        {/* ── PII REDACTION INFO ─────────────────────────────────── */}
        <section className="border-b border-slate-100 py-5">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Eraser className="h-4 w-4 text-slate-500" />
            Lead PII redaction
          </div>
          <p className="text-xs text-slate-500">
            Removes the lead&apos;s name, email, phone, and notes
            while preserving stage, score, conversation history, and
            tour records. The lead row stays — operational analytics
            still work after redaction. Audit history is preserved
            (we keep the proof the redaction happened).
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Trigger from the lead drawer (admin role only) or POST to{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">
              /api/admin/leads/{'{leadId}'}/redact-pii
            </code>
            . One lead at a time — no bulk redaction yet.
          </p>
        </section>

        {/* ── RETENTION POSTURE ──────────────────────────────────── */}
        <section className="pt-5">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Archive className="h-4 w-4 text-slate-500" />
            Retention posture
          </div>
          <dl className="mt-2 space-y-2 text-xs">
            <PostureRow
              label="Audit mirror"
              status={auditMirrorEnabled ? 'enabled' : 'disabled'}
              detail={
                auditMirrorEnabled
                  ? 'Every audit_events row is copied to audit_event_mirror (owner-only RLS).'
                  : 'AUDIT_MIRROR_ENABLED is off. Set to 1 to enable best-effort mirroring.'
              }
            />
            <PostureRow
              label="Digest retention"
              status={digestRetentionEnabled ? 'enabled' : 'disabled'}
              detail={
                digestRetentionEnabled
                  ? 'Old digest_audit_events rows are archived by the Inngest retention job (see RUNBOOK).'
                  : 'DIGEST_RETENTION_DAYS not set. Old rows accumulate until the cron starts archiving.'
              }
            />
            <PostureRow
              label="Audit log"
              status="retained"
              detail="audit_events rows are not auto-deleted. Manual purge via SQL editor only."
            />
            <PostureRow
              label="PII redaction"
              status="available"
              detail="Soft redaction via the endpoint above. No automatic redaction policy."
            />
          </dl>
        </section>
      </CardContent>
    </Card>
  )
}

function PostureRow({
  label,
  status,
  detail,
}: {
  label: string
  status: 'enabled' | 'disabled' | 'retained' | 'available'
  detail: string
}) {
  const statusClass =
    status === 'enabled' || status === 'available'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : status === 'retained'
        ? 'bg-slate-50 text-slate-700 border-slate-200'
        : 'bg-slate-50 text-slate-500 border-slate-200'
  return (
    <div className="grid grid-cols-[140px_auto_1fr] items-baseline gap-3">
      <dt className="text-slate-700">{label}</dt>
      <dd>
        <span
          className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${statusClass}`}
        >
          {status}
        </span>
      </dd>
      <dd className="text-slate-500">{detail}</dd>
    </div>
  )
}
