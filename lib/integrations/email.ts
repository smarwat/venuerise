import 'server-only'
import { Resend } from 'resend'
import { createServiceClient } from '@/lib/supabase/service'
import { isSuppressed } from './suppression'
import { signInternalRequest } from '@/lib/auth/internal-hmac'

/**
 * Email delivery integration — Resend, with a console fallback for local dev.
 *
 * ── HONESTY CONTRACT ───────────────────────────────────────────────────────
 * The caller (a job function) needs to know whether a real outbound message
 * left the building. We never lie:
 *
 *   - `delivered: true`  → Resend ACCEPTED the message AND returned an id.
 *                          Note: "accepted" is NOT the same as "delivered to
 *                          recipient inbox". The Resend webhook updates the
 *                          underlying `outbound_messages.status` (see below).
 *   - `delivered: false` → console fallback (dev), missing config, suppressed
 *                          recipient, OR a provider error. The caller must
 *                          NOT mark the underlying business row as "sent" in
 *                          this case.
 *   - `provider`         → which path actually ran. Always present.
 *
 * ── OUTBOUND_MESSAGES STATUS LIFECYCLE (Phase 4B) ──────────────────────────
 *   suppressed → never sent (address on email_suppressions).
 *   queued     → submitted to Resend, awaiting webhook confirmation.
 *                Has provider_message_id. NOT YET in the recipient's inbox.
 *   delivered  → Resend webhook 'email.delivered' fired. delivered_at set.
 *   bounced    → Resend webhook 'email.bounced' fired. Hard bounces also
 *                add an entry to email_suppressions.
 *   complained → Resend webhook 'email.complained' fired. Also suppressed.
 *   failed     → Resend rejected the send synchronously, OR console-fallback
 *                in dev (nothing was sent).
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Marked `server-only` to keep Resend (and its API key) out of any client
 * bundle.
 */

const isDev = process.env.NODE_ENV === 'development'

export type EmailProvider = 'resend' | 'console'

export interface SendEmailParams {
  to: string
  subject: string
  /** Plain-text version. Recommended for deliverability + accessibility. */
  text?: string
  /** HTML version. If omitted, `text` is auto-wrapped. */
  html?: string
  /** Override the default Reply-To (defaults to RESEND_REPLY_TO_EMAIL). */
  replyTo?: string
  /** Free-form metadata attached to Resend (tags) for observability. */
  metadata?: Record<string, string>

  // ---- New in Phase 4B — required for outbound_messages logging ----
  venueId: string
  leadId?: string | null
  /** e.g. 'follow_up_schedules' or 'tours' — for joining the audit log back. */
  relatedTable?: string | null
  relatedId?: string | null
}

export interface SendEmailResult {
  delivered: boolean
  provider: EmailProvider
  messageId?: string
  outboundMessageId?: string
  /** Includes `suppressed:<reason>` on suppression, or the raw provider error. */
  error?: string
}

let cachedResend: Resend | null = null
function getResend(): Resend | null {
  if (cachedResend) return cachedResend
  const key = process.env.RESEND_API_KEY
  if (!key) return null
  cachedResend = new Resend(key)
  return cachedResend
}

/** True iff Resend is fully configured. Used by /api/health + callers. */
export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM_EMAIL
}

/** Escape user-supplied text for safe HTML interpolation. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function htmlFromText(text: string): string {
  const escaped = escapeHtml(text)
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p style="margin:0 0 16px 0;line-height:1.55;color:#1F2937;">${p.replace(
          /\n/g,
          '<br />'
        )}</p>`
    )
    .join('')
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;font-size:15px;color:#1F2937;">${paragraphs}</div>`
}

/**
 * Build a one-click unsubscribe URL.
 *
 * Token format (compatible with `/api/unsubscribe`):
 *   payload = { email, ts }                   (canonical JSON, sorted keys)
 *   sig     = HMAC-SHA256(payload, INTERNAL_API_SECRET) → hex
 *   URL     = `${APP_URL}/api/unsubscribe?email=<urlenc>&ts=<ms>&sig=<hex>`
 *
 * Verified server-side in app/api/unsubscribe/route.ts. Tokens expire after
 * 90 days (checked there, not here).
 */
function buildUnsubscribeUrl(email: string): string | null {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  try {
    const ts = Date.now()
    const sig = signInternalRequest({ email, ts })
    const u = new URL('/api/unsubscribe', appUrl)
    u.searchParams.set('email', email)
    u.searchParams.set('ts', String(ts))
    u.searchParams.set('sig', sig)
    return u.toString()
  } catch (err) {
    // Missing INTERNAL_API_SECRET — surface but don't block the send.
    if (isDev) console.warn('[email] could not sign unsubscribe link:', err)
    return null
  }
}

