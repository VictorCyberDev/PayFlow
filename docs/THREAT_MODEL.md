# PayFlow Threat Model — Milestone 2C

Milestone 1 fail-closed policy semantics and the durable/concurrency controls from 2A/2B remain required. 2C protects the authorization-to-execution handoff.

## Authorization substitution

Threat: a caller obtains authority for one transaction and changes amount, currency, merchant, agent, mandate, proposal, capability or reservation before execution.

Control: a short-lived Ed25519 signature covers exact execution claims, including a deterministic SHA-256 proposal digest. The execution boundary also reloads the authoritative proposal and compares digest and explicit financial bindings. Modified signed payloads fail signature verification; modified persisted state fails revalidation.

## Forged or confused grants

Control: verification is hard-coded to Ed25519 through Node `crypto`; there is no caller-selectable algorithm and no `alg=none` path. Version and audience are explicit. `kid` must resolve to a known public key. Wrong keys, malformed grants, unsupported versions, wrong audiences and bad signatures fail before provider invocation.

Residual risk: production secret-manager/KMS/HSM custody and automated key rotation are not implemented. Compromise of the active private key permits grant forgery until that key is removed from trust.

## Stale authority

Threat: a correctly signed grant is used after the agent/mandate/approval/reservation changes.

Control: signature validity alone is insufficient. Immediately before claiming execution authority PayFlow locks durable state and revalidates mandate fingerprint/expiry/agent/capability, agent status/expiry/principal/capability, exact receipt/proposal/reservation bindings, reservation status/expiry, and approval for ESCALATE.

## Grant replay

Control: each JTI is a durable primary key. Execution locks its grant row and accepts only `ISSUED`. The same transaction moves grant to `CLAIMED` and reservation to `EXECUTING`. Concurrent requests for the same grant serialize on that row; only one can reach the sink. Successful use becomes `CONSUMED`; deterministic sink failure becomes `FAILED`. Duplicate calls are rejected, not replayed idempotently.

## Concurrent overspend

The 2B per-mandate lock remains authoritative for reservation acquisition. `AUTHORIZED` and `EXECUTING` reservations consume capacity. The existing real PostgreSQL 8000 + 8000 against 10000 concurrency test remains required.

## Escalation bypass

An ESCALATE receipt alone is not executable. Grant issuance requires the reservation created by the 2B approval flow, and execution rechecks an `APPROVED` record bound to the same principal/proposal/receipt. The original receipt remains ESCALATE.

## Corrupt persisted state

Runtime schemas and redundant signed/persisted bindings fail closed on malformed critical state. A privileged database writer remains a trusted-system threat: with sufficient access it can alter related rows/evidence consistently. The evidence chain is tamper-evident, not immutable.

## Evidence exposure

Execution evidence records grant IDs/digests, outcomes and safe reason codes. It does not intentionally record private signing keys, secrets or complete grant tokens.

## External provider TOCTOU

2C atomically claims local execution authority before provider I/O, then commits the transaction. It intentionally does not hold PostgreSQL locks across a fake network operation. A real provider can succeed while PayFlow loses the response, so `EXECUTING` cannot by itself prove provider outcome.

Milestone 2D must persist payment attempts before network I/O, use provider idempotency keys and implement reconciliation/webhook semantics for ambiguous outcomes. PostgreSQL + PayPal atomicity is not claimed.

## Explicit non-claims

2C does not implement PayPal, hardware-backed keys, non-repudiation, immutable audit storage, distributed consensus, production principal authentication, atomic external payment execution, LLM mandate parsing, product discovery or UI.
