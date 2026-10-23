# M6 — Delegated / Human-Not-Present Commerce

Status: see `docs/M6-ACCEPTANCE-HANDOFF.md` for the final state, SHAs and evidence.

M6 proves that a human can create an authenticated, bounded **Authority** and later let an Agent complete an eligible purchase **without asking again** — and only when that Authority explicitly permits that exact transaction. It is explicit delegation, not autonomy by default.

## Design rule (what M6 is not)

M6 adds **no second policy engine**. "Human-not-present" is not a new permission model. It is the existing kernel decision:

- `ALLOW` — the request is inside every Authority bound **and** at or below the Mandate's autonomous purchase threshold. No human step.
- `ESCALATE` — above the autonomous threshold. Delegation does not apply: no reservation, no grant, no capture. (`NEEDS_HUMAN`)
- `DENY` — outside the Authority. Zero provider effect.

Everything else is the accepted M1–M5 pipeline, unchanged:

```
selection -> trusted quote -> sealed manifest -> proposal
  -> authorizeProposal (kernel + durable reservation under the Mandate row lock)
  -> one-time Ed25519 execution grant
  -> ExecutionBoundary (immediate durable revalidation: Mandate, Agent, Principal, quote, commerce binding)
  -> PayPal rail (order -> capture, UNKNOWN quarantine, reconciliation)
  -> evidence ledger + OperationTrace
```

No migration was added (`011` is not needed): the existing schema already carries every M6 fact.

## What M6 added

| File | Purpose |
| --- | --- |
| `src/delegated-commerce.ts` | `DelegatedCommerceService` — composes the existing services; issues a grant **only** after kernel `ALLOW`; never asks a human, never retries a provider call; returns a bounded outcome (`COMPLETED`, `DENIED`, `NEEDS_HUMAN`, `REFUSED`, `UNRESOLVED`) with `providerEffect`. |
| `src/paypal.ts` (additive) | Optional pre-approved instrument (`payment_source.paypal.vault_id`) so an order is born approved and needs no payer action at execution time. Sandbox-only (`paypalDelegatedProviderFromEnv`). |
| `src/activity-projection.ts`, `src/activity-postgres.ts` (additive) | `delegated` flag (true only for a completed purchase with no human resume evidence) and proven zero-effect **quote refusals** (e.g. $184 trusted vs $100 maximum) in Activity, keyed by selection id. |
| `src/delegated-demo.ts`, `src/console-demo-agent.ts` | Non-production demonstration Shopping Agent and its owner-bound HTTP surface (`/api/demo-agent/*`). The browser names only a scenario and an Authority; the server decides everything else. |
| `src/console-hosted.ts` | Optional hosted wiring (`PAYFLOW_M6_DEMO_AGENT=true`); fails closed without a persistent Ed25519 signing key. |
| `hosting/operator/m6-sandbox-acceptance.ts` | Operator-only live Sandbox acceptance (fresh $84 delegated capture). |
| `apps/console` | Authority detail "Demo · Try your Agent", `Done without asking you` copy, `$0 moved` for refusals, system-driven reconciliation. Uses BRAND-001 unchanged. |

Small supporting changes: `merchantDisplay()` so Authorities say "PayFlow Demo Merchant — Sandbox"; the recorded demo intent now names the controlled demo merchant `payflow.demo.merchant` so a UI-created Authority works with the demo catalog.

## Scenarios and customer outcomes

| Scenario | Result | Customer sees | Provider money-moving calls |
| --- | --- | --- | --- |
| $84 new keyboard, approved merchant, active Authority | `COMPLETED` | **$84 paid once** · "Your Agent did this without asking you, within your Authority." | 1 order, 1 capture |
| $184 trusted price vs $100 maximum (price drift) | `REFUSED` (before any proposal) | **$0 moved** · "The price exceeded the maximum amount permitted by this authority." | 0 |
| Above the autonomous threshold | `NEEDS_HUMAN` | needs approval | 0 |
| Used / refurbished, wrong merchant, wrong product, quantity 2, wrong currency, capability outside Authority, stale fingerprint | kernel `DENY` | **$0 moved** + reason | 0 |
| Revoked / expired Authority, suspended Agent | `REFUSED` / `DENIED` | **$0 moved** | 0 |
| Revoked / expired / suspended **after** the grant, before dispatch | `REFUSED` by revalidation | **$0 moved** | 0 |
| Lost capture response | `UNRESOLVED` | **Checking what happened — don't retry yet** | 1 (never retried) |
| Later reconciliation | `COMPLETED` | **$84 paid once** | still 1 |

