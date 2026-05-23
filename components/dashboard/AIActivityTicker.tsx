'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Sparkles, ArrowRight, CalendarCheck, MessagesSquare, Flame, RotateCcw, Wand2 } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'

/**
 * GTM-0I — Real-time AI activity ticker.
 *
 * Sits on /dashboard between ExecutiveHero and TodayPriorityCard.
 * Answers the buyer's question: "is this thing actually doing
 * anything for me right now?"
 *
 * Design constraints:
 *   - Single compact card. Never grow past 5 visible rows.
 *   - Server hydrates `initialActions` from `ai_actions` (last 8);
 *     the client component prepends new INSERTs from a Supabase
 *     Realtime subscription so a brand-new draft shows up live.
 *   - No autonomous-send claims. Every label is buyer-friendly
 *     and honest about whether the AI drafted/suggested/flagged
 *     vs. actually sent anything.
 *   - Compact "Live" dot in the header so the operator knows the
 *     subscription is wired (cosmetic — there's no health probe
 *     against the channel state).
 *   - Subtle "View inbox →" CTA so the demo flow has a one-click
 *     handoff into where the AI's drafts live.
 *
 * Why client-component-with-server-hydration: the realtime
 * subscription needs `useEffect` + `useState`. Server-rendering
 * the initial rows means the demo has rich first paint, and the
 * subscription only ever appends — we never re-query the table.
 */

export interface AIActivityRow {
  id: string
  agent: string
  action: string
  input_summary: string | null
  output_summary: string | null
  success: boolean
  lead_id: string | null
  created_at: string
}

interface Props {
  initialActions: AIActivityRow[]
  venueId: string | null
}

const MAX_VISIBLE = 5
const MAX_BUFFER = 12

