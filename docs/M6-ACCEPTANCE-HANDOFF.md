# M6 Acceptance Handoff — Delegated / Human-Not-Present Commerce

Status: **BLOCKED ONLY ON OWNER-RUN LIVE PAYPAL SANDBOX ACCEPTANCE**

M6 implementation, deterministic verification, browser verification, isolated hosted environment, and hosted configuration checks are complete. **Do not merge PR #16 and do not start M7 until the fresh live PayPal Sandbox acceptance below ends in `M6 SANDBOX ACCEPTANCE: PASS`.**

## Pull request and tested implementation

- Repository: `VictorCyberDev/PayFlow`
- PR: `#16 — M6 — Delegated / Human-Not-Present Commerce`
- Branch: `m6-delegated-human-not-present-commerce`
- Base: `main`
- Tested implementation evidence SHA: `6c22e922de0e027a7a4547d090851325fbdfc45b`
- GitHub Actions run: `40035436670`
- PR state at handoff: Draft, open, mergeable, unmerged
- M7: **not started**

The GitHub Actions run above completed successfully across:

- console lint / typecheck / tests / production build
- console Chromium E2E
- root format check / lint / typecheck
- unit tests
- isolated PostgreSQL integration tests
- coverage gate and bounded coverage evidence export
- production dependency audit (`npm audit --omit=dev --audit-level=high`)
- root production build

No M6 schema migration was added. Historical migrations `001`–`010` remain unchanged.

## Hosted M6 acceptance environment

M6 has a dedicated hosted acceptance environment. It does **not** reuse or mutate the M5 deployment.

- Stable URL: `https://payflow-m6-acceptance.vercel.app`
- Vercel project: `payflow-m6-acceptance`
- Verified production deployment ID: `dpl_33hvVQhTgvKDzYhQCUw219wdfVn4`
- Verified deployment source SHA: `6c22e922de0e027a7a4547d090851325fbdfc45b`
- Dedicated hosting root: `hosting/m6/`
- Historical M5 hosting root remains `hosting/m5/`

Hosted verification completed:

1. Stable M6 URL returns HTTP 200 and the current PayFlow console.
2. Static responses send `Access-Control-Allow-Origin: https://payflow-m6-acceptance.vercel.app`.
3. Security headers include CSP, HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, a restrictive Permissions Policy, and `Referrer-Policy: no-referrer`.
4. Protected API access without a valid owner session fails closed with `{"status":"UNAVAILABLE"}`.
5. M5 and M6 hosting origins are now independently locked by regression coverage so an M6 deploy cannot silently inherit the historical M5 origin.

## Isolated Neon state

A dedicated Neon project named `payflow-m6-acceptance` is provisioned for M6 acceptance.

Verified state at handoff:

- 30 public tables
- one seeded principal
- one seeded Agent passport
- Authorities created and revoked by the hosted browser acceptance (5 Mandates, all revoked; 1 proven zero-effect quote refusal) — authority records only
- no transaction proposals
- no authorization reservations
- no execution grants
- no payment attempts
- no provider observations / financial history

This database is isolated from historical M4/M5 payment evidence and is clean for the final live M6 acceptance. The live operator script refuses only on payment history (attempts, reservations, grants, proposals, provider observations), all of which are zero here.

## Hosted browser acceptance (`npm run test:hosted` in `apps/console`)

Run against `https://payflow-m6-acceptance.vercel.app`: **7 / 7 passed** — HTTPS and cookie properties, the full create → confirm → Active → reload → revoke journey, the M6 demo Agent, hosted adversarial cases (cookie, CSRF, origin, principal injection, term tampering, replay), secret review of the client bundle and every response, 375 px mobile, and the host-header check.

The M6 demo Agent test proves the hosted deployment is honest about its missing payment rail: the `$84` purchase is disabled with "Payments aren't connected in this demo", and the `$184` price-drift case is blocked with `$0 moved`. Database check afterwards: 1 durable quote refusal; **0** proposals, reservations, grants, payment attempts and provider observations.

Two defects found and fixed by this run: the `trailingSlash` setting required by the static pages also redirected `/api/*` to a slash-terminated path the host does not match (adapter now normalizes it, covered by `tests/hosting-m5.integration.test.ts`), and the harness's raw HTTP helper did not follow that redirect.

