'use client'

import { useCallback, useState } from 'react'
import { Copy, Check, ExternalLink } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/dashboard/ui/Dialog'
import { Badge } from '@/components/dashboard/ui/Badge'

/**
 * Phase 8AF — DigestAuditEventDrawer
 *
 * Slide-in dialog over the `digest_audit_events` row most-recently
 * clicked in `DigestAuditLogCard`. Surfaces every field including a
 * pretty-printed `metadata` jsonb, two copy-to-clipboard buttons,
 * and (when `metadata.outbound_message_id` is present) a "View
 * related digest send" affordance that sets URL params so the
 * sibling `DigestAuditFeed` filters to the relevant row on the same
 * page.
 *
 * ── PII POSTURE ───────────────────────────────────────────────────────────
 * The drawer renders whatever the API returned. The API masks emails
 * at write time + at read time (`target_email_masked`), so this
 * drawer NEVER shows a raw address. The metadata JSON is also
 * pre-sanitized by `recordDigestAuditEvent` (Phase 8AC) — only
 * structural keys (route, counts, send_kind, outbound_message_id)
 * land in the column.
 *
 * No `dangerouslySetInnerHTML`. `metadata` is rendered as a
 * `<pre>{JSON.stringify(...)}</pre>` so any `<script>` payload
 * stays inert text.
 */

export interface DigestAuditEventDrawerItem {
  id: string
  venue_id: string
  actor_user_id: string | null
  actor_kind: 'operator' | 'cron' | 'system'
  action: string
  target_user_id: string | null
  target_email_masked: string | null
  reason: string | null
  metadata: Record<string, unknown> | null
  occurred_at: string
}

interface DigestAuditEventDrawerProps {
  open: boolean
  item: DigestAuditEventDrawerItem | null
  onClose: () => void
  /** Phase 8AF — dispatcher so the drawer can deep-link the sibling
   *  DigestAuditFeed without coupling to a router instance here.
   *  Called with the outbound_message_id (string) to drop into the
   *  send-feed `q` filter. */
  onViewRelatedSend?: (outboundMessageId: string) => void
}