export default function AIActivityTicker({ initialActions, venueId }: Props) {
  const [actions, setActions] = useState<AIActivityRow[]>(
    initialActions.slice(0, MAX_BUFFER)
  )
  const [live, setLive] = useState(false)

  useEffect(() => {
    if (!venueId) return
    const supabase = createClient()
    const channel = supabase
      .channel(`ai_actions:venue:${venueId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'ai_actions',
          filter: `venue_id=eq.${venueId}`,
        },
        (payload) => {
          const row = payload.new as Partial<AIActivityRow> & { id?: string }
          if (!row?.id) return
          setActions((prev) => {
            // De-dupe against the server-hydrated initial set in case
            // a row landed between server-render and subscribe.
            if (prev.some((a) => a.id === row.id)) return prev
            const next: AIActivityRow = {
              id: row.id as string,
              agent: (row.agent as string) ?? 'unknown',
              action: (row.action as string) ?? 'unknown',
              input_summary: (row.input_summary as string | null) ?? null,
              output_summary: (row.output_summary as string | null) ?? null,
              success: row.success !== false,
              lead_id: (row.lead_id as string | null) ?? null,
              created_at: (row.created_at as string) ?? new Date().toISOString(),
            }
            return [next, ...prev].slice(0, MAX_BUFFER)
          })
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setLive(true)
        else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') setLive(false)
      })
    return () => {
      supabase.removeChannel(channel)
    }
  }, [venueId])

  const visible = actions.slice(0, MAX_VISIBLE)
  const hasActivity = visible.length > 0

  return (
    <section className="rounded-2xl border border-[#E6E8EF] bg-white shadow-card overflow-hidden mb-4">
      <div className="flex items-center justify-between gap-3 px-5 pt-3.5 pb-2.5 border-b border-[#F1F5F9]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-7 h-7 rounded-lg bg-[#0F172A] text-white flex items-center justify-center shrink-0">
            <Sparkles className="w-3.5 h-3.5" />
          </span>
          <div className="min-w-0">
            <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#64748B] font-semibold">
              AI activity
            </div>
            <div className="text-[12.5px] font-semibold text-[#0F172A] leading-tight">
              What VenueRise is working on
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {/* GTM-0I — Live indicator. Goes solid emerald when the
              Realtime channel reports SUBSCRIBED, mutes to slate when
              the channel is closed or errored. Cosmetic only — no
              fallback polling. */}
          <span className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.12em] font-semibold">
            <span
              className={`relative w-1.5 h-1.5 rounded-full ${
                live ? 'bg-emerald-500' : 'bg-slate-300'
              }`}
            >
              {live && (
                <span className="absolute inset-0 rounded-full bg-emerald-500 animate-ping opacity-60" />
              )}
            </span>
            <span className={live ? 'text-emerald-700' : 'text-slate-400'}>
              {live ? 'Live' : 'Idle'}
            </span>
          </span>
          <Link
            href="/dashboard/inbox"
            className="inline-flex items-center gap-1 text-[11.5px] px-2.5 py-1 rounded-md text-[#1D4ED8] hover:bg-[#EFF6FF]"
          >
            View inbox
            <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      </div>

      <div className="px-5 py-3">
        {hasActivity ? (
          <ul className="divide-y divide-[#F1F5F9]">
            {visible.map((row) => {
              const meta = describeAction(row)
              const Icon = ICONS[meta.kind]
              return (
                <li key={row.id} className="py-2.5 flex items-center gap-3">
                  <span
                    className={`w-7 h-7 rounded-lg ${meta.iconBg} ${meta.iconText} flex items-center justify-center shrink-0`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[12.5px] text-[#0F172A] truncate">
                      {meta.label}
                    </p>
                  </div>
                  <span className="text-[10.5px] text-[#94A3B8] tabular-nums shrink-0">
                    {timeAgo(row.created_at)}
                  </span>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="py-4 flex items-center gap-3">
            <span className="w-7 h-7 rounded-lg bg-[#F1F5F9] text-[#475569] flex items-center justify-center shrink-0">
              <Sparkles className="w-3.5 h-3.5" />
            </span>
            <p className="text-[12.5px] text-[#475569] leading-snug">
              VenueRise is waiting on new inquiries. Activity will appear here as the AI works in the background.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}

// ── Buyer-friendly copy mapping ──────────────────────────────────────────
// Honest framing per the GTM-0I spec:
//   - "drafted" / "suggested" / "flagged" / "qualified" / "prepared"
//     are safe verbs. They describe AI-assisted work for review.
//   - We do NOT say "sent", "booked", or "recovered" — those require
//     evidence we don't have at this surface.
//   - Lead name is extracted from `input_summary` ("Lead: Sarah Johnson")
//     when present and rendered as "for <Name>"; otherwise we fall
//     back to "for a new inquiry" or "a lead interaction" so the
//     copy never goes hollow.

type ActivityKind =
  | 'draft'
  | 'qualify'
  | 'tour'
  | 'followup'
  | 'flag'
  | 'review'

interface DescribedAction {
  label: string
  kind: ActivityKind
  iconBg: string
  iconText: string
}

const ICONS: Record<ActivityKind, typeof Sparkles> = {
  draft: MessagesSquare,
  qualify: Wand2,
  tour: CalendarCheck,
  followup: RotateCcw,
  flag: Flame,
  review: Sparkles,
}

const TONES: Record<ActivityKind, { iconBg: string; iconText: string }> = {
  draft:    { iconBg: 'bg-[#EFF6FF]', iconText: 'text-[#1D4ED8]' },
  qualify:  { iconBg: 'bg-[#F1F5F9]', iconText: 'text-[#0F172A]' },
  tour:     { iconBg: 'bg-[#ECFDF5]', iconText: 'text-[#047857]' },
  followup: { iconBg: 'bg-[#FAF7F0]', iconText: 'text-[#92763C]' },
  flag:     { iconBg: 'bg-[#FFFBEB]', iconText: 'text-[#B45309]' },
  review:   { iconBg: 'bg-[#F1F5F9]', iconText: 'text-[#475569]' },
}

function extractLeadName(input: string | null | undefined): string | null {
  if (!input) return null
  // Common shapes from existing ai_actions writers:
  //   "Lead: Sarah Johnson"
  //   "Lead: Sarah Johnson, source: website"
  //   "Lead Sarah" (rare)
  const m = input.match(/^lead[:\s]+([^,;\n]+)/i)
  if (!m) return null
  const raw = m[1].trim()
  if (raw.length === 0 || raw.length > 60) return null
  return raw
}

function describeAction(row: AIActivityRow): DescribedAction {
  const action = (row.action ?? '').toLowerCase()
  const agent = (row.agent ?? '').toLowerCase()
  const name = extractLeadName(row.input_summary)
  const forName = name ? `for ${name}` : null

  // Instant Lead Response family (Phase GTM-ILR).
  if (action.startsWith('instant_lead_response')) {
    if (action.includes('fallback')) {
      return mk(
        forName
          ? `Prepared a safe fallback reply ${forName}`
          : 'Prepared a safe fallback reply for a new inquiry',
        'draft'
      )
    }
    if (action.includes('auto_send_eligible')) {
      return mk(
        forName
          ? `Drafted an instant reply ${forName} — ready for review`
          : 'Drafted an instant reply for a new inquiry — ready for review',
        'draft'
      )
    }
    return mk(
      forName
        ? `Drafted an instant reply ${forName}`
        : 'Drafted an instant reply for a new inquiry',
      'draft'
    )
  }

  // Orchestrator + qualification.
  if (action === 'handle_new_lead' || agent === 'lead_qualifier' || action === 'qualify') {
    return mk(
      name ? `Qualified a new inquiry from ${name}` : 'Qualified a new website inquiry',
      'qualify'
    )
  }

  // Draft regeneration (Phase 8AM).
  if (action.includes('draft_regenerate') || action.includes('draft')) {
    return mk(
      forName ? `Refreshed a draft reply ${forName}` : 'Refreshed a draft reply for a lead',
      'draft'
    )
  }

  // Tour scheduling helpers (Phase 8BJ/8BK).
  if (
    action.includes('tour') ||
    action.includes('slot') ||
    action.includes('availability')
  ) {
    return mk(
      forName ? `Suggested tour times ${forName}` : 'Suggested tour times for a lead',
      'tour'
    )
  }

  // Follow-up + reactivation.
  if (
    action.includes('follow_up') ||
    action.includes('followup') ||
    action.includes('reactivation') ||
    agent.includes('recovery')
  ) {
    return mk(
      forName
        ? `Prepared a follow-up message ${forName}`
        : 'Prepared a follow-up for a stalled lead',
      'followup'
    )
  }

  // High-fit / risk flagging.
  if (action.includes('flag') || action.includes('risk') || action.includes('high_fit')) {
    return mk(
      name ? `Flagged a high-fit inquiry from ${name}` : 'Flagged a high-fit inquiry',
      'flag'
    )
  }

  // Generic fallback — safe + truthful.
  return mk(
    name ? `AI reviewed a lead interaction for ${name}` : 'AI reviewed a lead interaction',
    'review'
  )
}

function mk(label: string, kind: ActivityKind): DescribedAction {
  return { label, kind, ...TONES[kind] }
}

function timeAgo(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true })
      .replace('about ', '')
      .replace('less than a minute ago', 'just now')
  } catch {
    return ''
  }
}