## What is already proven without live PayPal credentials

The deterministic and integration suites cover the required M6 authority behavior, including:

- valid `$84` compliant delegated purchase → one authorized provider effect in the deterministic rail
- `$184` price drift vs `$100` maximum → `$0 moved`
- used / refurbished item denial
- wrong merchant, product, condition, quantity, currency or capability denial
- revoked / expired Authority and suspended Agent → zero new provider effect
- revoke / suspend / expire after grant but before dispatch → execution boundary refuses the effect
- grant replay / expiry / tamper / re-scope defenses
- four-way concurrency against a one-keyboard / `$100` Authority → one winner
- provider ambiguity quarantine and reconciliation without duplicate capture
- Activity projection distinguishes delegated completion from human-resumed completion
- owner isolation and hosted demo-agent boundaries
- browser journeys including revoked Authority, ambiguous outcome reconciliation, and 375 px mobile

The remaining live run is therefore a provider-conformance acceptance of the real Sandbox delegated instrument path, not a substitute for the deterministic authority tests.

## Remaining hard gate — fresh live PayPal Sandbox `$84` capture

The account owner must supply the following **outside chat and outside the repository** through a secure local/operator environment:

- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_ENVIRONMENT=sandbox`
- `PAYPAL_EXPECTED_MERCHANT_ID` — the real 13-character Sandbox merchant ID PayFlow must verify
- `PAYPAL_DELEGATED_VAULT_ID` — a pre-approved Sandbox buyer PayPal wallet/vault instrument
- `PAYFLOW_M6_SIGNING_KEY` — persistent Ed25519 PKCS#8 PEM signing key
- `DATABASE_URL` — the fresh isolated M6 acceptance database

Do **not** paste these values into chat, commit them to GitHub, or print them into CI logs.

Run from a machine with network access to the isolated database:

```bash
RUN_M6_SANDBOX_ACCEPTANCE=true \
DATABASE_URL='…' \
PAYPAL_ENVIRONMENT=sandbox \
PAYPAL_CLIENT_ID='…' \
PAYPAL_CLIENT_SECRET='…' \
PAYPAL_DELEGATED_VAULT_ID='…' \
PAYPAL_EXPECTED_MERCHANT_ID='…' \
PAYFLOW_M6_SIGNING_KEY="$(cat key.pem)" \
npm run acceptance:m6:sandbox
```

The operator script must prove all of the following in one fresh acceptance run:

- one real `$84.00 USD` PayPal Sandbox delegated purchase
- no human approval step during the delegated execution
- exactly one provider capture
- no duplicate capture on a second/replay attempt
- durable reservation ends `COMMITTED`
- one-time execution grant ends `CONSUMED`
- payment attempt is terminally captured / reconciled truthfully
- Operation Trace verdict is `VERIFIED`
- output terminates with `M6 SANDBOX ACCEPTANCE: PASS`

If any of those checks fail, M6 remains incomplete and PR #16 remains unmerged.

## After the live PASS

Only after the operator script prints `M6 SANDBOX ACCEPTANCE: PASS`:

1. Record only non-secret acceptance evidence needed for independent review (for example the Sandbox order/capture identifiers and script verdict). Never record credentials or signing-key material.
2. Re-run / confirm CI on the final PR head if the branch changed.
3. Update this handoff with the live acceptance evidence.
4. Perform independent review of PR #16.
5. Mark the PR ready only if the review has no unresolved blocking findings.
6. Merge M6 only after explicit merge authorization.
7. Start M7 only after M6 is merged and the accepted M6 evidence is preserved.

## Non-regression boundary

M6 does not redesign or replace the accepted M1–M5 Trust Kernel, AgentPassport, Mandate, deterministic authorization, durable reservations/accounting, Ed25519 one-time grants, payment attempts, PayPal UNKNOWN/reconciliation/provider-conformance logic, trusted quote/sealed manifest, payer-return revalidation, EvidenceLedger, OperationTraceService, Authority projections, or owner/session controls.

Browser return and hosted UI state remain notifications/projections, never financial truth. External systems remain inputs/evidence and never silently become financial authority.
