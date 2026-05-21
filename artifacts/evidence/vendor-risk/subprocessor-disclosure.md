# VenueRise Subprocessor Disclosure

_Generated: 2026-05-20T18:29:52.119Z_

> This disclosure is for security review and procurement support. It is not legal advice or a contractual representation. Vendor SOC 2, DPA, SCC, and ISO posture must be verified against the vendor's current evidence before relying on any contractual commitment. Operators MUST review before sending to a buyer.

8 production subprocessor(s) listed below.

## Supabase

- **Category**: Database, auth, storage, realtime
- **Criticality**: critical
- **Risk tier**: high
- **Data categories**: account_data, lead_data, message_content, authentication_data, audit_metadata, billing_data

Hosts the application database, user authentication, and file storage. Data is encrypted at rest (AES-256) and in transit (TLS). Access is RLS-gated; service-role credentials are used only by trusted server code.

## Anthropic

- **Category**: AI model provider
- **Criticality**: critical
- **Risk tier**: high
- **Data categories**: lead_data, message_content

Generates draft replies + lead qualification signals. Lead inquiry text and conversation context are sent to the Anthropic API for inference; outputs return as drafts that require explicit operator approval before sending (no autonomous send path).

## Stripe

- **Category**: Billing + subscriptions
- **Criticality**: critical
- **Risk tier**: high
- **Data categories**: billing_data, account_data

Processes subscription payments. Card data is captured directly by Stripe and never reaches VenueRise systems; only Stripe customer/subscription/invoice ids and metadata are stored.

## Resend

- **Category**: Transactional email delivery
- **Criticality**: important
- **Risk tier**: medium
- **Data categories**: email_metadata, message_content, lead_data

Sends outbound email. Recipient addresses and message bodies are transmitted to Resend for delivery; bounce/complaint signals feed back into the in-app suppression list.

## Upstash

- **Category**: Rate-limit cache (Redis-compatible)
- **Criticality**: important
- **Risk tier**: low
- **Data categories**: usage_metadata

Stores short-lived rate-limit counters. Holds a salted-SHA-256 IP fingerprint and per-route bucket counts; no customer payload data is stored.

## Inngest

- **Category**: Background jobs + scheduled tasks
- **Criticality**: important
- **Risk tier**: medium
- **Data categories**: usage_metadata, audit_metadata

Coordinates background jobs. Event payloads include lead/tour identifiers and job metadata; job results are written back to the application database. Customer message content is fetched server-side per job, not stored at the orchestrator.

## Vercel

- **Category**: Hosting + serverless runtime
- **Criticality**: critical
- **Risk tier**: high
- **Data categories**: infrastructure_logs, usage_metadata

Runs the application servers and serves the marketing site + dashboard + widget. Request logs (method, path, status, latency) are retained at the platform layer; request bodies are not.

## Sentry

- **Category**: Error monitoring
- **Criticality**: important
- **Risk tier**: medium
- **Data categories**: infrastructure_logs, audit_metadata

Receives error telemetry. Event payloads include stack traces, route identifiers, and a salted-SHA-256 IP fingerprint; raw IPs and customer message content are not sent.
