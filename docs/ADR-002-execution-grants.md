# ADR-002: Cryptographic execution grants

Status: accepted for Milestone 2C.

## Decision

PayFlow uses a versioned `payflow.execution-grant.v1` envelope signed with Ed25519 through Node.js `crypto`. The private key is held only by the trusted issuer; execution verifies with a public-key ring selected by `kid`. No signing key is stored in PostgreSQL. Test keys are generated at test runtime.

The signed claims bind principal, agent, mandate and mandate fingerprint, proposal and deterministic SHA-256 proposal digest, Decision Receipt, reservation, capability, integer-minor amount, currency, merchant identity, authorization-engine version, audience, issue time and expiry. The default lifetime is 120 seconds and configuration is capped at 300 seconds. Clocks are assumed to be UTC-synchronized; 2C intentionally implements no skew allowance.

`proposalDigest` hashes deterministic canonical serialization rather than ordinary object insertion order. It includes proposal identity, agent/mandate binding, mandate fingerprint, amount/currency, merchant, category, condition, capability, proposal time, nonce and metadata. SHA-256 here is a digest, not a signature.

## One-use semantics

Grant identity and lifecycle are durable: `ISSUED -> CLAIMED -> CONSUMED` on success, or `ISSUED -> CLAIMED -> FAILED` when the fake execution sink fails. A duplicate invocation is rejected rather than returning a cached result. PostgreSQL row locking makes concurrent replay contend for the same grant; only an `ISSUED` row may claim execution authority.

## Pre-execution revalidation

Signature verification is necessary but insufficient. Inside one PostgreSQL transaction PayFlow locks the grant, mandate and reservation, reloads proposal/agent/receipt/approval, checks exact bindings and current validity, then atomically changes the reservation from `AUTHORIZED` to `EXECUTING` and the grant from `ISSUED` to `CLAIMED`. Only after that transaction commits may the execution sink be called.

For an `ESCALATE` receipt, an `APPROVED` durable approval bound to the same principal/proposal/receipt is mandatory. The original receipt remains `ESCALATE`.

## Key rotation

`kid` is signed and persisted. Verification resolves it through a public-key ring, allowing old public keys to remain available while grants issued under a new signing key are introduced. Removing an old public key immediately invalidates still-live grants using it. Production private-key loading/rotation orchestration is intentionally outside 2C. No HSM/KMS protection is claimed.

## External-provider TOCTOU

The database transaction is deliberately committed before the fake provider call. A real provider cannot participate atomically in PostgreSQL. Milestone 2D must persist payment attempts before network I/O, use provider idempotency keys, and reconcile ambiguous outcomes (for example, provider success followed by a lost response). 2C does not claim atomic external payment execution.
