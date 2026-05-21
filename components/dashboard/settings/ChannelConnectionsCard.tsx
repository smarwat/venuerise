'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Loader2,
  RefreshCw,
  Radio,
  Plug,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import ChannelSourceBadge from '../messages/ChannelSourceBadge'
import type {
  ChannelConnectionListSummary,
  ChannelConnectionRecord,
  ChannelType,
} from '@/lib/integrations/channels/types'

/**
 * Phase 8BE — ChannelConnectionsCard.
 *
 * Operator-facing inventory of channel posture. Lists every
 * supported channel from the capability matrix with its
 * inbound/outbound/manual-required posture and any existing
 * connection row. Lets owner/admin record a draft connection
 * label or flip status to disconnected/manual_only.
 *
 * Honesty UX:
 *   - Channels with `manualReplyRequired` carry an amber
 *     "Manual reply required" pill so the operator can't
 *     mistake them for direct-send-capable.
 *   - SCIM-style "Coming later" buttons are disabled until a
 *     real connector phase ships.
 *   - autonomous_sending_still_disabled note is rendered in
 *     the footer.
 */

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  connected: 'Connected',
  degraded: 'Degraded',
  disconnected: 'Disconnected',
  manual_only: 'Manual only',
}
const STATUS_TONE: Record<string, string> = {
  draft: 'bg-[#F1F5F9] text-[#475569] border-[#E2E8F0]',
  connected: 'bg-[#ECFDF5] text-[#047857] border-[#A7F3D0]',
  degraded: 'bg-[#FFFBEB] text-[#B45309] border-[#FDE68A]',
  disconnected: 'bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]',
  manual_only: 'bg-[#EFF6FF] text-[#1D4ED8] border-[#DBEAFE]',
}

interface DraftFormState {
  open: boolean
  channelType: ChannelType | ''
  label: string
  externalAccountId: string
}

const EMPTY_FORM: DraftFormState = {
  open: false,
  channelType: '',
  label: '',
  externalAccountId: '',
}

