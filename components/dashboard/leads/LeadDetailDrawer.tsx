'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  X,
  Phone,
  Mail,
  MoreHorizontal,
  Sparkles,
  Edit3,
  RefreshCcw,
  Check,
  Bot,
  BotOff,
  MessageSquare,
  Trash2,
  CalendarCheck,
  Calendar,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { cn } from '@/lib/utils'
import type { Database, LeadStage } from '@/types/database'
import { format, formatDistanceToNow } from 'date-fns'
import ScheduleTourDrawer from '../tours/ScheduleTourDrawer'
import {
  parseRevenueOsSettings,
  DEFAULT_REVENUE_OS_SETTINGS,
} from '@/lib/revenue-os/settings'
import {
  computeLeadSpeedToLeadScores,
  type LeadSpeedToLeadScore,
  type LeakageLead,
  type LeakageInboundActivity,
  type LeakageOutboundActivity,
  type LeakageTour,
} from '@/lib/revenue-os/leakage'
import {
  computeRecoverySignals,
  type RecoveryLeadSignal,
} from '@/lib/revenue-os/recovery'
import {
  computeTourBookingSignals,
  primaryTourSignalForLead,
  type TourBookingSignal,
} from '@/lib/revenue-os/tour-booking'
import {
  suggestTourSlots,
  type TourSlotSuggestion,
} from '@/lib/revenue-os/tour-slot-suggestions'
import {
  computeReactivationSignals,
  LOST_REASON_LABEL,
  LOST_REASON_VALUES,
  isLostReason,
  type LostReason,
  type ReactivationSignal,
} from '@/lib/revenue-os/reactivation'
import { Lightbulb, CalendarClock } from 'lucide-react'
// Phase 8BE-2 — manual-required reply UI + capability lookup.
import ManualChannelReplyBanner from '../messages/ManualChannelReplyBanner'
import ChannelSourceBadge from '../messages/ChannelSourceBadge'
import { getChannelCapabilities } from '@/lib/integrations/channels/capabilities'
import type { ChannelType } from '@/lib/integrations/channels/types'
// Phase 8BG — parse review surface (lead-forwarding parser).
import ParseReviewBadge from '../messages/ParseReviewBadge'
// Phase 8BH — Attribution surface (UTM + click ids + landing
// page + referrer + channel hint).
import AttributionSourceBadge from '../AttributionSourceBadge'
import { extractLeadAttribution } from '@/lib/enterprise/attribution/parse'
// Phase 8BI — booked-source treatment when stage === 'booked'.
import { formatBookedValueShort } from '@/lib/enterprise/attribution/revenue'

type Lead = Database['public']['Tables']['leads']['Row']
type Message = Database['public']['Tables']['messages']['Row']

/**
 * Phase 8AH — premium right-side lead detail drawer.
 *
 * Replaces the old `LeadDetailPanel` everywhere a clicked lead opens
 * a detail view. Visually mirrors the Phase 8AH reference screenshot:
 *
 *   - Backdrop dim + blur over the whole app
 *   - White right-aligned drawer (max ~660px on desktop, full-width
 *     on small screens)
 *   - Header: close + phone/email/more icon cluster
 *   - Identity row: avatar tile + couple name + email/phone + large
 *     fit-score on the right
 *   - 4-column event-summary grid
 *   - Stage + freshness badges
 *   - Tabs (Conversation / Notes / Activity)
 *   - Conversation tab: lead's last message + AI draft review card
 *     (when an ai_action with success=true exists) + adjustment
 *     chips + footer (Edit / Regenerate / Reject / Approve & send)
 *   - Secondary action bar: Schedule tour · Pause/Enable AI ·
 *     Open Inbox · Delete (preserves every existing capability)
 *
 * Functional posture:
 *   - Reuses `/api/leads/[id]` for PATCH (stage flip / ai_active
 *     toggle) and DELETE.
 *   - Fetches the latest conversation + last 6 messages + latest
 *     ai_actions row via the browser Supabase client (RLS still
 *     applies). Empty data renders graceful fallbacks; never breaks.
 *   - Schedule Tour drawer mounted as a sibling — same logic as
 *     the old LeadDetailPanel; no behavior change.
 *
 * Action footer buttons (Edit / Regenerate / Reject / Approve &
 * send) intentionally show but don't fire backend writes yet — a
 * later phase wires them to the existing `/api/ai/*` endpoints once
 * the draft-review API contract is finalized.
 */

const STAGES: { value: LeadStage; label: string }[] = [
  { value: 'new_inquiry', label: 'New Inquiry' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'tour_scheduled', label: 'Tour Scheduled' },
  { value: 'tour_completed', label: 'Tour Completed' },
  { value: 'negotiation', label: 'Negotiation' },
  { value: 'booked', label: 'Booked' },
  { value: 'lost', label: 'Lost' },
]

const STAGE_LABELS: Record<string, string> = Object.fromEntries(
  STAGES.map((s) => [s.value, s.label])
)

const SHOW_DEMO_QUICK_SCHEDULE = process.env.NEXT_PUBLIC_DEMO_BUTTON === '1'

interface LeadDetailDrawerProps {
  /** Lead to render. `null` collapses the drawer. */
  lead: Lead | null
  onClose: () => void
  onUpdate?: (lead: Lead) => void
  onDelete?: (leadId: string) => void
}

type TabKey = 'conversation' | 'notes' | 'activity'

interface ConversationState {
  loading: boolean
  conversationId: string | null
  /** Phase 8AJ — id of the latest successful ai_action (the draft
   *  the Reject button targets). Null when no draft exists. */
  aiActionId: string | null
  messages: Message[]
  aiDraft: string | null
  aiModel: string | null
  aiLatencyMs: number | null
}

const INITIAL_CONVO: ConversationState = {
  loading: false,
  conversationId: null,
  aiActionId: null,
  messages: [],
  aiDraft: null,
  aiModel: null,
  aiLatencyMs: null,
}

function fitScoreTone(score: number): { num: string; label: string } {
  if (score >= 90) return { num: 'text-[#0F8A5B]', label: 'text-[#0F8A5B]' }
  if (score >= 80) return { num: 'text-[#1D4ED8]', label: 'text-[#1D4ED8]' }
  if (score >= 60) return { num: 'text-[#0F172A]', label: 'text-[#475569]' }
  return { num: 'text-[#475569]', label: 'text-[#94A3B8]' }
}

function avatarTone(score: number): string {
  if (score >= 90) return 'bg-[#0F8A5B]'
  if (score >= 80) return 'bg-[#1D4ED8]'
  if (score >= 60) return 'bg-[#334155]'
  return 'bg-[#475569]'
}

function isFreshToday(createdAt: string): boolean {
  const d = new Date(createdAt)
  const now = new Date()
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  )
}

function formatBudget(b: number | null): string {
  if (b == null || b === 0) return '—'
  return `$${b.toLocaleString()}`
}