function actorLabel(item: DigestAuditEventDrawerItem): string {
  if (item.actor_kind === 'cron') return 'Cron'
  if (item.actor_kind === 'system') return 'System'
  if (item.actor_user_id) return `Operator · ${item.actor_user_id.slice(0, 8)}`
  return 'Operator'
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

function readString(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null
  return v
}

export default function DigestAuditEventDrawer({
  open,
  item,
  onClose,
  onViewRelatedSend,
}: DigestAuditEventDrawerProps) {
  const [copyState, setCopyState] = useState<
    Record<'id' | 'metadata', 'idle' | 'copied' | 'error'>
  >({ id: 'idle', metadata: 'idle' })

  const copy = useCallback(
    async (key: 'id' | 'metadata', value: string) => {
      try {
        if (typeof navigator === 'undefined' || !navigator.clipboard) {
          throw new Error('clipboard_unavailable')
        }
        await navigator.clipboard.writeText(value)
        setCopyState((prev) => ({ ...prev, [key]: 'copied' }))
        setTimeout(
          () =>
            setCopyState((prev) =>
              prev[key] === 'copied' ? { ...prev, [key]: 'idle' } : prev
            ),
          1500
        )
      } catch {
        setCopyState((prev) => ({ ...prev, [key]: 'error' }))
        setTimeout(
          () =>
            setCopyState((prev) =>
              prev[key] === 'error' ? { ...prev, [key]: 'idle' } : prev
            ),
          2000
        )
      }
    },
    []
  )

  const outboundMessageId = item
    ? readString((item.metadata ?? {}).outbound_message_id)
    : null

  return (
    <Dialog open={open && item !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Digest audit event</DialogTitle>
          <DialogDescription>
            Full payload + related digest send link.
          </DialogDescription>
        </DialogHeader>

        {item && (
          <div className="space-y-4 text-[13px]">
            {/* Header row: action + actor + when. Mirrors the Phase
                8N TourAuditDrawer visual rhythm. */}
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={item.actor_kind === 'cron' ? 'navy' : 'blue'}>
                {item.action.replace(/_/g, ' ')}
              </Badge>
              <span className="text-[12px] text-[#475569]">
                {actorLabel(item)}
              </span>
              <span className="text-[#CBD5E1]">·</span>
              <span className="text-[12px] text-[#475569]">
                {formatTime(item.occurred_at)}
              </span>
            </div>

            <dl className="grid grid-cols-3 gap-x-4 gap-y-2 text-[12px]">
              <Field label="Event ID">
                <code className="text-[11px] text-[#0F172A] break-all">
                  {item.id}
                </code>
              </Field>
              <Field label="Venue ID">
                <code className="text-[11px] text-[#475569] break-all">
                  {item.venue_id}
                </code>
              </Field>
              <Field label="Actor kind">
                <span className="text-[#0F172A]">{item.actor_kind}</span>
              </Field>
              <Field label="Actor user ID">
                <code className="text-[11px] text-[#475569] break-all">
                  {item.actor_user_id ?? '—'}
                </code>
              </Field>
              <Field label="Target user ID">
                <code className="text-[11px] text-[#475569] break-all">
                  {item.target_user_id ?? '—'}
                </code>
              </Field>
              <Field label="Target email (masked)">
                <span className="text-[#0F172A]">
                  {item.target_email_masked ?? '—'}
                </span>
              </Field>
              <Field label="Reason" span={3}>
                <span className="text-[#475569]">{item.reason ?? '—'}</span>
              </Field>
            </dl>

            {/* Pretty-printed metadata. Two-space indent for
                scannability; max-height + overflow keeps a tall
                payload from blowing out the dialog. */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider">
                  Metadata
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      copy('id', item.id)
                    }
                    className="inline-flex items-center gap-1 text-[11px] text-[#475569] hover:text-[#0F172A] px-2 py-0.5 rounded border border-[#E2E8F0] hover:bg-[#F8FAFC]"
                  >
                    {copyState.id === 'copied' ? (
                      <>
                        <Check className="w-3 h-3 text-[#059669]" />
                        Copied
                      </>
                    ) : copyState.id === 'error' ? (
                      'Copy failed'
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        Copy audit ID
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      copy('metadata', JSON.stringify(item.metadata ?? {}, null, 2))
                    }
                    className="inline-flex items-center gap-1 text-[11px] text-[#475569] hover:text-[#0F172A] px-2 py-0.5 rounded border border-[#E2E8F0] hover:bg-[#F8FAFC]"
                  >
                    {copyState.metadata === 'copied' ? (
                      <>
                        <Check className="w-3 h-3 text-[#059669]" />
                        Copied
                      </>
                    ) : copyState.metadata === 'error' ? (
                      'Copy failed'
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        Copy metadata JSON
                      </>
                    )}
                  </button>
                </div>
              </div>
              <pre className="text-[11px] text-[#0F172A] bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-3 overflow-auto max-h-72 whitespace-pre-wrap break-words">
                {JSON.stringify(item.metadata ?? {}, null, 2)}
              </pre>
            </div>

            {/* View related digest send — only renders when
                metadata.outbound_message_id is present (cron / preview
                / manual send audit rows). Sets URL params on the
                billing page so DigestAuditFeed restores filtered to
                this specific outbound row. */}
            {outboundMessageId && onViewRelatedSend && (
              <div className="pt-2 border-t border-[#F1F5F9]">
                <button
                  type="button"
                  onClick={() => onViewRelatedSend(outboundMessageId)}
                  className="inline-flex items-center gap-1.5 text-[12px] text-[#1D4ED8] hover:text-[#1E40AF] px-2 py-1 rounded-lg hover:bg-[#EFF6FF]"
                  title="Filter the digest send feed to this outbound row"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  View related digest send
                </button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

interface FieldProps {
  label: string
  span?: 1 | 2 | 3
  children: React.ReactNode
}

function Field({ label, span = 1, children }: FieldProps) {
  const colClass =
    span === 3 ? 'col-span-3' : span === 2 ? 'col-span-2' : 'col-span-1'
  return (
    <div className={colClass}>
      <dt className="text-[10px] font-semibold text-[#94A3B8] uppercase tracking-wider">
        {label}
      </dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  )
}