/**
 * Append an unsubscribe footer to the HTML body. Plain text gets the URL on
 * its own line. Always returns BOTH variants so the email can be multipart.
 */
function decorateWithUnsubscribe(
  htmlBody: string,
  textBody: string,
  unsubUrl: string | null
): { html: string; text: string } {
  if (!unsubUrl) return { html: htmlBody, text: textBody }

  const htmlFooter =
    `<p style="margin-top:32px;padding-top:16px;border-top:1px solid #E5E7EB;font-size:11px;line-height:1.5;color:#9CA3AF;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;">` +
    `You're receiving this because you contacted us about your event. ` +
    `If you'd prefer not to hear from us, ` +
    `<a href="${escapeHtml(unsubUrl)}" style="color:#6B7280;text-decoration:underline;">unsubscribe here</a>.` +
    `</p>`

  // Wrap the existing html (which may or may not already be in a div) and
  // append the footer at the end.
  const html = `<div>${htmlBody}${htmlFooter}</div>`

  const textFooter = `\n\n— — —\nTo stop receiving emails, visit:\n${unsubUrl}`
  const text = textBody + textFooter

  return { html, text }
}

// ============================================================================
// outbound_messages logging
// ============================================================================

interface OutboundRowInput {
  venueId: string
  leadId?: string | null
  to: string
  subject: string
  body: string
  provider: EmailProvider | null
  status: 'queued' | 'failed' | 'suppressed'
  error?: string | null
  relatedTable?: string | null
  relatedId?: string | null
  metadata?: Record<string, unknown>
}

async function createOutboundRow(input: OutboundRowInput): Promise<string | null> {
  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('outbound_messages')
      .insert({
        venue_id: input.venueId,
        lead_id: input.leadId ?? null,
        channel: 'email',
        to_address: input.to,
        subject: input.subject,
        body: input.body,
        provider: input.provider,
        status: input.status,
        error: input.error ?? null,
        related_table: input.relatedTable ?? null,
        related_id: input.relatedId ?? null,
        metadata: input.metadata ?? {},
      })
      .select('id')
      .single()

    if (error) {
      console.error('[email:outbound] insert failed', { error: error.message })
      return null
    }
    return (data as { id: string }).id
  } catch (err) {
    console.error('[email:outbound] insert threw', err)
    return null
  }
}

async function markOutboundAccepted(
  id: string,
  providerMessageId: string
): Promise<void> {
  try {
    const supabase = createServiceClient()
    // Keep status='queued' — "queued at provider, awaiting webhook to confirm
    // real delivery". Webhook flips to 'delivered' / 'bounced' / 'complained'.
    await supabase
      .from('outbound_messages')
      .update({ provider_message_id: providerMessageId })
      .eq('id', id)
  } catch (err) {
    console.error('[email:outbound] markAccepted threw', err)
  }
}

async function markOutboundFailed(id: string, error: string): Promise<void> {
  try {
    const supabase = createServiceClient()
    await supabase
      .from('outbound_messages')
      .update({ status: 'failed', error: error.slice(0, 500) })
      .eq('id', id)
  } catch (err) {
    console.error('[email:outbound] markFailed threw', err)
  }
}

