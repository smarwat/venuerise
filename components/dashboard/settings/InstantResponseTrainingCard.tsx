'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MessageSquare,
  ShieldAlert,
  Sparkles,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardSubtitle,
  CardTitle,
} from '@/components/dashboard/ui/Card'
import { Button } from '@/components/dashboard/ui/Button'
import {
  DEFAULT_INSTANT_RESPONSE_SETTINGS,
  INSTANT_RESPONSE_LIMITS,
  type InstantResponseSettings,
  type InstantResponseSampleReply,
  type InstantResponseFormality,
  type InstantResponseVoiceTone,
  type RevenueOsSettings,
} from '@/lib/revenue-os/settings'

/**
 * Phase GTM-ILR — Instant Response Training card.
 *
 * Operator-facing controls for the venue voice training profile +
 * safety gate. Sibling of `RevenueOsSettingsCard` (kept separate so
 * the SLA/leakage card doesn't grow into a monster).
 *
 * Reads + writes via the existing `/api/admin/revenue-os/settings`
 * endpoint — the `instantResponse` sub-block coexists with the other
 * Revenue OS settings under `venues.metadata.revenue_os`.
 *
 * Honesty contract:
 *   - Auto-send default is OFF. The toggle carries an explicit
 *     warning. Even when ON, this phase ships scaffolding only —
 *     no outbound integration is wired, every draft still requires
 *     operator approval in the dashboard.
 *   - Sample replies are stored verbatim (capped) and shipped to
 *     Claude inside the system prompt. The card warns operators to
 *     keep secrets out.
 */

type FetchState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; settings: InstantResponseSettings }

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string }

const VOICE_TONE_OPTIONS: Array<{ value: InstantResponseVoiceTone; label: string }> =
  [
    { value: 'warm_concierge', label: 'Warm concierge' },
    { value: 'luxury_formal', label: 'Luxury formal' },
    { value: 'friendly_casual', label: 'Friendly casual' },
    { value: 'short_direct', label: 'Short and direct' },
  ]

const FORMALITY_OPTIONS: Array<{ value: InstantResponseFormality; label: string }> =
  [
    { value: 'casual', label: 'Casual' },
    { value: 'polished', label: 'Polished' },
    { value: 'luxury', label: 'Luxury' },
  ]

function arrayToLines(arr: string[]): string {
  return arr.join('\n')
}
function linesToArray(text: string, cap: number, itemMax: number): string[] {
  if (typeof text !== 'string') return []
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim()
    if (t.length === 0) continue
    out.push(t.slice(0, itemMax))
    if (out.length >= cap) break
  }
  return out
}

function samplesToText(replies: InstantResponseSampleReply[]): string {
  // Render samples as plain blocks the operator can edit. We use a
  // markdown-ish separator so a single textarea round-trips cleanly.
  return replies
    .map((r) => {
      const label = r.label ? `[${r.label}]\n` : ''
      return `${label}LEAD: ${r.leadMessage}\nREPLY: ${r.idealResponse}`
    })
    .join('\n---\n')
}

function textToSamples(text: string): InstantResponseSampleReply[] {
  if (typeof text !== 'string' || text.trim().length === 0) return []
  const out: InstantResponseSampleReply[] = []
  // Split on lines that are exactly `---` (with optional whitespace).
  const blocks = text.split(/^\s*---\s*$/m)
  for (const raw of blocks) {
    const block = raw.trim()
    if (block.length === 0) continue
    // Optional [label] line.
    const labelMatch = block.match(/^\[([^\]]+)\]/)
    const label = labelMatch
      ? labelMatch[1].trim().slice(0, INSTANT_RESPONSE_LIMITS.sampleReplyLabelMax)
      : null
    const body = labelMatch ? block.slice(labelMatch[0].length).trim() : block
    const leadIdx = body.toUpperCase().indexOf('LEAD:')
    const replyIdx = body.toUpperCase().indexOf('REPLY:')
    if (leadIdx === -1 || replyIdx === -1 || replyIdx < leadIdx) continue
    const leadMessage = body
      .slice(leadIdx + 'LEAD:'.length, replyIdx)
      .trim()
      .slice(0, INSTANT_RESPONSE_LIMITS.sampleReplyLeadMessageMax)
    const idealResponse = body
      .slice(replyIdx + 'REPLY:'.length)
      .trim()
      .slice(0, INSTANT_RESPONSE_LIMITS.sampleReplyIdealResponseMax)
    if (leadMessage.length === 0 || idealResponse.length === 0) continue
    out.push({
      label: label && label.length > 0 ? label : null,
      leadMessage,
      idealResponse,
    })
    if (out.length >= INSTANT_RESPONSE_LIMITS.sampleRepliesCap) break
  }
  return out
}

