# PayFlow Threat Model — Milestone 2A

Milestone 1's fail-closed authorization, mandate fingerprint, capability intersection, principal-bound escalation and payment gating remain required.

| Threat | 2A control | Residual risk |
|---|---|---|
| Process restart loses replay state | Durable unique proposal/nonces and replay-key table | Existing Milestone 1 orchestration still requires full repository integration in 2B |
| Duplicate proposal | Primary key on proposal ID | Callers must map uniqueness failure to fail-closed behavior |
| Duplicate nonce | Unique mandate+nonce and replay-key claims | Scope design must remain security-specific |
| Persisted mandate mutation | Stored canonical fingerprint is recomputed on load | Privileged DB writer can alter both document and fingerprint |
| Malformed persisted critical state | Zod parsing and redundant money/currency checks fail closed | More row/document redundancy can be added |
| Wrong-principal approval | Repository resolves receipt→mandate principal before insert | Human/session identity authentication remains unimplemented |
| Reservation state corruption | Explicit enum + locked transition validation | Atomic budget reservation is deferred to 2B |
| Evidence modification/reordering | Durable SHA-256 hash chain verification | Privileged DB writer can rewrite/re-hash/delete entire chain |
| Evidence concurrent fork | Transaction advisory lock serializes append | Multi-database/multi-region anchoring not implemented |
| Secret leakage | DB URL remains environment configuration; evidence API accepts only event payloads | Production secret manager/rotation deferred |
| TOCTOU / concurrent overspend | Not claimed in 2A | Mandatory 2B atomic authorization + cumulative reservation |

## Explicit non-claims

2A does not implement PayPal, cryptographic execution grants, concurrency-safe cumulative authorization, production principal authentication, immutable audit storage, or LLM functionality. PostgreSQL durability reduces restart-loss risks but does not by itself make authorization transactionally safe across competing proposals.