> Revocation prevents new effects. It does not falsify history: a provider effect that already happened is reconciled truthfully.

## Test matrix

| Concern | Where |
| --- | --- |
| Valid delegated purchase; durable reservation `COMMITTED`; grant `CONSUMED`; attempt `CAPTURED`; Trace `VERIFIED`; remaining $16 | `tests/m6-delegated.integration.test.ts` |
| Denied paths each assert zero reservation/grant/attempt and zero create/capture calls | same |
| Race: revoke / suspend / expire between grant and dispatch (mutation-checked: without the hook the tests fail; removing `assertMandateActive` makes the revoke test fail) | same |
| Replay: grant replay, expired/tampered/re-scoped grants, second identical request, terminal retry, duplicate reconcile | same |
| Concurrency: 4 competing attempts on a one-keyboard/$100 Authority → exactly one capture; budget-limited two-purchase race | same |
| Provider ambiguity: lost capture / lost create → quarantine → reconcile → one capture; not-pre-approved instrument never completes and never prompts a human | same |
| Activity: delegated flag, human-resumed purchase is **not** delegated, $0-moved refusals, ordering, owner isolation | `tests/m6-activity.integration.test.ts` |
| Demo agent HTTP surface: owner binding, strict bodies, no secrets in responses, reconcile, no rail connected | `tests/m6-demo-agent.integration.test.ts` |
| Hosted composition: route absent without opt-in, fail-closed key handling, cross-instance Trace verification | `tests/hosting-m6.integration.test.ts` |
| Provider request shape and Sandbox-only guards | `tests/paypal-delegated.test.ts` |
| Browser: hero journey, revoked Authority, ambiguous outcome → system reconciliation, mobile 375 px | `apps/console/e2e/journey.e2e.mjs` (M6 tests) |

## Live PayPal Sandbox acceptance

The deterministic provider proves PayFlow's side exhaustively. The **live** proof needs inputs only the account owner can supply and which are never placed in chat or in the repository:

1. A PayPal **Sandbox** REST app: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT=sandbox`.
2. The real 13-character Sandbox merchant id: `PAYPAL_EXPECTED_MERCHANT_ID` (the order payee PayFlow verifies).
3. A **pre-approved Sandbox buyer instrument** (a vaulted PayPal wallet id the buyer approved once): `PAYPAL_DELEGATED_VAULT_ID`. This is the one-time consent that makes a later order need no payer action; it is not PayFlow authority.
4. A persistent grant signing key: `PAYFLOW_M6_SIGNING_KEY` (Ed25519 PKCS#8 PEM), so history stays verifiable.
5. A fresh isolated Postgres (the script refuses a database with payment history).

Then, from a machine with TCP access to that database:

```
RUN_M6_SANDBOX_ACCEPTANCE=true DATABASE_URL=… PAYPAL_ENVIRONMENT=sandbox \
PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… PAYPAL_DELEGATED_VAULT_ID=… \
PAYPAL_EXPECTED_MERCHANT_ID=… PAYFLOW_M6_SIGNING_KEY="$(cat key.pem)" \
npm run acceptance:m6:sandbox
```

It provisions one owner/agent/Authority, runs one fresh $84 USD delegated purchase with no human step, then prints the order id, capture id, amount, provider-side capture count, the number of `captureOrder` calls it observed itself, a second-attempt result and the Trace verdict, and ends `M6 SANDBOX ACCEPTANCE: PASS|FAIL`.

The vaulted-instrument request shape (`payment_source.paypal.vault_id`) follows PayPal's Orders v2 vaulting contract but has **not** been exercised against the live Sandbox from this repository's CI; the first live run is the verification of that single assumption.

## Hosted demo

`PAYFLOW_M6_DEMO_AGENT=true` + `PAYFLOW_M6_SIGNING_KEY` enable the demo Shopping Agent on a hosted deployment. Without PayPal Sandbox settings it truthfully reports `payment: NOT_CONNECTED`: the blocked scenario still runs (and writes real, verifiable durable records with zero provider effect); the purchase is refused before anything is written. It never shows recorded evidence as a live transaction.

## Known limitations

- The Shopping Agent is a fixed server-side simulation; real external agents are M7.
- The recorded interpretation uses a structured example sentence, not free natural language.
- The system reconciles uncertain payments when a demo client is open; a production deployment needs a worker.
- The live Sandbox capture is operator-run (see above).
