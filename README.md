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
