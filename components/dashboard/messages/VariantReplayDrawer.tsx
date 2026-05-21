'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  X,
  Sparkles,
  Copy,
  Check,
  Loader2,
  AlertTriangle,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { format } from 'date-fns'

/**
 * Phase 8AN — VariantReplayDrawer.
 *
 * Surfaced from an audit affordance on `human`-role message bubbles
 * whose `messages.metadata` includes `ai_action_id` +
 * `selected_variant_index` + `variant_count` (i.e. the bubble came
 * from a Phase 8AL+ "Approve & send" with multi-variant context).
 *
 * Renders a right-side drawer with:
 *   - "Sent option X of Y" header line
 *   - the exact sent message body (verbatim from the bubble)
 *   - the other offered variants pulled from
 *     `ai_actions.metadata.variants_offered` (a Phase 8AM-only field)
 *   - the regenerate instruction used (if any)
 *   - ai_action audit metadata: agent, success, latency_ms, created_at
 *   - a "Copy audit summary" button
 *
 * Data source:
 *   The drawer fetches the matching `ai_actions` row client-side via
 *   the browser Supabase client. RLS (Phase 6B `ai_actions: select
 *   for members`) gates cross-tenant access naturally — we don't need
 *   a new admin route. The drawer requests only the action whose id
 *   we already know.
 *
 * Read-only — no mutation, no PII leakage beyond what's already
 * visible in the conversation thread.
 */

interface SentMessageContext {
  /** The message id whose bubble was clicked. */
  messageId: string
  /** The exact body that was sent. */
  content: string
  /** ISO timestamp of when the message was sent. */
  createdAt: string
  /** AI action id pulled from messages.metadata. */
  aiActionId: string
  /** 0-indexed selected variant from messages.metadata. */
  selectedVariantIndex: number
  /** Count of variants offered at the time of approval. */
  variantCount: number
}

interface AiActionRow {
  id: string
  agent: string
  action: string
  success: boolean
  latency_ms: number | null
  created_at: string
  // Phase 8AM-only field; older rows return `{}` from the default.
  metadata: {
    variant_count?: number
    variants_offered?: string[]
    selected_by_default?: number
    instruction?: string | null
  } | null
}

type FetchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; action: AiActionRow }
  | { kind: 'error'; message: string }

interface Props {
  open: boolean
  context: SentMessageContext | null
  onClose: () => void
}

