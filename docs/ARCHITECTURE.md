# PayFlow Architecture — Milestone 2C

## Trusted path

```text
Untrusted Agent -> TransactionProposal -> DurableAuthorizationService
 -> Trust Kernel -> DecisionReceipt -> Authority Reservation
 -> ExecutionGrantIssuer -> Ed25519 signed grant
 -> ExecutionBoundary -> signature + exact binding + durable revalidation
 -> AUTHORIZED -> EXECUTING -> fake execution sink
```

The Trust Kernel remains deterministic and PostgreSQL-independent. Decision Receipt, Approval, Reservation, Execution Grant and future Payment Attempt are deliberately separate security concepts.

## Durable authorization foundation (2A/2B)

PostgreSQL is authoritative for mandates, passports, proposals, receipts, approvals, replay keys, reservations and evidence. Per-mandate `SELECT ... FOR UPDATE` is the serialization point for authority acquisition under `READ COMMITTED`. Capacity is derived as committed plus active (`AUTHORIZED`/`EXECUTING`) reservations. `RELEASED`, `EXPIRED` and `FAILED` restore capacity. An `ESCALATE` receipt remains immutable; principal approval is a separate durable object that can create a reservation after revalidation.

## Execution grants (2C)

`ExecutionGrantIssuer` accepts only a reservation identifier, then derives every security-critical claim from authoritative persisted state while holding the reservation/mandate locks. A `DENY`, missing reservation or unapproved `ESCALATE` cannot produce a grant.

The versioned grant uses Ed25519 via Node `crypto`. Claims include JTI, `kid`, principal, agent, mandate/fingerprint, proposal/SHA-256 canonical digest, receipt, reservation, capability, amount in integer minor units, currency, merchant, issue/expiry times, authorization-engine version and audience. Default TTL is 120 seconds; maximum configured TTL is 300 seconds.

`proposalDigest` hashes deterministic canonical serialization of all execution-sensitive proposal fields, including metadata. It is a digest, not a signature.

## Pre-execution transaction

`ExecutionBoundary` first verifies format/version, audience, expiry, `kid` and signature. It then begins a PostgreSQL transaction and locks the grant, mandate and reservation. It reloads and validates proposal, agent, receipt and approval when required. It compares persisted grant state and exact proposal digest/amount/currency/merchant/capability bindings, verifies mandate fingerprint/current expiry/agent authorization and verifies an approved escalation remains approved.

Only an `ISSUED` grant and `AUTHORIZED`, unexpired reservation can cross the boundary. Successful revalidation atomically changes grant `ISSUED -> CLAIMED` and reservation `AUTHORIZED -> EXECUTING`, with evidence in the same transaction. Concurrent replay contends on the grant row and only one caller can claim execution authority.

The fake execution sink is called only after that transaction commits. Success finalizes `CLAIMED -> CONSUMED` and `EXECUTING -> COMMITTED`. Deterministic fake-sink failure finalizes grant and reservation as `FAILED`.

## Evidence

2C adds `EXECUTION_GRANT_ISSUED`, `EXECUTION_GRANT_VERIFICATION_FAILED`, `EXECUTION_REVALIDATION_FAILED`, `EXECUTION_AUTHORITY_CLAIMED`, `PAYMENT_EXECUTION_STARTED`, `PAYMENT_EXECUTION_SUCCEEDED` and `PAYMENT_EXECUTION_FAILED`. Raw grant tokens and key material are not evidence payloads. Existing SHA-256 chaining remains tamper-evident, not immutable against a privileged database writer.

## Keys and rotation

Private signing keys are runtime secrets and are not persisted. `kid` selects a public key from a verifier key ring, permitting overlap during rotation. 2C does not implement secret-manager/KMS/HSM integration or claim hardware-backed keys/non-repudiation. See `ADR-002-execution-grants.md`.

## Remaining 2D boundary

A real payment provider cannot join a PostgreSQL transaction. 2C intentionally commits the execution-authority claim before provider I/O rather than holding a transaction across a network call. Milestone 2D must use durable payment attempts, provider idempotency and reconciliation to handle ambiguous outcomes such as provider success with a lost response. PayPal is not implemented in 2C.
