# PayFlow

**PayFlow is a programmable trust layer for agentic commerce.**

AI agents may propose commerce actions. PayFlow's deterministic Trust Kernel decides whether those actions are authorized. The LLM/agent remains outside the trusted financial authorization boundary.

## Milestone 2A — durable foundation

Milestone 2A adds a PostgreSQL persistence boundary without coupling the deterministic kernel to PostgreSQL. `PostgresTrustRepository` persists principals, passports, fingerprinted mandates, proposals, Decision Receipts, principal-bound approvals, replay keys, reservation state, payment-attempt/provider identifiers and tamper-evident evidence. Money remains integer minor units.

The SQL migration uses primary/unique keys, foreign keys, checks for non-negative monetary state, ISO-like currency shape, timestamp ordering and explicit database enums for reservation/payment state. Proposal IDs and mandate-scoped proposal nonces are unique; replay keys have an atomic `(scope, replay_key)` primary key.

Milestone 1 authorization semantics remain unchanged: fail closed; explicit capability intersection; `ALLOW | DENY | ESCALATE`; mandate fingerprints; separate principal-bound approval; no payment side effect before authorization.

### Reservation foundation

`PENDING → AUTHORIZED → EXECUTING → COMMITTED` is the success path. `PENDING`/`AUTHORIZED` may become `RELEASED`, `EXPIRED` or `FAILED`; `EXECUTING` may become `COMMITTED`, `RELEASED` or `FAILED`. Terminal states cannot transition. Transitions lock the reservation row and fail closed when invalid.

This milestone does **not** yet claim concurrency-safe budget authorization. Atomic cumulative-budget reservation and authorization transactions are Milestone 2B work.

### Durable evidence

PostgreSQL evidence records retain a SHA-256 previous-hash chain. Appends serialize on a PostgreSQL advisory transaction lock so concurrent writers do not fork the application-level chain. Verification detects modified/reordered entries. This is tamper-evident, not immutable: a privileged database writer can rewrite the database/chain or delete all evidence.

## Development

Set `TEST_DATABASE_URL` to a disposable PostgreSQL database for integration tests. CI provisions PostgreSQL automatically.

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

## Deferred beyond 2A

Milestone 2B must atomically reserve cumulative authority during authorization and remove remaining process-local security state from the execution orchestration. Cryptographic execution grants, immediate pre-payment revalidation and PayPal Sandbox are later Milestone 2 increments. LLM mandate parsing, product discovery and final UI remain out of scope.
