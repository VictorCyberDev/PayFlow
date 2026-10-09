# PayFlow Threat Model — Milestone 2B

Milestone 1's fail-closed authorization, mandate fingerprint, capability intersection and explicit `ALLOW | DENY | ESCALATE` semantics remain required. Milestone 2B moves security-critical authorization authority onto PostgreSQL-backed orchestration.

## Concurrent overspend

Control: every authority-acquiring transaction locks the mandate row before deriving committed plus active-reserved authority. Reservation creation occurs before that transaction commits. A real PostgreSQL concurrent test races two 8000-minor-unit proposals against a 10000-minor-unit mandate and requires only one to acquire executable authority.

Residual risk: the guarantee is per PostgreSQL database and per mandate serialization point. Cross-database replication, sharding and distributed transaction semantics are not implemented.

## Replay and duplicate submissions

Control: proposal primary keys, mandate-scoped nonce uniqueness, one Decision Receipt per proposal, one reservation per proposal and transactional replay-key claims prevent concurrent duplicates from both acquiring authority. Repeated evaluation of an already evaluated proposal fails closed.

Residual risk: API-level idempotent response caching is not implemented; callers receive rejection rather than replaying a previous success result.

## Corrupt persisted security state

Control: mandates, passports, proposals, Decision Receipts, approvals and reservations are runtime-validated before security-sensitive use. Redundant proposal money/currency and mandate fingerprint checks detect selected row/document inconsistencies. Malformed critical state throws and fails closed.

Residual risk: a privileged database writer can consistently alter multiple related rows. Database access control, external attestations and immutable storage are outside 2B.

## Approval substitution

Control: approval remains separate from the ESCALATE receipt and is bound to the mandate principal, exact receipt and exact proposal. Capacity and policy are revalidated while the mandate is locked before an approved escalation receives a reservation.

Residual risk: PayFlow does not yet authenticate a human principal session. Principal-ID binding is not a claim of verified real-world identity.

## Reservation leakage after crashes

Control: reservations have durable expirations. A deterministic idempotent recovery operation expires stale `PENDING`/`AUTHORIZED` rows; terminal/committed rows are not released. Expiry and evidence are transactional.

Residual risk: no background worker or production scheduler is implemented, so an operator/runtime must invoke recovery.

## Evidence inconsistency

Control: authorization evidence is written inside the same database transaction as receipts, replay claims and reservations. Rollback removes those events. A transaction-scoped advisory lock serializes hash-chain appends.

Residual risk: the chain is tamper-evident rather than immutable. A privileged database writer can rewrite, re-hash or delete the complete chain.

## Execution TOCTOU

Control in 2B: none beyond durable reservation eligibility and proposal/receipt persistence.

Residual risk: a later payment boundary still needs a cryptographically bound execution grant and immediate revalidation so a stale or substituted authorization artifact cannot authorize a provider side effect. This is explicitly deferred; 2B does not implement or claim cryptographic execution grants or PayPal execution.

## Explicit non-claims

Milestone 2B does not implement PayPal, cryptographic execution grants, production principal authentication, immutable audit storage, distributed/multi-region transaction guarantees, LLM functionality, product discovery or UI.