export default function ChannelConnectionsCard() {
  const [summary, setSummary] = useState<ChannelConnectionListSummary | null>(
    null
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<DraftFormState>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [savingRowId, setSavingRowId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/integrations/channels', {
        credentials: 'same-origin',
      })
      if (!res.ok) {
        setError(`Failed to load (${res.status})`)
        setSummary(null)
        return
      }
      const json = (await res.json()) as { summary: ChannelConnectionListSummary }
      setSummary(json.summary)
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const items = summary?.items ?? []
  const itemsWithConnection = useMemo(
    () => items.filter((i) => i.connection !== null),
    [items]
  )
  const itemsWithoutConnection = useMemo(
    () => items.filter((i) => i.connection === null),
    [items]
  )

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.channelType) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/integrations/channels', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel_type: form.channelType,
          external_account_label: form.label.trim() || null,
          external_account_id: form.externalAccountId.trim() || null,
          status: 'draft',
        }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as
          | { error?: string }
          | null
        setError(json?.error ?? 'create_failed')
        return
      }
      setForm(EMPTY_FORM)
      await load()
    } finally {
      setSubmitting(false)
    }
  }

  const patchRow = async (
    row: ChannelConnectionRecord,
    patch: Record<string, unknown>
  ) => {
    setSavingRowId(row.id)
    setError(null)
    try {
      const res = await fetch(`/api/admin/integrations/channels/${row.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as
          | { error?: string }
          | null
        setError(json?.error ?? 'update_failed')
        return
      }
      await load()
    } finally {
      setSavingRowId(null)
    }
  }

  return (
    <section className="bg-white border border-[#E2E8F0] rounded-2xl shadow-card p-6 space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold text-[#0F172A]">
              Channel connections
            </h2>
            <span className="inline-flex items-center gap-1 rounded-full bg-[#EFF6FF] text-[#1D4ED8] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
              <Radio className="w-2.5 h-2.5" />
              Foundation
            </span>
          </div>
          <p className="text-[12.5px] text-[#475569] mt-1 leading-relaxed">
            Where this venue receives inquiries and whether VenueRise can
            send replies back through each channel. Connection metadata
            only — no OAuth tokens, no secrets.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh"
          className="rounded-full border border-[#E2E8F0] bg-white p-1.5 text-[#475569] hover:text-[#0F172A] hover:bg-[#F1F5F9] transition-colors disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
        </button>
      </header>

      {error && (
        <div className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-[12px] text-[#B91C1C]">
          {error}
        </div>
      )}

      {/* Existing connections */}
      {itemsWithConnection.length > 0 && (
        <div>
          <p className="text-[10.5px] uppercase tracking-[0.16em] text-[#94A3B8] font-semibold mb-2">
            Active connections
          </p>
          <div className="space-y-2">
            {itemsWithConnection.map((item) => {
              const conn = item.connection!
              return (
                <ConnectionRow
                  key={conn.id}
                  channelType={item.channelType}
                  capabilities={item.capabilities}
                  connection={conn}
                  saving={savingRowId === conn.id}
                  onPatch={(patch) => patchRow(conn, patch)}
                />
              )
            })}
          </div>
        </div>
      )}

      {/* Unconnected channels */}
      {itemsWithoutConnection.length > 0 && (
        <div>
          <p className="text-[10.5px] uppercase tracking-[0.16em] text-[#94A3B8] font-semibold mb-2">
            Available channels
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {itemsWithoutConnection.map((item) => (
              <article
                key={item.channelType}
                className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <ChannelSourceBadge
                      channelType={item.channelType}
                      size="md"
                    />
                    {/* Phase 8BE-2 — clearer status label.
                        Phase 8BG — the_knot/weddingwire upgrade to
                        "Lead forwarding parser active" so the
                        deterministic parser surface is visible. */}
                    <span className="text-[11px] text-[#475569]">
                      {item.channelType === 'the_knot' ||
                      item.channelType === 'weddingwire'
                        ? 'Lead forwarding parser active'
                        : item.capabilities.inbound && !item.capabilities.outbound
                          ? 'Manual workflow active'
                          : item.capabilities.inbound && item.capabilities.outbound
                            ? 'Foundation active'
                            : 'Coming later'}
                    </span>
                    {(item.channelType === 'the_knot' ||
                      item.channelType === 'weddingwire') && (
                      <span className="text-[10.5px] text-[#94A3B8]">
                        · Outbound reply: manual · Parse confidence review:
                        active
                      </span>
                    )}
                  </div>
                  {item.manualReplyRequired && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full border border-[#FDE68A] bg-[#FFFBEB] text-[#B45309] px-2 py-0.5 text-[10px] font-semibold"
                      title="VenueRise cannot send back through this channel directly."
                    >
                      <AlertTriangle className="w-2.5 h-2.5" />
                      Manual reply
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-[#475569] leading-relaxed">
                  {item.capabilities.operatorNote}
                </p>
                <div className="flex items-center gap-2 text-[10.5px] text-[#64748B]">
                  <span>
                    Inbound:{' '}
                    <span
                      className={cn(
                        'font-semibold',
                        item.capabilities.inbound
                          ? 'text-[#047857]'
                          : 'text-[#94A3B8]'
                      )}
                    >
                      {item.capabilities.inbound ? 'supported' : 'not yet'}
                    </span>
                  </span>
                  <span aria-hidden>·</span>
                  <span>
                    Outbound:{' '}
                    <span
                      className={cn(
                        'font-semibold',
                        item.capabilities.outbound
                          ? 'text-[#047857]'
                          : 'text-[#B45309]'
                      )}
                    >
                      {item.capabilities.outbound ? 'supported' : 'manual'}
                    </span>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setForm({
                      open: true,
                      channelType: item.channelType,
                      label: '',
                      externalAccountId: '',
                    })
                  }
                  className="w-full inline-flex items-center justify-center gap-1.5 rounded-full border border-[#E2E8F0] bg-white px-3 py-1.5 text-[11.5px] font-medium text-[#0F172A] hover:bg-[#F1F5F9] transition-colors"
                >
                  <Plug className="w-3.5 h-3.5" />
                  Add manual connection
                </button>
              </article>
            ))}
          </div>
        </div>
      )}

      {/* Add-connection form */}
      {form.open && (
        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-4 space-y-3"
        >
          <div className="flex items-center justify-between">
            <p className="text-[12.5px] font-semibold text-[#0F172A]">
              New connection — {form.channelType || 'pick a channel'}
            </p>
            <button
              type="button"
              onClick={() => setForm(EMPTY_FORM)}
              className="text-[11px] text-[#475569] hover:text-[#0F172A]"
            >
              Cancel
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              type="text"
              placeholder="Account label (e.g. @venuename)"
              value={form.label}
              onChange={(e) =>
                setForm((f) => ({ ...f, label: e.target.value }))
              }
              className="rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-[12.5px] text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#1D4ED8]"
            />
            <input
              type="text"
              placeholder="External account id (optional)"
              value={form.externalAccountId}
              onChange={(e) =>
                setForm((f) => ({ ...f, externalAccountId: e.target.value }))
              }
              className="rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-[12.5px] text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#1D4ED8]"
            />
          </div>
          <p className="text-[10.5px] text-[#64748B]">
            No tokens or secrets — this records the connection
            posture only. OAuth flows ship in a later phase.
          </p>
          <button
            type="submit"
            disabled={submitting || !form.channelType}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#0F172A] px-3.5 py-1.5 text-[11.5px] font-semibold text-white hover:bg-[#1E293B] transition-colors disabled:opacity-50"
          >
            {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Save draft connection
          </button>
        </form>
      )}

      <footer className="border-t border-[#F1F5F9] pt-3 space-y-1.5">
        <p className="text-[10.5px] text-[#475569] leading-relaxed flex items-center gap-1.5">
          <CheckCircle2 className="w-3 h-3 text-[#047857]" />
          Autonomous sending stays disabled platform-wide. Channels without
          direct send support require explicit operator confirmation via
          the &ldquo;Mark sent manually&rdquo; workflow.
        </p>
        {summary?.disclaimer && (
          <p className="text-[10px] text-[#94A3B8] italic leading-relaxed">
            {summary.disclaimer}
          </p>
        )}
      </footer>
    </section>
  )
}

interface ConnectionRowProps {
  channelType: ChannelType
  capabilities: {
    displayName: string
    inbound: boolean
    outbound: boolean
    manualReplyRequired: boolean
    operatorNote: string
  }
  connection: ChannelConnectionRecord
  saving: boolean
  onPatch: (patch: Record<string, unknown>) => Promise<void>
}

// Phase 8BF — Meta-family identifier keys the admin route's
// metadata allowlist accepts. Keep this list in sync with
// `META_CONNECTION_METADATA_KEYS` in
// lib/integrations/channels/meta-connections.ts. Typing them
// explicitly here keeps the input order stable + lets the
// label/help-text live next to each field.
const META_METADATA_FIELDS: Array<{
  key: 'meta_page_id' | 'instagram_business_account_id' | 'meta_ad_account_id' | 'meta_app_id'
  label: string
  placeholder: string
}> = [
  { key: 'meta_page_id', label: 'Meta Page ID', placeholder: 'e.g. 1234567890' },
  {
    key: 'instagram_business_account_id',
    label: 'Instagram Business Account ID',
    placeholder: 'e.g. 178414...0234',
  },
  { key: 'meta_ad_account_id', label: 'Meta Ad Account ID', placeholder: 'e.g. act_1234567' },
  { key: 'meta_app_id', label: 'Meta App ID', placeholder: 'e.g. 4242424242' },
]

const META_FAMILY: ReadonlyArray<ChannelType> = [
  'instagram',
  'facebook',
  'meta_lead_ads',
]

function ConnectionRow({
  channelType,
  capabilities,
  connection,
  saving,
  onPatch,
}: ConnectionRowProps) {
  const [label, setLabel] = useState(connection.externalAccountLabel ?? '')
  const isMeta = META_FAMILY.includes(channelType)

  // Phase 8BF — local Meta-identifier form state. Initialised
  // from the saved metadata so the operator can edit + save
  // without clobbering other (non-Meta) keys. Save merges back
  // into the existing metadata object.
  const [metaForm, setMetaForm] = useState<Record<string, string>>(() => {
    if (!isMeta) return {}
    const md = (connection.metadata ?? {}) as Record<string, unknown>
    const initial: Record<string, string> = {}
    for (const f of META_METADATA_FIELDS) {
      const v = md[f.key]
      initial[f.key] = typeof v === 'string' ? v : ''
    }
    return initial
  })

  const metaDirty = isMeta
    ? META_METADATA_FIELDS.some((f) => {
        const saved = ((connection.metadata ?? {}) as Record<string, unknown>)[
          f.key
        ]
        const savedStr = typeof saved === 'string' ? saved : ''
        return (metaForm[f.key] ?? '') !== savedStr
      })
    : false

  const handleSaveMeta = () => {
    const merged: Record<string, unknown> = {
      ...(connection.metadata ?? {}),
    }
    for (const f of META_METADATA_FIELDS) {
      const v = (metaForm[f.key] ?? '').trim()
      if (v.length === 0) delete merged[f.key]
      else merged[f.key] = v
    }
    void onPatch({ metadata: merged })
  }

  return (
    <article className="rounded-xl border border-[#E2E8F0] bg-white p-3 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <ChannelSourceBadge channelType={channelType} size="md" />
          <div className="min-w-0">
            <p className="text-[12.5px] font-semibold text-[#0F172A] truncate">
              {connection.externalAccountLabel ?? capabilities.displayName}
            </p>
            <p className="text-[10.5px] text-[#94A3B8] truncate">
              {connection.externalAccountId ?? 'no external account id'}
            </p>
          </div>
          {capabilities.manualReplyRequired && (
            <span className="inline-flex items-center gap-1 rounded-full border border-[#FDE68A] bg-[#FFFBEB] text-[#B45309] px-2 py-0.5 text-[10px] font-semibold">
              Manual reply
            </span>
          )}
        </div>

        <span
          className={cn(
            'inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider',
            STATUS_TONE[connection.status] ?? STATUS_TONE.draft
          )}
        >
          {STATUS_LABEL[connection.status] ?? connection.status}
        </span>

        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label"
            className="rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1 text-[11.5px] text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#1D4ED8] w-32"
          />
          <button
            type="button"
            onClick={() => void onPatch({ external_account_label: label.trim() || null })}
            disabled={saving || label === (connection.externalAccountLabel ?? '')}
            className="rounded-full border border-[#E2E8F0] bg-white px-2.5 py-1 text-[11px] font-medium text-[#0F172A] hover:bg-[#F1F5F9] disabled:opacity-50"
          >
            Save label
          </button>
          {connection.status !== 'disconnected' && (
            <button
              type="button"
              onClick={() => void onPatch({ status: 'disconnected' })}
              disabled={saving}
              className="rounded-full border border-[#FECACA] bg-white px-2.5 py-1 text-[11px] font-medium text-[#B91C1C] hover:bg-[#FEF2F2] disabled:opacity-50"
            >
              Mark disconnected
            </button>
          )}
          {connection.status === 'disconnected' && (
            <button
              type="button"
              onClick={() => void onPatch({ status: 'draft' })}
              disabled={saving}
              className="rounded-full border border-[#E2E8F0] bg-white px-2.5 py-1 text-[11px] font-medium text-[#0F172A] hover:bg-[#F1F5F9] disabled:opacity-50"
            >
              Reactivate
            </button>
          )}
        </div>
      </div>

      {/* Phase 8BF — Meta identifier editor. Only renders for
          instagram / facebook / meta_lead_ads rows. Fields are
          explicitly allowlisted (page id / IG business / ad
          account / app id). Tokens and secrets are rejected
          server-side by the admin route. */}
      {isMeta && (
        <div className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold text-[#0F172A]">
              Meta identifiers
            </p>
            <span className="text-[10px] text-[#94A3B8]">
              Verified inbound active · Outbound reply: manual until Send API is configured
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {META_METADATA_FIELDS.map((f) => (
              <label key={f.key} className="block">
                <span className="block text-[10px] uppercase tracking-wider text-[#475569] mb-0.5">
                  {f.label}
                </span>
                <input
                  type="text"
                  value={metaForm[f.key] ?? ''}
                  onChange={(e) =>
                    setMetaForm((prev) => ({ ...prev, [f.key]: e.target.value }))
                  }
                  placeholder={f.placeholder}
                  className="w-full rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1 text-[11.5px] text-[#0F172A] placeholder:text-[#CBD5E1] focus:outline-none focus:border-[#1D4ED8]"
                />
              </label>
            ))}
          </div>
          <p className="text-[10px] text-[#64748B] leading-relaxed">
            Identifiers only. Tokens / app secrets / page tokens are
            configured server-side via env vars and are never stored
            here. Inbound webhook verification requires{' '}
            <code className="text-[10px]">META_APP_SECRET</code> and{' '}
            <code className="text-[10px]">META_WEBHOOK_VERIFY_TOKEN</code>.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSaveMeta}
              disabled={saving || !metaDirty}
              className="rounded-full bg-[#0F172A] px-3 py-1 text-[11px] font-semibold text-white hover:bg-[#1E293B] disabled:opacity-50"
            >
              Save identifiers
            </button>
            {metaDirty && (
              <span className="text-[10px] text-[#B45309]">
                Unsaved changes
              </span>
            )}
          </div>
        </div>
      )}
    </article>
  )
}
