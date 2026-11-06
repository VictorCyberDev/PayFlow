# M21 — Hosted Verify

Status: **COMPLETE_LOCAL**. Real PostgreSQL and real HTTP through the hosted host, against real signed Proofs of
sandbox payments. **Not deployed** (`payflow-public` is owner-gated), so it has not been exercised on a public URL and
has not seen real abuse. The static page at `/verify/` (in-browser, offline verification) is separate and unchanged.

## What it is

`POST /v1/verify/proofs`: anonymous, read-only. Send a signed Proof (and, optionally, what you expect it to say); get
back whether it is authentic, what it says, and each expectation that did not match.

```json
{
  "proof": { "...": "portable Proof" },
  "expect": { "amountMinor": 8400, "currency": "USD", "merchantId": "m" }
}
```

## Read-only, by construction

- It reads only the **published public keys** and the Proof you sent. It reads no tenant data and makes no outbound call.
- It writes nothing except rate-limit counters. A test counts rows in the evidence, replay, attempt, reservation,
  credential, organization and audit tables before and after hostile input and requires them unchanged.
- Everything in the answer comes from the Proof itself plus the verdict. `effectCount` is `null` for UNKNOWN and an
  unverifiable Proof carries no `effectCount` at all, so it can never be read as "nothing moved".

## Trust boundary

Only the issuer this host publishes keys for is trusted. A Proof from another issuer is `UNKNOWN_ISSUER`; an unknown
key id is `UNKNOWN_KEY`. The host never fetches a key from a URL the caller supplied, so there is no server-side request
forgery surface. Trusting other issuers is a separate, reviewed step (M24).

## Abuse protections (and their limits)

| Protection                                                              | Where it is tested                  |
| ----------------------------------------------------------------------- | ----------------------------------- |
| Strict request schema; unknown fields, bad types and bad ranges are 400 | `m21-hosted-verify` malformed       |
| Body cap 16 KB                                                          | same                                |
| 30 requests/minute per address and 1,200/minute globally; `Retry-After` | same (per-address; global untested) |
| One address cannot exhaust another's allowance                          | same                                |
| Fails closed: if the limiter is down it answers 503, never unmetered    | same                                |
| `Cache-Control: no-store`; no CORS headers (server-to-server use)       | same                                |

Mutation checks: raising the per-address limit fails the limit test; letting a limiter fault fall through fails the
fail-closed test.

Known limits:

- The per-address key is the first `X-Forwarded-For` entry. On Vercel the platform sets it; behind any proxy that lets a
  client set it, an attacker can rotate it. The global ceiling bounds the damage but would also deny honest callers.
- The global ceiling is not covered by a test (it would need 1,200 requests).
- Signature verification is cheap (Ed25519), so the realistic abuse is volume, not CPU; no load test has been run.
- Authority _presentations_ (as opposed to Proofs) are not verified here: the sandbox holds no trusted issuer keys
  (see M22/M24).
