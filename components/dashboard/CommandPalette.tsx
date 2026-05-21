'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useRouter } from 'next/navigation'
import {
  Search,
  Home,
  Users,
  Inbox as InboxIcon,
  CalendarCheck,
  BarChart3,
  Settings,
  CreditCard,
  Plus,
  CalendarPlus,
  Mail,
  ArrowRight,
  Loader2,
  User as UserIcon,
  MessageSquare,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Phase 8AJ → 8AK → 8AL — global command palette.
 *
 * 8AJ: static command set, ⌘K shortcut, opened from topbar pill.
 * 8AK: quick actions dispatch CustomEvents + URL fallbacks.
 * 8AL: backend search adds dynamic LEADS / CONVERSATIONS / TOURS
 *      groups beneath the static commands. Single debounced GET to
 *      `/api/dashboard/search?q=...`. Keyboard nav traverses the
 *      combined static + dynamic list as one flat sequence.
 *
 * Opens from:
 *   - Click on the DashboardTopBar search pill
 *   - ⌘K (Mac) / Ctrl+K (Windows / Linux) anywhere in the dashboard
 *
 * Closes on Esc, on route navigation, on backdrop click, or on
 * explicit `onClose`.
 *
 * Quick-action contract (Phase 8AK):
 *   - "New lead": navigate to /dashboard/leads?new_lead=1 AND dispatch
 *     `venuerise:open-new-lead-modal`. The leads page listens.
 *   - "Schedule tour": `?schedule_tour=1` + `venuerise:open-schedule-tour`.
 *   - "Send sample digest": `/dashboard/settings/billing?digest_action=sample`
 *     scrolls + highlights the DigestPreferencesCard.
 */

type CommandKind = 'route' | 'action' | 'lead' | 'conversation' | 'tour' | 'message'
type ResultKind = 'lead' | 'conversation' | 'tour' | 'message'
type CommandGroup =
  | 'Commands'
  | 'Quick actions'
  | 'Leads'
  | 'Conversations'
  | 'Tours'
  | 'Messages'

export interface CommandItem {
  id: string
  kind: CommandKind
  label: string
  description: string
  href: string
  icon: typeof Home
  hint?: string
  group: CommandGroup
  /** Optional CustomEvent name to dispatch after navigation (8AK). */
  dispatchEvent?: string
}

interface ApiSearchItem {
  id: string
  kind: 'lead' | 'conversation' | 'tour' | 'message'
  title: string
  subtitle: string
  href: string
  score: number
}

const STATIC_COMMANDS: ReadonlyArray<CommandItem> = [
  { id: 'overview',  kind: 'route',  label: 'Overview',  description: 'Dashboard home',                  href: '/dashboard',                  icon: Home,          group: 'Commands' },
  { id: 'leads',     kind: 'route',  label: 'Leads',     description: 'Pipeline + Kanban board',         href: '/dashboard/leads',            icon: Users,         group: 'Commands' },
  { id: 'inbox',     kind: 'route',  label: 'Inbox',     description: 'Lead conversations + AI drafts',  href: '/dashboard/inbox',            icon: InboxIcon,     group: 'Commands' },
  { id: 'tours',     kind: 'route',  label: 'Tours',     description: 'Schedule + audit venue tours',    href: '/dashboard/tours',            icon: CalendarCheck, group: 'Commands' },
  { id: 'analytics', kind: 'route',  label: 'Analytics', description: '30-day funnel + KPIs',            href: '/dashboard/analytics',        icon: BarChart3,     group: 'Commands' },
  { id: 'settings',  kind: 'route',  label: 'Settings',  description: 'Workspace preferences',           href: '/dashboard/settings',         icon: Settings,      group: 'Commands' },
  { id: 'billing',   kind: 'route',  label: 'Billing',   description: 'Plan, invoices, digest controls', href: '/dashboard/settings/billing', icon: CreditCard,    group: 'Commands' },
  { id: 'new-lead',  kind: 'action', label: 'New lead',           description: 'Open the Add Lead modal on the leads board',     href: '/dashboard/leads?new_lead=1',                       icon: Plus,         group: 'Quick actions', dispatchEvent: 'venuerise:open-new-lead-modal' },
  { id: 'sched',     kind: 'action', label: 'Schedule tour',      description: 'Open the Schedule Tour drawer on the tours page', href: '/dashboard/tours?schedule_tour=1',                  icon: CalendarPlus, group: 'Quick actions', dispatchEvent: 'venuerise:open-schedule-tour' },
  { id: 'digest',    kind: 'action', label: 'Send sample digest', description: 'Jump to digest preferences and confirm a sample', href: '/dashboard/settings/billing?digest_action=sample', icon: Mail,         group: 'Quick actions' },
]

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
}

const DEBOUNCE_MS = 240