function formatEventDate(iso: string | null): { primary: string; sub: string | null } {
  if (!iso) return { primary: '—', sub: null }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { primary: iso, sub: null }
  const primary = format(d, 'EEE, MMMM d yyyy')
  const diff = Math.round((d.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
  const sub = diff > 0 ? `in ${diff} days` : diff === 0 ? 'today' : `${Math.abs(diff)} days ago`
  return { primary, sub }
}

/**
 * Draft action state.
 *
 * Phase 8AI introduced the Edit / Regenerate / Reject / Approve & send
 * footer; 8AJ wired Approve & send + Reject to real backend routes; 8AK
 * wired Regenerate to POST /api/ai/draft. All four actions now hit real
 * endpoints. The legacy `sent_unsupported` value is retained in the
 * union for backward compatibility with any third-party harness that
 * still asserts the shape, but no in-tree code path sets it.
 */
type DraftStatus =
  | 'idle'
  | 'editing'
  | 'regenerating'
  | 'rejected'
  | 'sending'
  | 'sent_unsupported'
  | 'error'

type Adjustment = 'Warmer' | 'More concise' | 'Add pricing' | 'Mention dietary'

export default function LeadDetailDrawer({
  lead,
  onClose,
  onUpdate,
  onDelete,
}: LeadDetailDrawerProps) {
  const [tab, setTab] = useState<TabKey>('conversation')
  const [convo, setConvo] = useState<ConversationState>(INITIAL_CONVO)

  // Phase 8BE-2 — per-conversation channel posture. Resolved from
  // the most-recent external_conversations row mapped to
  // `convo.conversationId`. Null when no mapping exists (legacy
  // in-product conversations stay as-is). Drives both the channel
  // badge in the drawer header and the ManualChannelReplyBanner
  // shown above the Approve & send footer for manual-required
  // channels.
  const [conversationChannel, setConversationChannel] = useState<{
    channelType: ChannelType
    manualReplyRequired: boolean
    displayName: string
    externalThreadId: string | null
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  // Phase 8BB — when the operator clicks a suggested tour
  // window in TourReadinessPanel, we stash the ISO timestamp
  // here and pass it to ScheduleTourDrawer via
  // `defaultScheduledAt`. Cleared when the drawer closes (or
  // when the operator clicks the bare "Schedule tour" CTA so
  // the drawer falls back to its own default seed).
  const [scheduleSeedAt, setScheduleSeedAt] = useState<string | null>(null)

  // Phase 8AI — draft state lifted to drawer level so the footer
  // CTAs can mutate it. Initialized from `convo.aiDraft` on each
  // fetch via the useEffect below; reset whenever a new lead opens.
  const [draftBody, setDraftBody] = useState<string | null>(null)
  const [draftStatus, setDraftStatus] = useState<DraftStatus>('idle')
  const [draftEditBuffer, setDraftEditBuffer] = useState<string>('')
  const [selectedAdjustment, setSelectedAdjustment] = useState<Adjustment | null>(null)

  // Phase 8AL — multi-variant regenerate. `draftVariants` carries the
  // full set returned by /api/ai/draft (always length >= 1 on success);
  // `selectedVariantIndex` is the active variant the operator is
  // looking at + would send if they Approve. Set on every successful
  // regenerate; cleared on Reject / lead change.
  const [draftVariants, setDraftVariants] = useState<string[] | null>(null)
  const [selectedVariantIndex, setSelectedVariantIndex] = useState<number>(0)
  // Phase 8AV — parallel to `draftVariants`; each entry 0..100 is the
  // model's self-rated (or heuristic-fallback) brand voice
  // confidence. Null when the lead has no active draft. Cleared on
  // lead change + on a successful regenerate replaces the array.
  const [draftConfidences, setDraftConfidences] = useState<number[] | null>(
    null
  )
  // Phase 8AX — parallel to `draftVariants`. Each entry is the
  // autopilot decision for that variant: mode (eligible / review /
  // blocked), operator-readable label + helper, reason codes, and
  // the final confidence. Used to render the decision pill +
  // helper sentence below the AI draft card. The pill updates
  // automatically as `selectedVariantIndex` changes — no extra
  // computation in the drawer.
  const [draftAutopilotDecisions, setDraftAutopilotDecisions] = useState<
    Array<{
      mode: 'eligible' | 'review_required' | 'blocked'
      label: string
      helper: string
      reasons: string[]
      confidence: number | null
    }> | null
  >(null)
  // Phase 8AV — venue-level brand voice settings, fetched alongside
  // the speed-score effect. Defaults are used until the fetch lands
  // so the gate is always defined.
  const [brandVoiceFloor, setBrandVoiceFloor] = useState<number>(
    DEFAULT_REVENUE_OS_SETTINGS.brandVoiceConfidenceFloor
  )
  const [brandVoiceMode, setBrandVoiceMode] = useState<
    'off' | 'warn' | 'block'
  >(DEFAULT_REVENUE_OS_SETTINGS.brandVoiceEscalationMode)

  // Phase 8AL — draft staleness guard. When a teammate (or another
  // device session) sends a human-role message on this conversation
  // while we have an AI draft visible, the draft is now responding to
  // a stale state. We:
  //   - flag it stale
  //   - swap the inline notice to amber
  //   - disable Approve & send (Regenerate stays enabled)
  // `draftStaleReason` differentiates "teammate sent" from "edited
  // after teammate" so the footer copy can stay precise.
  const [draftStale, setDraftStale] = useState<boolean>(false)
  // Phase 8AM — extended union covers the softer lead-reply guard.
  // `teammate` / `edited_after_teammate` keep the strong amber Approve-
  // blocking semantics from 8AL. `lead_replied` / `edited_after_lead`
  // are the new blue informational states — Approve stays enabled
  // because the operator's draft is still a valid response, just one
  // that doesn't acknowledge the latest inbound message.
  const [draftStaleReason, setDraftStaleReason] = useState<
    | 'teammate'
    | 'edited_after_teammate'
    | 'lead_replied'
    | 'edited_after_lead'
    | null
  >(null)

  // Phase 8AL — track ids of operator-authored messages this drawer
  // INSERTed (via Approve & send) so the realtime echo for our own
  // send doesn't trigger the stale guard. The optimistic local append
  // adds the row by id; when the realtime echo arrives with the same
  // id we recognize it and skip the stale flag.
  const sentMessageIdsRef = useRef<Set<string>>(new Set())
  // Bridge for the brief window between clicking Approve & send and
  // receiving the inserted row id. While this is true any incoming
  // human message is treated as our own pending echo, not as a
  // teammate's send. Cleared once handleApproveSend resolves either
  // way.
  const pendingSelfSendRef = useRef<boolean>(false)

  // Phase 8AQ — Speed-to-Lead chip. Best-effort: a tiny fetch when
  // the lead opens, then `computeLeadSpeedToLeadScores` does the
  // scoring. A failure (RLS hiccup, network) means the chip silently
  // stays hidden — never blocks the drawer.
  const [speedScore, setSpeedScore] = useState<LeadSpeedToLeadScore | null>(
    null
  )

  // Phase 8AS — recovery explainer. Targeted per-lead fetch (tours +
  // venue settings; messages already in `convo`) hands off to the
  // pure helper. Result is null when the lead isn't on the recovery
  // queue, so the panel renders nothing in the common case.
  const [recoverySignal, setRecoverySignal] =
    useState<RecoveryLeadSignal | null>(null)

  // Phase 8AT — tour booking signal for this lead. Computed by the
  // same recovery fetch effect (no extra round-trip; tours +
  // settings are already pulled). Null when the lead has no
  // actionable tour state.
  const [tourSignal, setTourSignal] = useState<TourBookingSignal | null>(null)

  // Phase 8BD — reactivation signal for this lead. Computed by
  // the same recovery effect (no extra round-trip; lost leads +
  // the lead-role last-message timestamp are already in scope).
  // Null when the lead isn't a reactivation candidate today.
  const [reactivationSignal, setReactivationSignal] =
    useState<ReactivationSignal | null>(null)

  // Phase 8BB — suggested tour windows derived from the venue's
  // saved availability + existing upcoming tours. State machine:
  // `'idle'` before we've tried, `'loading'` mid-fetch,
  // `'no_availability'` when the venue has zero active windows,
  // `'no_open_windows'` when availability exists but every
  // candidate conflicts, `'ready'` with `slots[]`, `'error'` on
  // fetch failure (panel hides quietly). Driven by the same
  // effect that already pulls tours + venue metadata for the
  // recovery + tour-booking signals, so we don't add a round-
  // trip in the common case.
  const [tourSuggestions, setTourSuggestions] = useState<{
    state:
      | 'idle'
      | 'loading'
      | 'no_availability'
      | 'no_open_windows'
      | 'ready'
      | 'error'
    slots: TourSlotSuggestion[]
  }>({ state: 'idle', slots: [] })

  // Phase 8AS — pending recovery suggestion is a separate channel
  // from `selectedAdjustment` (which is locked to the short chip
  // labels). When the operator clicks "Use suggestion in draft" we
  // stash the full instruction here; the Regenerate body prefers
  // this over `selectedAdjustment`. Cleared after regenerate
  // succeeds OR on lead change.
  const [pendingRecoveryInstruction, setPendingRecoveryInstruction] =
    useState<{ label: string; instruction: string } | null>(null)

  // Phase 8AH — close on Escape. Mirrors the existing dialog-style
  // primitives across the app.
  useEffect(() => {
    if (!lead) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lead, onClose])

  // Phase 8AH — when a lead is shown, fetch the latest conversation,
  // last 6 messages, and the most-recent AI draft for that lead.
  // RLS gates this naturally; no extra auth needed.
  useEffect(() => {
    if (!lead) return
    let cancelled = false
    setConvo({ ...INITIAL_CONVO, loading: true })
    const supabase = createClient()
    ;(async () => {
      try {
        // Latest conversation for this lead.
        const { data: convRow } = await supabase
          .from('conversations')
          .select('id')
          .eq('lead_id', lead.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        const conversationId = (convRow as { id?: string } | null)?.id ?? null

        // Last 6 messages (chronological).
        let messages: Message[] = []
        if (conversationId) {
          const { data: msgs } = await supabase
            .from('messages')
            .select('*')
            .eq('conversation_id', conversationId)
            .order('created_at', { ascending: false })
            .limit(6)
          messages = (msgs as Message[] | null) ?? []
          messages.reverse()
        }

        // Latest successful + non-rejected ai_action for the lead.
        // Filtering on rejected_at IS NULL keeps a previously-
        // rejected draft from re-surfacing on the next drawer open.
        const { data: aiRows } = await supabase
          .from('ai_actions')
          .select('id, agent, action, output_summary, latency_ms, success, rejected_at, created_at')
          .eq('lead_id', lead.id)
          .is('rejected_at', null)
          .order('created_at', { ascending: false })
          .limit(1)
        const ai = (aiRows as Array<{
          id: string
          output_summary: string | null
          agent: string | null
          latency_ms: number | null
          success: boolean
        }> | null)?.[0]
        const aiDraft = ai?.success ? ai?.output_summary ?? null : null

        // Phase 8BE-2 — resolve the most-recent external_conversations
        // mapping for this conversation. RLS lets venue members read.
        // Legacy conversations with no mapping return null and the
        // manual-required banner stays hidden.
        let channel: typeof conversationChannel = null
        if (conversationId) {
          const { data: ecRow } = await supabase
            .from('external_conversations')
            .select('channel_type, external_thread_id')
            .eq('conversation_id', conversationId)
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          const ct = (ecRow as { channel_type?: string | null } | null)?.channel_type
          if (ct) {
            const caps = getChannelCapabilities(ct)
            channel = {
              channelType: ct as ChannelType,
              manualReplyRequired: caps.manualReplyRequired,
              displayName: caps.displayName,
              externalThreadId:
                (ecRow as { external_thread_id?: string | null } | null)
                  ?.external_thread_id ?? null,
            }
          } else {
            // Fallback: scan recent messages.metadata.channel_type so
            // ingestion paths that never wrote external_conversations
            // (legacy) still light up the badge.
            const { data: msgMeta } = await supabase
              .from('messages')
              .select('metadata')
              .eq('conversation_id', conversationId)
              .not('metadata', 'is', null)
              .order('created_at', { ascending: false })
              .limit(6)
            for (const row of (msgMeta ?? []) as Array<{
              metadata: Record<string, unknown> | null
            }>) {
              const mct = row.metadata?.['channel_type']
              if (typeof mct === 'string') {
                const caps = getChannelCapabilities(mct)
                channel = {
                  channelType: mct as ChannelType,
                  manualReplyRequired: caps.manualReplyRequired,
                  displayName: caps.displayName,
                  externalThreadId: null,
                }
                break
              }
            }
          }
        }

        if (cancelled) return
        setConversationChannel(channel)
        setConvo({
          loading: false,
          conversationId,
          aiActionId: ai?.id ?? null,
          messages,
          aiDraft,
          aiModel: ai?.agent ?? null,
          aiLatencyMs: ai?.latency_ms ?? null,
        })
      } catch {
        if (cancelled) return
        // Render empty state without erroring out the drawer.
        setConversationChannel(null)
        setConvo({ ...INITIAL_CONVO, loading: false })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [lead])

  // Phase 8AK — optional realtime subscription on the active
  // conversation's `messages` table. While the drawer is open we listen
  // for INSERTs against the current conversation_id; on event we append
  // the new row to the local `messages` list. Dedupe by id so the
  // optimistic local append from `handleApproveSend` doesn't end up
  // double-rendered when the realtime echo arrives.
  //
  // RLS posture: the browser anon client only sees messages the signed-
  // in user can SELECT (Phase 6B `messages: select for members`).
  // Subscribing client-side respects the same policy.
  useEffect(() => {
    if (!convo.conversationId) return
    const supabase = createClient()
    const channel = supabase
      .channel(`lead-drawer:msgs:${convo.conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${convo.conversationId}`,
        },
        (payload) => {
          const msg = ((payload as unknown) as { new?: Message | null }).new ?? null
          if (!msg || !msg.id) return
          // Phase 8AL → 8AM — staleness guard.
          //   - `human` from a teammate → strong amber, Approve
          //     disabled, must Regenerate (or Save edit to soften).
          //   - `lead` (inbound) → soft blue, Approve stays enabled,
          //     nudges the operator to Regenerate so the reply
          //     acknowledges the latest inbound. We don't suppress
          //     Approve because the operator's drafted reply is
          //     usually still valid — just one step behind.
          // We recognize our own teammate sends two ways:
          //   1. `sentMessageIdsRef` tracks ids appended via the
          //      optimistic local append in handleApproveSend.
          //   2. `pendingSelfSendRef` covers the racy window between
          //      the click and the row id landing — during it we
          //      treat any human INSERT as our own.
          const isHumanFromTeammate =
            msg.role === 'human' &&
            !sentMessageIdsRef.current.has(msg.id) &&
            !pendingSelfSendRef.current
          const isLeadReply = msg.role === 'lead'
          setConvo((prev) => {
            if (prev.messages.some((m) => m.id === msg.id)) return prev
            return { ...prev, messages: [...prev.messages, msg] }
          })
          if (isHumanFromTeammate) {
            // Teammate signal trumps any pre-existing lead-reply
            // notice — Approve has to be re-blocked.
            setDraftStale(true)
            setDraftStaleReason('teammate')
          } else if (isLeadReply) {
            // Don't downgrade an existing teammate guard to lead-
            // reply (that would re-enable Approve when it shouldn't
            // be). Only flip into lead_replied if the draft isn't
            // already in the stronger guarded state.
            setDraftStaleReason((prev) =>
              prev === 'teammate' || prev === 'edited_after_teammate'
                ? prev
                : 'lead_replied'
            )
            setDraftStale((prev) => prev || true)
          }
        }
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [convo.conversationId])

  // Phase 8AI — keep `draftBody` in lockstep with the latest fetched
  // ai_action draft. Resets on lead change. Operators editing a draft
  // in-place override this until the next fetch overwrites them; an
  // explicit "Regenerate" call replaces it. Phase 8AL also clears
  // multi-variant state + the staleness guard so a fresh lead never
  // inherits the previous lead's session flags.
  useEffect(() => {
    setDraftBody(convo.aiDraft)
    setDraftStatus('idle')
    setDraftEditBuffer(convo.aiDraft ?? '')
    setSelectedAdjustment(null)
    setDraftVariants(convo.aiDraft ? [convo.aiDraft] : null)
    setSelectedVariantIndex(0)
    // Phase 8AV — clear confidence buffer on lead change. We don't
    // have a server-side confidence on the persisted draft yet (the
    // confidence is computed at regenerate time + lives in
    // ai_actions.metadata.variant_confidences); the next regenerate
    // refills the buffer.
    setDraftConfidences(null)
    // Phase 8AX — same cleanup story as confidences. We don't replay
    // the autopilot decision on the persisted draft; the next
    // regenerate will refill it.
    setDraftAutopilotDecisions(null)
    setDraftStale(false)
    setDraftStaleReason(null)
    sentMessageIdsRef.current = new Set()
    pendingSelfSendRef.current = false
  }, [convo.aiDraft, lead?.id])

  // Phase 8AQ — Speed-to-Lead chip. Best-effort: when the lead
  // changes, fetch venue settings + the earliest outbound message
  // for this lead in parallel, then compute the per-lead score via
  // the shared helper. Both probes are RLS-scoped (browser client);
  // a failure silently leaves the chip hidden.
  useEffect(() => {
    if (!lead) {
      setSpeedScore(null)
      return
    }
    let cancelled = false
    setSpeedScore(null)
    const supabase = createClient()
    ;(async () => {
      try {
        const [venueRes, outboundRes] = await Promise.all([
          supabase
            .from('venues')
            .select('metadata')
            .eq('id', lead.venue_id)
            .maybeSingle(),
          supabase
            .from('messages')
            .select('created_at')
            .eq('lead_id', lead.id)
            .in('role', ['ai', 'human'])
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle(),
        ])
        if (cancelled) return
        const settings = venueRes.data
          ? parseRevenueOsSettings(
              (venueRes.data as { metadata?: unknown }).metadata
            )
          : DEFAULT_REVENUE_OS_SETTINGS
        const firstOutboundAt =
          (outboundRes.data as { created_at?: string } | null)?.created_at ??
          null
        const [score] = computeLeadSpeedToLeadScores(
          [{ id: lead.id, created_at: lead.created_at }],
          [{ lead_id: lead.id, first_outbound_at: firstOutboundAt }],
          { firstReplySlaMinutes: settings.firstReplySlaMinutes }
        )
        if (cancelled) return
        setSpeedScore(score ?? null)
        // Phase 8AV — venue-level brand voice settings, threaded into
        // the gate via component-level state. The defaults already
        // drive the gate before this fetch lands, so the operator
        // never sees a "no gate" window.
        setBrandVoiceFloor(settings.brandVoiceConfidenceFloor)
        setBrandVoiceMode(settings.brandVoiceEscalationMode)
      } catch {
        // Defensive: chip stays hidden on any error.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [lead])

  // Phase 8AS — recovery explainer fetch. Targeted per-lead probe:
  //   - venue settings
  //   - latest inbound message
  //   - earliest outbound message
  //   - tours
  // Then hands a one-lead array to `computeRecoverySignals`. Best-
  // effort: a probe failure leaves the panel hidden, never blocks.
  // Also clears pending-instruction state on lead change so a
  // dangling suggestion from a different lead can't leak across.
  useEffect(() => {
    if (!lead) {
      setRecoverySignal(null)
      setTourSignal(null)
      setPendingRecoveryInstruction(null)
      setTourSuggestions({ state: 'idle', slots: [] })
      setReactivationSignal(null)
      return
    }
    let cancelled = false
    setRecoverySignal(null)
    setTourSignal(null)
    setPendingRecoveryInstruction(null)
    setTourSuggestions({ state: 'loading', slots: [] })
    setReactivationSignal(null)
    const supabase = createClient()
    ;(async () => {
      try {
        const [
          venueRes,
          latestInboundRes,
          firstOutboundRes,
          toursRes,
          availabilityRes,
          venueToursRes,
          blackoutsRes,
        ] = await Promise.all([
          supabase
            .from('venues')
            // Phase 8BC — pull `timezone` alongside `metadata` so
            // the slot-suggestion helper can honor the venue's
            // local timezone when building chip labels.
            .select('metadata, timezone')
            .eq('id', lead.venue_id)
            .maybeSingle(),
          supabase
            .from('messages')
            .select('created_at')
            .eq('lead_id', lead.id)
            .eq('role', 'lead')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase
            .from('messages')
            .select('created_at')
            .eq('lead_id', lead.id)
            .in('role', ['ai', 'human'])
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle(),
          supabase
            .from('tours')
            .select('id, lead_id, status, scheduled_at')
            .eq('lead_id', lead.id)
            .limit(20),
          // Phase 8BB — venue-wide availability + upcoming tours
          // feed `suggestTourSlots`. Availability is small (≤ 7
          // active windows in practice); upcoming tours are
          // bounded to the next 60 days. Both are cheap.
          supabase
            .from('tour_availability')
            .select('day_of_week, start_time, end_time, is_active')
            .eq('venue_id', lead.venue_id)
            .eq('is_active', true),
          supabase
            .from('tours')
            .select('scheduled_at, duration_minutes, status')
            .eq('venue_id', lead.venue_id)
            .gte(
              'scheduled_at',
              new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
            )
            .lte(
              'scheduled_at',
              new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
            )
            .limit(200),
          // Phase 8BC — blackout dates for this venue. We pull
          // anything from today forward; rows older than today
          // are harmless to keep (the helper compares calendar
          // dates) but irrelevant to upcoming suggestions.
          supabase
            .from('tour_blackouts')
            .select('blackout_date, reason')
            .eq('venue_id', lead.venue_id)
            .gte(
              'blackout_date',
              new Date().toISOString().slice(0, 10)
            )
            .limit(200),
        ])
        if (cancelled) return
        const settings = venueRes.data
          ? parseRevenueOsSettings(
              (venueRes.data as { metadata?: unknown }).metadata
            )
          : DEFAULT_REVENUE_OS_SETTINGS
        const oneLead: LeakageLead = {
          id: lead.id,
          stage: lead.stage,
          lead_score: lead.lead_score,
          created_at: lead.created_at,
          updated_at: lead.updated_at,
        }
        const inbound: LeakageInboundActivity[] = [
          {
            lead_id: lead.id,
            last_inbound_at:
              (latestInboundRes.data as { created_at?: string } | null)
                ?.created_at ?? null,
          },
        ]
        const outbound: LeakageOutboundActivity[] = [
          {
            lead_id: lead.id,
            first_outbound_at:
              (firstOutboundRes.data as { created_at?: string } | null)
                ?.created_at ?? null,
          },
        ]
        const tours = ((toursRes.data ?? []) as LeakageTour[]).filter(
          (t) => t.lead_id === lead.id
        )
        const [first] = computeRecoverySignals({
          leads: [oneLead],
          inbound,
          outbound,
          tours,
          settings,
        })
        if (cancelled) return
        setRecoverySignal(first ?? null)
        // Phase 8AT — tour-booking is computed from the same slice;
        // no extra round-trip. The helper returns multiple signals
        // (e.g. tour-today + qualified_no_tour); we pick the
        // highest-priority one for the panel.
        const allTourSignals = computeTourBookingSignals({
          leads: [oneLead],
          tours,
          settings,
        })
        setTourSignal(
          primaryTourSignalForLead(allTourSignals, oneLead.id) ?? null
        )

        // Phase 8BD — compute reactivation signal for this
        // lead. Uses the same `latestInboundRes` timestamp + the
        // lead's existing metadata.lost_reason. Helper returns
        // an empty array when the lead isn't a candidate, so we
        // pluck index 0.
        const lostReason = readLostReason(lead)?.reason ?? null
        const [reactivationFirst] = computeReactivationSignals({
          leads: [
            {
              id: lead.id,
              name: lead.name,
              stage: lead.stage,
              lead_score: lead.lead_score,
              event_date: lead.event_date,
              updated_at: lead.updated_at,
              lost_reason: lostReason,
            },
          ],
          lastMessages: {
            [lead.id]:
              (latestInboundRes.data as { created_at?: string } | null)
                ?.created_at ?? null,
          },
        })
        setReactivationSignal(reactivationFirst ?? null)

        // Phase 8BB — compute tour slot suggestions from the
        // venue-wide availability + the venue-wide upcoming
        // tours we just fetched. The helper handles the
        // active-only filter + conflict detection + earliest-
        // per-day de-dup; we only have to project the row
        // shapes here.
        const availabilityRows = (availabilityRes.data ?? []) as Array<{
          day_of_week: number
          start_time: string
          end_time: string
          is_active: boolean
        }>
        if (availabilityRows.length === 0) {
          setTourSuggestions({ state: 'no_availability', slots: [] })
        } else {
          // Cancelled tours don't reserve their slot — exclude
          // them so we don't gratuitously block a window the
          // lead can actually be booked into.
          const venueTours = ((venueToursRes.data ?? []) as Array<{
            scheduled_at: string
            duration_minutes: number | null
            status: string | null
          }>)
            .filter((t) => t.status !== 'cancelled')
            .map((t) => ({
              scheduled_at: t.scheduled_at,
              duration_minutes: t.duration_minutes,
            }))
          // Phase 8BC — project blackouts + venue settings + venue
          // timezone into the helper inputs. `settings` is the
          // parsed RevenueOsSettings we already computed above
          // (via parseRevenueOsSettings on venueRes.metadata) —
          // re-using it means duration + buffer agree with what
          // the Settings card shows.
          const blackoutRows = ((blackoutsRes.data ?? []) as Array<{
            blackout_date: string
            reason: string | null
          }>).map((b) => ({
            blackout_date: b.blackout_date,
            reason: b.reason,
          }))
          const venueTimezone =
            (venueRes.data as { timezone?: string | null } | null)?.timezone ??
            null
          const slots = suggestTourSlots({
            availability: availabilityRows,
            existingTours: venueTours,
            leadEventDate: lead.event_date ?? null,
            timezone: venueTimezone,
            blackoutDates: blackoutRows,
            defaultDurationMinutes: settings.tourDurationMinutes,
            bufferMinutes: settings.tourBufferMinutes,
          })
          if (slots.length === 0) {
            setTourSuggestions({ state: 'no_open_windows', slots: [] })
          } else {
            setTourSuggestions({ state: 'ready', slots })
          }
        }
      } catch {
        // Defensive: panel stays hidden on any error.
        setTourSuggestions({ state: 'error', slots: [] })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [lead])

  // Phase 8AS — "Use suggestion in draft" handler. Sets the pending
  // recovery instruction + jumps to the Conversation tab so the
  // operator lands on the Regenerate button. Deliberately does NOT
  // call /api/ai/draft — the operator stays in control of the actual
  // network round-trip.
  const handleUseSuggestion = useCallback(() => {
    if (!recoverySignal) return
    setPendingRecoveryInstruction({
      label: recoverySignal.suggestedAction.title,
      instruction: recoverySignal.suggestedAction.instruction,
    })
    setTab('conversation')
  }, [recoverySignal])

  // Phase 8AT — Tour Booking suggestion variant. Same shape as
  // `handleUseSuggestion`; named separately so a future surface can
  // wire a different analytics tag without conflating the two
  // streams (operator pulling a recovery suggestion vs a tour
  // suggestion is meaningfully different intent data).
  const handleUseTourSuggestion = useCallback(() => {
    if (!tourSignal) return
    setPendingRecoveryInstruction({
      label: tourSignal.suggestedAction.title,
      instruction: tourSignal.suggestedAction.instruction,
    })
    setTab('conversation')
  }, [tourSignal])

  // Phase 8BD — reactivation "Use suggestion in draft" handler.
  // Reuses the pendingRecoveryInstruction channel that 8AS / 8AT
  // already plumbed; the operator still has to click Regenerate
  // and Approve & send. No autonomous sending.
  const handleUseReactivationSuggestion = useCallback(() => {
    if (!reactivationSignal) return
    setPendingRecoveryInstruction({
      label: reactivationSignal.label,
      instruction: reactivationSignal.suggestedInstruction,
    })
    setTab('conversation')
  }, [reactivationSignal])

  // Phase 8AT — "Schedule tour" CTA: open the existing
  // ScheduleTourDrawer pre-filled with the current lead. The drawer
  // is already mounted at the bottom of LeadDetailDrawer (Phase 8AH);
  // we just flip its open state.
  const handleScheduleTour = useCallback(() => {
    // Bare CTA path — no preselected slot. Drawer reverts to
    // its built-in `nextTuesdayAtTenAm()` seed.
    setScheduleSeedAt(null)
    setScheduleOpen(true)
  }, [])

  // Phase 8BB — click handler for a suggested slot chip in
  // TourReadinessPanel. We stash the ISO and open the existing
  // ScheduleTourDrawer pre-filled with it. The operator still
  // confirms inside the drawer — nothing schedules autonomously.
  const handleScheduleTourAt = useCallback((iso: string) => {
    setScheduleSeedAt(iso)
    setScheduleOpen(true)
  }, [])

  // Phase 8AI — local-only draft handlers. Comments call out where a
  // future backend phase should swap the placeholder for a real
  // network call.
  const handleStartEdit = useCallback(() => {
    setDraftEditBuffer(draftBody ?? '')
    setDraftStatus('editing')
  }, [draftBody])
  const handleCancelEdit = useCallback(() => {
    setDraftEditBuffer(draftBody ?? '')
    setDraftStatus('idle')
  }, [draftBody])
  const handleSaveEdit = useCallback(() => {
    setDraftBody(draftEditBuffer)
    setDraftStatus('idle')
    // Phase 8AL → 8AM — Save edit transitions the stale flag through
    // its softer parallel state so the operator's review is
    // acknowledged + Approve unblocks (in the teammate case) /
    // refines the messaging (in the lead-reply case). Mapping:
    //   teammate           → edited_after_teammate
    //   lead_replied       → edited_after_lead
    //   anything else      → unchanged
    setDraftStaleReason((prev) => {
      if (prev === 'teammate') return 'edited_after_teammate'
      if (prev === 'lead_replied') return 'edited_after_lead'
      return prev
    })
  }, [draftEditBuffer])
  const handleReject = useCallback(async () => {
    // Phase 8AJ — clears local draft immediately for snappy UX,
    // then fires the persistent PATCH against
    // /api/ai/actions/[id]/reject. Network failures roll back to a
    // graceful inline error but DON'T resurrect the draft (the
    // operator's intent was to reject; reverting their visible
    // action would feel worse than the audit row staying live).
    setDraftBody(null)
    setDraftStatus('rejected')
    if (!convo.aiActionId) return
    try {
      const res = await fetch(`/api/ai/actions/${convo.aiActionId}/reject`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        // The rejected state still renders; just log the failure
        // so it's visible in DevTools.
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null
        // eslint-disable-next-line no-console -- client-only diagnostic
        console.warn('lead-drawer.reject_persist_failed', body?.error)
      }
    } catch (err) {
      // eslint-disable-next-line no-console -- client-only diagnostic
      console.warn('lead-drawer.reject_persist_threw', err)
    }
  }, [convo.aiActionId])
  const handleRegenerate = useCallback(async () => {
    // Phase 8AK — real wiring against /api/ai/draft. POSTs the current
    // draft body + the selected adjustment chip (if any) and swaps in
    // the returned variant on success. On failure we KEEP the old
    // draft visible (so the operator never loses their working text)
    // and surface a transient error state via the footer; the next
    // click resets to idle.
    if (!lead || !draftBody) return
    const previousBody = draftBody
    setDraftStatus('regenerating')
    try {
      const res = await fetch('/api/ai/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id: lead.id,
          current_draft: draftBody,
          // Phase 8AS — recovery suggestions take precedence over the
          // short adjustment chips. The pending instruction is the
          // full action-catalog string ("Re-engage this lead with a
          // brief, warm check-in…") and gives the operator the most
          // pointed nudge; the chip remains for vibe tweaks.
          instruction:
            pendingRecoveryInstruction?.instruction ??
            selectedAdjustment ??
            null,
          // Phase 8AL — always ask for 3 variants so the operator gets
          // a chooser. The route caps server-side; the response
          // returns whatever it could generate (>=1) and the drawer
          // gracefully shows fewer pills when the model returns less.
          variant_count: 3,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null
        const code = body?.error ?? `HTTP ${res.status}`
        setDraftBody(previousBody)
        setDraftStatus('error')
        // eslint-disable-next-line no-console -- client-only diagnostic
        console.warn('lead-drawer.regenerate_failed', code)
        setTimeout(() => {
          setDraftStatus((s) => (s === 'error' ? 'idle' : s))
        }, 2500)
        return
      }
      const json = (await res.json().catch(() => null)) as
        | {
            draft?: string
            drafts?: string[]
            confidences?: number[]
            // Phase 8AX — parallel to `drafts`. Optional so older
            // server builds without 8AX still parse cleanly.
            autopilot_decisions?: Array<{
              mode?: 'eligible' | 'review_required' | 'blocked'
              label?: string
              helper?: string
              reasons?: string[]
              confidence?: number | null
            }>
            ai_action_id?: string | null
          }
        | null
      // Phase 8AL — prefer the structured `drafts[]` envelope but fall
      // back to the legacy `draft` field for compatibility.
      const rawList = Array.isArray(json?.drafts) ? json!.drafts! : []
      const cleaned = rawList
        .map((d) => (typeof d === 'string' ? d.trim() : ''))
        .filter((d) => d.length > 0)
      const primary = cleaned[0] ?? (json?.draft ?? '').trim()
      if (!primary) {
        setDraftBody(previousBody)
        setDraftStatus('error')
        setTimeout(() => {
          setDraftStatus((s) => (s === 'error' ? 'idle' : s))
        }, 2500)
        return
      }
      // Variant list always contains the primary so the selector
      // renders a stable count, even when the API returned only the
      // legacy `draft` field.
      const variantList = cleaned.length > 0 ? cleaned : [primary]
      setDraftVariants(variantList)
      setSelectedVariantIndex(0)
      // Phase 8AV — capture parallel confidence array. Server clamps
      // 0..100 and pads with the heuristic fallback when the model
      // forgot the CONFIDENCE: line, so we just project + align.
      // Length-mismatch defensiveness: pad with `null`-equivalent
      // (50) so a future Approve guard always has a number.
      const rawConfidences = Array.isArray(json?.confidences)
        ? json!.confidences!
        : []
      const confidenceList = variantList.map((_, i) => {
        const v = rawConfidences[i]
        if (typeof v !== 'number' || !Number.isFinite(v)) return 50
        return Math.max(0, Math.min(100, Math.round(v)))
      })
      setDraftConfidences(confidenceList)
      // Phase 8AX — project the per-variant autopilot decisions
      // returned by the route. Defensive: when the array is missing
      // (older server) or shorter than `variantList`, pad with a
      // neutral 'review_required' so the pill always renders rather
      // than disappearing.
      const rawDecisions = Array.isArray(json?.autopilot_decisions)
        ? json!.autopilot_decisions!
        : []
      const decisionList = variantList.map((_, i) => {
        const d = rawDecisions[i]
        const mode: 'eligible' | 'review_required' | 'blocked' =
          d?.mode === 'eligible' || d?.mode === 'blocked'
            ? d.mode
            : 'review_required'
        return {
          mode,
          label:
            typeof d?.label === 'string' && d.label.length > 0
              ? d.label
              : mode === 'eligible'
                ? 'Autopilot eligible'
                : mode === 'blocked'
                  ? 'Autopilot blocked'
                  : 'Review required',
          helper:
            typeof d?.helper === 'string' && d.helper.length > 0
              ? d.helper
              : mode === 'eligible'
                ? 'This draft is low-risk, but still requires operator approval.'
                : mode === 'blocked'
                  ? 'Do not auto-send. Operator review is required because this draft may involve pricing, policy, availability, or low confidence.'
                  : 'Review before sending. The system detected medium confidence or context gaps.',
          reasons: Array.isArray(d?.reasons) ? d!.reasons! : [],
          confidence:
            typeof d?.confidence === 'number' && Number.isFinite(d.confidence)
              ? Math.max(0, Math.min(100, Math.round(d.confidence)))
              : null,
        }
      })
      setDraftAutopilotDecisions(decisionList)
      // Swap the visible draft, refresh the edit buffer so an
      // immediate Edit click starts from the new variant, clear the
      // adjustment chip (it's been consumed), and treat the returned
      // ai_action_id as the new active draft so Reject targets it.
      setDraftBody(primary)
      setDraftEditBuffer(primary)
      setSelectedAdjustment(null)
      // Phase 8AS — consume the recovery suggestion the same way the
      // adjustment chip is consumed. The new draft already
      // incorporated it; leaving it set would feed the next
      // regenerate the SAME instruction unintentionally.
      setPendingRecoveryInstruction(null)
      // Phase 8AL — a successful regenerate consumes the staleness
      // flag: the new draft was synthesized against the conversation
      // including the teammate's message.
      setDraftStale(false)
      setDraftStaleReason(null)
      if (json?.ai_action_id) {
        setConvo((prev) => ({
          ...prev,
          aiActionId: json.ai_action_id ?? null,
          aiDraft: primary,
        }))
      } else {
        setConvo((prev) => ({ ...prev, aiDraft: primary }))
      }
      setDraftStatus('idle')
    } catch (err) {
      setDraftBody(previousBody)
      setDraftStatus('error')
      // eslint-disable-next-line no-console -- client-only diagnostic
      console.warn('lead-drawer.regenerate_threw', err)
      setTimeout(() => {
        setDraftStatus((s) => (s === 'error' ? 'idle' : s))
      }, 2500)
    }
  }, [lead, draftBody, selectedAdjustment])

  const handleApproveSend = useCallback(async () => {
    // Phase 8AJ — real send wiring. POST against
    // /api/conversations/[id]/messages inserts the operator-
    // approved body as a `human` role message. The drawer's
    // conversation preview appends locally on success so the
    // operator sees their message immediately without waiting for
    // the next router.refresh().
    if (!convo.conversationId || !draftBody || !lead) return
    setDraftStatus('sending')
    // Phase 8AL — bridge the race between click and inserted-row id
    // landing. While this flag is true, any incoming human-role
    // realtime INSERT is treated as our own echo (not a teammate's
    // send) so the stale guard doesn't fire on our own message.
    pendingSelfSendRef.current = true
    try {
      // Phase 8AM — stamp the chosen variant context onto the message
      // row's metadata so the audit trail can replay "operator picked
      // option 2 of 3 from ai_action <id>". The server side allowlists
      // these fields strictly; anything else here would be dropped.
      const metadata: Record<string, unknown> = {
        source: 'lead_detail_drawer_approve',
      }
      if (convo.aiActionId) {
        metadata.ai_action_id = convo.aiActionId
      }
      if (draftVariants && draftVariants.length > 0) {
        metadata.selected_variant_index = selectedVariantIndex
        metadata.variant_count = draftVariants.length
      }
      const res = await fetch(
        `/api/conversations/${convo.conversationId}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: draftBody,
            sender_type: 'operator',
            metadata,
          }),
        }
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null
        const code = body?.error ?? `HTTP ${res.status}`
        setDraftStatus('error')
        // eslint-disable-next-line no-console -- client-only diagnostic
        console.warn('lead-drawer.approve_send_failed', code)
        setTimeout(() => {
          setDraftStatus((s) => (s === 'error' ? 'idle' : s))
        }, 2500)
        return
      }
      const json = (await res.json().catch(() => null)) as
        | { message?: Message }
        | null
      // Optimistic local append + clear draft so the UX feels
      // immediate. The next fetch (or a router.refresh()) will
      // reconcile against the canonical row. Phase 8AL — register
      // the inserted id so the realtime echo for our own send is
      // recognized + skipped by the stale guard.
      if (json?.message) {
        const inserted = json.message as Message
        if (inserted.id) sentMessageIdsRef.current.add(inserted.id)
        setConvo((prev) => ({
          ...prev,
          messages: [...prev.messages, inserted],
          aiDraft: null,
          aiActionId: null,
        }))
      }
      setDraftBody(null)
      setDraftVariants(null)
      setDraftConfidences(null)
      // Phase 8AX — clear autopilot decisions on send too. The draft
      // that owned them is gone (sent to lead); the next regenerate
      // will repopulate.
      setDraftAutopilotDecisions(null)
      setSelectedVariantIndex(0)
      setDraftStale(false)
      setDraftStaleReason(null)
      setDraftStatus('idle')
    } catch (err) {
      setDraftStatus('error')
      // eslint-disable-next-line no-console -- client-only diagnostic
      console.warn('lead-drawer.approve_send_threw', err)
      setTimeout(() => {
        setDraftStatus((s) => (s === 'error' ? 'idle' : s))
      }, 2500)
    } finally {
      // Clear the self-send bridge regardless of outcome. The window
      // we needed it for (Approve click → row id append) has closed.
      pendingSelfSendRef.current = false
    }
  }, [convo.conversationId, draftBody, lead])

  const patch = useCallback(
    async (data: Record<string, unknown>) => {
      if (!lead) return
      setSaving(true)
      try {
        const res = await fetch(`/api/leads/${lead.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
        if (res.ok) {
          const updated = (await res.json()) as Lead
          onUpdate?.(updated)
        }
      } finally {
        setSaving(false)
      }
    },
    [lead, onUpdate]
  )

  // Phase 8BD — lost-reason prompt. When the operator moves a
  // lead to `lost`, we open the inline prompt below the stage
  // flipper. Skipping does NOT block the stage change (the PATCH
  // already happened); saving records the reason against
  // `metadata.lost_reason` via the existing patch helper.
  const [lostReasonPromptOpen, setLostReasonPromptOpen] = useState(false)
  const [lostReasonDraft, setLostReasonDraft] = useState<LostReason | ''>('')
  const [lostReasonNote, setLostReasonNote] = useState('')
  const [lostReasonSaving, setLostReasonSaving] = useState(false)

  const handleStageChange = useCallback(
    async (nextStage: LeadStage) => {
      if (!lead) return
      const wasLost = lead.stage === 'lost'
      await patch({ stage: nextStage })
      // Open the prompt only on the transition INTO `lost`; a
      // lead already at `lost` shouldn't re-prompt every time
      // the stage flipper is touched.
      if (nextStage === 'lost' && !wasLost) {
        setLostReasonDraft('')
        setLostReasonNote('')
        setLostReasonPromptOpen(true)
      }
    },
    [lead, patch]
  )

  const handleSaveLostReason = useCallback(async () => {
    if (!lead || !lostReasonDraft) return
    setLostReasonSaving(true)
    try {
      const body: Record<string, unknown> = {
        lost_reason: {
          reason: lostReasonDraft,
          ...(lostReasonNote.trim().length > 0
            ? { note: lostReasonNote.trim() }
            : {}),
        },
      }
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const updated = (await res.json()) as Lead
        onUpdate?.(updated)
        setLostReasonPromptOpen(false)
      }
    } finally {
      setLostReasonSaving(false)
    }
  }, [lead, lostReasonDraft, lostReasonNote, onUpdate])

  const handleSkipLostReason = useCallback(() => {
    setLostReasonPromptOpen(false)
  }, [])

  const handleDelete = useCallback(async () => {
    if (!lead) return
    if (
      typeof window !== 'undefined' &&
      // UI_INTERACTION_EXEMPT: admin-only destructive lead delete; native confirm is intentional friction.
      !window.confirm(`Delete lead for ${lead.name}? This cannot be undone.`)
    )
      return
    await fetch(`/api/leads/${lead.id}`, { method: 'DELETE' })
    onDelete?.(lead.id)
    onClose()
  }, [lead, onClose, onDelete])

  if (!lead) return null

  const initials = (() => {
    const parts = lead.name.split(/\s+/).slice(0, 2)
    return parts.map((p) => p.charAt(0).toUpperCase()).join('') || 'L'
  })()
  const fitTone = fitScoreTone(lead.lead_score)
  const eventDate = formatEventDate(lead.event_date)
  const fresh = isFreshToday(lead.created_at)
  const lastMessage = convo.messages[convo.messages.length - 1] ?? null

  // Phase 8BK — derive the most recent lead-side slot selection from
  // the loaded conversation messages. The orchestrator stamps
  // `metadata.tour_slot_selection` on a lead message when the
  // deterministic detector matched the lead's reply against the
  // prior AI message's `offered_tour_slots`. We surface that as a
  // "Tour time selected — Create tour" panel below.
  //
  // Skipped when:
  //   - no selection metadata found
  //   - the slot itself is already in the past
  //   - the existing tourSignal already indicates a scheduled tour
  //     (the operator has already created the tour row; the realtime
  //     tour refresh will hide the panel naturally)
  const slotSelection = (() => {
    for (let i = convo.messages.length - 1; i >= 0; i -= 1) {
      const m = convo.messages[i]
      if (m.role !== 'lead') continue
      const meta = (m.metadata as Record<string, unknown> | null) ?? null
      const raw = meta?.['tour_slot_selection'] as
        | Record<string, unknown>
        | undefined
      if (!raw || raw['selected'] !== true) continue
      const startsAt = typeof raw['starts_at'] === 'string' ? raw['starts_at'] : null
      const endsAt = typeof raw['ends_at'] === 'string' ? raw['ends_at'] : null
      const label = typeof raw['label'] === 'string' ? raw['label'] : null
      const confidence =
        raw['confidence'] === 'high' ||
        raw['confidence'] === 'medium' ||
        raw['confidence'] === 'low'
          ? (raw['confidence'] as 'high' | 'medium' | 'low')
          : 'medium'
      if (!startsAt || !endsAt || !label) continue
      const startsAtMs = new Date(startsAt).getTime()
      if (!Number.isFinite(startsAtMs)) continue
      if (startsAtMs <= Date.now()) return null
      // If the existing tourSignal already indicates a scheduled
      // tour for this lead, the operator has already acted — hide
      // the panel.
      if (
        tourSignal?.signal === 'tour_scheduled_unconfirmed' ||
        tourSignal?.signal === 'tour_today'
      ) {
        return null
      }
      return { startsAt, endsAt, label, confidence, messageId: m.id }
    }
    return null
  })()

  // Phase 8AV — Brand Voice escalation gate.
  //
  // `confidenceForSelected` is the per-variant score for whatever the
  // operator currently has in `draftBody`. `lowConfidence` flags any
  // variant whose score is below the venue's floor (chip surfaces in
  // the AI draft card). `blockApproveFromConfidence` reflects the
  // venue's escalation mode — only `'block'` actually disables the
  // button; `'warn'` keeps it clickable but tones the copy down;
  // `'off'` does neither and only shows the chip.
  const confidenceForSelected =
    draftConfidences && draftConfidences[selectedVariantIndex] !== undefined
      ? draftConfidences[selectedVariantIndex]
      : null
  const lowConfidence =
    confidenceForSelected !== null && confidenceForSelected < brandVoiceFloor
  const blockApproveFromConfidence = lowConfidence && brandVoiceMode === 'block'

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop — blurred + dimmed */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close lead detail"
        data-testid="lead-drawer-backdrop-close"
        className="fixed inset-0 z-40 bg-slate-950/25 backdrop-blur-[3px] cursor-default"
      />

      {/* Drawer */}
      <aside
        role="dialog"
        aria-label="Lead detail"
        data-testid="lead-detail-drawer"
        data-lead-id={lead.id}
        className="relative ml-auto z-50 h-dvh w-full max-w-[660px] min-w-[320px] bg-white border-l border-[#E2E8F0] shadow-[0_-10px_60px_rgba(15,23,42,0.18)] flex flex-col animate-in slide-in-from-right duration-300"
      >
        {/* Top action row */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#F1F5F9]">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 text-[12.5px] text-[#475569] hover:text-[#0F172A] px-2 py-1 rounded-lg hover:bg-[#F1F5F9] transition-colors"
          >
            <X className="w-3.5 h-3.5" />
            Close
          </button>
          <div className="flex items-center gap-2">
            {lead.phone && (
              <a
                href={`tel:${lead.phone}`}
                aria-label="Call lead"
                className="w-9 h-9 rounded-full border border-[#E2E8F0] bg-white flex items-center justify-center text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] transition-colors"
              >
                <Phone className="w-3.5 h-3.5" />
              </a>
            )}
            <a
              href={`mailto:${lead.email}`}
              aria-label="Email lead"
              className="w-9 h-9 rounded-full border border-[#E2E8F0] bg-white flex items-center justify-center text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] transition-colors"
            >
              <Mail className="w-3.5 h-3.5" />
            </a>
            <button
              type="button"
              aria-label="More actions"
              onClick={handleDelete}
              title="Delete lead"
              className="w-9 h-9 rounded-full border border-[#E2E8F0] bg-white flex items-center justify-center text-[#475569] hover:text-[#B91C1C] hover:bg-[#FEF2F2] transition-colors"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Identity */}
        <div className="px-6 pt-5 pb-4 border-b border-[#F1F5F9]">
          <div className="flex items-start gap-4">
            <div
              className={cn(
                'w-14 h-14 rounded-2xl flex items-center justify-center text-white font-semibold text-[15px] shrink-0',
                avatarTone(lead.lead_score)
              )}
            >
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-[24px] sm:text-[26px] font-semibold text-[#0F172A] tracking-[-0.02em] leading-tight truncate">
                {lead.name}
              </h2>
              <div className="mt-2 flex items-center gap-2 text-[12.5px] text-[#475569] flex-wrap">
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="w-3 h-3 text-[#94A3B8]" />
                  <a
                    href={`mailto:${lead.email}`}
                    className="hover:text-[#0F172A] truncate max-w-[260px]"
                  >
                    {lead.email}
                  </a>
                </span>
                {lead.phone && (
                  <>
                    <span className="text-[#CBD5E1]">·</span>
                    <span className="inline-flex items-center gap-1.5">
                      <Phone className="w-3 h-3 text-[#94A3B8]" />
                      <a href={`tel:${lead.phone}`} className="hover:text-[#0F172A]">
                        {lead.phone}
                      </a>
                    </span>
                  </>
                )}
                {/* Phase 8BE-2 — channel badge inline with email/phone.
                    Renders only when the conversation has a recorded
                    channel mapping. */}
                {conversationChannel && (
                  <>
                    <span className="text-[#CBD5E1]">·</span>
                    <ChannelSourceBadge
                      channelType={conversationChannel.channelType}
                    />
                  </>
                )}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div
                className={cn(
                  'text-[44px] sm:text-[48px] font-semibold leading-none tracking-[-0.025em] tabular-nums',
                  fitTone.num
                )}
              >
                {lead.lead_score}
              </div>
              <div
                className={cn(
                  'mt-1 text-[10.5px] font-semibold uppercase tracking-[0.16em]',
                  fitTone.label
                )}
              >
                Fit score
              </div>
            </div>
          </div>

          {/* Event summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-5 gap-y-3 mt-5">
            <SummaryCell label="Event date" primary={eventDate.primary} sub={eventDate.sub ?? undefined} />
            <SummaryCell
              label="Guests"
              primary={lead.guest_count != null ? String(lead.guest_count) : '—'}
              sub={lead.guest_count != null ? 'capacity 240' : null}
            />
            <SummaryCell
              label="Budget"
              primary={formatBudget(lead.budget)}
              sub={lead.budget == null || lead.budget === 0 ? 'not disclosed' : null}
            />
            <SummaryCell
              label="Source"
              primary={lead.source || '—'}
              sub={`${formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })}`}
            />
          </div>

          {/* Badges */}
          <div className="flex items-center gap-2 mt-5 flex-wrap">
            <Badge
              variant={`stage_${lead.stage}` as Parameters<typeof Badge>[0]['variant']}
            >
              {STAGE_LABELS[lead.stage] ?? lead.stage}
            </Badge>
            {fresh && <Badge variant="blue">New today</Badge>}
            {lead.ai_active && (
              <Badge variant="navy">
                <Bot className="w-3 h-3 mr-1" /> AI active
              </Badge>
            )}
            {/* Phase 8AQ — Speed-to-Lead chip. Renders only when the
                helper resolved (best-effort). Color follows status:
                met=emerald, pending=blue, missed/overdue=amber.
                Future Revenue OS direction: clicking this should
                drill into the audit trail for why the score is what
                it is. */}
            {speedScore && <SpeedToLeadChip score={speedScore} />}
          </div>

          {/* Phase 8BK — Tour Slot Selection panel. The lead picked
              one of the slots the AI offered ("Tuesday at 11 works").
              The deterministic detector matched it against the prior
              AI message's `offered_tour_slots` and stamped
              `metadata.tour_slot_selection` on the lead message.
              This panel turns that detection into a one-click
              "Create tour" affordance that opens the existing
              ScheduleTourDrawer prefilled.

              Renders ABOVE TourReadinessPanel because once the lead
              has named a specific time, that's the most concrete
              next action available to the operator. */}
          {slotSelection && (
            <div className="rounded-2xl border border-[#BFDBFE] bg-gradient-to-br from-[#EFF6FF] to-white p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1D4ED8] text-white shrink-0">
                  <Calendar className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-[13px] font-semibold text-[#0F172A]">
                      Tour time selected
                    </p>
                    {slotSelection.confidence === 'medium' && (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">
                        Medium confidence
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[14px] text-[#0F172A]">
                    {lead.name.split(/\s+/)[0]} selected{' '}
                    <strong>{slotSelection.label}</strong>.
                  </p>
                  {slotSelection.confidence === 'medium' && (
                    <p className="mt-1 text-[12px] text-[#92400E]">
                      Medium confidence match — review before scheduling.
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setScheduleSeedAt(slotSelection.startsAt)
                      setScheduleOpen(true)
                    }}
                    className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#0F172A] text-white text-[12.5px] font-semibold hover:bg-[#1E293B] transition-colors shadow-[0_4px_14px_rgba(15,23,42,0.25)]"
                  >
                    <Calendar className="h-3.5 w-3.5" />
                    Create tour
                  </button>
                  <p className="mt-2 text-[11px] text-[#94A3B8] leading-relaxed">
                    Opens the schedule drawer with this time prefilled.
                    No tour is created until you confirm.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Phase 8AT — Tour Readiness panel. Rendered FIRST when
              present because tour booking is closer to revenue than
              recovery is — if a lead is both stalled AND has a tour
              signal, the tour signal is the more actionable next
              step. Both panels can render together; the operator
              sees the tour CTA on top and the recovery context
              underneath. */}
          {tourSignal && (
            <TourReadinessPanel
              signal={tourSignal}
              pending={pendingRecoveryInstruction}
              onScheduleTour={handleScheduleTour}
              onUseSuggestion={handleUseTourSuggestion}
              onClearPending={() => setPendingRecoveryInstruction(null)}
              suggestionState={tourSuggestions.state}
              suggestionSlots={tourSuggestions.slots}
              onScheduleAt={handleScheduleTourAt}
            />
          )}

          {/* Phase 8AS — "Why this lead is slipping" explainer. Renders
              only when the recovery helper resolved a signal for this
              lead (best-effort). The CTA pre-fills the regenerate
              instruction; it never auto-calls the AI. */}
          {recoverySignal && (
            <RecoveryExplainerPanel
              signal={recoverySignal}
              pending={pendingRecoveryInstruction}
              onUseSuggestion={handleUseSuggestion}
              onClearPending={() => setPendingRecoveryInstruction(null)}
            />
          )}

          {/* Phase 8BD — existing lost reason display. Renders only
              for leads at `lost` stage with a recorded reason; shows
              the operator the calibration data already in the row so
              they can spot-check + override via the lost-reason
              prompt on the next stage transition. */}
          {(() => {
            if (lead.stage !== 'lost') return null
            const lr = readLostReason(lead)
            if (!lr) return null
            return (
              <div className="mt-5 rounded-2xl border border-[#E2E8F0] bg-white p-3.5">
                <div className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-[#64748B]">
                  Lost reason
                </div>
                <p className="mt-0.5 text-[12.5px] text-[#0F172A]">
                  <span className="font-semibold">
                    {LOST_REASON_LABEL[lr.reason]}
                  </span>
                  {lr.note ? (
                    <span className="text-[#475569]"> — {lr.note}</span>
                  ) : null}
                </p>
                {lr.recordedAt && (
                  <p className="mt-1 text-[10.5px] text-[#94A3B8]">
                    Recorded {new Date(lr.recordedAt).toLocaleDateString()}
                  </p>
                )}
              </div>
            )
          })()}

          {/* Phase 8BD — Reactivation panel. Renders only on
              lost-stage leads when the reactivation helper
              classified them as a candidate. Suggestion plumbing
              reuses the existing pendingRecoveryInstruction
              channel (no extra state machine). The operator still
              clicks Regenerate + Approve & send. */}
          {reactivationSignal && (
            <ReactivationPanel
              signal={reactivationSignal}
              pending={pendingRecoveryInstruction}
              onUseSuggestion={handleUseReactivationSuggestion}
              onClearPending={() => setPendingRecoveryInstruction(null)}
            />
          )}

          {/* Phase 8BH — Attribution panel. Reads the lead's
              metadata.attribution blob and renders the
              extracted source, campaign, landing page,
              referrer, plus click-id presence badges. Hidden
              when no attribution is captured (legacy leads). */}
          {(() => {
            const attribution = extractLeadAttribution(
              (lead as { metadata?: unknown }).metadata
            )
            if (!attribution) return null
            const clickIds: Array<{ label: string; present: boolean }> = [
              { label: 'Google click ID', present: !!attribution.gclid },
              { label: 'Meta click ID', present: !!attribution.fbclid },
              { label: 'Microsoft click ID', present: !!attribution.msclkid },
              { label: 'TikTok click ID', present: !!attribution.ttclid },
            ]
            const anyClickId = clickIds.some((c) => c.present)
            return (
              <section className="rounded-2xl border border-[#E6E8EF] bg-white p-4 space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-[10.5px] uppercase tracking-[0.16em] text-[#94A3B8] font-semibold">
                    {lead.stage === 'booked' ? 'Booked source' : 'Attribution'}
                  </p>
                  <AttributionSourceBadge
                    sourceLabel={attribution.source_label}
                    size="md"
                  />
                  {/* Phase 8BI — when the lead is booked AND a
                      budget exists, surface the estimated
                      booked value next to the source. Clearly
                      labelled as estimated. */}
                  {lead.stage === 'booked' && lead.budget != null && lead.budget > 0 && (
                    <span className="inline-flex items-center rounded-full bg-[#ECFDF5] text-[#047857] border border-[#A7F3D0] px-2 py-[1px] text-[10px] font-semibold">
                      Est. booked ~{formatBookedValueShort(lead.budget)}
                    </span>
                  )}
                </div>
                {/* Phase 8BJ — source-cohort context line. Tells the
                    operator which Source Leakage cohort this lead
                    belongs to + (if any) the highest-priority
                    leakage signal active on the lead right now.
                    Read-only — no new actions, just framing. The
                    signal derives from the already-fetched recovery
                    / tour / reactivation / lost state; no extra
                    network call. */}
                {(() => {
                  const cohortLabel =
                    attribution.source_label === 'Unknown'
                      ? 'unattributed cohort'
                      : `${attribution.source_label} source cohort`
                  // Highest-priority active leakage signal from the
                  // signals already in scope. Ordering mirrors
                  // TOP_LEAK_PRIORITY in lib/enterprise/attribution/
                  // leakage.ts (actionable buckets first; lost last).
                  let leakageLabel: string | null = null
                  if (tourSignal) {
                    leakageLabel =
                      tourSignal.signal === 'qualified_no_tour'
                        ? 'No tour booked'
                        : tourSignal.signal === 'tour_scheduled_unconfirmed' ||
                            tourSignal.signal === 'tour_today'
                          ? 'Tour pending confirm'
                          : 'Tour booking'
                  } else if (recoverySignal) {
                    leakageLabel = 'Follow-up recovery'
                  } else if (reactivationSignal) {
                    leakageLabel = 'Reactivation'
                  } else if (lead.stage === 'lost') {
                    leakageLabel = 'Lost'
                  }
                  return (
                    <div className="space-y-1">
                      <p className="text-[11px] text-[#475569] leading-relaxed">
                        This lead is part of the{' '}
                        <span className="font-semibold text-[#0F172A]">
                          {cohortLabel}
                        </span>
                        .
                      </p>
                      {leakageLabel && (
                        <p className="text-[11px] text-[#B45309] leading-relaxed">
                          Current source leakage signal:{' '}
                          <span className="font-semibold">{leakageLabel}</span>.
                        </p>
                      )}
                    </div>
                  )
                })()}
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11.5px]">
                  {attribution.campaign && (
                    <div className="rounded-lg bg-[#F8FAFC] border border-[#E2E8F0] px-2.5 py-1.5">
                      <dt className="text-[9.5px] uppercase tracking-wider text-[#94A3B8]">
                        Campaign
                      </dt>
                      <dd className="text-[#0F172A] font-medium truncate">
                        {attribution.campaign}
                      </dd>
                    </div>
                  )}
                  {attribution.medium && (
                    <div className="rounded-lg bg-[#F8FAFC] border border-[#E2E8F0] px-2.5 py-1.5">
                      <dt className="text-[9.5px] uppercase tracking-wider text-[#94A3B8]">
                        Medium
                      </dt>
                      <dd className="text-[#0F172A] font-medium truncate">
                        {attribution.medium}
                      </dd>
                    </div>
                  )}
                  {attribution.landing_page && (
                    <div className="rounded-lg bg-[#F8FAFC] border border-[#E2E8F0] px-2.5 py-1.5 sm:col-span-2">
                      <dt className="text-[9.5px] uppercase tracking-wider text-[#94A3B8]">
                        Landing page
                      </dt>
                      <dd className="text-[#0F172A] font-medium truncate">
                        {attribution.landing_page}
                      </dd>
                    </div>
                  )}
                  {attribution.referrer && (
                    <div className="rounded-lg bg-[#F8FAFC] border border-[#E2E8F0] px-2.5 py-1.5 sm:col-span-2">
                      <dt className="text-[9.5px] uppercase tracking-wider text-[#94A3B8]">
                        Referrer
                      </dt>
                      <dd className="text-[#0F172A] font-medium truncate">
                        {attribution.referrer}
                      </dd>
                    </div>
                  )}
                </dl>
                {anyClickId && (
                  <div className="flex flex-wrap gap-1.5">
                    {clickIds
                      .filter((c) => c.present)
                      .map((c) => (
                        <span
                          key={c.label}
                          className="inline-flex items-center rounded-full bg-[#EFF6FF] text-[#1D4ED8] border border-[#DBEAFE] px-2 py-[1px] text-[10px] font-medium"
                          title="Click ID present — paid ad referral verified"
                        >
                          {c.label}
                        </span>
                      ))}
                  </div>
                )}
                <p className="text-[10px] text-[#94A3B8] italic leading-relaxed">
                  Revenue attribution is estimated until ad spend and final
                  contract value are connected. Booked value uses the lead
                  budget field; this is not true ROAS.
                </p>
              </section>
            )
          })()}

          {/* Phase 8BG — Source parse review panel. Surfaces the
              extracted fields + confidence reasons when the
              forwarding parser flagged the latest inbound
              message. Read-only — no edit UI yet. */}
          {(() => {
            const inbound = [...convo.messages]
              .reverse()
              .find((m) => m.role === 'lead')
            const md = (inbound?.metadata ?? null) as
              | (Record<string, unknown> & {
                  parse_needs_review?: boolean
                  parse_confidence?: number
                  parse_confidence_reasons?: string[]
                  channel_type?: string
                })
              | null
            if (!md || md.parse_needs_review !== true) return null
            const reasons: string[] = Array.isArray(md.parse_confidence_reasons)
              ? (md.parse_confidence_reasons as string[])
              : []
            const missing = reasons.filter((r) => r.endsWith('_missing'))
            const eventDate = (lead?.event_date as string | null) ?? null
            const guestCount = (lead?.guest_count as number | null) ?? null
            const budget = (lead?.budget as number | null) ?? null
            return (
              <section className="rounded-2xl border border-[#FCD9A1] bg-[#FFFBEB] p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <ParseReviewBadge
                      needsReview
                      confidence={
                        typeof md.parse_confidence === 'number'
                          ? md.parse_confidence
                          : null
                      }
                      reasons={reasons}
                      size="md"
                    />
                    {md.channel_type && (
                      <ChannelSourceBadge
                        channelType={md.channel_type as ChannelType}
                      />
                    )}
                  </div>
                  <span className="text-[10.5px] font-semibold uppercase tracking-wider text-[#92400E]">
                    Source parse review
                  </span>
                </div>
                <p className="text-[11.5px] text-[#92400E] leading-relaxed">
                  VenueRise extracted this lead from a forwarded
                  inquiry. Confirm the fields before relying on them
                  — the deterministic parser does not catch every
                  format.
                </p>
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <div className="rounded-lg bg-white border border-[#FDE68A] px-2.5 py-1.5">
                    <p className="text-[9.5px] uppercase tracking-wider text-[#B45309]">
                      Event date
                    </p>
                    <p className="text-[#0F172A] font-medium">
                      {eventDate
                        ? format(new Date(eventDate), 'MMM d, yyyy')
                        : '—'}
                    </p>
                  </div>
                  <div className="rounded-lg bg-white border border-[#FDE68A] px-2.5 py-1.5">
                    <p className="text-[9.5px] uppercase tracking-wider text-[#B45309]">
                      Guests
                    </p>
                    <p className="text-[#0F172A] font-medium">
                      {guestCount ?? '—'}
                    </p>
                  </div>
                  <div className="rounded-lg bg-white border border-[#FDE68A] px-2.5 py-1.5">
                    <p className="text-[9.5px] uppercase tracking-wider text-[#B45309]">
                      Budget
                    </p>
                    <p className="text-[#0F172A] font-medium">
                      {budget != null && budget > 0
                        ? `$${budget.toLocaleString()}`
                        : '—'}
                    </p>
                  </div>
                </div>
                {missing.length > 0 && (
                  <p className="text-[10.5px] text-[#92400E]">
                    Missing signals: {missing.join(', ')}
                  </p>
                )}
              </section>
            )
          })()}
        </div>

        {/* Tabs */}
        <div className="px-6 border-b border-[#F1F5F9]">
          <div className="flex items-center gap-5">
            {(
              [
                { id: 'conversation' as const, label: 'Conversation', count: convo.messages.length },
                { id: 'notes' as const, label: 'Notes' },
                { id: 'activity' as const, label: 'Activity' },
              ]
            ).map((t) => {
              const active = tab === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'relative py-3 text-[13px] font-medium transition-colors',
                    active ? 'text-[#0F172A]' : 'text-[#94A3B8] hover:text-[#475569]'
                  )}
                >
                  {t.label}
                  {typeof t.count === 'number' && t.count > 0 ? (
                    <span className="ml-1.5 text-[#94A3B8]">· {t.count}</span>
                  ) : null}
                  {active && (
                    <span className="absolute -bottom-px left-0 right-0 h-[2px] bg-[#0F172A] rounded-full" />
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {tab === 'conversation' && (
            <ConversationTab
              lead={lead}
              convo={convo}
              lastMessage={lastMessage}
              draftBody={draftBody}
              draftStatus={draftStatus}
              draftEditBuffer={draftEditBuffer}
              onChangeEditBuffer={setDraftEditBuffer}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={handleCancelEdit}
              selectedAdjustment={selectedAdjustment}
              onSelectAdjustment={setSelectedAdjustment}
              draftVariants={draftVariants}
              selectedVariantIndex={selectedVariantIndex}
              onSelectVariant={(idx) => {
                setSelectedVariantIndex(idx)
                if (draftVariants && draftVariants[idx]) {
                  setDraftBody(draftVariants[idx])
                  setDraftEditBuffer(draftVariants[idx])
                }
              }}
              draftConfidences={draftConfidences}
              brandVoiceFloor={brandVoiceFloor}
              draftAutopilotDecisions={draftAutopilotDecisions}
            />
          )}
          {tab === 'notes' && <NotesTab lead={lead} />}
          {tab === 'activity' && <ActivityTab lead={lead} />}
        </div>

        {/* Phase 8AI — draft action footer. Visible whenever there's
            a draft to act on OR the user is mid-edit / has just
            rejected / has triggered an Approve attempt. Buttons are
            wired against local state only (see Known Limitations in
            the handoff). */}
        {tab === 'conversation' &&
          (draftBody !== null || draftStatus === 'editing' || draftStatus === 'rejected') && (
            <div className="px-6 py-3 border-t border-[#F1F5F9] bg-white space-y-3">
              {/* Phase 8BE-2 — Manual-required reply banner. Mounts
                  only when the resolved channel cannot be delivered to
                  directly. Operator copies the draft + confirms the
                  manual send; the POST inserts a `human` message with
                  `metadata.source='manual_channel_reply'` and stamps
                  external_messages with `marked_sent_manually`. */}
              {convo.conversationId &&
                conversationChannel?.manualReplyRequired &&
                draftBody && (
                  <ManualChannelReplyBanner
                    conversationId={convo.conversationId}
                    channelType={conversationChannel.channelType}
                    draftBody={draftBody}
                    onMarkedSent={() => {
                      // Clear the draft so the operator doesn't
                      // re-send the same reply twice. The realtime
                      // messages subscription will surface the new
                      // human row + the "Sent manually" pill.
                      setDraftBody(null)
                    }}
                  />
                )}
              <div className="flex items-center gap-2 flex-wrap">
                {draftStatus === 'editing' ? (
                  <>
                    <button
                      type="button"
                      onClick={handleSaveEdit}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] bg-[#0F172A] text-white text-[12.5px] hover:bg-[#1E293B]"
                    >
                      <Check className="w-3.5 h-3.5" />
                      Save edit
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelEdit}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-[#E2E8F0] text-[12.5px] text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC]"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={handleStartEdit}
                      disabled={draftBody === null}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-[#E2E8F0] text-[12.5px] text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] disabled:opacity-50"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={handleRegenerate}
                      disabled={draftStatus === 'regenerating'}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-[#E2E8F0] text-[12.5px] text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] disabled:opacity-50"
                    >
                      <Sparkles
                        className={cn(
                          'w-3.5 h-3.5',
                          draftStatus === 'regenerating' && 'animate-spin'
                        )}
                      />
                      {draftStatus === 'regenerating' ? 'Regenerating…' : 'Regenerate'}
                    </button>
                    <div className="flex-1" />
                    <button
                      type="button"
                      onClick={handleReject}
                      disabled={draftBody === null}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] text-[12.5px] text-[#475569] hover:text-[#B91C1C] disabled:opacity-50"
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      onClick={handleApproveSend}
                      disabled={
                        draftBody === null ||
                        draftStatus === 'sending' ||
                        draftStatus === 'sent_unsupported' ||
                        // Phase 8AL — block Approve while the draft is
                        // stale-from-teammate-send. Save edit
                        // (transitions to 'edited_after_teammate') or
                        // Regenerate (clears the flag entirely) un-
                        // blocks the button.
                        (draftStale && draftStaleReason === 'teammate') ||
                        // Phase 8AV — Brand Voice escalation gate
                        // in `block` mode. Operator must regenerate
                        // or save an edit to clear.
                        blockApproveFromConfidence ||
                        // Phase 8BE-2 — block direct send on
                        // manual-required channels. The banner above
                        // provides Copy + Mark sent manually instead;
                        // we do NOT create an illusion that VenueRise
                        // delivered the reply through Instagram /
                        // WeddingWire / etc.
                        Boolean(conversationChannel?.manualReplyRequired)
                      }
                      title={
                        conversationChannel?.manualReplyRequired
                          ? `Direct VenueRise sending is not enabled for ${conversationChannel.displayName}. Use the banner above to copy + mark sent manually.`
                          : blockApproveFromConfidence
                            ? 'Operator approval recommended — regenerate or save an edit to send.'
                            : undefined
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] bg-[#0F172A] text-white text-[12.5px] hover:bg-[#1E293B] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Check
                        className={cn(
                          'w-3.5 h-3.5',
                          draftStatus === 'sending' && 'animate-spin'
                        )}
                      />
                      {draftStatus === 'sending'
                        ? 'Sending…'
                        : draftStatus === 'sent_unsupported'
                          ? 'Wiring pending'
                          : draftStatus === 'error'
                            ? 'Retry send'
                            : conversationChannel?.manualReplyRequired
                              ? 'Manual reply only'
                              : 'Approve & send'}
                    </button>
                  </>
                )}
              </div>
              {/* Status hints */}
              {/* Phase 8AL — stale-draft notices. `teammate` is the
                  hard amber state (Approve blocked). `edited_after_teammate`
                  is the soft amber state operators reach by clicking
                  Save edit; Approve is re-enabled and the copy
                  acknowledges that they've consciously reviewed. */}
              {draftStale && draftStaleReason === 'teammate' && (
                <p className="mt-2 text-[11px] text-[#B45309]">
                  A teammate sent a message in this conversation.
                  Regenerate before sending this draft.
                </p>
              )}
              {draftStale && draftStaleReason === 'edited_after_teammate' && (
                <p className="mt-2 text-[11px] text-[#B45309]">
                  Edited after teammate activity. Review before sending.
                </p>
              )}
              {/* Phase 8AM — lead-reply guard. Approve stays enabled
                  because the drafted reply is usually still valid —
                  this is a nudge, not a block. Blue rather than amber
                  to differentiate from the teammate-send guard
                  visually. */}
              {draftStale && draftStaleReason === 'lead_replied' && (
                <p className="mt-2 text-[11px] text-[#1D4ED8]">
                  The lead replied after this draft was generated.
                  Regenerate to include their latest message.
                </p>
              )}
              {draftStale && draftStaleReason === 'edited_after_lead' && (
                <p className="mt-2 text-[11px] text-[#1D4ED8]">
                  Edited after the lead replied. Review carefully before
                  sending.
                </p>
              )}
              {draftStatus === 'rejected' && (
                <p className="mt-2 text-[11px] text-[#B45309]">
                  Draft rejected for this session. Use Regenerate or close
                  to recover.
                </p>
              )}
              {draftStatus === 'error' && (
                <p className="mt-2 text-[11px] text-[#B91C1C]">
                  Couldn&apos;t complete that action. Please try again — or
                  use Open Inbox to send manually.
                </p>
              )}
              {draftStatus === 'regenerating' && (
                <p className="mt-2 text-[11px] text-[#64748B]">
                  {pendingRecoveryInstruction
                    ? `Regenerating with recovery suggestion: ${pendingRecoveryInstruction.label}…`
                    : selectedAdjustment
                      ? `Regenerating with adjustment: ${selectedAdjustment}…`
                      : 'Regenerating draft…'}
                </p>
              )}
              {/* Phase 8AS — surface the pre-filled recovery
                  suggestion next to the action footer when the
                  operator hasn't fired Regenerate yet. Gives them a
                  last chance to clear or change their mind without
                  jumping back to the identity panel. */}
              {pendingRecoveryInstruction && draftStatus === 'idle' && (
                <p className="mt-2 text-[11px] text-[#1D4ED8]">
                  Recovery suggestion ready:{' '}
                  <span className="font-semibold">
                    {pendingRecoveryInstruction.label}
                  </span>
                  . Click Regenerate to use it.
                </p>
              )}
              {/* Phase 8AV — Brand Voice escalation hints. The chip
                  in the AI draft card already surfaces the score
                  visually; this is the action-level copy operators
                  read right above the Approve button. */}
              {lowConfidence &&
                brandVoiceMode === 'warn' &&
                draftStatus === 'idle' && (
                  <p className="mt-2 text-[11px] text-[#B45309]">
                    Brand voice confidence is{' '}
                    <span className="font-semibold">
                      {confidenceForSelected}/100
                    </span>
                    {' '}— below the venue floor of {brandVoiceFloor}. Operator
                    approval recommended.
                  </p>
                )}
              {lowConfidence &&
                brandVoiceMode === 'block' &&
                draftStatus === 'idle' && (
                  <p className="mt-2 text-[11px] text-[#B91C1C]">
                    Brand voice confidence is{' '}
                    <span className="font-semibold">
                      {confidenceForSelected}/100
                    </span>
                    {' '}— below the venue floor of {brandVoiceFloor}.
                    Regenerate, edit, or pick another variant to send.
                  </p>
                )}
            </div>
          )}

        {/* Secondary action bar — preserves every existing capability
            from the legacy LeadDetailPanel so we don't lose ground. */}
        <div className="px-6 py-3 border-t border-[#F1F5F9] flex flex-wrap items-center gap-2 bg-[#F8FAFC]">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              // Phase 8BB — clear any stashed suggestion seed
              // before opening from the bare footer CTA.
              setScheduleSeedAt(null)
              setScheduleOpen(true)
            }}
          >
            <CalendarCheck className="w-3.5 h-3.5" />
            Schedule tour…
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => patch({ ai_active: !lead.ai_active })}
            disabled={saving}
            className={cn(lead.ai_active && 'text-[#B45309] border-[#FCD9A1]')}
          >
            {lead.ai_active ? (
              <>
                <BotOff className="w-3.5 h-3.5" /> Pause AI
              </>
            ) : (
              <>
                <Bot className="w-3.5 h-3.5" /> Enable AI
              </>
            )}
          </Button>
          <Button variant="secondary" size="sm" asChild>
            <a href={`/dashboard/inbox?lead=${lead.id}`}>
              <MessageSquare className="w-3.5 h-3.5" />
              Open Inbox
            </a>
          </Button>
          <div className="flex-1" />
          <Button variant="destructive" size="icon" onClick={handleDelete} disabled={saving}>
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>

        {/* Stage flipper rendered inline below action bar; collapses
            to a single chevron menu when room is tight. Reuses the
            standard `patch({ stage })` path. */}
        <div className="px-6 py-3 border-t border-[#F1F5F9] bg-white flex items-center gap-2 flex-wrap">
          <span className="text-[10.5px] uppercase tracking-[0.16em] text-[#94A3B8] font-semibold">
            Move to
          </span>
          {STAGES.filter((s) => s.value !== lead.stage)
            .slice(0, 4)
            .map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => handleStageChange(s.value)}
                disabled={saving}
                className="text-[11px] px-2 py-1 rounded-md border border-[#E2E8F0] text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] disabled:opacity-50"
              >
                {s.label}
              </button>
            ))}
        </div>

        {/* Phase 8BD — lost reason prompt. Non-blocking: the
            stage change has already been persisted; this is
            calibration data the operator chooses to record. */}
        {lostReasonPromptOpen && (
          <div className="px-6 py-3 border-t border-[#F1F5F9] bg-[#F8FAFC] space-y-2">
            <div>
              <div className="text-[10.5px] uppercase tracking-[0.16em] text-[#94A3B8] font-semibold">
                Why was this lead lost?
              </div>
              <div className="text-[11.5px] text-[#475569] mt-0.5">
                Helps the reactivation queue surface the right
                candidates later. Skip if you&apos;d rather not say.
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <select
                value={lostReasonDraft}
                onChange={(e) =>
                  setLostReasonDraft(e.target.value as LostReason | '')
                }
                disabled={lostReasonSaving}
                className="text-[12.5px] bg-white border border-[#E2E8F0] rounded-md px-2 py-1.5 outline-none text-[#0F172A] focus:border-[#1D4ED8]"
              >
                <option value="">Select a reason…</option>
                {LOST_REASON_VALUES.map((r) => (
                  <option key={r} value={r}>
                    {LOST_REASON_LABEL[r]}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={lostReasonNote}
                onChange={(e) => setLostReasonNote(e.target.value)}
                disabled={lostReasonSaving}
                placeholder="Optional note"
                maxLength={500}
                className="flex-1 text-[12.5px] bg-white border border-[#E2E8F0] rounded-md px-2 py-1.5 outline-none text-[#0F172A] placeholder:text-[#94A3B8] focus:border-[#1D4ED8]"
              />
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleSaveLostReason}
                  disabled={!lostReasonDraft || lostReasonSaving}
                  className="inline-flex items-center gap-1 text-[11.5px] font-semibold px-2.5 py-1.5 rounded-md bg-[#0F172A] text-white hover:bg-[#1E293B] disabled:opacity-40"
                >
                  {lostReasonSaving ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={handleSkipLostReason}
                  disabled={lostReasonSaving}
                  className="inline-flex items-center text-[11.5px] px-2.5 py-1.5 rounded-md border border-[#E2E8F0] text-[#475569] hover:text-[#0F172A] hover:bg-white disabled:opacity-50"
                >
                  Skip
                </button>
              </div>
            </div>
          </div>
        )}

        {SHOW_DEMO_QUICK_SCHEDULE ? (
          <div className="px-6 py-2 text-[10px] text-[#94A3B8]">
            Demo quick-schedule wiring is mounted on this lead — see the leads page.
          </div>
        ) : null}
      </aside>

      <ScheduleTourDrawer
        open={scheduleOpen}
        onOpenChange={(next) => {
          setScheduleOpen(next)
          // Phase 8BB — clear the stashed suggestion seed on
          // close so the next open from the bare footer CTA
          // falls back to the drawer's own default.
          if (!next) setScheduleSeedAt(null)
        }}
        leads={[{ id: lead.id, name: lead.name, email: lead.email, stage: lead.stage }]}
        defaultLeadId={lead.id}
        defaultNotes="Scheduled from lead detail."
        defaultScheduledAt={scheduleSeedAt ?? undefined}
      />
    </div>
  )
}

function SummaryCell({
  label,
  primary,
  sub,
}: {
  label: string
  primary: string
  sub?: string | null
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold">
        {label}
      </div>
      <div className="mt-1 text-[14px] font-semibold text-[#0F172A] truncate">
        {primary}
      </div>
      {sub ? (
        <div className="mt-0.5 text-[11px] text-[#94A3B8] truncate">{sub}</div>
      ) : null}
    </div>
  )
}

interface ConversationTabProps {
  lead: Lead
  convo: ConversationState
  lastMessage: Message | null
  draftBody: string | null
  draftStatus: DraftStatus
  draftEditBuffer: string
  onChangeEditBuffer: (next: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  selectedAdjustment: Adjustment | null
  onSelectAdjustment: (next: Adjustment | null) => void
  // Phase 8AL — multi-variant regenerate.
  draftVariants: string[] | null
  selectedVariantIndex: number
  onSelectVariant: (index: number) => void
  // Phase 8AV — per-variant brand voice confidence (parallel to
  // draftVariants) + the venue's floor. The chip + variant pill
  // styling reads from these.
  draftConfidences: number[] | null
  brandVoiceFloor: number
  // Phase 8AX — per-variant autopilot decisions, parallel to
  // `draftVariants`. Null until the next regenerate. The decision
  // pill below the AI draft card reads
  // `draftAutopilotDecisions[selectedVariantIndex]`, so switching
  // variants updates the pill + helper copy automatically.
  draftAutopilotDecisions:
    | Array<{
        mode: 'eligible' | 'review_required' | 'blocked'
        label: string
        helper: string
        reasons: string[]
        confidence: number | null
      }>
    | null
}

const ADJUSTMENTS: Adjustment[] = ['Warmer', 'More concise', 'Add pricing', 'Mention dietary']

function ConversationTab(props: ConversationTabProps) {
  const {
    lead,
    convo,
    lastMessage,
    draftBody,
    draftStatus,
    draftEditBuffer,
    onChangeEditBuffer,
    onSaveEdit,
    onCancelEdit,
    selectedAdjustment,
    onSelectAdjustment,
    draftVariants,
    selectedVariantIndex,
    onSelectVariant,
    draftConfidences,
    brandVoiceFloor,
    draftAutopilotDecisions,
  } = props

  if (convo.loading) {
    return (
      <div className="text-[12.5px] text-[#94A3B8] py-6 text-center">
        Loading conversation…
      </div>
    )
  }

  const showDraftCard = draftBody !== null
  const showRejectedState = draftStatus === 'rejected'
  const isRegenerating = draftStatus === 'regenerating'

  return (
    <>
      {lastMessage ? (
        <div>
          <div className="rounded-2xl border border-[#E2E8F0] bg-white p-4 shadow-card">
            <p className="text-[13.5px] text-[#0F172A] leading-relaxed whitespace-pre-wrap">
              {lastMessage.content}
            </p>
          </div>
          <div className="mt-2 text-[11px] text-[#94A3B8]">
            {lastMessage.role === 'lead'
              ? 'Lead'
              : lastMessage.role === 'ai'
                ? 'AI'
                : lastMessage.role === 'human'
                  ? 'Operator'
                  : 'System'}
            {' · '}
            {formatDistanceToNow(new Date(lastMessage.created_at), { addSuffix: true })}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-[#E2E8F0] bg-white p-5 text-[12.5px] text-[#64748B]">
          No conversation messages yet. When {lead.name} replies, the latest
          message lands here.
        </div>
      )}

      {showDraftCard ? (
        <div className="rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] p-4 shadow-card">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5 min-w-0">
              <div className="w-7 h-7 rounded-[8px] bg-[#0F172A] text-white flex items-center justify-center shrink-0">
                <Sparkles
                  className={cn('w-3 h-3', isRegenerating && 'animate-spin')}
                />
              </div>
              <div className="min-w-0">
                <div className="text-[12.5px] text-[#0F172A]">
                  <span className="font-semibold">AI drafted a reply</span>{' '}
                  <span className="text-[#64748B]">
                    · based on this thread + venue knowledge
                  </span>
                </div>
                <div className="text-[11px] text-[#94A3B8] font-mono mt-0.5">
                  {/* Phase 8AL — surface the audit metadata the
                      operator cares about: which AI model wrote it,
                      how long it took, and (when the latest action
                      was a regenerate with multiple variants) how
                      many variants are available. */}
                  {convo.aiModel ? <>model · {convo.aiModel}</> : 'model · venuerise'}
                  {convo.aiLatencyMs ? <> · {convo.aiLatencyMs}ms</> : null}
                  {draftVariants && draftVariants.length > 1 ? (
                    <> · {draftVariants.length} variants</>
                  ) : null}
                </div>
              </div>
            </div>
            {/* Phase 8AV — Brand voice confidence chip. Renders when
                the selected variant scored below the venue's floor.
                Tone is amber (operator-friendly) rather than red
                (alarm-bell). The chip replaces the "Awaiting review"
                pill so the operator's eye lands on the warning
                instead of the default status. */}
            {(() => {
              const conf =
                draftConfidences &&
                draftConfidences[selectedVariantIndex] !== undefined
                  ? draftConfidences[selectedVariantIndex]
                  : null
              const low = conf !== null && conf < brandVoiceFloor
              if (isRegenerating) {
                return (
                  <span className="shrink-0 inline-flex items-center text-[10.5px] font-semibold uppercase tracking-[0.1em] px-2 py-0.5 rounded-full bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE]">
                    Regenerating
                  </span>
                )
              }
              if (low) {
                return (
                  <span
                    className="shrink-0 inline-flex items-center text-[10.5px] font-semibold uppercase tracking-[0.1em] px-2 py-0.5 rounded-full bg-[#FFFBEB] text-[#B45309] border border-[#FCD9A1]"
                    title={`Brand voice confidence ${conf}/100 · venue floor ${brandVoiceFloor}`}
                  >
                    Low confidence · {conf}/100
                  </span>
                )
              }
              return (
                <span className="shrink-0 inline-flex items-center text-[10.5px] font-semibold uppercase tracking-[0.1em] px-2 py-0.5 rounded-full bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE]">
                  {conf !== null
                    ? `Awaiting review · ${conf}/100`
                    : 'Awaiting review'}
                </span>
              )
            })()}
          </div>

          {/* Phase 8AL — variant selector. Shown only when the most
              recent regenerate returned >1 variant. Clicking a pill
              swaps the visible draft text + edit buffer; the selection
              feeds Approve & send so the operator sends whatever's
              currently displayed. Hidden while editing (the edit
              buffer is variant-agnostic — saving exits the variant
              flow). */}
          {draftVariants && draftVariants.length > 1 && draftStatus !== 'editing' ? (
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <span className="text-[10.5px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold">
                Variants
              </span>
              {draftVariants.map((_v, i) => {
                const active = i === selectedVariantIndex
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onSelectVariant(i)}
                    className={cn(
                      'text-[11px] px-2.5 py-1 rounded-full border transition-colors',
                      active
                        ? 'bg-[#1D4ED8] text-white border-[#1D4ED8]'
                        : 'border-[#E2E8F0] text-[#475569] hover:text-[#0F172A] hover:bg-white'
                    )}
                  >
                    Option {i + 1}
                  </button>
                )
              })}
            </div>
          ) : null}

          {/* Phase 8AX — Autopilot decision pill + helper. Hidden
              while regenerating, editing, or rejected (those are
              transient states; the operator's eye should stay on
              the live action, not on a stale decision). Updates
              automatically as the operator switches variants. The
              helper line below is intentionally a single sentence so
              it doesn't compete with the draft body for attention. */}
          {(() => {
            if (
              draftStatus === 'editing' ||
              draftStatus === 'rejected' ||
              isRegenerating
            ) {
              return null
            }
            const decision =
              draftAutopilotDecisions &&
              draftAutopilotDecisions[selectedVariantIndex] !== undefined
                ? draftAutopilotDecisions[selectedVariantIndex]
                : null
            if (!decision) return null
            const style =
              decision.mode === 'eligible'
                ? {
                    pill: 'bg-[#ECFDF5] text-[#059669] border-[#A7F3D0]',
                    helper: 'text-[#475569]',
                  }
                : decision.mode === 'review_required'
                  ? {
                      pill: 'bg-[#FFFBEB] text-[#B45309] border-[#FCD9A1]',
                      helper: 'text-[#475569]',
                    }
                  : {
                      pill: 'bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]',
                      helper: 'text-[#475569]',
                    }
            return (
              <div className="mt-3 flex flex-col gap-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10.5px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold">
                    Autopilot
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center text-[10.5px] font-semibold uppercase tracking-[0.1em] px-2 py-0.5 rounded-full border',
                      style.pill
                    )}
                    title={
                      decision.reasons.length > 0
                        ? `Reasons: ${decision.reasons.join(', ')}`
                        : undefined
                    }
                  >
                    {decision.label}
                  </span>
                </div>
                <p
                  className={cn(
                    'text-[11.5px] leading-snug',
                    style.helper
                  )}
                >
                  {decision.helper}
                </p>
              </div>
            )
          })()}

          {draftStatus === 'editing' ? (
            <textarea
              value={draftEditBuffer}
              onChange={(e) => onChangeEditBuffer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSaveEdit()
                if (e.key === 'Escape') onCancelEdit()
              }}
              rows={6}
              className="mt-3 w-full rounded-xl border border-[#E2E8F0] bg-white p-3 text-[13.5px] text-[#0F172A] leading-relaxed focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/30 focus:border-[#1D4ED8]"
              autoFocus
            />
          ) : (
            <p
              className={cn(
                'mt-3 text-[13.5px] leading-relaxed whitespace-pre-wrap',
                isRegenerating ? 'text-[#94A3B8]' : 'text-[#0F172A]'
              )}
            >
              {draftBody}
            </p>
          )}

          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <span className="text-[10.5px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold">
              Adjust
            </span>
            {ADJUSTMENTS.map((c) => {
              const active = selectedAdjustment === c
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => onSelectAdjustment(active ? null : c)}
                  className={cn(
                    'text-[11px] px-2.5 py-1 rounded-full border transition-colors',
                    active
                      ? 'bg-[#0F172A] text-white border-[#0F172A]'
                      : 'border-[#E2E8F0] text-[#475569] hover:text-[#0F172A] hover:bg-white'
                  )}
                >
                  {c}
                </button>
              )
            })}
          </div>
        </div>
      ) : showRejectedState ? (
        <div className="rounded-2xl border border-[#FDE68A] bg-[#FFFBEB] p-4 text-[12.5px] text-[#92400E]">
          Draft rejected for this session. Use Regenerate or close to recover.
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-[#E2E8F0] bg-white p-5 text-[12.5px] text-[#64748B]">
          No AI draft ready yet. When the assistant prepares a reply, it shows
          up here for review.
        </div>
      )}
    </>
  )
}

function NotesTab({ lead }: { lead: Lead }) {
  if (!lead.notes) {
    return (
      <div className="rounded-2xl border border-dashed border-[#E2E8F0] bg-white p-5 text-[12.5px] text-[#64748B]">
        No notes yet. Use the Inbox or the legacy edit panel to add context for
        the AI.
      </div>
    )
  }
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-4 shadow-card">
      <p className="text-[13.5px] text-[#0F172A] leading-relaxed whitespace-pre-wrap">
        {lead.notes}
      </p>
    </div>
  )
}

function ActivityTab({ lead }: { lead: Lead }) {
  const rows: { when: string; what: string }[] = [
    {
      when: format(new Date(lead.created_at), 'MMM d, yyyy · h:mm a'),
      what: 'Lead created',
    },
    {
      when: format(new Date(lead.updated_at), 'MMM d, yyyy · h:mm a'),
      what: 'Lead last updated',
    },
  ]
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white">
      {rows.map((r, i) => (
        <div
          key={i}
          className={cn(
            'flex items-center justify-between gap-3 px-4 py-3 text-[12.5px]',
            i > 0 && 'border-t border-[#F1F5F9]'
          )}
        >
          <span className="text-[#0F172A]">{r.what}</span>
          <span className="text-[#94A3B8] font-mono text-[11px]">{r.when}</span>
        </div>
      ))}
    </div>
  )
}

// Phase 8AT — Tour Readiness panel. Lives ABOVE the recovery
// explainer when present because tour booking is the closest
// operational proxy to revenue. Renders one CTA pair when the signal
// is `qualified_no_tour` (Schedule + Use suggestion), one CTA when
// the signal is anything else (Use suggestion only). Schedule Tour
// reuses the existing Phase 8AH/ScheduleTourDrawer host already
// mounted in the drawer.
function TourReadinessPanel({
  signal,
  pending,
  onScheduleTour,
  onUseSuggestion,
  onClearPending,
  suggestionState,
  suggestionSlots,
  onScheduleAt,
}: {
  signal: TourBookingSignal
  pending: { label: string; instruction: string } | null
  onScheduleTour: () => void
  onUseSuggestion: () => void
  onClearPending: () => void
  // Phase 8BB — suggestions are passed from the drawer, not
  // computed here, so the panel stays presentational. The
  // chips only render when `signal.signal === 'qualified_no_tour'`
  // — every other signal (tour today, scheduled-unconfirmed,
  // no-show, etc.) has its own dedicated copy already.
  suggestionState:
    | 'idle'
    | 'loading'
    | 'no_availability'
    | 'no_open_windows'
    | 'ready'
    | 'error'
  suggestionSlots: TourSlotSuggestion[]
  onScheduleAt: (iso: string) => void
}) {
  // Tone by urgency. `high` (tour today, scheduled-unconfirmed) gets
  // the assertive blue ring; `medium` (qualified-no-tour,
  // tour-completed-no-next-step) gets navy slate; `low` (no-show)
  // gets the soft amber.
  const tone =
    signal.urgency === 'high'
      ? {
          wrap: 'border-[#BFDBFE] bg-[#EFF6FF]',
          eyebrow: 'text-[#1D4ED8]',
          iconBg: 'bg-white border border-[#BFDBFE] text-[#1D4ED8]',
        }
      : signal.urgency === 'medium'
        ? {
            wrap: 'border-[#E2E8F0] bg-[#F8FAFC]',
            eyebrow: 'text-[#475569]',
            iconBg: 'bg-white border border-[#E2E8F0] text-[#0F172A]',
          }
        : {
            wrap: 'border-[#FCD9A1] bg-[#FFFBEB]',
            eyebrow: 'text-[#B45309]',
            iconBg: 'bg-white border border-[#FCD9A1] text-[#B45309]',
          }

  const showScheduleCta = signal.signal === 'qualified_no_tour'

  return (
    <div className={`mt-5 rounded-2xl border ${tone.wrap} p-3.5`}>
      <div className="flex items-start gap-2.5">
        <span
          className={`w-8 h-8 rounded-[10px] ${tone.iconBg} flex items-center justify-center shrink-0`}
        >
          <CalendarClock className="w-3.5 h-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={`text-[10.5px] uppercase tracking-[0.14em] font-semibold ${tone.eyebrow}`}
          >
            Tour Booking Agent
          </div>
          <p className="mt-0.5 text-[12.5px] text-[#0F172A] leading-snug">
            <span className="font-semibold">{signal.label}.</span>{' '}
            {signal.helper}
          </p>
        </div>
      </div>

      {/* Phase 8BB — Suggested tour windows. Renders only on
          the qualified-no-tour signal (the only branch with a
          Schedule CTA) so the chips appear right where the
          operator is already deciding when to schedule. Empty
          states are explicit + non-blocking; fetch errors hide
          the section so the panel keeps working. */}
      {showScheduleCta && (
        <SuggestedTourWindows
          state={suggestionState}
          slots={suggestionSlots}
          onScheduleAt={onScheduleAt}
        />
      )}

      <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[11.5px] text-[#475569] leading-snug min-w-0">
          <span className="font-semibold text-[#0F172A]">
            Suggested · {signal.suggestedAction.title}.
          </span>{' '}
          {pending ? (
            <span className="text-[#1D4ED8]">
              Loaded into the next regenerate.
            </span>
          ) : (
            <span>Operator stays in control — no AI is called yet.</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {showScheduleCta && (
            <button
              type="button"
              onClick={onScheduleTour}
              className="inline-flex items-center gap-1.5 text-[11.5px] px-2.5 py-1.5 rounded-md border border-[#E2E8F0] text-[#475569] hover:text-[#0F172A] hover:bg-white"
            >
              Schedule tour
            </button>
          )}
          {pending ? (
            <button
              type="button"
              onClick={onClearPending}
              className="inline-flex items-center gap-1.5 text-[11.5px] px-2.5 py-1.5 rounded-md border border-[#E2E8F0] text-[#475569] hover:text-[#0F172A] hover:bg-white"
            >
              Clear suggestion
            </button>
          ) : (
            <button
              type="button"
              onClick={onUseSuggestion}
              className="inline-flex items-center gap-1.5 text-[11.5px] px-2.5 py-1.5 rounded-md bg-[#0F172A] text-white hover:bg-[#1E293B]"
            >
              {signal.suggestedAction.ctaLabel
                ? `Use ${signal.suggestedAction.ctaLabel.toLowerCase()} in draft`
                : 'Use suggestion in draft'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
/**
 * Phase 8BD — read operator-supplied lost reason from the lead
 * row. Defensive: `lead.metadata` is `Json` (opaque) at the
 * type level; we shape-check before trusting any sub-field.
 */
function readLostReason(lead: Lead): {
  reason: LostReason
  note: string | null
  recordedAt: string | null
  recordedBy: string | null
} | null {
  const md = (lead as unknown as { metadata?: unknown }).metadata
  if (!md || typeof md !== 'object') return null
  const block = (md as { lost_reason?: unknown }).lost_reason
  if (!block || typeof block !== 'object') return null
  const obj = block as Record<string, unknown>
  if (!isLostReason(obj.reason)) return null
  return {
    reason: obj.reason,
    note: typeof obj.note === 'string' ? obj.note : null,
    recordedAt: typeof obj.recorded_at === 'string' ? obj.recorded_at : null,
    recordedBy: typeof obj.recorded_by === 'string' ? obj.recorded_by : null,
  }
}

/**
 * Phase 8BD — Reactivation panel. Mirrors RecoveryExplainerPanel
 * structurally so the operator UX is consistent: eyebrow + title
 * + body + "Use suggestion in draft" CTA. Plumbs through the
 * shared `pendingRecoveryInstruction` channel so a future surface
 * can swap one suggestion for another cleanly. NO autonomous
 * sending — the operator still clicks Regenerate + Approve & send.
 */
function ReactivationPanel({
  signal,
  pending,
  onUseSuggestion,
  onClearPending,
}: {
  signal: ReactivationSignal
  pending: { label: string; instruction: string } | null
  onUseSuggestion: () => void
  onClearPending: () => void
}) {
  const isStrong = signal.candidacy === 'strong_candidate'
  return (
    <div
      className={`mt-5 rounded-2xl border ${
        isStrong
          ? 'border-[#BFDBFE] bg-[#EFF6FF]'
          : 'border-[#E2E8F0] bg-[#F8FAFC]'
      } p-3.5`}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={`w-8 h-8 rounded-[10px] ${
            isStrong
              ? 'bg-white border border-[#BFDBFE] text-[#1D4ED8]'
              : 'bg-white border border-[#E2E8F0] text-[#0F172A]'
          } flex items-center justify-center shrink-0`}
        >
          <Lightbulb className="w-3.5 h-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={`text-[10.5px] uppercase tracking-[0.14em] font-semibold ${
              isStrong ? 'text-[#1D4ED8]' : 'text-[#475569]'
            }`}
          >
            Reactivation Agent
          </div>
          <p className="mt-0.5 text-[12.5px] text-[#0F172A] leading-snug">
            <span className="font-semibold">
              This lost lead may be worth reactivating.
            </span>{' '}
            <span className="text-[#475569]">
              {signal.label}. {signal.rationale}
            </span>
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[11.5px] text-[#475569] leading-snug min-w-0">
          <span className="font-semibold text-[#0F172A]">Suggested · </span>
          {pending ? (
            <span className="text-[#1D4ED8]">
              Loaded into the next regenerate.
            </span>
          ) : (
            <span>{signal.suggestedInstruction}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {pending ? (
            <button
              type="button"
              onClick={onClearPending}
              className="inline-flex items-center gap-1.5 text-[11.5px] px-2.5 py-1.5 rounded-md border border-[#E2E8F0] text-[#475569] hover:text-[#0F172A] hover:bg-white"
            >
              Clear suggestion
            </button>
          ) : (
            <button
              type="button"
              onClick={onUseSuggestion}
              className="inline-flex items-center gap-1.5 text-[11.5px] px-2.5 py-1.5 rounded-md bg-[#0F172A] text-white hover:bg-[#1E293B]"
            >
              Use reactivation suggestion in draft
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Phase 8BB — Suggested tour windows. Lives inside
 * TourReadinessPanel; renders up to two clickable chips
 * derived from the venue's saved availability. The chips open
 * the existing ScheduleTourDrawer with the slot pre-filled —
 * the operator still confirms inside the drawer.
 *
 * Empty/fallback states keep the panel useful:
 *   - `loading`           — quiet skeleton (no spinner; the
 *                           rest of the panel is already
 *                           usable)
 *   - `no_availability`   — nudge the operator to Settings →
 *                           Availability
 *   - `no_open_windows`   — every candidate conflicted with
 *                           existing tours or fell outside
 *                           the lead's event date
 *   - `ready`             — chips
 *   - `error` / `idle`    — hide silently; the panel keeps
 *                           working
 */
function SuggestedTourWindows({
  state,
  slots,
  onScheduleAt,
}: {
  state:
    | 'idle'
    | 'loading'
    | 'no_availability'
    | 'no_open_windows'
    | 'ready'
    | 'error'
  slots: TourSlotSuggestion[]
  onScheduleAt: (iso: string) => void
}) {
  if (state === 'idle' || state === 'error') return null
  return (
    <div className="mt-3">
      <div className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-[#64748B]">
        Suggested tour windows
      </div>
      {state === 'loading' && (
        <div className="mt-1 text-[11.5px] text-[#94A3B8]">
          Finding open windows from your availability…
        </div>
      )}
      {state === 'no_availability' && (
        <div className="mt-1 text-[11.5px] text-[#475569]">
          Add availability in Settings to unlock slot suggestions.
        </div>
      )}
      {state === 'no_open_windows' && (
        <div className="mt-1 text-[11.5px] text-[#475569]">
          No open windows found after availability, conflicts, and blackout dates.
        </div>
      )}
      {state === 'ready' && (
        <>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {slots.map((slot) => (
              <button
                key={slot.startsAt}
                type="button"
                onClick={() => onScheduleAt(slot.startsAt)}
                title={slot.rationale}
                className="inline-flex items-center text-[11.5px] px-2.5 py-1 rounded-full border border-[#BFDBFE] bg-white text-[#1D4ED8] hover:bg-[#EFF6FF]"
              >
                {slot.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10.5px] text-[#94A3B8]">
            Suggested from your availability, duration, buffer, and blackout dates.
          </p>
        </>
      )}
    </div>
  )
}

// Phase 8AS — Recovery explainer panel. Inline beneath the badge row
// so the operator sees "why this lead is slipping" before they pick a
// tab. The "Use suggestion in draft" CTA pre-fills the regenerate
// instruction but the operator stays in control of the actual send.
function RecoveryExplainerPanel({
  signal,
  pending,
  onUseSuggestion,
  onClearPending,
}: {
  signal: RecoveryLeadSignal
  pending: { label: string; instruction: string } | null
  onUseSuggestion: () => void
  onClearPending: () => void
}) {
  // Tone follows the primary reason. Cold = slate, tour = blue, the
  // amber-leaning reasons (high-fit, qualified-no-tour, negotiation)
  // share a single amber palette so the panel doesn't strobe between
  // shades for related signals.
  const reason = signal.primaryReason
  const tone =
    reason === 'tour_pending_confirm'
      ? {
          wrap: 'border-[#BFDBFE] bg-[#EFF6FF]',
          eyebrow: 'text-[#1D4ED8]',
          iconBg: 'bg-white border border-[#BFDBFE] text-[#1D4ED8]',
          chip: 'bg-white text-[#1D4ED8] border-[#BFDBFE]',
        }
      : reason === 'cold_lead'
        ? {
            wrap: 'border-[#E2E8F0] bg-[#F8FAFC]',
            eyebrow: 'text-[#475569]',
            iconBg: 'bg-white border border-[#E2E8F0] text-[#475569]',
            chip: 'bg-white text-[#475569] border-[#E2E8F0]',
          }
        : {
            wrap: 'border-[#FCD9A1] bg-[#FFFBEB]',
            eyebrow: 'text-[#B45309]',
            iconBg: 'bg-white border border-[#FCD9A1] text-[#B45309]',
            chip: 'bg-white text-[#B45309] border-[#FCD9A1]',
          }
  return (
    <div className={`mt-5 rounded-2xl border ${tone.wrap} p-3.5`}>
      <div className="flex items-start gap-2.5">
        <span
          className={`w-8 h-8 rounded-[10px] ${tone.iconBg} flex items-center justify-center shrink-0`}
        >
          <Lightbulb className="w-3.5 h-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={`text-[10.5px] uppercase tracking-[0.14em] font-semibold ${tone.eyebrow}`}
          >
            Why this lead is slipping
          </div>
          <p className="mt-0.5 text-[12.5px] text-[#0F172A] leading-snug">
            {signal.helper}
          </p>
          <div className="mt-2 flex items-center gap-1.5 flex-wrap">
            {signal.reasons.map((r) => (
              <span
                key={r}
                className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-[0.1em] px-2 py-0.5 rounded-full border ${tone.chip}`}
              >
                {r.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[11.5px] text-[#475569] leading-snug min-w-0">
          <span className="font-semibold text-[#0F172A]">
            Suggested · {signal.suggestedAction.title}.
          </span>{' '}
          {pending ? (
            <span className="text-[#1D4ED8]">
              Loaded into the next regenerate.
            </span>
          ) : (
            <span>
              Operator stays in control — clicking only pre-fills the
              instruction.
            </span>
          )}
        </div>
        {pending ? (
          <button
            type="button"
            onClick={onClearPending}
            className="inline-flex items-center gap-1.5 text-[11.5px] px-2.5 py-1.5 rounded-md border border-[#E2E8F0] text-[#475569] hover:text-[#0F172A] hover:bg-white shrink-0"
          >
            Clear suggestion
          </button>
        ) : (
          <button
            type="button"
            onClick={onUseSuggestion}
            className="inline-flex items-center gap-1.5 text-[11.5px] px-2.5 py-1.5 rounded-md bg-[#0F172A] text-white hover:bg-[#1E293B] shrink-0"
          >
            Use suggestion in draft
          </button>
        )}
      </div>
    </div>
  )
}

// Phase 8AQ — Speed-to-Lead chip. Lives inline so it sits next to the
// other identity badges. Wraps the helper output in a tone-coded pill.
function SpeedToLeadChip({ score }: { score: LeadSpeedToLeadScore }) {
  // Format minutes as "12m" / "2h 10m" so the chip stays compact.
  const formatMinutes = (m: number): string => {
    if (m < 60) return `${m}m`
    const h = Math.floor(m / 60)
    const rest = m % 60
    return rest === 0 ? `${h}h` : `${h}h ${rest}m`
  }
  let label: string
  let tone: 'emerald' | 'amber' | 'blue' | 'slate'
  if (score.status === 'met' && score.minutesToFirstReply !== null) {
    label = `SLA met · ${formatMinutes(score.minutesToFirstReply)}`
    tone = 'emerald'
  } else if (score.status === 'missed' && score.minutesToFirstReply !== null) {
    label = `SLA missed · ${formatMinutes(score.minutesToFirstReply)}`
    tone = 'amber'
  } else if (score.status === 'pending') {
    // Score 20 means we're past the SLA window; 60 means still inside.
    if (score.score <= 30) {
      label = 'Reply overdue'
      tone = 'amber'
    } else {
      label = 'Reply pending'
      tone = 'blue'
    }
  } else {
    label = 'SLA unknown'
    tone = 'slate'
  }
  const toneClasses: Record<typeof tone, string> = {
    emerald:
      'bg-[#ECFDF5] text-[#047857] border-[#A7F3D0]',
    amber:
      'bg-[#FFFBEB] text-[#B45309] border-[#FCD9A1]',
    blue:
      'bg-[#EFF6FF] text-[#1D4ED8] border-[#BFDBFE]',
    slate:
      'bg-[#F1F5F9] text-[#475569] border-[#E2E8F0]',
  }
  return (
    <span
      title={`Speed-to-Lead score ${score.score}/100 · SLA ${score.slaMinutes}m`}
      className={`inline-flex items-center text-[10.5px] font-semibold uppercase tracking-[0.1em] px-2 py-0.5 rounded-full border ${toneClasses[tone]}`}
    >
      {label}
    </span>
  )
}
