# PayFlow

**PayFlow is a programmable trust layer for agentic commerce.**

AI agents may propose commerce actions. PayFlow's deterministic Trust Kernel decides whether those actions are authorized. The LLM/agent remains outside the trusted financial authorization boundary.

## Milestone 2B — atomic durable authorization

Milestone 2B moves security-critical authorization orchestration onto the PostgreSQL foundation. `DurableAuthorizationService` loads runtime-validated security objects, locks the mandate's authoritative row, derives current financial authority, reruns the deterministic Trust Kernel and commits the Decision Receipt, replay claims, reservation and security evidence atomically where applicable.

The Trust Kernel itself remains independent of PostgreSQL and independently unit-testable.

### Concurrency-safe cumulative authority

For each mandate, PostgreSQL `SELECT ... FOR UPDATE` on the mandate row is the serialization point for authority acquisition. PayFlow uses PostgreSQL `READ COMMITTED` plus that explicit lock; it does not claim global serializable isolation.

Authority is derived from durable reservation state rather than trusting `spent_minor`:

```text
consumed = committed + active_reserved
available = cumulative_limit - consumed

committed      = COMMITTED reservations
active_reserved = AUTHORIZED + EXECUTING reservations
```

`RELEASED`, `EXPIRED` and `FAILED` reservations restore capacity. A real integration test concurrently submits 8000 + 8000 minor units against a 10000-unit mandate and asserts that only one can acquire executable authority.

### Escalation and replay

An `ESCALATE` Decision Receipt remains immutable. A separate durable approval must bind to the correct principal, proposal and receipt. Before approval creates authority, policy and cumulative capacity are revalidated under the mandate lock.

Proposal IDs, mandate-scoped proposal nonces and execution-relevant replay keys are durable. Duplicate/concurrent attempts cannot both acquire reservations.

### Crash recovery and evidence

Reservations carry durable expiry. An idempotent recovery operation expires stale `PENDING`/`AUTHORIZED` reservations without releasing committed spend. A production scheduler/background worker is not included yet.

Authorization evidence is persisted in the same PostgreSQL transaction as the state it describes, so rolled-back authorization cannot leave a durable success event. Evidence retains the SHA-256 previous-hash chain. It is tamper-evident, not immutable: a privileged database writer can rewrite/re-hash/delete the chain.

## Development

Set `TEST_DATABASE_URL` to a disposable PostgreSQL database for integration tests. CI provisions PostgreSQL 17 automatically.

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

## Deferred beyond 2B

Milestone 2B stops at durable authorization/reservation eligibility. Cryptographic execution grants, immediate pre-payment revalidation and PayPal are intentionally deferred. The remaining execution TOCTOU boundary must be closed before a later payment provider integration is treated as production-safe. LLM mandate parsing, product discovery and final UI remain out of scope.
