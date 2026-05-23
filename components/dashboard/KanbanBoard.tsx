'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  DragOverlay,
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import KanbanColumn from './KanbanColumn'
import KanbanCard from './KanbanCard'
import LeadDetailDrawer from './leads/LeadDetailDrawer'
import AddLeadModal from './AddLeadModal'
import { Button } from './ui/Button'
import { Plus, Search, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import {
  parseRevenueOsSettings,
  DEFAULT_REVENUE_OS_SETTINGS,
  type RevenueOsSettings,
} from '@/lib/revenue-os/settings'
import {
  leakageSignalDisplayName,
  type LeakageSignalKey,
  type LeakageLead,
  type LeakageInboundActivity,
  type LeakageOutboundActivity,
  type LeakageTour,
} from '@/lib/revenue-os/leakage'
import {
  computeRecoverySignals,
  type RecoveryLeadSignal,
} from '@/lib/revenue-os/recovery'
// Phase 8BJ — source filter (composes with leakage filter).
import { getLeadAttributionLabel } from '@/lib/enterprise/attribution/parse'
import { SOURCE_LABELS } from '@/lib/enterprise/attribution/types'
import {
  computeTourBookingSignals,
  tourBookingLeadIds,
} from '@/lib/revenue-os/tour-booking'
import {
  computeReactivationSignals,
  isLostReason,
  type LostReason,
} from '@/lib/revenue-os/reactivation'
import type { Database, LeadStage } from '@/types/database'

type Lead = Database['public']['Tables']['leads']['Row']

const STAGES: LeadStage[] = [
  'new_inquiry', 'qualified', 'tour_scheduled',
  'tour_completed', 'negotiation', 'booked', 'lost',
]

// Phase 8AQ — the four leakage filters that make sense for the leads
// board. `tour_pending_confirm` deep-links to /dashboard/tours instead
// (the brief routes it there, not here).
//
// Phase 8AS — `follow_up_recovery` is a synthetic key that aggregates
// the five recovery reasons from `computeRecoverySignals`. It lives
// in the same URL slot (`?leakage=`) so the existing pill + clear
// pattern stays consistent.
//
// Phase 8AT — `tour_booking` is the same shape but aggregates the
// Tour Booking Agent's five signals (qualified_no_tour,
// tour_scheduled_unconfirmed, tour_today, tour_completed_no_next_step,
// tour_no_show_recovery). One URL slot, one filter pattern.
type BoardFilterKey =
  | LeakageSignalKey
  | 'follow_up_recovery'
  | 'tour_booking'
  | 'reactivation'
const SUPPORTED_LEAKAGE_KEYS: BoardFilterKey[] = [
  'slow_first_reply',
  'high_fit_idle',
  'no_tour_booked',
  'cold_lead_recovery',
  'follow_up_recovery',
  'tour_booking',
  // Phase 8BD — `reactivation` aggregates lost leads where the
  // reactivation helper classified them as `strong` or `possible`
  // candidate. Lives in the same URL slot.
  'reactivation',
]

const STAGES_IN_FLIGHT = new Set<LeadStage>([
  'new_inquiry',
  'qualified',
  'tour_scheduled',
  'tour_completed',
  'negotiation',
])

interface KanbanBoardProps {
  initialLeads: Lead[]
}

export default function KanbanBoard({ initialLeads }: KanbanBoardProps) {
  const [leads, setLeads] = useState<Lead[]>(initialLeads)
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [search, setSearch] = useState('')

  // Phase 8AQ — leakage filter state.
  //   - `leakageFilter` is the active signal key (or null).
  //   - `settings` are the per-venue Revenue OS thresholds (defaults
  //     until the venue's metadata loads).
  //   - `tourLeadIds` is the set of lead ids with any tour row,
  //     fetched lazily when `no_tour_booked` is selected.
  //   - `lastInboundByLead` is the map of lead id → last inbound
  //     timestamp, fetched lazily when `cold_lead_recovery` is
  //     selected.
  //
  // We deliberately fetch extras ON DEMAND so the leads board stays
  // fast when no leakage filter is active. The brief's already-server-
  // rendered numbers carry the precise counts; the board's job here is
  // a usable approximate filter.
  // Phase 8BJ — independent source filter that composes on top
  // of the existing leakage filter via the URL `?source=` param.
  // Hydration mirrors the leakage filter useEffect below.
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)
  const [leakageFilter, setLeakageFilter] = useState<BoardFilterKey | null>(
    null
  )
  // Phase 8AS — set of lead ids that the recovery helper flagged.
  // Lazy-fetched when the operator switches to `follow_up_recovery`.
  // While the fetch is pending we fall back to "show in-flight
  // leads" so the board isn't empty.
  const [recoveryLeadIds, setRecoveryLeadIds] = useState<Set<string> | null>(
    null
  )
  // Phase 8AT — lead ids returned by the Tour Booking helper.
  // Lazy-fetched when `tour_booking` is the active filter.
  const [tourBookingFilterIds, setTourBookingFilterIds] = useState<
    Set<string> | null
  >(null)
  // Phase 8BD — lead ids returned by `computeReactivationSignals`.
  // Lazy-fetched when `reactivation` is the active filter. While
  // pending we fall back to "show lost leads" so the board isn't
  // empty mid-load.
  const [reactivationLeadIds, setReactivationLeadIds] = useState<
    Set<string> | null
  >(null)
  const [settings, setSettings] = useState<RevenueOsSettings>(
    DEFAULT_REVENUE_OS_SETTINGS
  )
  const [tourLeadIds, setTourLeadIds] = useState<Set<string> | null>(null)
  const [lastInboundByLead, setLastInboundByLead] = useState<Map<
    string,
    string
  > | null>(null)
  const [filterLoading, setFilterLoading] = useState(false)

  // Phase 8B — sync local state when the server-rendered `initialLeads`
  // changes (e.g. RealtimeLeadsLayer calls router.refresh() after a
  // postgres_changes event). Without this `useState(initialLeads)` only
  // seeds on first mount and live updates would be invisible.
  useEffect(() => {
    setLeads(initialLeads)
  }, [initialLeads])

  // Phase 8AK — CommandPalette "New lead" quick action wiring.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('new_lead') === '1') {
      setAddOpen(true)
      try {
        params.delete('new_lead')
        const next =
          window.location.pathname +
          (params.toString() ? `?${params.toString()}` : '') +
          window.location.hash
        window.history.replaceState({}, '', next)
      } catch {
        // replaceState can fail in sandboxed iframes; the modal still
        // opens, the URL just stays sticky.
      }
    }
    const onOpen = () => setAddOpen(true)
    window.addEventListener('venuerise:open-new-lead-modal', onOpen)
    return () => {
      window.removeEventListener('venuerise:open-new-lead-modal', onOpen)
    }
  }, [])

  // Phase 8AL — CommandPalette lead-result deep-link.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const target = params.get('lead')
    if (!target) return
    const match = initialLeads.find((l) => l.id === target)
    if (match) {
      setSelectedLead((cur) => (cur && cur.id === target ? cur : match))
    }
  }, [initialLeads])

  // Phase 8AL — strip `?lead=` on drawer close.
  const handleDrawerClose = useCallback(() => {
    setSelectedLead(null)
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (!params.has('lead')) return
    try {
      params.delete('lead')
      const next =
        window.location.pathname +
        (params.toString() ? `?${params.toString()}` : '') +
        window.location.hash
      window.history.replaceState({}, '', next)
    } catch {
      // Sandboxed iframe edge case — drawer still closes, URL stays.
    }
  }, [])

  // Phase 8AQ — on mount + on history navigation, read `?leakage=` and
  // hydrate the filter state. We don't strip the param; clearing the
  // filter pill is what removes it. That keeps a refresh inside a
  // filtered view stable.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const apply = () => {
      const params = new URLSearchParams(window.location.search)
      const raw = params.get('leakage')
      if (raw && (SUPPORTED_LEAKAGE_KEYS as string[]).includes(raw)) {
        setLeakageFilter(raw as BoardFilterKey)
      } else {
        setLeakageFilter(null)
      }
      // Phase 8BJ — `?source=<SourceLabel>`. Validate against
      // the known label union so a typo silently no-ops instead
      // of filtering to an empty board.
      const rawSource = params.get('source')
      if (
        rawSource &&
        (SOURCE_LABELS as readonly string[]).includes(rawSource)
      ) {
        setSourceFilter(rawSource)
      } else {
        setSourceFilter(null)
      }
    }
    apply()
    window.addEventListener('popstate', apply)
    return () => window.removeEventListener('popstate', apply)
  }, [])

  // Phase 8AR — fetch venue settings once on mount so KanbanCard
  // can render the at-a-glance Speed-to-Lead chip on new_inquiry
  // cards against the venue's real SLA, not the default. Best-effort:
  // a failure leaves settings at the default and nothing breaks.
  useEffect(() => {
    if (leads.length === 0) return
    let cancelled = false
    const supabase = createClient()
    const venueId = leads[0].venue_id
    ;(async () => {
      try {
        const { data: venueRow } = await supabase
          .from('venues')
          .select('metadata')
          .eq('id', venueId)
          .maybeSingle()
        if (cancelled) return
        setSettings(
          parseRevenueOsSettings(
            (venueRow as { metadata?: unknown } | null)?.metadata
          )
        )
      } catch {
        // Defaults stay in place; chips still render against them.
      }
    })()
    return () => {
      cancelled = true
    }
    // We intentionally re-derive on the FIRST mount only — settings
    // changes mid-session are rare and the leakage-filter effect
    // below also refreshes settings, so churn is bounded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Phase 8AQ — when a leakage filter is active, fetch the venue
  // settings (one shot, cached for the session) + any auxiliary data
  // the chosen signal needs.
  useEffect(() => {
    if (!leakageFilter) {
      setFilterLoading(false)
      return
    }
    if (leads.length === 0) return
    let cancelled = false
    setFilterLoading(true)
    const supabase = createClient()
    const venueId = leads[0].venue_id
    ;(async () => {
      try {
        // 1. Venue settings — only fetch once per session per venue.
        // The settings are written to local state so subsequent filter
        // switches don't re-pay the round-trip.
        const { data: venueRow } = await supabase
          .from('venues')
          .select('metadata')
          .eq('id', venueId)
          .maybeSingle()
        if (cancelled) return
        const next = parseRevenueOsSettings(
          (venueRow as { metadata?: unknown } | null)?.metadata
        )
        setSettings(next)

        // 2. Conditional extras per filter.
        const leadIds = leads.map((l) => l.id)
        if (leakageFilter === 'no_tour_booked' && leadIds.length > 0) {
          const { data: tourRows } = await supabase
            .from('tours')
            .select('lead_id')
            .eq('venue_id', venueId)
            .in('lead_id', leadIds)
            .limit(2000)
          if (cancelled) return
          const ids = new Set<string>()
          for (const t of (tourRows as Array<{ lead_id: string }> | null) ??
            []) {
            ids.add(t.lead_id)
          }
          setTourLeadIds(ids)
        }
        if (leakageFilter === 'cold_lead_recovery' && leadIds.length > 0) {
          const { data: msgRows } = await supabase
            .from('messages')
            .select('lead_id, created_at')
            .eq('venue_id', venueId)
            .eq('role', 'lead')
            .in('lead_id', leadIds)
            .order('created_at', { ascending: true })
            .limit(5000)
          if (cancelled) return
          const map = new Map<string, string>()
          for (const m of (msgRows as Array<{
            lead_id: string
            created_at: string
          }> | null) ?? []) {
            map.set(m.lead_id, m.created_at)
          }
          setLastInboundByLead(map)
        }
        // Phase 8AT — `tour_booking` needs lead + tour data only
        // (no message history). One round-trip + helper call.
        if (leakageFilter === 'tour_booking' && leadIds.length > 0) {
          const inFlightLeads: LeakageLead[] = leads
            .filter((l) => l.stage !== 'lost')
            .map((l) => ({
              id: l.id,
              stage: l.stage,
              lead_score: l.lead_score,
              created_at: l.created_at,
              updated_at: l.updated_at,
            }))
          const { data: tourRows } = await supabase
            .from('tours')
            .select('id, lead_id, status, scheduled_at')
            .eq('venue_id', venueId)
            .limit(2000)
          if (cancelled) return
          const tours = (tourRows ?? []) as LeakageTour[]
          const signals = computeTourBookingSignals({
            leads: inFlightLeads,
            tours,
          })
          setTourBookingFilterIds(tourBookingLeadIds(signals))
        }
        // Phase 8AS — `follow_up_recovery` needs the full recovery
        // input set (in-flight leads + last inbound + first outbound
        // + tours) to compute the queue. We pull everything in one
        // burst and hand it to the helper so the board agrees with
        // the Overview RecoveryQueueCard.
        if (leakageFilter === 'follow_up_recovery' && leadIds.length > 0) {
          const inFlightLeads: LeakageLead[] = leads
            .filter(
              (l) => l.stage !== 'booked' && l.stage !== 'lost'
            )
            .map((l) => ({
              id: l.id,
              stage: l.stage,
              lead_score: l.lead_score,
              created_at: l.created_at,
              updated_at: l.updated_at,
            }))
          const [msgRes, tourRes] = await Promise.all([
            supabase
              .from('messages')
              .select('lead_id, role, created_at')
              .eq('venue_id', venueId)
              .in(
                'lead_id',
                inFlightLeads.map((l) => l.id)
              )
              .order('created_at', { ascending: true })
              .limit(5000),
            supabase
              .from('tours')
              .select('id, lead_id, status, scheduled_at')
              .eq('venue_id', venueId)
              .limit(500),
          ])
          if (cancelled) return
          const inboundMap = new Map<string, string | null>()
          const outboundMap = new Map<string, string | null>()
          for (const m of (msgRes.data as Array<{
            lead_id: string
            role: string
            created_at: string
          }> | null) ?? []) {
            if (m.role === 'ai' || m.role === 'human') {
              if (!outboundMap.has(m.lead_id)) {
                outboundMap.set(m.lead_id, m.created_at)
              }
            } else if (m.role === 'lead') {
              inboundMap.set(m.lead_id, m.created_at)
            }
          }
          const inbound: LeakageInboundActivity[] = inFlightLeads.map(
            (l) => ({
              lead_id: l.id,
              last_inbound_at: inboundMap.get(l.id) ?? null,
            })
          )
          const outbound: LeakageOutboundActivity[] = inFlightLeads.map(
            (l) => ({
              lead_id: l.id,
              first_outbound_at: outboundMap.get(l.id) ?? null,
            })
          )
          const tours = (tourRes.data ?? []) as LeakageTour[]
          const signals: RecoveryLeadSignal[] = computeRecoverySignals({
            leads: inFlightLeads,
            inbound,
            outbound,
            tours,
            settings: next,
          })
          setRecoveryLeadIds(new Set(signals.map((s) => s.leadId)))
        }

        // Phase 8BD — `reactivation` needs lost leads + per-lead
        // last lead-role message + each lead's metadata.lost_reason.
        // We pull lost leads explicitly (the in-memory `leads`
        // already has them but not their metadata) so the helper
        // sees the recorded reason.
        if (leakageFilter === 'reactivation') {
          const lostIds = leads
            .filter((l) => l.stage === 'lost')
            .map((l) => l.id)
          if (lostIds.length > 0) {
            const [lostRowsRes, lostMsgRes] = await Promise.all([
              supabase
                .from('leads')
                .select(
                  'id, name, stage, lead_score, event_date, updated_at, metadata'
                )
                .eq('venue_id', venueId)
                .in('id', lostIds),
              supabase
                .from('messages')
                .select('lead_id, created_at')
                .eq('venue_id', venueId)
                .eq('role', 'lead')
                .in('lead_id', lostIds)
                .order('created_at', { ascending: false })
                .limit(2000),
            ])
            if (cancelled) return
            const lastInbound: Record<string, string | null> = {}
            for (const m of (lostMsgRes.data as Array<{
              lead_id: string
              created_at: string
            }> | null) ?? []) {
              if (!(m.lead_id in lastInbound)) {
                lastInbound[m.lead_id] = m.created_at
              }
            }
            for (const id of lostIds) {
              if (!(id in lastInbound)) lastInbound[id] = null
            }
            const helperLeads = ((lostRowsRes.data ?? []) as Array<{
              id: string
              name: string
              stage: string
              lead_score: number
              event_date: string | null
              updated_at: string
              metadata: Record<string, unknown> | null
            }>).map((l) => {
              const block =
                l.metadata && typeof l.metadata === 'object'
                  ? (l.metadata as { lost_reason?: unknown }).lost_reason
                  : undefined
              const reason =
                block &&
                typeof block === 'object' &&
                isLostReason(
                  (block as { reason?: unknown }).reason
                )
                  ? ((block as { reason: LostReason }).reason)
                  : null
              return {
                id: l.id,
                name: l.name,
                stage: l.stage,
                lead_score: l.lead_score,
                event_date: l.event_date,
                updated_at: l.updated_at,
                lost_reason: reason,
              }
            })
            const reactSignals = computeReactivationSignals({
              leads: helperLeads,
              lastMessages: lastInbound,
            })
            setReactivationLeadIds(
              new Set(reactSignals.map((s) => s.leadId))
            )
          } else {
            setReactivationLeadIds(new Set())
          }
        }
      } catch {
        // Defensive: a probe failure collapses to "no extras" — the
        // approximate filter still works on lead-only columns.
      } finally {
        if (!cancelled) setFilterLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [leakageFilter, leads])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // Phase 8AQ — leakage filter applied on top of the existing search.
  // The math here mirrors the helpers in lib/revenue-os/leakage.ts
  // (deliberately duplicated as approximation — we don't have the full
  // outbound activity slice on the client). Each missing piece of data
  // collapses to a more permissive predicate so the operator sees the
  // candidate slice rather than an empty board.
  const now = Date.now()
  const filteredByLeakage = useMemo(() => {
    if (!leakageFilter) return leads
    switch (leakageFilter) {
      case 'slow_first_reply': {
        const cutoff = now - settings.firstReplySlaMinutes * 60 * 1000
        return leads.filter((l) => {
          if (l.stage !== 'new_inquiry') return false
          return new Date(l.created_at).getTime() <= cutoff
        })
      }
      case 'high_fit_idle': {
        const cutoff = now - settings.staleHighFitHours * 60 * 60 * 1000
        return leads.filter((l) => {
          if (l.lead_score < settings.highFitThreshold) return false
          if (!STAGES_IN_FLIGHT.has(l.stage as LeadStage)) return false
          return new Date(l.updated_at).getTime() <= cutoff
        })
      }
      case 'no_tour_booked': {
        return leads.filter((l) => {
          if (l.stage !== 'qualified' && l.stage !== 'negotiation') return false
          // If the tours fetch hasn't completed yet, fall back to
          // "any qualified-stage lead" — better than showing nothing.
          if (tourLeadIds === null) return true
          return !tourLeadIds.has(l.id)
        })
      }
      case 'tour_booking': {
        // Phase 8AT — until the helper fetch completes, fall back
        // to in-flight leads (consistent with the recovery filter).
        return leads.filter((l) => {
          if (tourBookingFilterIds === null) {
            return STAGES_IN_FLIGHT.has(l.stage as LeadStage)
          }
          return tourBookingFilterIds.has(l.id)
        })
      }
      case 'follow_up_recovery': {
        // Phase 8AS — use the recovery helper's lead id set. Until
        // the lazy fetch completes, fall back to in-flight leads so
        // the board isn't empty mid-load.
        return leads.filter((l) => {
          if (recoveryLeadIds === null) {
            return STAGES_IN_FLIGHT.has(l.stage as LeadStage)
          }
          return recoveryLeadIds.has(l.id)
        })
      }
      case 'reactivation': {
        // Phase 8BD — use the reactivation helper's lead id set.
        // Until the lazy fetch completes, fall back to "any lost
        // lead" so the board isn't empty mid-load.
        return leads.filter((l) => {
          if (l.stage !== 'lost') return false
          if (reactivationLeadIds === null) return true
          return reactivationLeadIds.has(l.id)
        })
      }
      case 'cold_lead_recovery': {
        // Phase 8AR — baseline fix mirrors the helper: when no inbound
        // exists, lead.created_at is the safest "last heard from the
        // lead" proxy. A lead is cold only when the baseline is
        // older than `coldLeadDays`.
        const coldCutoff = now - settings.coldLeadDays * 24 * 60 * 60 * 1000
        return leads.filter((l) => {
          if (!STAGES_IN_FLIGHT.has(l.stage as LeadStage)) return false
          if (l.stage === 'new_inquiry') return false
          // While the inbound fetch hasn't completed, fall back to
          // `lead.created_at` as the baseline (matches the helper's
          // post-fetch behavior — no false-positive surge).
          const last =
            lastInboundByLead === null ? null : lastInboundByLead.get(l.id)
          const baseline = last ?? l.created_at
          const baselineMs = new Date(baseline).getTime()
          if (!Number.isFinite(baselineMs)) return false
          return baselineMs < coldCutoff
        })
      }
      default:
        return leads
    }
  }, [
    leads,
    leakageFilter,
    settings,
    tourLeadIds,
    lastInboundByLead,
    recoveryLeadIds,
    tourBookingFilterIds,
    reactivationLeadIds,
    now,
  ])

  // Phase 8BJ — source filter composes on top of leakage. Reads
  // each lead's attribution source label and matches against the
  // hydrated URL param. `Unknown` is matchable so operators can
  // see the unattributed bucket.
  const filteredBySource = useMemo(() => {
    if (!sourceFilter) return filteredByLeakage
    return filteredByLeakage.filter((l) => {
      const label =
        getLeadAttributionLabel((l as { metadata?: unknown }).metadata) ??
        'Unknown'
      return label === sourceFilter
    })
  }, [filteredByLeakage, sourceFilter])

  // Search filter is applied AFTER both filters so the operator
  // can narrow a filtered slice further.
  const filtered = filteredBySource.filter(
    (l) =>
      !search ||
      l.name.toLowerCase().includes(search.toLowerCase()) ||
      l.email.toLowerCase().includes(search.toLowerCase())
  )
  const leadsByStage = (stage: LeadStage) =>
    filtered.filter((l) => l.stage === stage)
  const activeLead = activeId ? leads.find((l) => l.id === activeId) ?? null : null
  // DnD is suppressed when EITHER filter is active — same
  // rationale as 8AQ: dropping into a column whose contents
  // are partially hidden loses operator context.
  const dndDisabled = leakageFilter !== null || sourceFilter !== null

  // Phase 8BJ — independent clear handler for the source param.
  // Removes ONLY `?source=`, leaves `?leakage=` alone (and vice
  // versa for the leakage clear handler below).
  const clearSourceFilter = useCallback(() => {
    setSourceFilter(null)
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (!params.has('source')) return
    try {
      params.delete('source')
      const next =
        window.location.pathname +
        (params.toString() ? `?${params.toString()}` : '') +
        window.location.hash
      window.history.replaceState({}, '', next)
    } catch {
      // sandboxed iframe — filter still clears in memory.
    }
  }, [])

  const clearLeakageFilter = useCallback(() => {
    setLeakageFilter(null)
    setTourLeadIds(null)
    setLastInboundByLead(null)
    setRecoveryLeadIds(null)
    setTourBookingFilterIds(null)
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (!params.has('leakage')) return
    try {
      params.delete('leakage')
      const next =
        window.location.pathname +
        (params.toString() ? `?${params.toString()}` : '') +
        window.location.hash
      window.history.replaceState({}, '', next)
    } catch {
      // sandboxed iframe edge case — filter still clears in memory.
    }
  }, [])

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event
    setActiveId(null)
    if (!over) return

    const leadId = active.id as string
    const targetStage = over.id as LeadStage
    if (!STAGES.includes(targetStage)) return

    const lead = leads.find((l) => l.id === leadId)
    if (!lead || lead.stage === targetStage) return

    setLeads((prev) => prev.map((l) => l.id === leadId ? { ...l, stage: targetStage } : l))

    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: targetStage }),
      })
      if (!res.ok) {
        setLeads((prev) => prev.map((l) => l.id === leadId ? { ...l, stage: lead.stage } : l))
      } else {
        const updated = await res.json()
        setLeads((prev) => prev.map((l) => l.id === leadId ? updated : l))
      }
    } catch {
      setLeads((prev) => prev.map((l) => l.id === leadId ? { ...l, stage: lead.stage } : l))
    }
  }, [leads])

  const handleUpdate = (updated: Lead) => {
    setLeads((prev) => prev.map((l) => l.id === updated.id ? updated : l))
    setSelectedLead(updated)
  }
  const handleDelete = (leadId: string) => setLeads((prev) => prev.filter((l) => l.id !== leadId))
  const handleCreated = (lead: Lead) => setLeads((prev) => [lead, ...prev])

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-3 mb-4">
        {/* GTM-0E — the LeadsPipelineSummary above the board now
            carries the headline framing ("tracked / need action /
            open pipeline"). This in-board line is the live filter
            counter, deliberately quieter and only meaningful when
            search/filter narrows the view. */}
        <p className="text-[12.5px] text-[#64748B]">
          {filtered.length === leads.length
            ? `Showing all ${leads.length} ${leads.length === 1 ? 'lead' : 'leads'}`
            : `Showing ${filtered.length} of ${leads.length} ${leads.length === 1 ? 'lead' : 'leads'}`}
        </p>
        <div className="flex items-center gap-2">
          <div className="hidden md:flex items-center gap-2 bg-white border border-[#E2E8F0] rounded-full pl-3 pr-2 h-9 w-64">
            <Search className="w-3.5 h-3.5 text-[#94A3B8]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search couple, email, or source…"
              className="flex-1 bg-transparent text-[13px] outline-none text-[#0F172A] placeholder:text-[#94A3B8]"
            />
          </div>
          <Button data-testid="add-lead-button" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="w-3.5 h-3.5" />
            Add Lead
          </Button>
        </div>
      </div>

      {/* Phase 8BJ — source filter pill. Renders ABOVE the leakage
          pill so when both are active the operator reads the
          source context first ("you're inside Google Ads, and
          you're seeing the No-tour-booked slice"). Clear is
          independent — closing the source pill leaves any active
          leakage filter intact. */}
      {sourceFilter && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-[#FCD9A1] bg-[#FFFBEB] px-3 py-2">
          <span className="text-[10.5px] uppercase tracking-[0.14em] text-[#B45309] font-semibold">
            Source filter
          </span>
          <span className="text-[12.5px] text-[#0F172A] font-semibold">
            {sourceFilter}
          </span>
          <span className="text-[11px] text-[#B45309]">
            · {filteredBySource.length} match
            {filteredBySource.length === 1 ? '' : 'es'}
          </span>
          <div className="flex-1" />
          <span className="text-[11px] text-[#92400E] hidden sm:inline">
            Clear the source filter to see all leads.
          </span>
          <button
            type="button"
            onClick={clearSourceFilter}
            className="inline-flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-md text-[#B45309] hover:bg-white"
          >
            <X className="w-3 h-3" />
            Clear source
          </button>
        </div>
      )}

      {/* Phase 8AQ — leakage filter pill. Renders only when a filter
          is active. Includes a clear button that strips the URL param
          + a soft "drag disabled while filtered" hint so the operator
          isn't surprised when cards stop reordering. */}
      {leakageFilter && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-[#BFDBFE] bg-[#EFF6FF] px-3 py-2">
          <span className="text-[10.5px] uppercase tracking-[0.14em] text-[#1D4ED8] font-semibold">
            Revenue OS filter
          </span>
          <span className="text-[12.5px] text-[#0F172A] font-semibold">
            Showing:{' '}
            {leakageFilter === 'follow_up_recovery'
              ? 'Recovery queue'
              : leakageFilter === 'tour_booking'
                ? 'Tour Booking queue'
                : leakageFilter === 'reactivation'
                  ? 'Reactivation queue'
                  : leakageSignalDisplayName(leakageFilter)}
          </span>
          {filterLoading && (
            <span className="text-[11px] text-[#1D4ED8]">Refining…</span>
          )}
          <span className="text-[11px] text-[#1D4ED8]">
            · {filteredByLeakage.length} match
            {filteredByLeakage.length === 1 ? '' : 'es'}
          </span>
          <div className="flex-1" />
          <span className="text-[11px] text-[#64748B] hidden sm:inline">
            Clear the leakage filter to reorder pipeline cards.
          </span>
          <button
            type="button"
            onClick={clearLeakageFilter}
            className="inline-flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-md text-[#1D4ED8] hover:bg-white"
          >
            <X className="w-3 h-3" />
            Clear filter
          </button>
        </div>
      )}

      <div className="overflow-x-auto -mx-6 lg:-mx-8 px-6 lg:px-8 pb-4">
        {dndDisabled ? (
          // Phase 8AQ — drag/drop intentionally suppressed while a
          // leakage filter is active. Mixing a partial pipeline view
          // with stage drag-and-drop would let the operator drop a
          // card into a column that's been filtered down to a tiny
          // subset and lose context. Cards are still clickable
          // (opens the drawer) so triage still works.
          <div className="flex gap-3 min-w-max">
            {STAGES.map((stage) => (
              <KanbanColumn
                key={stage}
                stage={stage}
                leads={leadsByStage(stage)}
                onCardClick={setSelectedLead}
                slaMinutes={settings.firstReplySlaMinutes}
              />
            ))}
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={(e) => setActiveId(e.active.id as string)}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setActiveId(null)}
          >
            <div className="flex gap-3 min-w-max">
              {STAGES.map((stage) => (
                <KanbanColumn
                  key={stage}
                  stage={stage}
                  leads={leadsByStage(stage)}
                  onCardClick={setSelectedLead}
                />
              ))}
            </div>

            <DragOverlay>
              {/* UI_INTERACTION_EXEMPT: DragOverlay clone — visual only, not clickable. */}
              {activeLead && <KanbanCard lead={activeLead} onClick={() => {}} />}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      {/* Phase 8AH — premium right-side drawer replaces the legacy
          LeadDetailPanel. */}
      <LeadDetailDrawer
        lead={selectedLead}
        onClose={handleDrawerClose}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
      />

      <AddLeadModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  )
}
