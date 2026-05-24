import {
  deliveryModeLabel,
  deliveryModeTone,
  type ReplyMethod,
} from '@/lib/integrations/channels/reply-method'
import ChannelSourceBadge from './ChannelSourceBadge'

/**
 * Phase 8BM — Reply Method Bar.
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
 */

interface Props {
  reply: ReplyMethod
}

export default function ReplyMethodBar({ reply }: Props) {
  const tone = deliveryModeTone(reply.deliveryMode)
  const modeLabel = deliveryModeLabel(reply.deliveryMode)
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

      {/* Method + destination. Destination renders only when
          present (email address, phone number); channel-native
          methods show just the label. */}
      <span className="inline-flex items-baseline gap-1.5 min-w-0">
        <span className="text-[11px] text-[#94A3B8]">Replying via</span>
        <span className="text-[12px] font-semibold text-[#0F172A] truncate">
          {reply.methodLabel}
        </span>
        {reply.destinationLabel && (
          <>
            <span className="text-[#CBD5E1]">·</span>
            <span className="text-[11.5px] text-[#475569] truncate font-medium tabular-nums">
              {reply.destinationLabel}
            </span>
          </>
        )}
      </span>

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
