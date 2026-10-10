# PayFlow Architecture — Milestone 2D

## Trusted path

```text
Untrusted Agent -> TransactionProposal -> Trust Kernel -> DecisionReceipt
 -> durable Authority Reservation -> Ed25519 Execution Grant
 -> signature verification + immediate durable revalidation
 -> one-time execution authority claim
 -> durable Payment Attempt -> PayPal Sandbox Orders v2
 -> capture verification/reconciliation -> COMMITTED
```

The Trust Kernel remains deterministic and PostgreSQL-independent. PayPal does not decide whether a transaction is authorized.

## Durable authorization and execution authority

Milestones 2A/2B keep PostgreSQL authoritative for mandates, passports, proposals, receipts, approvals, replay keys, reservations and evidence. Per-mandate locking serializes authority acquisition. Milestone 2C binds exact execution authority into short-lived Ed25519 grants and atomically moves `ISSUED -> CLAIMED` with reservation `AUTHORIZED -> EXECUTING` after immediate revalidation.

## Payment Attempts

2D evolves the existing Payment Attempt into the durable provider interaction record. One execution grant/reservation maps to one logical attempt. The attempt binds grant, reservation, proposal, mandate, principal, provider, operation, integer-minor amount/currency and merchant reference. It persists separate create-order/capture request IDs before network side effects and stores only structured provider identifiers/status needed for correctness.

The local state machine distinguishes no side effect, order creation in flight/unknown, order created, payer action required, capture in flight/unknown/provider-pending, captured and definitive failure. UNKNOWN is not FAILED.

## PayPal provider boundary

`PaymentProvider` keeps PayPal HTTP types outside the Trust Kernel. `PayPalPaymentProvider` uses native `fetch`, server-side OAuth and current PayPal REST endpoints in Sandbox only:

- `POST /v1/oauth2/token`
- `POST /v2/checkout/orders` with `intent=CAPTURE`
- `GET /v2/checkout/orders/{id}`
- `POST /v2/checkout/orders/{id}/capture`

OAuth tokens are cached only in memory until shortly before expiry; concurrent refreshes are coalesced. Non-sandbox configuration is rejected.

## Money

PayFlow remains integer-minor internally. A dedicated conversion layer emits PayPal decimal strings without binary floating point and rejects unsupported currencies/invalid values. Provider capture amount/currency must equal the authoritative Payment Attempt/execution authority.

## Idempotency and crash recovery

Create-order and capture use distinct stable `PayPal-Request-Id` values derived from the durable attempt identity. The same logical retry reuses the same persisted ID.

PostgreSQL and PayPal cannot participate in one atomic transaction. Therefore capture timeout/reset/ambiguous 5xx is quarantined as `CAPTURE_UNKNOWN`. The grant stays `CLAIMED`; reservation stays `EXECUTING`; budget authority remains consumed until reconciliation resolves provider truth.

Reconciliation starts from the persisted PayPal order ID and uses Show Order. A completed capture with exact amount/currency atomically finalizes Payment Attempt `CAPTURED`, grant `CONSUMED`, reservation `COMMITTED` and evidence. No second capture is sent merely because the original response was lost.

Order creation ambiguity is handled separately: safe retries reuse the same create request ID. An existing order is resumed rather than replaced. Payer approval is represented explicitly and is not treated as payment success.

## Evidence

2D extends the durable timeline with payment-attempt creation, order-create start/result, payer action, capture start/unknown/pending/confirmed, reconciliation and commit/failure events. Evidence never intentionally contains PayPal Client Secret, OAuth token, Authorization header or raw credentials.

## Webhooks

2D does not expose an insecure placeholder webhook. Explicit reconciliation is authoritative. Verified, replay-protected webhook ingestion may be added later using PayPal-supported authenticity verification and the same provider/local bindings.

See `ADR-002-execution-grants.md` and `ADR-003-paypal-execution-reconciliation.md`.

## Integrated Milestone 2E review

[ADR 004](ADR-004-integrated-security-boundary.md) documents the integrated trust
boundary, current-authority dispatch checks, fail-closed finalization, rollback-safe
evidence, corruption detection, reconciliation discovery and adversarial matrices.
The dispatch handoff is the revocation cutoff; GET plus retry is not atomic, and
provider idempotency/retention remain external dependencies. Unknown authority is
never released merely because a response or local commit failed.

## Formal revocation linearization point

The successful transaction COMMIT that revalidates locked authority, moves the
attempt to ORDER_CREATING or CAPTURE_IN_FLIGHT and appends
PAYPAL_OPERATION_DISPATCHED is the revocation linearization point. Revocation,
suspension or expiration before this handoff prevents the operation. After
handoff the specific validated operation may proceed, even before physical
network transmission; it cannot be recalled by local revocation. Subsequent
independent operations require fresh authority checks. Completed provider effects
remain truthfully reconcilable after revocation or expiration.

Request material comes from the private validated attempt snapshot, not mutable
durable rows reread after handoff. PostgreSQL and PayPal have no shared atomic
transaction; GET plus retry is not atomic and distributed exactly-once execution
is not claimed. See [ADR-004](ADR-004-integrated-security-boundary.md#formal-revocation-linearization-point)
for the lock, snapshot, race-test and crash-recovery guarantees.

## Milestone 3A untrusted intent boundary

A separate pure compiler accepts typed untrusted interpretation plus authoritative
source/review context and produces a non-authoritative mandate draft or explicit
clarification/rejection. It imports only schema definitions and hashing utilities;
it cannot persist authority, authorize transactions, issue grants or invoke PayPal.
Human confirmation/activation is a separate 3C boundary. Quantity and
merchant-allowlist requirements remain explicit in drafts; 3C satisfies them
through deterministic reservation and execution checks rather than omitting constraints. See [ADR-005](ADR-005-ai-intent-trust-boundary.md).

## Milestone 3B model boundary

`IntentModelProvider` accepts only source/reference. The Groq adapter performs one
bounded native-fetch request with strict JSON Schema and a static versioned system
instruction; source is separate user-role data. The shared service locally validates
unknown output, invokes the unchanged 3A compiler with independently supplied
review bounds and adds conservative semantic-support checks and fixed clarification
questions. Fake providers exercise this same path. Transitive dependency tests
keep the model layer outside persistence, authorization, grants and PayPal.
No trusted activation or confirmation endpoint is added. See [ADR-006](ADR-006-model-intent-integration.md)
for limits and the distinction between exact provenance and semantic proof.

## Milestone 3C: explicit authenticated activation

`IntentActivationService` persists exact untrusted drafts for review and accepts confirmation only through a configured `HumanActionAuthenticator` and sealed human context. A fingerprint is review binding, not authentication. Five-minute durable reviews, one-time challenge hashes, current security snapshots and atomic mandate creation separate interpretation from authority. New mandates enforce quantity through PostgreSQL reservations and logical merchant allowlists at authorization and execution. Historical mandates retain their existing semantics. See [ADR-007](ADR-007-authenticated-intent-activation.md) for host authentication obligations and lock/expiry boundaries.
