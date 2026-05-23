/**
 * Phase 8BJ — Contact-info extraction + no-repeat guard.
 *
 * Pure helper. The conversation agent used to ask the lead for
 * email and phone even after the lead had already typed them
 * into a single message ("email is X and phone is Y"). This
 * extractor scans the latest message + recent transcript and
 * tells the agent which fields are already known so it doesn't
 * ask again.
 *
 * Used by the orchestrator before generating an AI reply. The
 * extracted values can ALSO be patched onto the lead row when
 * the lead's `email` / `phone` columns are still null — same
 * spirit as the widget intake's contact-capture path.
 */

export interface ExtractedContact {
  email: string | null
  phone: string | null
}

export interface KnownContactSignals {
  email: boolean
  phone: boolean
  extractedFromMessage: ExtractedContact
}

// ──────────────────────────────────────────────────────────────────────
//  Public helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Extract the first email + first plausible phone number from a
 * single message body. Returns nulls when nothing is found.
 *
 * Email: standard RFC-ish pattern. Phone: 10-digit US-style by
 * default, accepting parens, dashes, dots, and leading "+1". We
 * deliberately do NOT validate against carrier — false positives
 * here are cheap (the operator can correct), false negatives
 * mean the agent re-asks for contact info the lead already gave.
 */
export function extractContactFromMessage(
  rawText: string | null | undefined
): ExtractedContact {
  if (!rawText || typeof rawText !== 'string') {
    return { email: null, phone: null }
  }
  const email = extractFirstEmail(rawText)
  const phone = extractFirstPhone(rawText)
  return { email, phone }
}

/**
 * Roll up "what contact info do we already have" from:
 *   1. The lead row's existing email/phone columns
 *   2. The latest inbound message body
 *   3. Recent prior message bodies (in case the lead gave contact
 *      info two turns ago and we missed it)
 *
 * The agent prompt uses the boolean flags to know whether to
 * re-ask. The caller can ALSO use `extractedFromMessage` to
 * upsert the lead row when those fields are still null.
 */
export function getKnownContactSignals(args: {
  leadEmail: string | null | undefined
  leadPhone: string | null | undefined
  latestMessage: string | null | undefined
  recentMessages?: ReadonlyArray<{ role: string; content: string }>
}): KnownContactSignals {
  const extractedFromMessage = extractContactFromMessage(args.latestMessage)

  let email = !!args.leadEmail || !!extractedFromMessage.email
  let phone = !!args.leadPhone || !!extractedFromMessage.phone

  if ((!email || !phone) && args.recentMessages) {
    for (const m of args.recentMessages) {
      // Only consider what the lead said — we don't want the AI's
      // prior "Could you share your phone?" line to count as a
      // phone number being known.
      if (m.role !== 'lead') continue
      const e = extractFirstEmail(m.content)
      const p = extractFirstPhone(m.content)
      if (e) email = true
      if (p) phone = true
      if (email && phone) break
    }
  }

  return { email, phone, extractedFromMessage }
}

/**
 * Render a structured prompt block describing what contact info
 * is already known. Pair with the scheduling context block in
 * the conversation prompt.
 */
export function renderContactSignalsPromptBlock(
  signals: KnownContactSignals
): string {
  const lines: string[] = []
  lines.push('KNOWN_CONTACT:')
  lines.push(`- email: ${signals.email ? 'present' : 'missing'}`)
  lines.push(`- phone: ${signals.phone ? 'present' : 'missing'}`)
  if (signals.email && signals.phone) {
    lines.push(
      `- Instruction: Do NOT ask the lead for their email or phone — both are already on file.`
    )
  } else if (!signals.email && !signals.phone) {
    lines.push(
      `- Instruction: If natural to the conversation, ask the lead for the missing contact fields (email and/or phone) — but only after answering their actual question.`
    )
  } else {
    const missing = signals.email ? 'phone' : 'email'
    lines.push(
      `- Instruction: We have ${signals.email ? 'email' : 'phone'}. Only ask for ${missing} if natural — never ask for the field we already have.`
    )
  }
  return lines.join('\n')
}

// ──────────────────────────────────────────────────────────────────────
//  Internals
// ──────────────────────────────────────────────────────────────────────

// Conservative-ish email regex. Allows the address forms a real
// person writes in chat ("name@example.com", "name.last@sub.co").
// Refuses local-part with spaces.
const EMAIL_RE =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i

function extractFirstEmail(text: string): string | null {
  const m = text.match(EMAIL_RE)
  if (!m) return null
  return m[0].trim()
}

/**
 * Find the first plausible phone number in `text`.
 *
 * Strategy: pull all digit runs (allowing common separators) and
 * keep the first one that has between 10 and 15 digits after
 * stripping non-digits — covers US 10-digit numbers, +1 prefixes,
 * and international 11–15-digit E.164 forms.
 *
 * Deliberately permissive: "3332323223" (10 digits, no separators)
 * counts. So does "(415) 555-0123" and "+1 415.555.0123".
 *
 * The caller can re-format / validate downstream; here we just
 * want to know whether the LEAD has shared a number so the agent
 * doesn't ask again.
 */
function extractFirstPhone(text: string): string | null {
  // Match runs of digits + common separators (spaces, dots, dashes,
  // parens, plus signs). Length filter is applied after digit
  // extraction so we don't reject "+1 (415) 555-0123" because of
  // its punctuation.
  const candidates = text.match(/[+\d][\d\s().\-]{8,}/g)
  if (!candidates) return null
  for (const c of candidates) {
    const digits = c.replace(/\D/g, '')
    if (digits.length >= 10 && digits.length <= 15) {
      return c.trim()
    }
  }
  return null
}
