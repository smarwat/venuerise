import { ShieldCheck, CircleCheck, CircleAlert, CircleHelp } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import { buildReadinessChecklist } from '@/lib/enterprise/evidence/readiness-checklist'

/**
 * Phase 9J — EnterpriseReadinessCard.
 *
 * Server-rendered card that surfaces the readiness checklist
 * inline. No client fetch — the layout renders this whenever
 * the operator navigates to /dashboard/settings/billing.
 *
 * The checklist is informational, not gating. Items show
 * `ready` / `partial` / `missing` based on file presence + env
 * + the static evidence control map.
 */

export default async function EnterpriseReadinessCard() {
  const checklist = await buildReadinessChecklist()
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div>
            <CardTitle>Enterprise readiness checklist</CardTitle>
            <CardSubtitle>
              At-a-glance signal: is the platform ready for an enterprise
              demo? Informational only — &quot;missing&quot; items don&apos;t
              block; they just flag what a security reviewer might ask
              about first.
            </CardSubtitle>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Total" value={checklist.summary.total} tone="slate" />
          <Stat label="Ready" value={checklist.summary.ready} tone="emerald" />
          <Stat label="Partial" value={checklist.summary.partial} tone="amber" />
          <Stat label="Missing" value={checklist.summary.missing} tone="red" />
        </dl>
        <ul className="space-y-2">
          {checklist.items.map((item) => (
            <li
              key={item.id}
              className="flex items-start gap-3 rounded-md border border-slate-200 bg-white p-3"
            >
              <div className="mt-0.5 flex-shrink-0">{statusIcon(item.status)}</div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-900">
                    {item.title}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${chipClass(item.status)}`}
                  >
                    {item.status}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-slate-600">{item.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function statusIcon(status: 'ready' | 'partial' | 'missing') {
  if (status === 'ready') {
    return <CircleCheck className="h-4 w-4 text-emerald-600" />
  }
  if (status === 'partial') {
    return <CircleAlert className="h-4 w-4 text-amber-600" />
  }
  return <CircleHelp className="h-4 w-4 text-red-600" />
}

function chipClass(status: 'ready' | 'partial' | 'missing'): string {
  if (status === 'ready') {
    return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  }
  if (status === 'partial') {
    return 'bg-amber-50 text-amber-700 border-amber-200'
  }
  return 'bg-red-50 text-red-700 border-red-200'
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'slate' | 'emerald' | 'amber' | 'red'
}) {
  const toneClass =
    tone === 'emerald'
      ? 'text-emerald-700'
      : tone === 'amber'
        ? 'text-amber-700'
        : tone === 'red'
          ? 'text-red-700'
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