// ============================================================================
// sendEmail
// ============================================================================

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const { to, subject, text, html, replyTo, metadata, venueId, leadId, relatedTable, relatedId } = params

  // 0. Basic input validation.
  if (!to || !subject || (!text && !html)) {
    return {
      delivered: false,
      provider: 'console',
      error: 'Missing required email fields (to/subject/text-or-html).',
    }
  }
  if (!venueId) {
    return {
      delivered: false,
      provider: 'console',
      error: 'Missing venueId — required for outbound_messages logging.',
    }
  }

  // 1. Suppression check (fails CLOSED on lookup error — see suppression.ts).
  const supp = await isSuppressed(to)
  if (supp.suppressed) {
    const errMsg = `suppressed:${supp.reason ?? 'unknown'}`
    if (isDev) console.warn('[email] suppressed — NOT sending', { to, reason: supp.reason })

    const outboundId = await createOutboundRow({
      venueId,
      leadId,
      to,
      subject,
      body: text ?? html ?? '',
      provider: emailConfigured() ? 'resend' : 'console',
      status: 'suppressed',
      error: errMsg,
      relatedTable,
      relatedId,
      metadata: { ...(metadata ?? {}), suppressed_reason: supp.reason },
    })

    return {
      delivered: false,
      provider: emailConfigured() ? 'resend' : 'console',
      error: errMsg,
      outboundMessageId: outboundId ?? undefined,
    }
  }

  // 2. Build HTML + decorate with unsubscribe footer.
  const baseHtml = html ?? (text ? htmlFromText(text) : '<p></p>')
  const baseText = text ?? '' // The footer is added in plaintext too.
  const unsubUrl = buildUnsubscribeUrl(to)
  const { html: finalHtml, text: finalText } = decorateWithUnsubscribe(baseHtml, baseText, unsubUrl)

  // ---- 3a. Console fallback (no Resend configured) ----
  if (!emailConfigured()) {
    if (isDev) {
      console.warn(
        '[email:console] RESEND not configured — email NOT delivered. ' +
          'Set RESEND_API_KEY + RESEND_FROM_EMAIL to enable real delivery.',
        { to, subject, preview: (text ?? html ?? '').slice(0, 120) }
      )
    } else {
      console.error('[email:console] RESEND not configured in production environment.')
    }

    const outboundId = await createOutboundRow({
      venueId,
      leadId,
      to,
      subject,
      body: text ?? html ?? '',
      provider: 'console',
      status: 'failed',
      error: 'console-fallback: RESEND not configured',
      relatedTable,
      relatedId,
      metadata,
    })

    return {
      delivered: false,
      provider: 'console',
      outboundMessageId: outboundId ?? undefined,
      error: 'console-fallback: RESEND not configured',
    }
  }

  // 3b. Real send path — pre-create the outbound row so we can include its id
  //     in Resend's tags. That gives the webhook a stable handle even if our
  //     provider_message_id capture races with the first webhook delivery.
  const outboundId = await createOutboundRow({
    venueId,
    leadId,
    to,
    subject,
    body: text ?? html ?? '',
    provider: 'resend',
    status: 'queued',
    error: null,
    relatedTable,
    relatedId,
    metadata,
  })

  const resend = getResend()
  if (!resend) {
    if (outboundId) await markOutboundFailed(outboundId, 'Resend client init failed')
    return {
      delivered: false,
      provider: 'console',
      outboundMessageId: outboundId ?? undefined,
      error: 'Resend client init failed',
    }
  }

  const from = process.env.RESEND_FROM_EMAIL!
  const fallbackReplyTo = process.env.RESEND_REPLY_TO_EMAIL
  const effectiveReplyTo = replyTo ?? fallbackReplyTo

  const allTags: { name: string; value: string }[] = []
  if (metadata) {
    for (const [name, value] of Object.entries(metadata)) {
      allTags.push({ name, value })
    }
  }
  if (outboundId) {
    // Crucial for the webhook to find the row even before we persist
    // provider_message_id back to it.
    allTags.push({ name: 'out_id', value: outboundId })
  }

  try {
    const { data, error } = await resend.emails.send({
      from,
      to,
      subject,
      html: finalHtml,
      text: finalText || undefined,
      replyTo: effectiveReplyTo ?? undefined,
      tags: allTags.length ? allTags : undefined,
    })

    if (error) {
      console.error('[email:resend] send failed', { to, subject, error: error.message })
      if (outboundId) await markOutboundFailed(outboundId, error.message)
      return {
        delivered: false,
        provider: 'resend',
        outboundMessageId: outboundId ?? undefined,
        error: error.message,
      }
    }

    if (!data?.id) {
      console.error('[email:resend] send returned no id', { to, subject })
      if (outboundId) await markOutboundFailed(outboundId, 'No message id returned')
      return {
        delivered: false,
        provider: 'resend',
        outboundMessageId: outboundId ?? undefined,
        error: 'No message id returned',
      }
    }

    // Persist provider_message_id; status stays 'queued' until webhook fires.
    if (outboundId) await markOutboundAccepted(outboundId, data.id)

    if (isDev) {
      console.log('[email:resend] accepted (awaiting webhook for delivery confirmation)', {
        to,
        subject,
        messageId: data.id,
        outboundMessageId: outboundId,
      })
    }
    return {
      delivered: true,
      provider: 'resend',
      messageId: data.id,
      outboundMessageId: outboundId ?? undefined,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Resend error'
    console.error('[email:resend] threw', { to, subject, error: message })
    if (outboundId) await markOutboundFailed(outboundId, message)
    return {
      delivered: false,
      provider: 'resend',
      outboundMessageId: outboundId ?? undefined,
      error: message,
    }
  }
}
