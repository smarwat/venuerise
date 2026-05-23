'use client'

import { useState } from 'react'

/**
 * Phase 8BL — Confirm-button island for the public slot-confirmation
 * page. Server validated the token to render this surface; the
 * button posts to /api/tour/confirm-slot/<token> to actually create
 * the tour. Three deliberate properties:
 *
 *   1. The tour is created on CLICK, not on PAGE LOAD. Link previewers
 *      and crawlers GET this page and never execute the POST. That
 *      keeps a Slack unfurl or Gmail link-checker from accidentally
 *      booking a tour.
 *   2. Network failures keep the button click-able so the lead can
 *      retry. Success replaces the surface with a thank-you panel —
 *      we never redirect the browser (a redirect with no-store
 *      doubles the round-trip and breaks the "I'm done now" UX).
 *   3. The token is the only payload. Everything else the route
 *      needs is in the DB row keyed by the token hash.
 */
export function ConfirmSlotClient({ token }: { token: string }) {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'submitting' }
    | { kind: 'success' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  async function handleConfirm() {
    if (state.kind === 'submitting') return
    setState({ kind: 'submitting' })
    try {
      const res = await fetch(
        `/api/tour/confirm-slot/${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // No body — the token in the URL is the entire request.
          body: '{}',
        }
      )
      if (!res.ok) {
        // The route returns structured JSON for the failure cases
        // the page can rerender as. We deliberately surface the
        // server's text (it's already lead-friendly copy) instead
        // of inventing client-side text that could drift.
        const json = (await res.json().catch(() => null)) as
          | { error?: string; message?: string }
          | null
        const message =
          json?.message ??
          (res.status === 409
            ? 'This time slot is no longer available. Please pick another from the original message.'
            : "We couldn't confirm just now. Please try again in a moment, or reply to the original message.")
        setState({ kind: 'error', message })
        return
      }
      setState({ kind: 'success' })
    } catch {
      setState({
        kind: 'error',
        message:
          "We couldn't reach the server. Please check your connection and try again.",
      })
    }
  }

  if (state.kind === 'success') {
    return (
      <div className="actions">
        <p className="lead-time" style={{ color: '#047857' }}>
          You&rsquo;re all set — we&rsquo;ll be in touch soon with directions.
        </p>
      </div>
    )
  }

  return (
    <div className="actions">
      <button
        type="button"
        onClick={handleConfirm}
        disabled={state.kind === 'submitting'}
        style={{
          padding: '12px 22px',
          background: '#0F172A',
          color: '#FFFFFF',
          border: 'none',
          borderRadius: '12px',
          fontSize: '15px',
          fontWeight: 600,
          cursor: state.kind === 'submitting' ? 'not-allowed' : 'pointer',
          opacity: state.kind === 'submitting' ? 0.7 : 1,
        }}
      >
        {state.kind === 'submitting' ? 'Confirming…' : 'Confirm this time'}
      </button>
      {state.kind === 'error' ? (
        <p style={{ marginTop: 14, color: '#B91C1C', fontSize: 14 }}>
          {state.message}
        </p>
      ) : null}
    </div>
  )
}