export default function InstantResponseTrainingCard() {
  const [state, setState] = useState<FetchState>({ kind: 'loading' })
  const [draft, setDraft] = useState<InstantResponseSettings>(
    DEFAULT_INSTANT_RESPONSE_SETTINGS
  )
  // Textarea-shaped local state for collections (round-trips on save).
  const [phrasesUseText, setPhrasesUseText] = useState('')
  const [phrasesAvoidText, setPhrasesAvoidText] = useState('')
  const [safetyNotesText, setSafetyNotesText] = useState('')
  const [samplesText, setSamplesText] = useState('')
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await fetch('/api/admin/revenue-os/settings', {
          credentials: 'same-origin',
        })
        if (cancelled) return
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          setState({
            kind: 'error',
            message: body?.error ?? `HTTP ${res.status}`,
          })
          return
        }
        const body = (await res.json()) as {
          settings: RevenueOsSettings
        }
        const ir = body.settings.instantResponse
        setState({ kind: 'ready', settings: ir })
        setDraft(ir)
        setPhrasesUseText(arrayToLines(ir.phrasesToUse))
        setPhrasesAvoidText(arrayToLines(ir.phrasesToAvoid))
        setSafetyNotesText(arrayToLines(ir.safetyNotes))
        setSamplesText(samplesToText(ir.sampleReplies))
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
  }, [reloadTick])

  const dirty = useMemo(() => {
    if (state.kind !== 'ready') return false
    const phrasesUseNow = linesToArray(
      phrasesUseText,
      INSTANT_RESPONSE_LIMITS.phrasesToUseCap,
      INSTANT_RESPONSE_LIMITS.phraseMax
    )
    const phrasesAvoidNow = linesToArray(
      phrasesAvoidText,
      INSTANT_RESPONSE_LIMITS.phrasesToAvoidCap,
      INSTANT_RESPONSE_LIMITS.phraseMax
    )
    const safetyNow = linesToArray(
      safetyNotesText,
      INSTANT_RESPONSE_LIMITS.safetyNotesCap,
      INSTANT_RESPONSE_LIMITS.safetyNoteMax
    )
    const samplesNow = textToSamples(samplesText)
    return (
      draft.enabled !== state.settings.enabled ||
      draft.autoSendEnabled !== state.settings.autoSendEnabled ||
      draft.autoSendMinConfidence !== state.settings.autoSendMinConfidence ||
      draft.voiceTone !== state.settings.voiceTone ||
      draft.voiceFormality !== state.settings.voiceFormality ||
      (draft.preferredGreeting ?? '') !== (state.settings.preferredGreeting ?? '') ||
      (draft.preferredCta ?? '') !== (state.settings.preferredCta ?? '') ||
      JSON.stringify(phrasesUseNow) !==
        JSON.stringify(state.settings.phrasesToUse) ||
      JSON.stringify(phrasesAvoidNow) !==
        JSON.stringify(state.settings.phrasesToAvoid) ||
      JSON.stringify(safetyNow) !== JSON.stringify(state.settings.safetyNotes) ||
      JSON.stringify(samplesNow) !== JSON.stringify(state.settings.sampleReplies)
    )
  }, [
    state,
    draft,
    phrasesUseText,
    phrasesAvoidText,
    safetyNotesText,
    samplesText,
  ])

  const handleSave = useCallback(async () => {
    if (state.kind !== 'ready' || !dirty) return
    setSave({ kind: 'saving' })
    try {
      const payload = {
        settings: {
          instantResponse: {
            enabled: draft.enabled,
            autoSendEnabled: draft.autoSendEnabled,
            autoSendMinConfidence: draft.autoSendMinConfidence,
            voiceTone: draft.voiceTone,
            voiceFormality: draft.voiceFormality,
            preferredGreeting:
              draft.preferredGreeting && draft.preferredGreeting.trim().length > 0
                ? draft.preferredGreeting.trim()
                : null,
            preferredCta:
              draft.preferredCta && draft.preferredCta.trim().length > 0
                ? draft.preferredCta.trim()
                : null,
            phrasesToUse: linesToArray(
              phrasesUseText,
              INSTANT_RESPONSE_LIMITS.phrasesToUseCap,
              INSTANT_RESPONSE_LIMITS.phraseMax
            ),
            phrasesToAvoid: linesToArray(
              phrasesAvoidText,
              INSTANT_RESPONSE_LIMITS.phrasesToAvoidCap,
              INSTANT_RESPONSE_LIMITS.phraseMax
            ),
            safetyNotes: linesToArray(
              safetyNotesText,
              INSTANT_RESPONSE_LIMITS.safetyNotesCap,
              INSTANT_RESPONSE_LIMITS.safetyNoteMax
            ),
            sampleReplies: textToSamples(samplesText),
          },
        },
      }
      const res = await fetch('/api/admin/revenue-os/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setSave({
          kind: 'error',
          message: body?.error ?? `HTTP ${res.status}`,
        })
        return
      }
      setSave({ kind: 'saved' })
      setReloadTick((t) => t + 1)
      setTimeout(() => setSave({ kind: 'idle' }), 1800)
    } catch (err) {
      setSave({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      })
    }
  }, [state, draft, dirty, phrasesUseText, phrasesAvoidText, safetyNotesText, samplesText])

  if (state.kind === 'loading') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Instant Response training</CardTitle>
          <CardSubtitle>Loading…</CardSubtitle>
        </CardHeader>
      </Card>
    )
  }
  if (state.kind === 'error') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Instant Response training</CardTitle>
          <CardSubtitle>
            <span className="text-red-600">Error: {state.message}</span>
          </CardSubtitle>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3 min-w-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#EFF6FF] text-[#1D4ED8] shrink-0">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <CardTitle>Instant Response training</CardTitle>
            <CardSubtitle>
              Train the AI to draft instant replies in your voice. Auto-send
              stays OFF until you explicitly turn it on — every draft requires
              operator approval in the dashboard.
            </CardSubtitle>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-5">
          {/* Enable instant draft */}
          <ToggleRow
            label="Enable instant AI draft"
            description="Generate a draft reply as soon as a new lead arrives. Default ON."
            checked={draft.enabled}
            onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
            icon={<MessageSquare className="h-4 w-4 text-[#1D4ED8]" />}
          />

          {/* Auto-send toggle with warning */}
          <div className="rounded-md border border-amber-200 bg-amber-50/40 p-3">
            <ToggleRow
              label="Enable auto-send (scaffolding only)"
              description="Default OFF. When ON, drafts that pass every safety check are MARKED auto-send-eligible. This phase ships scaffolding only — no outbound integration is wired, so drafts are still queued for operator approval."
              checked={draft.autoSendEnabled}
              onChange={(v) => setDraft((d) => ({ ...d, autoSendEnabled: v }))}
              icon={<ShieldAlert className="h-4 w-4 text-[#B45309]" />}
              danger
            />
            {draft.autoSendEnabled && (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Auto-send is recorded as <em>eligible</em> in the audit row.
                  The dashboard does NOT actually send anything in this phase.
                  Wiring an outbound channel is a separate future phase.
                </span>
              </div>
            )}
            <div className="mt-3">
              <label className="block text-[12.5px] font-medium text-[#0F172A] mb-1">
                Auto-send confidence floor: {draft.autoSendMinConfidence}
              </label>
              <input
                type="range"
                min={INSTANT_RESPONSE_LIMITS.autoSendMinConfidenceMin}
                max={INSTANT_RESPONSE_LIMITS.autoSendMinConfidenceMax}
                value={draft.autoSendMinConfidence}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    autoSendMinConfidence: Number(e.target.value),
                  }))
                }
                className="w-full"
              />
              <p className="text-[11px] text-[#64748B]">
                Drafts must score this confidence or higher to be marked
                auto-send-eligible. Range {INSTANT_RESPONSE_LIMITS.autoSendMinConfidenceMin}–
                {INSTANT_RESPONSE_LIMITS.autoSendMinConfidenceMax}.
              </p>
            </div>
          </div>

          {/* Voice tone + formality */}
          <div className="grid sm:grid-cols-2 gap-4">
            <SelectRow
              label="Voice tone"
              value={draft.voiceTone}
              onChange={(v) =>
                setDraft((d) => ({ ...d, voiceTone: v as InstantResponseVoiceTone }))
              }
              options={VOICE_TONE_OPTIONS}
            />
            <SelectRow
              label="Formality"
              value={draft.voiceFormality}
              onChange={(v) =>
                setDraft((d) => ({
                  ...d,
                  voiceFormality: v as InstantResponseFormality,
                }))
              }
              options={FORMALITY_OPTIONS}
            />
          </div>

          {/* Preferred greeting + CTA */}
          <TextInputRow
            label="Preferred greeting style"
            placeholder="e.g. Start with congratulations on the engagement"
            value={draft.preferredGreeting ?? ''}
            onChange={(v) => setDraft((d) => ({ ...d, preferredGreeting: v }))}
            max={INSTANT_RESPONSE_LIMITS.preferredGreetingMax}
            optional
          />
          <TextInputRow
            label="Preferred next-step phrasing"
            placeholder="e.g. Would you like to schedule a private tour this week?"
            value={draft.preferredCta ?? ''}
            onChange={(v) => setDraft((d) => ({ ...d, preferredCta: v }))}
            max={INSTANT_RESPONSE_LIMITS.preferredCtaMax}
            optional
            helper="The AI will adapt to context — it won't paste this verbatim."
          />

          {/* Phrases */}
          <TextareaRow
            label="Phrases to use (one per line)"
            value={phrasesUseText}
            onChange={setPhrasesUseText}
            placeholder={'private tour\nour estate\nyour celebration'}
            rows={3}
            cap={INSTANT_RESPONSE_LIMITS.phrasesToUseCap}
            itemMax={INSTANT_RESPONSE_LIMITS.phraseMax}
          />
          <TextareaRow
            label="Phrases to avoid (one per line)"
            value={phrasesAvoidText}
            onChange={setPhrasesAvoidText}
            placeholder={'cheap\nbudget-friendly\ndeal'}
            rows={3}
            cap={INSTANT_RESPONSE_LIMITS.phrasesToAvoidCap}
            itemMax={INSTANT_RESPONSE_LIMITS.phraseMax}
          />

          {/* Sample replies */}
          <div>
            <label className="block text-[13px] font-medium text-[#0F172A] mb-1">
              Sample past replies (up to{' '}
              {INSTANT_RESPONSE_LIMITS.sampleRepliesCap})
            </label>
            <p className="text-[11px] text-[#64748B] mb-2">
              Paste 2–3 real examples of how your team would reply. Use{' '}
              <code className="text-[10px]">LEAD:</code> and{' '}
              <code className="text-[10px]">REPLY:</code> markers, separated by{' '}
              <code className="text-[10px]">---</code>. The AI will match this
              voice. <strong>Do not paste secrets or PII.</strong>
            </p>
            <textarea
              className="w-full rounded-md border border-[#CBD5E1] bg-white p-2 text-[13px] text-[#0F172A] font-mono"
              rows={10}
              value={samplesText}
              onChange={(e) => setSamplesText(e.target.value)}
              placeholder={`[Saturday inquiry]
LEAD: Hi, are you open on May 16, 2026 for 150 guests?
REPLY: Hi Sarah! Congrats on the engagement. We'd love to host you for May 16 — let's schedule a tour to confirm fit.
---
LEAD: What's pricing for a Friday night?
REPLY: Hi Jordan, Friday packages start lower than Saturdays. The best way to get accurate numbers is a 30-min tour — would Thursday work?`}
            />
          </div>

          {/* Safety notes */}
          <TextareaRow
            label="Additional venue rules (binding)"
            value={safetyNotesText}
            onChange={setSafetyNotesText}
            placeholder={'Never offer payment plans\nNo outside alcohol'}
            rows={3}
            cap={INSTANT_RESPONSE_LIMITS.safetyNotesCap}
            itemMax={INSTANT_RESPONSE_LIMITS.safetyNoteMax}
            helper="The AI will treat each line as a hard rule."
          />

          {/* Save */}
          <div className="flex items-center gap-3 pt-2 border-t border-[#E2E8F0]">
            <Button
              onClick={handleSave}
              disabled={!dirty || save.kind === 'saving'}
              variant="primary"
            >
              {save.kind === 'saving' ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                </>
              ) : (
                'Save training'
              )}
            </Button>
            {save.kind === 'saved' && (
              <span className="flex items-center gap-1 text-[12.5px] text-[#047857]">
                <CheckCircle2 className="h-3.5 w-3.5" /> Saved.
              </span>
            )}
            {save.kind === 'error' && (
              <span className="flex items-center gap-1 text-[12.5px] text-red-600">
                <AlertTriangle className="h-3.5 w-3.5" /> {save.message}
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ──────────────────────────────────────────────────────────────────────
//  Subcomponents
// ──────────────────────────────────────────────────────────────────────

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  icon,
  danger,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
  icon?: React.ReactNode
  danger?: boolean
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 rounded border-[#CBD5E1]"
      />
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[13px] font-medium text-[#0F172A]">
          {icon}
          {label}
        </div>
        <p
          className={`text-[11.5px] mt-0.5 ${
            danger ? 'text-[#B45309]' : 'text-[#64748B]'
          }`}
        >
          {description}
        </p>
      </div>
    </label>
  )
}

function SelectRow({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <label className="block">
      <span className="block text-[13px] font-medium text-[#0F172A] mb-1">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-[#CBD5E1] bg-white px-2 py-1.5 text-[13px] text-[#0F172A]"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function TextInputRow({
  label,
  value,
  onChange,
  placeholder,
  max,
  optional,
  helper,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  max: number
  optional?: boolean
  helper?: string
}) {
  return (
    <label className="block">
      <span className="flex items-center justify-between text-[13px] font-medium text-[#0F172A] mb-1">
        {label}
        {optional && (
          <span className="text-[11px] font-normal text-[#94A3B8]">
            Optional
          </span>
        )}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, max))}
        placeholder={placeholder}
        maxLength={max}
        className="w-full rounded-md border border-[#CBD5E1] bg-white px-2 py-1.5 text-[13px] text-[#0F172A]"
      />
      {helper && <p className="mt-1 text-[11px] text-[#64748B]">{helper}</p>}
    </label>
  )
}

function TextareaRow({
  label,
  value,
  onChange,
  placeholder,
  rows,
  cap,
  itemMax,
  helper,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows: number
  cap: number
  itemMax: number
  helper?: string
}) {
  const lineCount = value.split(/\r?\n/).filter((l) => l.trim().length > 0).length
  return (
    <div>
      <label className="flex items-center justify-between text-[13px] font-medium text-[#0F172A] mb-1">
        <span>{label}</span>
        <span className="text-[11px] font-normal text-[#94A3B8]">
          {lineCount}/{cap} (max {itemMax} chars each)
        </span>
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full rounded-md border border-[#CBD5E1] bg-white p-2 text-[13px] text-[#0F172A]"
      />
      {helper && <p className="mt-1 text-[11px] text-[#64748B]">{helper}</p>}
    </div>
  )
}
