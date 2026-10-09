# PayFlow

**PayFlow is a programmable trust layer for agentic commerce.**

AI agents can reason about what to buy. PayFlow decides what an agent is allowed to do with a principal's money.

> Agent → Transaction Intent → Deterministic Authorization → Payment Execution → Verification → Evidence

The language model/agent is deliberately outside the trusted authorization boundary. It can propose a transaction, but it cannot produce a trusted authorization decision.

## Milestone 1 — Trust Kernel

This milestone implements the foundational authorization architecture:

- principal-authored mandates
- agent passports and explicit capabilities
- canonical mandate serialization and SHA-256 `mandateFingerprint`
- typed transaction proposals
- deterministic `ALLOW | DENY | ESCALATE` policy evaluation
- structured Decision Receipts
- nonce and proposal-ID replay protection
- tamper-evident hash-chained evidence ledger
- authorization-gated payment execution
- mock payment provider
- PayPal provider boundary (no network transactions)
- explicit principal-bound approval for escalated proposals
- adversarial tests

## Security model

Authorization is fail-closed. The kernel recomputes policy from validated inputs and does not trust an agent-supplied authorization result. A mandate fingerprint binds security-critical mandate fields. The normal in-process service path records issued Decision Receipts and refuses an unissued receipt or a substituted proposal before reaching the payment provider. `DENY` cannot execute; `ESCALATE` requires a separate approval bound to the mandate principal.

These are Milestone 1 process-local controls, not distributed cryptographic credentials. Human/session authentication, durable authorization state, concurrency-safe reservations and short-lived signed execution grants remain future work.

The evidence ledger is **tamper-evident**, not immutable storage and not a blockchain. `mandateFingerprint` is a hash fingerprint, not a digital signature.

See `docs/THREAT_MODEL.md` and `docs/ARCHITECTURE.md`.

## PayPal

PayPal is the primary intended payment rail for the hackathon. Milestone 1 defines a server-side provider boundary only. No credentials are required and no real or sandbox financial transaction is made.

Expected future server-only environment variables are documented in `.env.example`.

## Run

```bash
npm ci
npm run dev
```

The developer demo prints the keyboard mandate scenarios and their Decision Receipts/evidence verification.

## Quality gates

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm audit --omit=dev --audit-level=high
npm run build
```

## Current limitations

Milestone 1 uses in-memory replay state, cumulative-spend state, issued-receipt state, approvals and evidence storage. The execution boundary is process-local rather than a cross-service cryptographic grant. The PayPal adapter intentionally does not contact PayPal. Merchant risk is a trusted server-side context input in this milestone; a production risk oracle is not implemented. Human approval is checked against the mandate principal ID, but production-grade authentication of the approving human/session is not implemented.

## Roadmap

Milestone 2 should add durable transactional persistence, concurrency-safe budget/replay reservations, short-lived cryptographically verifiable authorization grants, a real PayPal sandbox adapter behind the existing boundary, stronger principal/agent authentication and merchant/risk attestation, and service/API boundaries. Product discovery, autonomous browsing, LLM mandate parsing, polished UI, subscriptions and disputes remain deferred until the trust boundary is hardened.