export default function VariantReplayDrawer({ open, context, onClose }: Props) {
  const [state, setState] = useState<FetchState>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)

  // Close on Escape — matches the LeadDetailDrawer/Schedule drawer
  // primitives across the app.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Fetch the ai_actions row on open / context change.
  useEffect(() => {
    if (!open || !context) return
    let cancelled = false
    setState({ kind: 'loading' })
    setCopied(false)
    const supabase = createClient()
    ;(async () => {
      try {
        const { data, error } = await supabase
          .from('ai_actions')
          .select('id, agent, action, success, latency_ms, created_at, metadata')
          .eq('id', context.aiActionId)
          .maybeSingle()
        if (cancelled) return
        if (error || !data) {
          setState({
            kind: 'error',
            message:
              error?.message ?? 'No matching AI action found for this message.',
          })
          return
        }
        setState({ kind: 'ready', action: data as AiActionRow })
      } catch (err) {
        if (cancelled) return
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Network error',
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, context])

  const summary = useMemo(() => {
    if (state.kind !== 'ready' || !context) return ''
    const action = state.action
    const meta = action.metadata ?? {}
    const variants = Array.isArray(meta.variants_offered)
      ? meta.variants_offered
      : []
    const lines: string[] = []
    lines.push('AI Draft Selection Audit')
    lines.push(`Sent: option ${context.selectedVariantIndex + 1} of ${context.variantCount}`)
    lines.push(`Sent at: ${context.createdAt}`)
    lines.push(`AI action: ${action.id}`)
    lines.push(`Agent: ${action.agent} · Success: ${action.success}`)
    if (action.latency_ms != null) lines.push(`Latency: ${action.latency_ms}ms`)
    if (meta.instruction) lines.push(`Instruction: ${meta.instruction}`)
    lines.push('')
    lines.push('Sent body:')
    lines.push(context.content)
    if (variants.length > 0) {
      lines.push('')
      lines.push(`Variants offered (${variants.length}):`)
      variants.forEach((v, i) => {
        lines.push(`[${i + 1}] ${v}`)
      })
    }
    return lines.join('\n')
  }, [state, context])

  const handleCopy = useCallback(async () => {
    if (!summary) return
    try {
      await navigator.clipboard.writeText(summary)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // clipboard.writeText can throw in non-secure contexts; the
      // audit summary stays visible in the drawer so the operator can
      // hand-copy if needed.
    }
  }, [summary])

  if (!open || !context) return null

  return (
    <div className="fixed inset-0 z-[70] flex" role="dialog" aria-label="AI draft selection audit">
      {/* Backdrop */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close audit"
        className="fixed inset-0 z-[70] bg-slate-950/25 backdrop-blur-[3px] cursor-default"
      />

      <aside className="relative ml-auto z-[71] h-dvh w-full max-w-[520px] min-w-[320px] bg-white border-l border-[#E2E8F0] shadow-[0_-10px_60px_rgba(15,23,42,0.18)] flex flex-col animate-in slide-in-from-right duration-300">
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-[#F1F5F9]">
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-[10px] bg-[#0F172A] text-white flex items-center justify-center shrink-0">
              <Sparkles className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-[14px] font-semibold text-[#0F172A] leading-tight">
                AI draft selection
              </h2>
              <p className="text-[11.5px] text-[#64748B] mt-0.5">
                Sent option {context.selectedVariantIndex + 1} of{' '}
                {context.variantCount}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-full flex items-center justify-center text-[#475569] hover:text-[#0F172A] hover:bg-[#F1F5F9] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {state.kind === 'loading' && (
            <div className="flex items-center gap-2 text-[12.5px] text-[#475569] py-3">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Loading audit details…
            </div>
          )}

          {state.kind === 'error' && (
            <div className="rounded-xl bg-[#FEF2F2] border border-[#FECACA] px-3 py-2.5 text-[12px] text-[#B91C1C] flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{state.message}</span>
            </div>
          )}

          {/* Sent body block — always visible, even if the ai_actions
              fetch failed. The operator can confirm what actually
              went out even without the variant context. */}
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.16em] text-[#94A3B8] font-semibold mb-1.5">
              Sent body
            </div>
            <div className="rounded-2xl border border-[#E2E8F0] bg-white p-3.5 shadow-card">
              <p className="text-[13px] text-[#0F172A] leading-relaxed whitespace-pre-wrap">
                {context.content}
              </p>
            </div>
            <p className="mt-1.5 text-[11px] text-[#94A3B8]">
              Sent {format(new Date(context.createdAt), 'MMM d, h:mm a')}
            </p>
          </div>

          {state.kind === 'ready' && (
            <>
              {/* Instruction (if present) */}
              {state.action.metadata?.instruction ? (
                <div>
                  <div className="text-[10.5px] uppercase tracking-[0.16em] text-[#94A3B8] font-semibold mb-1.5">
                    Adjustment instruction
                  </div>
                  <div className="inline-flex items-center text-[11.5px] px-2.5 py-1 rounded-full bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE]">
                    {state.action.metadata.instruction}
                  </div>
                </div>
              ) : null}

              {/* Other variants */}
              <div>
                <div className="text-[10.5px] uppercase tracking-[0.16em] text-[#94A3B8] font-semibold mb-1.5">
                  Other variants offered
                </div>
                {Array.isArray(state.action.metadata?.variants_offered) &&
                state.action.metadata!.variants_offered!.length > 0 ? (
                  <div className="space-y-2.5">
                    {state.action.metadata!.variants_offered!.map((v, i) => {
                      const isChosen = i === context.selectedVariantIndex
                      return (
                        <div
                          key={i}
                          className={cn(
                            'rounded-2xl border p-3.5',
                            isChosen
                              ? 'border-[#0F172A] bg-[#F8FAFC]'
                              : 'border-[#E2E8F0] bg-white'
                          )}
                        >
                          <div className="flex items-center justify-between gap-2 mb-1.5">
                            <span
                              className={cn(
                                'text-[10.5px] uppercase tracking-[0.14em] font-semibold',
                                isChosen ? 'text-[#0F172A]' : 'text-[#94A3B8]'
                              )}
                            >
                              Option {i + 1}
                              {isChosen ? ' · sent' : ''}
                            </span>
                          </div>
                          <p className="text-[13px] text-[#0F172A] leading-relaxed whitespace-pre-wrap">
                            {v}
                          </p>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-[12px] text-[#64748B]">
                    No variant history stored for this AI action. (Older
                    drafts predate the variant audit memory feature.)
                  </p>
                )}
              </div>

              {/* AI action metadata */}
              <div>
                <div className="text-[10.5px] uppercase tracking-[0.16em] text-[#94A3B8] font-semibold mb-1.5">
                  AI action
                </div>
                <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3 text-[11.5px] font-mono text-[#475569] space-y-0.5">
                  <div>id · {state.action.id}</div>
                  <div>agent · {state.action.agent}</div>
                  <div>
                    success · {state.action.success ? 'true' : 'false'}
                  </div>
                  {state.action.latency_ms != null && (
                    <div>latency · {state.action.latency_ms}ms</div>
                  )}
                  <div>
                    created ·{' '}
                    {format(
                      new Date(state.action.created_at),
                      'MMM d, yyyy h:mm:ss a'
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[#F1F5F9] bg-white flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            disabled={state.kind !== 'ready'}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-[#E2E8F0] text-[12.5px] text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] disabled:opacity-50"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-[#059669]" />
                Copied
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                Copy audit summary
              </>
            )}
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center px-3 py-1.5 rounded-[10px] bg-[#0F172A] text-white text-[12.5px] hover:bg-[#1E293B]"
          >
            Close
          </button>
        </div>
      </aside>
    </div>
  )
}
