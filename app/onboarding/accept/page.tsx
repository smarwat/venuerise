'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'

/**
 * Phase 6D — invitation accept landing page.
 *
 * 1. Reads `token` from the search params.
 * 2. Checks for a Supabase session in the browser.
 *    - If no session: ask the user to sign in, then re-open the link.
 *      We intentionally do NOT auto-redirect to /login because the token
 *      lives in the URL and we want them to come back to *this* URL with
 *      the same query string (the simplest UX is to just nudge them).
 * 3. If signed in: POST { token } to /api/team/invitations/accept.
 * 4. On success, show a confirmation + link to /dashboard.
 *
 * Wrapped in <Suspense> because useSearchParams() is a client hook that
 * Next 16 marks as suspending.
 */
export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={<Shell><p className="text-slate-600">Loading invitation…</p></Shell>}>
      <AcceptInner />
    </Suspense>
  )
}

type Phase =
  | { kind: 'no_token' }
  | { kind: 'unauthenticated' }
  | { kind: 'submitting' }
  | { kind: 'success'; venueId: string; alreadyMember: boolean }
  | { kind: 'error'; message: string }

function AcceptInner() {
  const searchParams = useSearchParams()
  const token = searchParams.get('token')?.trim() ?? ''
  const [phase, setPhase] = useState<Phase>({ kind: 'submitting' })

  useEffect(() => {
    let cancelled = false

    async function run() {
      if (!token) {
        if (!cancelled) setPhase({ kind: 'no_token' })
        return
      }

      // Check session client-side. We use anon + url envs (NEXT_PUBLIC_*).
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL
      const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      if (!url || !anon) {
        if (!cancelled) setPhase({ kind: 'error', message: 'Supabase is not configured.' })
        return
      }
      const supabase = createBrowserClient(url, anon)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        if (!cancelled) setPhase({ kind: 'unauthenticated' })
        return
      }

      try {
        const res = await fetch('/api/team/invitations/accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        const json: unknown = await res.json().catch(() => null)
        if (res.ok && typeof json === 'object' && json && 'venue_id' in json) {
          const j = json as { venue_id: string; already_member?: boolean }
          if (!cancelled) {
            setPhase({
              kind: 'success',
              venueId: j.venue_id,
              alreadyMember: Boolean(j.already_member),
            })
          }
          return
        }
        const errMsg =
          typeof json === 'object' && json && 'error' in json
            ? String((json as { error: unknown }).error)
            : `Request failed (${res.status})`
        if (!cancelled) setPhase({ kind: 'error', message: errMsg })
      } catch (e) {
        if (!cancelled) {
          setPhase({
            kind: 'error',
            message: e instanceof Error ? e.message : 'Network error',
          })
        }
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [token])

  if (phase.kind === 'no_token') {
    return (
      <Shell>
        <Title>Missing invitation token</Title>
        <p className="text-slate-600">
          The link looks incomplete. Open the original invite email and click the button there.
        </p>
      </Shell>
    )
  }

  if (phase.kind === 'unauthenticated') {
    return (
      <Shell>
        <Title>Sign in to accept</Title>
        <p className="text-slate-600">
          Please sign in first, then return to this invite link to join the workspace.
        </p>
        <a
          href="/login"
          className="mt-4 inline-block rounded-lg bg-slate-900 text-white px-4 py-2 text-sm font-medium hover:bg-slate-800"
        >
          Go to sign in
        </a>
      </Shell>
    )
  }

  if (phase.kind === 'submitting') {
    return (
      <Shell>
        <Title>Accepting invitation…</Title>
        <p className="text-slate-600">Hang tight — adding you to the workspace.</p>
      </Shell>
    )
  }

  if (phase.kind === 'error') {
    return (
      <Shell>
        <Title>Could not accept invitation</Title>
        <p className="text-slate-600">{humanReadableError(phase.message)}</p>
        <p className="mt-3 text-xs text-slate-400">Error code: {phase.message}</p>
      </Shell>
    )
  }

  return (
    <Shell>
      <Title>You&rsquo;re in.</Title>
      <p className="text-slate-600">
        {phase.alreadyMember
          ? 'You were already a member of this workspace — the invitation has been marked accepted.'
          : 'Welcome to the team. Your workspace access is now active.'}
      </p>
      <a
        href="/dashboard"
        className="mt-4 inline-block rounded-lg bg-slate-900 text-white px-4 py-2 text-sm font-medium hover:bg-slate-800"
      >
        Open dashboard
      </a>
    </Shell>
  )
}

function humanReadableError(code: string): string {
  switch (code) {
    case 'invitation_not_found':
      return 'This invitation link is not recognized. It may have been rotated by a new invite — ask the sender for a fresh link.'
    case 'invitation_expired':
      return 'This invitation has expired. Ask the sender to invite you again.'
    case 'invitation_revoked':
      return 'This invitation has been revoked.'
    case 'invitation_already_accepted':
      return 'This invitation has already been accepted.'
    case 'unauthorized':
      return 'You need to be signed in to accept this invitation.'
    case 'validation_failed':
      return 'The invitation token format is invalid.'
    default:
      return 'Something went wrong while accepting your invitation. Please try again or contact the sender.'
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-sm p-8">
        {children}
      </div>
    </main>
  )
}

function Title({ children }: { children: React.ReactNode }) {
  return <h1 className="text-2xl font-semibold text-slate-900 mb-3">{children}</h1>
}
