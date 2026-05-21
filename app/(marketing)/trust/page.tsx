import type { Metadata } from 'next'
import Link from 'next/link'
import { buildPublicTrustSummary } from '@/lib/enterprise/trust-center/artifacts'

/**
 * Phase 9N — Public Trust Center page.
 *
 * Server-rendered. Uses ONLY `buildPublicTrustSummary()`,
 * which renders curated `PUBLIC_TRUST_SECTIONS` + the vendor
 * registry filtered to `disclosureStatus === 'public'`.
 *
 * NEVER reads:
 *   - Internal-only vendor rows.
 *   - Env variable names, package names, or audit internals.
 *   - Raw incident records, DSR records, or customer data.
 *
 * Cache: revalidate every 5 minutes so curated copy updates
 * propagate without a deploy. The summary builder is cheap
 * (no network calls).
 */

export const revalidate = 300

export const metadata: Metadata = {
  title: 'VenueRise Trust Center',
  description:
    'Security, privacy, and reliability posture for VenueRise. Subprocessor list, incident response posture, backup/DR targets, and SOC 2 certification status.',
}

export default async function TrustCenterPage() {
  const summary = await buildPublicTrustSummary()
  return (
    <main className="mx-auto max-w-4xl px-6 py-16 text-slate-900">
      <header className="mb-10 border-b border-slate-200 pb-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Trust center
        </p>
        <h1 className="mt-2 font-serif text-4xl text-slate-900 sm:text-5xl">
          VenueRise Security &amp; Privacy Posture
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-slate-600">
          {summary.headline}
        </p>
        <p className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs italic text-slate-600">
          {summary.disclaimer}
        </p>
      </header>

      {summary.sections.map((s) => (
        <section key={s.id} className="mb-10">
          <h2 className="font-serif text-2xl text-slate-900">{s.title}</h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            {s.body}
          </p>
          {s.bullets && s.bullets.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-6 text-sm text-slate-700">
              {s.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          )}
        </section>
      ))}

      <section className="mb-10">
        <h2 className="font-serif text-2xl text-slate-900">
          Production subprocessors
        </h2>
        <p className="mt-3 text-sm text-slate-600">
          These are the third-party processors that may handle customer data
          in production. A buyer-safe disclosure with data categories + risk
          tier is available on request.
        </p>
        <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {summary.publicSubprocessorNames.map((n) => (
            <li
              key={n}
              className="rounded-md border border-slate-200 bg-white p-2 text-center text-sm text-slate-800"
            >
              {n}
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-10">
        <h2 className="font-serif text-2xl text-slate-900">
          Known limitations
        </h2>
        <p className="mt-3 text-sm text-slate-600">
          We publish what we actually do — and what we don&apos;t.
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-6 text-sm text-slate-700">
          {summary.knownLimitations.map((k, i) => (
            <li key={i}>{k}</li>
          ))}
        </ul>
      </section>

      <section className="mb-4 rounded-md border border-slate-200 bg-slate-50 p-6">
        <h2 className="font-serif text-xl text-slate-900">
          Request the security packet
        </h2>
        <p className="mt-2 text-sm text-slate-700">
          Active enterprise procurement reviews can request a packet
          containing the buyer security summary, security questionnaire
          response, subprocessor disclosure, privacy readiness, incident
          response summary, and disaster-recovery summary. Operator + legal
          review before sending.
        </p>
        <p className="mt-3 text-sm">
          <Link
            href="/"
            className="font-semibold text-slate-900 underline underline-offset-2 hover:text-slate-700"
          >
            Contact us
          </Link>{' '}
          to start a security review.
        </p>
      </section>

      <footer className="mt-8 border-t border-slate-200 pt-4 text-xs text-slate-500">
        Generated {summary.generatedAt}. Trust materials are reviewed each
        time the source-of-truth catalogs change.
      </footer>
    </main>
  )
}
