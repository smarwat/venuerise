import { NextRequest, NextResponse } from 'next/server'
import { verifyInternalRequest } from '@/lib/auth/internal-hmac'
import { addSuppression } from '@/lib/integrations/suppression'
import { log } from '@/lib/log'

/**
 * Unsubscribe handler.
 *
 * Accepts GET with three query params (built by `lib/integrations/email.ts`):
 *   email — the address to suppress
 *   ts    — unix milliseconds when the link was generated
 *   sig   — HMAC-SHA256 over the canonical JSON `{email,ts}` using
 *           INTERNAL_API_SECRET (delegated to lib/auth/internal-hmac.ts)
 *
 * Behaviour:
 *   - 200 + confirmation HTML on success
 *   - 400 + error HTML on bad/expired token
 *   - Always inserts an `email_suppressions` row with reason='unsubscribe'
 *     (the addSuppression helper is idempotent — duplicates are ignored).
 *
 * Note: returns HTML, not JSON — this URL is clicked from inside a real
 * email client, so the response is rendered as a page.
 */

const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

const PAGE_STYLES = `body{font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;background:#F8FAFC;color:#0F172A;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;}.card{background:#fff;border:1px solid #E2E8F0;border-radius:20px;padding:40px 48px;max-width:480px;box-shadow:0 1px 2px rgba(15,23,42,.04),0 2px 8px rgba(15,23,42,.03);text-align:center;}h1{margin:0 0 12px;font-size:22px;font-weight:600;letter-spacing:-0.01em;}p{margin:0 0 0;font-size:14px;line-height:1.55;color:#475569;}.ok{color:#047857;}.err{color:#B91C1C;}`

function htmlPage(title: string, body: string, status: 'ok' | 'err'): string {
  const titleClass = status === 'ok' ? 'ok' : 'err'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>${title} — VenueRise</title>
<style>${PAGE_STYLES}</style>
</head>
<body>
<main class="card">
<h1 class="${titleClass}">${title}</h1>
<p>${body}</p>
</main>
</body>
</html>`
}

function respondHtml(html: string, status: number): NextResponse {
  return new NextResponse(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const email = url.searchParams.get('email')
  const tsStr = url.searchParams.get('ts')
  const sig = url.searchParams.get('sig')

  // ---- Basic shape check ----
  if (!email || !tsStr || !sig) {
    return respondHtml(
      htmlPage(
        'Invalid link',
        'This unsubscribe link is missing required parameters. If you copy-pasted it, please use the original link from the email.',
        'err'
      ),
      400
    )
  }

  const ts = Number(tsStr)
  if (!Number.isFinite(ts) || ts <= 0) {
    return respondHtml(htmlPage('Invalid link', 'The unsubscribe token is malformed.', 'err'), 400)
  }

  // ---- Signature verification ----
  // The payload is the same shape that `lib/integrations/email.ts`
  // signs at send time: { email, ts }.
  let valid = false
  try {
    valid = verifyInternalRequest({ email, ts }, sig)
  } catch (err) {
    log.error({ err }, 'unsubscribe.verify.threw')
    return respondHtml(
      htmlPage(
        'Configuration error',
        'We could not process your request right now. Please contact the sender directly.',
        'err'
      ),
      500
    )
  }
  if (!valid) {
    return respondHtml(
      htmlPage(
        'Invalid link',
        'This unsubscribe link is invalid or has been tampered with. If you keep seeing this, contact the sender.',
        'err'
      ),
      400
    )
  }

  // ---- Expiry check ----
  if (Date.now() - ts > TOKEN_TTL_MS) {
    return respondHtml(
      htmlPage(
        'Link expired',
        'This unsubscribe link is more than 90 days old. Please reply directly to the email and ask to be removed.',
        'err'
      ),
      400
    )
  }

  // ---- Add to suppression list (idempotent) ----
  await addSuppression(email, 'unsubscribe', 'unsubscribe_link')
  log.info({ route: '/api/unsubscribe' }, 'unsubscribe.completed')

  return respondHtml(
    htmlPage(
      'You have been unsubscribed.',
      `${escapeHtml(email)} will no longer receive emails from us. If you change your mind, just reply to a previous email and let us know.`,
      'ok'
    ),
    200
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
