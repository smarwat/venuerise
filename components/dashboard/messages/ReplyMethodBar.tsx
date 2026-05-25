'use client'

import { Fragment, useMemo } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown } from 'lucide-react'
import {
  deliveryModeLabel,
  deliveryModeTone,
  type ReplyDeliveryMode,
  type ReplyMethod,
  type ReplyMethodKey,
  type ReplyMethodOption,
} from '@/lib/integrations/channels/reply-method'
import ChannelSourceBadge from './ChannelSourceBadge'

/**
 * Phase 8BM — Reply Method Bar.
 * Phase 8BV — Operator can now SWITCH between available reply methods
 *             when the resolver returned more than one (e.g. a lead
 *             with both email and phone). The selection is composer-
 *             session scoped — it never persists to the DB; the route
 *             always re-verifies that the chosen channel is actually
 *             wired server-side before any external send.
 *
 * Compact, honest pill row that sits directly above the
 * MessageComposer textarea. Tells the operator at a glance:
 *
 *   1. Where the inquiry came from (source channel badge)
 *   2. Where the reply will go (method + destination)
 *   3. Whether VenueRise can deliver it directly
 *      (`Direct` / `Manual` / `Internal` / `Unavailable` pill)
 *   4. A one-line helper / warning when needed
 *
 * Design intent:
 *   - Single horizontal row at md+ widths; wraps cleanly on
 *     narrow viewports.
 *   - Never adds vertical bulk to the composer — buyer demos
 *     on small laptops still see the textarea + send button
 *     above the fold.
 *   - Tone tracks the delivery mode (emerald = direct,
 *     champagne = manual, slate = internal, red = unavailable).
 *     Used sparingly per the dashboard polish guide.
 *
 * Backwards-compatible: when neither `switchOptions` nor
 * `onSelectReplyMethod` is supplied, the bar renders the static
 * 8BM display exactly as before.
 */

interface Props {
  reply: ReplyMethod
  /**
   * Phase 8BV — When the composer owns reply-method state and the
   * resolver returned multiple options, pass them in along with a
   * change handler. The bar swaps the static method label for a
   * Radix DropdownMenu trigger and renders one item per option.
   *
   * When `switchOptions` is omitted or has length ≤ 1, the bar
   * falls back to the static label (no dropdown rendered).
   */
  switchOptions?: ReplyMethodOption[]
  onSelectReplyMethod?: (option: ReplyMethodOption) => void
}

function modeHelper(mode: ReplyDeliveryMode, label: string): string {
  switch (mode) {
    case 'direct':
      return `Sends via ${label.toLowerCase()} when you click send.`
    case 'manual':
      return `Reply in ${label}, then mark sent manually.`
    case 'internal_only':
      return `Saved in VenueRise only. ${label} sending is not connected.`
    case 'unavailable':
      return `No working delivery path. Reply will be saved in VenueRise only.`
  }
}

