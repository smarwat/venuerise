import type { Metadata } from 'next'
import {
  recordTrustAccessEvent,
  validateTrustAccessToken,
} from '@/lib/enterprise/trust-center/access'
import { buildTrustPacket } from '@/lib/enterprise/trust-center/artifacts'
import { TRUST_CENTER_DISCLAIMER } from '@/lib/enterprise/trust-center/policy'

/**
 * Phase 9N — Gated Trust Center access page.
 *
 * Server-rendered. Validates the bearer token + renders the
 * packet manifest with download links. On invalid / expired /
 * revoked tokens, renders a generic denial page — we never
 * leak WHICH state the token is in beyond a generic message.
 *
 * `grant_accessed` event is recorded on every successful load.
 * Failed loads record `access_denied` (best-effort).
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'VenueRise Trust Access',
  robots: { index: false, follow: false },
}

type PageProps = { params: Promise<{ token: string }> }

export default async function TrustAccessPage(props: PageProps) {
  const { token } = await props.params
  const validation = await validateTrustAccessToken(token)

  if (!validation.ok || !validation.grant) {
    void recordTrustAccessEvent({
      grantId: validation.grant?.id ?? null,
      venueId: validation.grant?.venueId ?? null,
      eventType: 'access_denied',
      artifactType: null,
      format: null,
      ip: null,
      userAgent: null,
      metadata: { reason: validation.reason },
    })
    return (
      <main className="mx-auto max-w-2xl px-6 py-20 text-slate-900">
        <header className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            Trust access
          </p>
          <h1 className="mt-2 font-serif text-3xl">Access unavailable</h1>
        </header>
        <p className="text-sm text-slate-700">
          This link is no longer available. It may have expired, been
          revoked, or never been valid. If you need to review VenueRise
          security materials, ask your VenueRise contact for a new access
          link.
        </p>
        <p className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs italic text-slate-600">
          {TRUST_CENTER_DISCLAIMER}
        </p>
      </main>
    )
  }

  const grant = validation.grant
  const packet = await buildTrustPacket(grant.scope)

  void recordTrustAccessEvent({
    grantId: grant.id,
    venueId: grant.venueId,
    eventType: 'grant_accessed',
    artifactType: null,
    format: null,
    ip: null,
    userAgent: null,
    metadata: {
      scope: grant.scope,
      buyer_company: grant.buyerCompany ?? null,
    },
  })

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-slate-900">
      <header className="mb-8 border-b border-slate-200 pb-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Trust access · {grant.scope.replace(/_/g, ' ')}
        </p>
        <h1 className="mt-2 font-serif text-3xl">
          VenueRise security packet
        </h1>
        {grant.buyerCompany && (
          <p className="mt-2 text-sm text-slate-600">
            Shared with {grant.buyerCompany}
          </p>
        )}
        <p className="mt-1 text-xs text-slate-500">
          Access expires {new Date(grant.expiresAt).toLocaleString()}.
        </p>
        <p className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs italic text-slate-600">
          {TRUST_CENTER_DISCLAIMER}
        </p>
      </header>

      <section>
        <h2 className="mb-4 font-serif text-2xl">Available artifacts</h2>
        <ul className="space-y-3">
          {packet.artifacts.map((a) => (
            <li
              key={a.type}
              className="rounded-md border border-slate-200 bg-white p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-slate-900">
                    {a.title}
                    {!a.includedInScope && (
                      <span className="ml-2 inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                        not in scope
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-600">
                    {a.description}
                  </p>
                </div>
                {a.includedInScope && (
                  <div className="flex flex-col gap-1">
                    {a.formats
                      .filter((f) => f !== 'pdf_placeholder')
                      .map((f) => (
                        <a
                          key={f}
                          href={`/api/trust/access/${token}/artifact?type=${a.type}&format=${f}`}
                          className="inline-flex h-8 items-center rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          {f.toUpperCase()}
                        </a>
                      ))}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {packet.warnings.length > 0 && (
        <section className="mt-6 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          {packet.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </section>
      )}

      <footer className="mt-10 border-t border-slate-200 pt-4 text-xs text-slate-500">
        This link is a bearer credential. Treat it like a password — anyone
        with the URL can access this packet until expiry or revocation.
      </footer>
    </main>
  )
}
