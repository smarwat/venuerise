# Post-Incident Review — VenueRise

> These targets describe VenueRise's intended incident response. VenueRise does NOT currently staff a 24/7 on-call rotation and does NOT offer an uptime SLA contract. Detectors are conservative + operator-triggered; no autonomous remediation occurs. Customer notification for any security event requires legal/operator review before sending.

## Summary

- **Incident id**:
- **Title**:
- **Severity** (sev1 / sev2 / sev3 / sev4):
- **Status**:
- **Detected at**:
- **Mitigated at**:
- **Resolved at**:
- **Time to mitigation**:
- **Time to resolution**:
- **Owner / scribe**:

## What happened

(One paragraph plain English; what the customer / operator experienced.)

## Detection path

(How was this caught — operator report, abuse detector candidate, SSO failure
spike, backup posture warning, vendor advisory, other?)

## Mitigation steps

1.
2.
3.

## Root cause

(Code path / config drift / vendor incident / human action. Be specific —
this is the section that drives the action items.)

## Customer impact

- Tenants affected:
- Data categories touched:
- Customer notification posture (required_legal_review / recommended_legal_review / operator_discretion / not_required):
- Notification sent? (yes / no / pending legal review):

## What went well

-
-

## What went poorly

-
-

## Action items

| # | Item | Owner | Due | Ticket |
|---|---|---|---|---|
| 1 |  |  |  |  |
| 2 |  |  |  |  |

## Followups to runbook

(Update docs/INCIDENT-RESPONSE.md, docs/RUNBOOK.md, or
lib/enterprise/incidents/policy.ts if this incident exposed an ambiguity in
the documented intent. Reference the PR.)