export default function ReplyMethodBar({
  reply,
  switchOptions,
  onSelectReplyMethod,
}: Props) {
  const tone = deliveryModeTone(reply.deliveryMode)
  const modeLabel = deliveryModeLabel(reply.deliveryMode)

  // Only render the dropdown affordance when (a) the parent passed
  // a handler and (b) there's actually more than one option. The
  // resolver's `canSwitch` flag would suffice, but we also defend
  // against an upstream caller forgetting to wire `onSelect`.
  const interactive =
    typeof onSelectReplyMethod === 'function' &&
    Array.isArray(switchOptions) &&
    switchOptions.length > 1

  // Sort options for stable display: active first, then by method
  // priority (email → sms → channel-native → internal). Keeps the
  // dropdown order predictable across leads.
  const orderedOptions = useMemo(() => {
    if (!switchOptions) return []
    const priority: Record<ReplyMethodKey, number> = {
      email: 1,
      sms: 2,
      instagram: 3,
      facebook: 4,
      the_knot: 5,
      weddingwire: 6,
      meta_lead_ads: 7,
      website: 8,
      internal: 9,
    }
    return [...switchOptions].sort((a, b) => {
      const aActive = a.method === reply.method ? 0 : 1
      const bActive = b.method === reply.method ? 0 : 1
      if (aActive !== bActive) return aActive - bActive
      return (priority[a.method] ?? 99) - (priority[b.method] ?? 99)
    })
  }, [switchOptions, reply.method])

  return (
    <div className="rounded-xl border border-[#E6E8EF] bg-[#F8FAFC] px-3 py-2 flex items-center gap-2.5 flex-wrap">
      {/* Eyebrow — keeps the row from looking like a banner. */}
      <span className="text-[9.5px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold shrink-0">
        Reply method
      </span>

      {/* Source channel badge — same component used in the
          ConversationThread bubble metadata, so the operator
          recognizes the channel marker. */}
      {reply.sourceChannel && (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-[#475569]">
          <span className="text-[#94A3B8]">Source</span>
          <ChannelSourceBadge channelType={reply.sourceChannel} />
        </span>
      )}

      <span className="text-[#CBD5E1]">·</span>

      {/* Method + destination. Phase 8BV — when multiple options are
          available, this region becomes a Radix DropdownMenu trigger.
          Otherwise it renders the same static label as before. */}
      {interactive ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="group inline-flex items-baseline gap-1.5 min-w-0 rounded-md px-1.5 py-0.5 -mx-1.5 -my-0.5 hover:bg-white border border-transparent hover:border-[#E2E8F0] focus:outline-none focus:border-[#1D4ED8] focus:ring-[2px] focus:ring-[#3B82F6]/15 transition-colors"
              aria-label="Change reply method"
            >
              <span className="text-[11px] text-[#94A3B8]">Replying via</span>
              <span className="text-[12px] font-semibold text-[#0F172A] truncate">
                {reply.methodLabel}
              </span>
              {reply.destinationLabel && (
                <Fragment>
                  <span className="text-[#CBD5E1]">·</span>
                  <span className="text-[11.5px] text-[#475569] truncate font-medium tabular-nums">
                    {reply.destinationLabel}
                  </span>
                </Fragment>
              )}
              <ChevronDown className="w-3 h-3 text-[#94A3B8] group-hover:text-[#475569] shrink-0 self-center ml-0.5" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              sideOffset={6}
              className="z-50 min-w-[260px] max-w-[340px] rounded-xl bg-white border border-[#E2E8F0] shadow-[0_20px_50px_rgba(15,23,42,0.18)] p-1.5 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
            >
              <div className="px-2 py-1.5 text-[9.5px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold">
                Send this reply via
              </div>
              {orderedOptions.map((opt) => {
                const isActive = opt.method === reply.method
                const optTone = deliveryModeTone(opt.deliveryMode)
                const optModeLabel = deliveryModeLabel(opt.deliveryMode)
                const helper = opt.helperText || modeHelper(opt.deliveryMode, opt.methodLabel)
                return (
                  <DropdownMenu.Item
                    key={opt.method}
                    onSelect={() => onSelectReplyMethod?.(opt)}
                    className="group flex items-start gap-2 px-2 py-2 rounded-lg outline-none cursor-pointer text-left data-[highlighted]:bg-[#F1F5F9]"
                  >
                    {/* Active marker — Check on selected row, transparent placeholder otherwise so labels stay aligned. */}
                    <span className="w-3.5 h-3.5 flex items-center justify-center mt-0.5 shrink-0">
                      {isActive ? (
                        <Check className="w-3.5 h-3.5 text-[#1D4ED8]" />
                      ) : (
                        <span className="w-3.5 h-3.5" />
                      )}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[12.5px] font-semibold text-[#0F172A]">
                          {opt.methodLabel}
                        </span>
                        {opt.destinationLabel && (
                          <Fragment>
                            <span className="text-[#CBD5E1]">·</span>
                            <span className="text-[11.5px] text-[#475569] font-medium tabular-nums truncate">
                              {opt.destinationLabel}
                            </span>
                          </Fragment>
                        )}
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded-md border text-[9.5px] font-semibold uppercase tracking-[0.1em] ${optTone.bg} ${optTone.text} ${optTone.ring}`}
                        >
                          {optModeLabel}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-[#64748B] leading-snug">
                        {helper}
                      </p>
                    </div>
                  </DropdownMenu.Item>
                )
              })}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : (
        <span className="inline-flex items-baseline gap-1.5 min-w-0">
          <span className="text-[11px] text-[#94A3B8]">Replying via</span>
          <span className="text-[12px] font-semibold text-[#0F172A] truncate">
            {reply.methodLabel}
          </span>
          {reply.destinationLabel && (
            <Fragment>
              <span className="text-[#CBD5E1]">·</span>
              <span className="text-[11.5px] text-[#475569] truncate font-medium tabular-nums">
                {reply.destinationLabel}
              </span>
            </Fragment>
          )}
        </span>
      )}

      {/* Delivery mode pill — single source of truth on whether
          VenueRise will actually deliver this. Tone shifts per
          mode. */}
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-[0.1em] ${tone.bg} ${tone.text} ${tone.ring}`}
        title={reply.warning ?? reply.helperText}
      >
        {modeLabel}
      </span>

      {/* Helper / warning line. Renders on the next line on
          narrow widths via flex-wrap so it never truncates. */}
      <span className="basis-full text-[10.5px] text-[#64748B] leading-snug">
        {reply.warning ?? reply.helperText}
      </span>
    </div>
  )
}
