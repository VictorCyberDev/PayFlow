# PayFlow

**PayFlow is a programmable trust layer for agentic commerce.**

AI agents can reason about what to buy. PayFlow decides what an agent is allowed to do with a principal's money.

> Agent → Transaction Intent → Deterministic Authorization → Payment Execution → Verification → Evidence

The language model/agent is deliberately outside the trusted authorization boundary. Payment execution is reachable only through deterministic policy evaluation and an authorization artifact.

## Milestone 1 — Trust Kernel

This milestone implements the foundational authorization architecture:

- principal-authored mandates
- agent passports and explicit capabilities
- canonical mandate serialization and SHA-256 `mandateFingerprint`
- typed transaction proposals
- deterministic `ALLOW | DENY | ESCALATE` policy evaluation
- structured Decision Receipts
- replay protection
- tamper-evident hash-chained evidence ledger
- authorization-gated payment execution
- mock payment provider
- PayPal provider boundary (no live transactions)
- explicit human approval for escalated proposals
- adversarial tests

## Security model

Authorization is fail-closed. A client or agent cannot supply an authorization result and have it trusted. The kernel recomputes policy from validated inputs. A mandate fingerprint binds the security-critical mandate fields. Payment execution requires an authorization artifact produced by the kernel, and escalated proposals require a separate human-approval artifact.

The evidence ledger is **tamper-evident**, not immutable storage and not a blockchain.

See `docs/THREAT_MODEL.md` and `docs/ARCHITECTURE.md`.

## PayPal

PayPal is the primary intended payment rail for the hackathon. Milestone 1 defines a server-side provider boundary only. No credentials are required and no real or sandbox financial transaction is made.

Expected future server-only environment variables are documented in `.env.example`.

## Run

```bash
npm install
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
npm run build
```

## Current limitations

Milestone 1 uses in-memory replay state, cumulative-spend state, approvals, and evidence storage. The authorization artifact is an opaque object that can only be minted by the in-process kernel; durable cross-service cryptographic authorization tokens are future work. The PayPal adapter intentionally does not contact PayPal. Merchant risk is a trusted server-side context input in this milestone; a production risk oracle is not implemented.

## Roadmap

Milestone 2 should add durable transactional persistence, concurrency-safe budget/replay reservations, short-lived cryptographically verifiable authorization grants, a real PayPal sandbox adapter behind the existing boundary, stronger merchant/risk attestation, and service/API boundaries. Product discovery, autonomous browsing, LLM mandate parsing, polished UI, subscriptions and disputes remain deferred until the trust boundary is hardened.
