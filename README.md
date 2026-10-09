# PayFlow

**PayFlow is a programmable trust layer for agentic commerce.**

AI agents may propose commerce actions. PayFlow's deterministic Trust Kernel decides whether those actions are authorized. The LLM/agent remains outside the trusted financial authorization boundary.

## Milestone 2C — cryptographic execution grants

PayFlow issues short-lived Ed25519-signed execution grants bound to an exact authorized proposal and revalidates durable authority before execution. A grant is not a Decision Receipt, approval, reservation or payment attempt: it is a one-use cryptographic authorization to attempt one exact execution.

The signed `payflow.execution-grant.v1` claims bind the principal, agent, mandate/fingerprint, proposal/SHA-256 canonical digest, Decision Receipt, reservation, capability, integer-minor amount, currency, merchant, authorization-engine version, audience, `kid`, issue time and expiry. The default TTL is 120 seconds and configuration is capped at 300 seconds.

Ed25519 uses Node's standard `crypto` implementation. The private key belongs only to the issuer. Verification uses a `kid`-selected public-key ring so rotation can retain old public keys while live grants expire. No private signing key is stored in PostgreSQL or committed to this repository.

### Execution choke point

`ExecutionBoundary` is the future provider choke point. It verifies grant format/version, audience, expiry, `kid` and Ed25519 signature before entering a PostgreSQL transaction. It then locks the durable grant, mandate and reservation; reloads proposal, agent, receipt and approval where applicable; checks exact proposal digest/amount/currency/merchant/capability bindings and current mandate/agent/reservation validity; and atomically changes `ISSUED -> CLAIMED` plus `AUTHORIZED -> EXECUTING`.

Only after that transaction commits is the fake execution sink invoked. Concurrent use of the same grant cannot claim authority twice. Success finalizes `CONSUMED` + `COMMITTED`; deterministic fake-provider failure finalizes `FAILED` + `FAILED`. A duplicate invocation is rejected rather than replaying a side effect.

An `ESCALATE` receipt cannot receive executable authority until the existing 2B principal approval flow creates a valid reservation. The receipt itself remains `ESCALATE`.

### Remaining external-provider boundary

2C deliberately does **not** integrate PayPal. A real network side effect cannot be atomic with PostgreSQL. Milestone 2D must persist provider payment attempts, establish provider idempotency, and reconcile ambiguous outcomes such as provider success followed by a lost response. PayFlow does not claim atomic external payment execution.

See `docs/ADR-002-execution-grants.md` for canonicalization, key rotation, one-use semantics and TOCTOU decisions.

## Milestones 2A/2B foundation

PostgreSQL remains authoritative for security state. Per-mandate `SELECT ... FOR UPDATE` serializes cumulative authority acquisition. Durable reservations account for committed and active reserved authority; replay keys, principal-bound approvals and tamper-evident evidence survive process recreation. The deterministic Trust Kernel remains independent of PostgreSQL.

## Development

Set `TEST_DATABASE_URL` to a disposable PostgreSQL database for integration tests. CI provisions PostgreSQL 17 automatically. Test Ed25519 keys are generated at runtime and CI requires no signing secrets.

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

## Deferred beyond 2C

PayPal OAuth, Orders/capture, webhooks and real credentials are Milestone 2D. LLM mandate parsing, product discovery, browser automation, final UI, subscriptions, refunds, disputes and multi-provider execution remain out of scope.
