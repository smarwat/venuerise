import 'server-only'
import { Resend } from 'resend'

/**
 * Email delivery integration — Resend, with a console fallback for local dev.
 *
 * ── HONESTY CONTRACT ───────────────────────────────────────────────────────
 * The caller (a job function) needs to know whether a real outbound message
 * left the building. We never lie:
 *
 *   - `delivered: true`  → Resend accepted the message AND returned an id
 *   - `delivered: false` → console fallback (dev), missing config, OR a
 *                          provider error. The caller must NOT mark the
 *                          underlying row as "sent" in this case unless it
 *                          explicitly opts in to the dev-mode behaviour.
 *   - `provider`         → which path actually ran. Always present.
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
}

export interface SendEmailResult {
  delivered: boolean
  provider: EmailProvider
  messageId?: string
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

/**
 * Returns true if the deployment can actually deliver email through Resend.
 * Used by /api/health and by callers that want to gate behaviour.
 */
export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM_EMAIL
}

function htmlFromText(text: string): string {
  // Minimal but safe: escape, preserve line breaks.
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px 0;line-height:1.55;color:#1F2937;">${p.replace(/\n/g, '<br />')}</p>`)
    .join('')
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;font-size:15px;">${paragraphs}</div>`
}

/**
 * Send an email. Returns a typed result — the caller decides how to react.
 */
export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const { to, subject, text, html, replyTo, metadata } = params

  if (!to || !subject || (!text && !html)) {
    return {
      delivered: false,
      provider: 'console',
      error: 'Missing required email fields (to/subject/text-or-html).',
    }
  }

  const finalHtml = html ?? (text ? htmlFromText(text) : undefined)

  // ---- Console fallback (no Resend configured) ----
  if (!emailConfigured()) {
    if (isDev) {
      console.warn(
        '[email:console] RESEND not configured — email NOT delivered. ' +
          'Set RESEND_API_KEY + RESEND_FROM_EMAIL to enable real delivery.',
        { to, subject, preview: (text ?? html ?? '').slice(0, 120) }
      )
    } else {
      // In production this is a configuration bug — log loudly without payload.
      console.error('[email:console] RESEND not configured in production environment.')
    }
    return { delivered: false, provider: 'console' }
  }

  // ---- Resend path ----
  const resend = getResend()
  if (!resend) {
    return { delivered: false, provider: 'console', error: 'Resend client init failed' }
  }

  const from = process.env.RESEND_FROM_EMAIL!
  const fallbackReplyTo = process.env.RESEND_REPLY_TO_EMAIL
  const effectiveReplyTo = replyTo ?? fallbackReplyTo

  try {
    // Resend 6's send() signature is a discriminated union over template vs.
    // direct content. We always use the direct path — provide html (and a
    // plaintext fallback derived from text when present) so the union
    // narrows correctly.
    const safeHtml = finalHtml ?? '<p></p>'
    const sendPayload = {
      from,
      to,
      subject,
      html: safeHtml,
      text: text ?? undefined,
      replyTo: effectiveReplyTo ?? undefined,
      tags: metadata
        ? Object.entries(metadata).map(([name, value]) => ({ name, value }))
        : undefined,
    }
    const { data, error } = await resend.emails.send(sendPayload)

    if (error) {
      console.error('[email:resend] send failed', { to, subject, error: error.message })
      return { delivered: false, provider: 'resend', error: error.message }
    }

    if (!data?.id) {
      console.error('[email:resend] send returned no id', { to, subject })
      return { delivered: false, provider: 'resend', error: 'No message id returned' }
    }

    if (isDev) {
      console.log('[email:resend] delivered', { to, subject, messageId: data.id })
    }
    return { delivered: true, provider: 'resend', messageId: data.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Resend error'
    console.error('[email:resend] threw', { to, subject, error: message })
    return { delivered: false, provider: 'resend', error: message }
  }
}
