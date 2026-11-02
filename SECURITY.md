# Security policy

DRAFT, 2026-11-02. This policy has not been reviewed by counsel and the contact address is a placeholder. Do not treat it as published until both are resolved.

PayFlow is a **developer preview**: PayPal Sandbox only, hosted on Vercel with a Neon Postgres database. There are no customers, no certification, no external security audit, no measured uptime and no legal review. We still want to hear about weaknesses.

## How to report

Use the contact route on the PayFlow site: **/contact/** and choose **Security** to request a private channel.

```
Contact: https://payflow.example/contact/ (REPLACE with the real production address before publication)
```

The URL above is a placeholder. No email address or PGP key is published here yet. Do not post vulnerability details in public issues, pull requests, discussions or social media. Machine-readable contact details are in `apps/console/public/.well-known/security.txt` (served at `/.well-known/security.txt` once the placeholder host is replaced).

## What to include

- A short description and the affected component (route, file or document).
- The impact you believe it has, in terms of PayFlow's guarantees: unauthorized economic effect, bypass of an Authority limit, replay, cross-tenant access, credential or signing-key exposure, evidence tampering, or an UNKNOWN outcome being retried or misreported.
- Steps to reproduce against the Sandbox, with request IDs (`x-payflow-request-id`) and times in UTC.
- Your preferred name for credit, or a request to stay anonymous.

## What not to include

- Real secrets, tokens, private keys, connection strings or passwords. If you found one, say where, and redact it.
- Personal data of other people, payment card or bank details, or data copied from a system that is not yours.
- Anything obtained by social engineering, physical access, or attacks on PayPal, Vercel, Neon or other third parties.

## Scope

In scope (developer preview):

- The source code in this repository, including the Trust Kernel, execution grants, the Execution Boundary, the Gateway (`/v1/*`), credential handling, reconciliation, signed Proof and the verifier.
- The PayFlow Sandbox deployments and the company site that you are given access to.
- Documentation that makes a security claim (threat model, runbooks), if you believe a claim is false.

Out of scope:

- Vulnerabilities in PayPal, Vercel, Neon, npm packages or other third-party services themselves (report those to the owner). A weakness in how PayFlow uses them is in scope.
- Denial-of-service by volume, load testing and automated scanning at scale. Rate limiting is not yet implemented on the hosted gateway (see `docs/security-ops/SECURITY-ENGINEERING-REVIEW.md`, F-02); please do not demonstrate it with floods.
- Findings that need a compromised operator device, or already-documented gaps listed in `docs/security-ops/` as NOT IMPLEMENTED, unless you have a concrete exploit.
- Spam, social engineering, physical attacks, and reports with no security impact.

## What to expect

- We will try to acknowledge reports and keep you informed. **No response-time SLA is promised.**
- **No bounty is offered or implied.** We may credit you if you want.
- We may ask follow-up questions. Fixes are made in the repository with a regression test where practical; severity and timelines are decided case by case.
- We ask for a reasonable period to fix before public disclosure, agreed with you in the private channel.

## Safe harbour (DRAFT - for counsel review)

DRAFT - for counsel review. This text is not legally binding and has not been reviewed by a lawyer.

If you make a good-faith effort to follow this policy, we intend not to pursue or support legal action against you for research that stays within scope, uses only your own accounts and Sandbox data, avoids privacy violations and service disruption, does not move real money, and stops and reports as soon as you reach sensitive data. This does not authorize access to other people's data or accounts, does not bind third parties (PayPal, Vercel, Neon and others have their own terms), and may change after legal review.

## Related documents

- `docs/security-ops/INCIDENT-RUNBOOKS.md` for how we handle incidents.
- `docs/security-ops/THREAT-MODEL-UPDATE.md` and `docs/THREAT_MODEL.md` for the threat model.
- `docs/security-ops/SECURITY-ENGINEERING-REVIEW.md` for known gaps.