function iconForKind(kind: 'lead' | 'conversation' | 'tour' | 'message') {
  if (kind === 'lead') return UserIcon
  if (kind === 'conversation') return MessageSquare
  if (kind === 'message') return MessageSquare
  return CalendarCheck
}

function groupForKind(
  kind: 'lead' | 'conversation' | 'tour' | 'message'
): CommandGroup {
  if (kind === 'lead') return 'Leads'
  if (kind === 'conversation') return 'Conversations'
  if (kind === 'message') return 'Messages'
  return 'Tours'
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Phase 8AL — dynamic search state. We deliberately keep `results`
  // separate from the static command set so the renderer can group
  // them under distinct headings without a discriminator probe.
  const [results, setResults] = useState<ApiSearchItem[]>([])
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  // Track the in-flight request so a stale response from a slow earlier
  // keystroke can't overwrite a fresher one (or land after Esc closed
  // the palette).
  const inflightRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Reset on each open so the operator always lands at the top
  // with a clear input.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      setResults([])
      setSearchState('idle')
      const t = setTimeout(() => inputRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
    // On close, abort any in-flight request so the cleanup is symmetric.
    return () => {
      if (inflightRef.current) {
        inflightRef.current.abort()
        inflightRef.current = null
      }
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
    }
  }, [open])

  // Phase 8AL — substring filter on the static command set. Same
  // semantics as before; we only feed visible static commands into the
  // combined list so the keyboard cursor never lands on a hidden row.
  const staticMatches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return STATIC_COMMANDS
    return STATIC_COMMANDS.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q)
    )
  }, [query])

  // Phase 8AL — debounced backend call. Skipped for q < 2 (the route
  // shortcircuits those too, but skipping client-side saves the
  // network round-trip + rate-limit budget).
  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      // Cancel any pending debounce/inflight; clear results.
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (inflightRef.current) inflightRef.current.abort()
      setResults([])
      setSearchState('idle')
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setSearchState('loading')
    debounceRef.current = setTimeout(async () => {
      if (inflightRef.current) inflightRef.current.abort()
      const controller = new AbortController()
      inflightRef.current = controller
      try {
        const res = await fetch(
          `/api/dashboard/search?q=${encodeURIComponent(trimmed)}`,
          {
            method: 'GET',
            signal: controller.signal,
            credentials: 'same-origin',
          }
        )
        if (!res.ok) {
          setResults([])
          setSearchState('error')
          return
        }
        const body = (await res.json().catch(() => null)) as
          | { items?: ApiSearchItem[] }
          | null
        const items = Array.isArray(body?.items) ? body!.items! : []
        setResults(items)
        setSearchState('ready')
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setResults([])
        setSearchState('error')
      } finally {
        if (inflightRef.current === controller) inflightRef.current = null
      }
    }, DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, open])

  // Phase 8AL → 8AM — flatten static + dynamic into a single
  // keyboard-traversable list. Order is fixed so the cursor index is
  // stable:
  //   1. matching static commands (Commands group)
  //   2. matching static quick actions (Quick actions group)
  //   3. dynamic leads
  //   4. dynamic conversations
  //   5. dynamic tours
  //   6. dynamic messages (Phase 8AM)
  // Within each group we keep insertion order from the data source.
  // We re-sort dynamic items by kind so the API can return them in any
  // order without scrambling the group rendering.
  const KIND_ORDER: ResultKind[] = ['lead', 'conversation', 'tour', 'message']
  const combined: CommandItem[] = useMemo(() => {
    const out: CommandItem[] = [...staticMatches]
    const sorted = [...results].sort(
      (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    )
    for (const r of sorted) {
      out.push({
        id: r.id,
        kind: r.kind,
        label: r.title,
        description: r.subtitle,
        href: r.href,
        icon: iconForKind(r.kind),
        group: groupForKind(r.kind),
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staticMatches, results])

  // Clamp activeIndex when the combined list shrinks.
  useEffect(() => {
    if (activeIndex >= combined.length) {
      setActiveIndex(combined.length > 0 ? combined.length - 1 : 0)
    }
  }, [combined.length, activeIndex])

  // Reset the cursor to 0 whenever the query changes so the first
  // visible row is highlighted by default (matches typical palette UX).
  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  const runCommand = useCallback(
    (cmd: CommandItem) => {
      router.push(cmd.href)
      onClose()
      // 8AK — same-page consumers react to this event immediately;
      // cross-page consumers fall back to URL params.
      if (cmd.dispatchEvent && typeof window !== 'undefined') {
        try {
          window.dispatchEvent(new CustomEvent(cmd.dispatchEvent))
        } catch {
          // CustomEvent constructor is universally supported.
        }
      }
    },
    [router, onClose]
  )

  const onInputKey = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (combined.length === 0 ? 0 : (i + 1) % combined.length))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) =>
          combined.length === 0 ? 0 : (i - 1 + combined.length) % combined.length
        )
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const cmd = combined[activeIndex]
        if (cmd) runCommand(cmd)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [combined, activeIndex, runCommand, onClose]
  )

  if (!open) return null

  // Render-time group breaks so we can interleave section headers
  // without an extra pre-grouping pass.
  let lastGroup: CommandGroup | null = null
  const trimmed = query.trim()
  const showSearchHint = trimmed.length >= 2

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh]">
      {/* Backdrop */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close command palette"
        className="fixed inset-0 bg-slate-950/30 backdrop-blur-[3px] cursor-default"
      />

      {/* Card */}
      <div
        role="dialog"
        aria-label="Command palette"
        className="relative z-[61] w-full max-w-[560px] mx-4 bg-white border border-[#E6E8EF] rounded-2xl shadow-[0_30px_80px_rgba(15,23,42,0.25)] overflow-hidden animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Search input */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[#EEF2F7]">
          <Search className="w-4 h-4 text-[#64748B] shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Type a command or search leads, conversations, tours, messages…"
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[14px] text-[#0F172A] placeholder:text-[#94A3B8]"
          />
          {searchState === 'loading' && (
            <Loader2 className="w-3.5 h-3.5 text-[#64748B] animate-spin shrink-0" />
          )}
          <span className="hidden sm:inline font-mono text-[10.5px] px-1.5 py-px border border-[#E6E8EF] rounded-md bg-[#F8FAFC] text-[#475569]">
            Esc
          </span>
        </div>

        {/* Combined list */}
        <div className="max-h-[440px] overflow-y-auto p-1.5">
          {combined.length === 0 ? (
            <div className="text-[12.5px] text-[#94A3B8] py-8 text-center">
              {showSearchHint && searchState === 'loading'
                ? 'Searching workspace…'
                : showSearchHint && searchState === 'ready'
                  ? 'No matching leads, conversations, tours, or messages.'
                  : `No commands match "${trimmed}".`}
            </div>
          ) : (
            <>
              {combined.map((cmd, i) => {
                const Icon = cmd.icon
                const active = i === activeIndex
                const showGroupHeader = cmd.group !== lastGroup
                lastGroup = cmd.group
                return (
                  <div key={cmd.id}>
                    {showGroupHeader && (
                      <div className="px-2.5 pt-2 pb-1 text-[10px] uppercase tracking-[0.16em] text-[#94A3B8] font-semibold">
                        {cmd.group}
                      </div>
                    )}
                    <button
                      type="button"
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => runCommand(cmd)}
                      className={cn(
                        'w-full text-left flex items-center gap-3 px-2.5 py-2 rounded-xl transition-colors',
                        active
                          ? 'bg-[#F1F5F9] text-[#0F172A]'
                          : 'hover:bg-[#F8FAFC] text-[#0F172A]'
                      )}
                    >
                      <div
                        className={cn(
                          'w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0',
                          active ? 'bg-white border border-[#E6E8EF]' : 'bg-[#F8FAFC]'
                        )}
                      >
                        <Icon className="w-4 h-4 text-[#475569]" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium text-[#0F172A] truncate">
                          {cmd.label}
                        </div>
                        <div className="text-[11.5px] text-[#64748B] truncate">
                          {cmd.description}
                        </div>
                      </div>
                      {active && (
                        <ArrowRight className="w-3.5 h-3.5 text-[#475569] shrink-0" />
                      )}
                      {cmd.hint && (
                        <span className="hidden sm:inline font-mono text-[10.5px] px-1.5 py-px border border-[#E6E8EF] rounded-md bg-white text-[#475569] shrink-0">
                          {cmd.hint}
                        </span>
                      )}
                    </button>
                  </div>
                )
              })}
              {/* Inline progress hint when dynamic results are still
                  loading but static matches are already shown — the
                  operator gets a clear "more is coming" signal. */}
              {showSearchHint && searchState === 'loading' && results.length === 0 && (
                <div className="px-2.5 py-2 text-[11.5px] text-[#94A3B8] flex items-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Searching workspace…
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-t border-[#EEF2F7] text-[11px] text-[#94A3B8] bg-[#F8FAFC]">
          <div className="flex items-center gap-2">
            <span className="font-mono px-1.5 py-px rounded border border-[#E6E8EF] bg-white text-[#475569]">↑</span>
            <span className="font-mono px-1.5 py-px rounded border border-[#E6E8EF] bg-white text-[#475569]">↓</span>
            <span>navigate</span>
            <span className="text-[#CBD5E1]">·</span>
            <span className="font-mono px-1.5 py-px rounded border border-[#E6E8EF] bg-white text-[#475569]">↵</span>
            <span>open</span>
          </div>
          <span>
            <span className="font-mono px-1.5 py-px rounded border border-[#E6E8EF] bg-white text-[#475569]">⌘K</span>{' '}
            anywhere
          </span>
        </div>
      </div>
    </div>
  )
}
