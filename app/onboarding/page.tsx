'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Phase 6C — minimal onboarding form.
 *
 * Posts to /api/onboarding/create-workspace and routes to /dashboard on
 * success. Deliberately bare-bones; the design-polished version belongs
 * to a future UI phase. Lives at /onboarding so the dashboard's "no venue
 * yet" path can simply `redirect('/onboarding')`.
 *
 * Auth is enforced server-side by the API route (401 if no session). This
 * page itself doesn't gate access — an unauthenticated user submitting
 * just sees the API's 401 in the inline error banner.
 */
export default function OnboardingPage() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const formData = new FormData(event.currentTarget)

    const venueName = String(formData.get('venue_name') ?? '').trim()
    if (!venueName) {
      setError('Venue name is required.')
      return
    }

    const capacityMinStr = String(formData.get('capacity_min') ?? '')
    const capacityMaxStr = String(formData.get('capacity_max') ?? '')
    const basePriceStr = String(formData.get('base_price') ?? '')
    const timezone = String(formData.get('timezone') ?? '').trim()

    const payload: Record<string, unknown> = { venue_name: venueName }
    if (capacityMinStr) payload.capacity_min = Number(capacityMinStr)
    if (capacityMaxStr) payload.capacity_max = Number(capacityMaxStr)
    if (basePriceStr) payload.base_price = Number(basePriceStr)
    if (timezone) payload.timezone = timezone

    startTransition(async () => {
      try {
        const res = await fetch('/api/onboarding/create-workspace', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (res.status === 201 || res.status === 200) {
          router.push('/dashboard')
          return
        }
        const json: unknown = await res.json().catch(() => null)
        const errMsg =
          typeof json === 'object' && json && 'error' in json
            ? String((json as { error: unknown }).error)
            : `Request failed (${res.status})`
        setError(errMsg)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error')
      }
    })
  }

  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-sm p-8">
        <h1 className="text-2xl font-semibold text-slate-900">Set up your workspace</h1>
        <p className="mt-2 text-sm text-slate-600">
          A few essentials to spin up your venue. You can edit anything later in settings.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <Field label="Venue name" required>
            <input
              name="venue_name"
              type="text"
              required
              maxLength={100}
              autoFocus
              className="form-input"
              placeholder="The Magnolia Estate"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Capacity (min)">
              <input
                name="capacity_min"
                type="number"
                min={1}
                defaultValue={50}
                className="form-input"
              />
            </Field>
            <Field label="Capacity (max)">
              <input
                name="capacity_max"
                type="number"
                min={1}
                defaultValue={250}
                className="form-input"
              />
            </Field>
          </div>

          <Field label="Base price (USD)">
            <input
              name="base_price"
              type="number"
              min={0}
              step={500}
              defaultValue={15000}
              className="form-input"
            />
          </Field>

          <Field label="Timezone">
            <input
              name="timezone"
              type="text"
              defaultValue="America/Chicago"
              className="form-input"
            />
          </Field>

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isPending}
            className="w-full rounded-lg bg-slate-900 text-white py-2.5 text-sm font-medium hover:bg-slate-800 disabled:opacity-60"
          >
            {isPending ? 'Creating workspace…' : 'Create workspace'}
          </button>
        </form>
      </div>

      <style>{`
        .form-input {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid rgb(226 232 240);
          background: white;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          color: rgb(15 23 42);
          outline: none;
        }
        .form-input:focus {
          border-color: rgb(29 78 216);
          box-shadow: 0 0 0 3px rgb(59 130 246 / 0.15);
        }
      `}</style>
    </main>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">
        {label}
        {required && <span className="text-red-600"> *</span>}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  )
}
