# PayFlow

**PayFlow is a programmable trust layer for agentic commerce.** AI agents may propose commerce actions; the deterministic Trust Kernel remains the financial authority. PayPal is only an execution provider.

## Milestone 2D — PayPal Sandbox execution

The trusted path is:

`Trust Kernel -> durable reservation -> Ed25519 execution grant -> immediate durable revalidation -> one-time authority claim -> durable Payment Attempt -> PayPal Orders v2 -> reconciliation -> COMMITTED`.

2D uses PayPal Sandbox only (`https://api-m.sandbox.paypal.com`), server-side OAuth, Orders v2 and `intent=CAPTURE`. Non-sandbox configuration is rejected. Credentials and OAuth tokens are never committed or written to evidence.

A Payment Attempt is durable and unique per execution grant/reservation. It stores separate stable create-order and capture idempotency IDs before provider side effects, plus the PayPal order/capture IDs, local/provider statuses, authoritative integer-minor amount/currency, failure classification and reconciliation timestamps. Order creation is not payment success.

### Ambiguous outcomes

PostgreSQL and PayPal cannot participate in one atomic transaction. A timeout/reset/ambiguous 5xx after a capture request therefore enters `CAPTURE_UNKNOWN`, not `FAILED`. The grant remains `CLAIMED` and the reservation remains `EXECUTING`; authority is quarantined and is not returned to the mandate budget.

Reconciliation uses Show Order. If PayPal proves the exact expected capture completed, PayFlow validates amount/currency and transactionally records `CAPTURED`, `CONSUMED` and `COMMITTED` without sending another capture. If provider state remains ambiguous, PayFlow remains fail-closed.

Payer approval is represented explicitly. If PayPal requires payer action, the order and approval URL are persisted and no capture is claimed as successful. The final redirect UI is intentionally out of scope.

Money conversion uses integer minor units and explicit currency precision (`8900 USD -> 89.00`); binary floating point is not used.

See `docs/ADR-003-paypal-execution-reconciliation.md` for the distributed-systems decision.

## Development

Set `TEST_DATABASE_URL` to a disposable PostgreSQL database. Normal CI uses deterministic fake provider/HTTP boundaries and does not need PayPal credentials.

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:coverage
npm audit --omit=dev --audit-level=high
npm run build
```

Optional real Sandbox smoke test:

```bash
PAYPAL_ENVIRONMENT=sandbox PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm run test:paypal:sandbox
```

The smoke path never stores or automates a Sandbox payer password. Manual payer approval may be required before capture.

## Scope boundary

Milestones 1, 2A, 2B and 2C security invariants remain in force. 2D does not implement live PayPal, LLM mandate parsing, product discovery, final UI, autonomous shopping, subscriptions, refunds, disputes, multi-provider payments or Milestone 3. Webhook mutation is intentionally deferred rather than accepting an insecure unsigned placeholder; explicit provider reconciliation is authoritative in 2D.

## Milestone 2E security boundary

Normal execution and reconciliation share atomic Payment Attempt/grant/reservation
finalization. Unknown outcomes retain authority; recovery dispatch rechecks current
revocation/expiration and reuses persisted provider keys. Apply the forward
`db/migrations/004_milestone_2e_security_boundary.sql` after migrations 001–003.
See [ADR 004](docs/ADR-004-integrated-security-boundary.md) for crash windows,
revocation handoff, evidence semantics, recovery APIs and residual dependencies.

## Milestone 3A — intent contract and draft compiler

`src/intent.ts` accepts an untrusted structured interpretation and independently
supplied source/review bounds. It returns `VALID_DRAFT`, `NEEDS_CLARIFICATION` or
`REJECTED`. A draft is never a trusted mandate; explicit human confirmation is
still required. No LLM provider, activation/persistence operation or payment route
is added. Quantity and merchant restrictions remain visible activation blockers
where M2 lacks enforcement. See [ADR-005](docs/ADR-005-ai-intent-trust-boundary.md)
for provenance, widening protections and semantic-verification limitations.

## Milestone 3B — Groq interpretation, never authorization

`src/intent-model.ts` connects natural-language source to Groq strict JSON Schema
output, local 3A validation/compiler, conservative semantic checks and deterministic
clarification. The model receives only the current source/reference; independent
review bounds stay local. The output remains an untrusted draft for human review,
with quantity/merchant activation requirements intact. The model has no
confirmation/activation or financial route. The AI interprets your intention. It does not grant itself
permission.

Configure server-side `INTENT_MODEL_PROVIDER=groq`,
`INTENT_MODEL_NAME=openai/gpt-oss-20b` and an external `GROQ_API_KEY`.
Standard tests/CI use fake providers or mocked HTTP, require no key and make no
Groq requests. Optional live interpretation smoke (no payment):

```bash
RUN_GROQ_SMOKE_TEST=true npm run test:groq:smoke
```

See [ADR-006](docs/ADR-006-model-intent-integration.md) for the checked free-tier
model, resource limits, safe failures and semantic limitations. Live smoke has not
been verified without a runtime credential. Milestone 3C adds the separate authenticated activation boundary described below.

### Milestone 3C domain boundary

“The AI interprets your intention. It does not grant itself permission.”

The server can now persist an intent review, present its exact draft, authenticate an explicit human confirmation through a host-supplied verifier, and atomically activate a trusted mandate. Reviews expire within five minutes and are durably single-use. New activated mandates enforce quantity reservations and exact logical merchant allowlists. No web authentication server or final UI is included; a production host must implement the authentication guarantees in [ADR-007](docs/ADR-007-authenticated-intent-activation.md). Normal tests require no Groq or PayPal credentials. Migration 005 preserves legacy mandate semantics.

### Milestone 3D adversarial trust-boundary review

The full interpretation → authenticated activation → quantity/merchant authorization → signed grant → PayPal/evidence path is exercised with deterministic adversarial inputs and real PostgreSQL concurrency. A reproduced rejection-evidence privacy defect is fixed without changing financial semantics. See [ADR-008](docs/ADR-008-adversarial-trust-boundary-hardening.md) for the attack matrix, executable controls and residual limits.

### Live-provider smoke tests

Provider credentials alone never enable live tests. Normal tests and CI use fake
providers/mocked transport and consume no external-provider quota. Only the exact
lowercase value `true` enables a live smoke switch; absent, `false`, `1`, `yes`
and other values leave it disabled. Explicit opt-in without required configuration
fails before a provider is constructed.

- Groq: `RUN_GROQ_SMOKE_TEST=true npm run test:groq:smoke`, with external `GROQ_API_KEY`.
- PayPal Sandbox: `RUN_PAYPAL_SANDBOX_SMOKE_TEST=true npm run test:paypal:sandbox`,
  with external Sandbox client ID/secret and `PAYPAL_ENVIRONMENT=sandbox`.
  This optional test obtains OAuth and creates an order; it must never run merely
  because credentials are configured.
- Channel3: `RUN_CHANNEL3_SMOKE_TEST=false` is reserved; no Channel3 live test or
  provider is implemented yet.

All switches default OFF. Never commit credentials or persist PayPal OAuth tokens.
