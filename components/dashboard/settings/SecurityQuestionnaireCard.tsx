'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Loader2,
  AlertTriangle,
  FileText,
  Download,
  ClipboardList,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'

/**
 * Phase 9J — SecurityQuestionnaireCard (admin/owner only).
 *
 * Format picker (generic / caiq-lite / sig-lite / vsaq-lite) +
 * counts by answer status + Markdown / CSV download buttons.
 *
 * The card explicitly tells the operator to review answers
 * before sending. Every export writes a
 * `questionnaire_response_exported` audit row so the trail of
 * "who handed which answer set to which buyer" stays intact.
 */

const FORMATS = [
  { value: 'generic', label: 'Generic' },
  { value: 'caiq-lite', label: 'CAIQ-Lite' },
  { value: 'sig-lite', label: 'SIG-Lite' },
  { value: 'vsaq-lite', label: 'VSAQ-Lite' },
] as const

type Format = (typeof FORMATS)[number]['value']

interface Summary {
  totalQuestions: number
  yes: number
  partial: number
  manual: number
  planned: number
  no: number
  notApplicable: number
}

interface QuestionnaireResponse {
  format: string
  generatedAt: string
  disclaimer: string
  summary: Summary
  sections: Array<{ id: string; title: string; answers: unknown[] }>
  warnings: string[]
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; response: QuestionnaireResponse }

export default function SecurityQuestionnaireCard() {
  const [format, setFormat] = useState<Format>('generic')
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await fetch(
          `/api/admin/security/questionnaire-response?format=${format}&download=json`,
          { method: 'GET', signal: abort.signal, credentials: 'same-origin' }
        )
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: unknown }
            | null
          const code =
            body && typeof body.error === 'string'
              ? body.error
              : `HTTP ${res.status}`
          setState({ kind: 'error', message: code })
          return
        }
        const body = (await res.json()) as { response?: QuestionnaireResponse }
        if (!body.response) {
          setState({ kind: 'error', message: 'empty_response' })
          return
        }
        setState({ kind: 'ready', response: body.response })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Network error',
        })
      }
    })()
    return () => abort.abort()
  }, [format])

  const handleDownload = useCallback(
    (download: 'markdown' | 'csv') => {
      const url = `/api/admin/security/questionnaire-response?format=${format}&download=${download}`
      window.location.href = url
    },
    [format]
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
            <ClipboardList className="h-4 w-4" />
          </div>
          <div>
            <CardTitle>Security questionnaire generator</CardTitle>
            <CardSubtitle>
              Pre-fills the obvious answers from internal evidence. Pick a
              framework, review the result, edit before sending to a buyer.
            </CardSubtitle>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {FORMATS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFormat(f.value)}
              className={
                f.value === format
                  ? 'inline-flex h-8 items-center rounded-md bg-slate-900 px-3 text-xs font-medium text-white'
                  : 'inline-flex h-8 items-center rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50'
              }
            >
              {f.label}
            </button>
          ))}
        </div>

        {state.kind === 'loading' && (
          <div className="flex items-center justify-center py-10 text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}
        {state.kind === 'error' && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>
              <div className="font-medium">Could not load questionnaire</div>
              <div className="text-xs">{state.message}</div>
            </div>
          </div>
        )}
        {state.kind === 'ready' && (
          <>
            <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-6">
              <Stat label="Sections" value={state.response.sections.length} tone="slate" />
              <Stat label="Total Q" value={state.response.summary.totalQuestions} tone="slate" />
              <Stat label="Yes" value={state.response.summary.yes} tone="emerald" />
              <Stat label="Partial" value={state.response.summary.partial} tone="amber" />
              <Stat label="Manual" value={state.response.summary.manual} tone="blue" />
              <Stat label="Planned" value={state.response.summary.planned} tone="slate" />
            </dl>

            {state.response.warnings.length > 0 && (
              <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                <div className="mb-1 font-medium">Warnings</div>
                <ul className="list-disc pl-5">
                  {state.response.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleDownload('markdown')}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                <FileText className="h-3.5 w-3.5" />
                Download Markdown
              </button>
              <button
                type="button"
                onClick={() => handleDownload('csv')}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5" />
                Download CSV
              </button>
            </div>

            <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              {state.response.disclaimer}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'slate' | 'emerald' | 'amber' | 'blue'
}) {
  const toneClass =
    tone === 'emerald'
      ? 'text-emerald-700'
      : tone === 'amber'
        ? 'text-amber-700'
        : tone === 'blue'
          ? 'text-blue-700'
          : 'text-slate-700'
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className={`mt-0.5 font-mono text-lg ${toneClass}`}>{value}</dd>
    </div>
  )
}
