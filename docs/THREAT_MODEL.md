# PayFlow Threat Model — Milestone 2D

Milestone 1 fail-closed policy semantics and the durable/concurrency controls from 2A/2B plus 2C execution-grant protections remain required. 2D adds a real Sandbox provider without making PayPal an authorization authority.

## Authorization and provider substitution

Threat: amount, currency, merchant, order, capture, attempt, proposal, agent, mandate or reservation is substituted after authorization.

Controls: the Ed25519 execution grant binds exact authority; immediate durable revalidation remains mandatory. Payment Attempts redundantly persist grant/reservation/proposal/mandate/principal plus integer-minor amount/currency. PayPal capture amount/currency must match. Provider order/capture IDs have durable uniqueness constraints. Any mismatch fails closed and is not committed.

## Duplicate capture and request replay

Threat: a retry or concurrent request creates a second charge.

Controls: the 2C grant/reservation claim remains the primary choke point. One grant/reservation maps to one Payment Attempt. Create-order and capture have separate stable persisted request IDs; retries of the same logical operation reuse them. A successful capture ID is unique. Concurrent attempt creation is protected by the reservation/grant uniqueness constraints.

## Lost response / timeout after provider success

Threat: PayPal captures successfully but the response is lost, then PayFlow charges again or releases authority.

Controls: timeout, reset, malformed post-transmission response and ambiguous 5xx become `CAPTURE_UNKNOWN`, never ordinary failure. Grant stays `CLAIMED`; reservation stays `EXECUTING`; authority remains quarantined. Reconciliation uses Show Order and, when PayPal proves the expected completed capture, finalizes the existing attempt without another capture.

Create-order response loss with no local order ID is recovered with the original durable amount/currency/proposal reference and persisted create key. Capture recovery GETs and validates the order first; an existing capture is never recaptured. Only a bound `APPROVED` order with no captures or payer-action URL permits same-key capture retry. Repeated ambiguity never releases the reservation or grant. Automatic retries stop six hours after the original attempt; idempotency retention is not assumed to be infinite.

Finalization locks the attempt, grant and reservation, verifies exact bindings and states, and checks all three affected-row counts before atomically committing state and `PAYMENT_COMMITTED` evidence. Corrupt state or a suppressed update rolls back. A session advisory lock serializes reconcilers without holding a transaction during network requests; already finalized state is validated before returning success and no duplicate commitment is emitted.

Residual risk: prolonged PayPal unavailability or expiry of the conservative retry window can require operator investigation while authority stays quarantined. GET and retry are not atomic at PayPal; safety depends on provider idempotency. Database-session loss releases the advisory lock, and privileged writers or external provider actors are outside that serialization. Perfect exactly-once distributed execution is not claimed.

## Process crash after side effect

Durable Payment Attempt state survives process death. Crash before create is safe to resume. Crash after order creation resumes the existing order. Crash after capture success but before local finalization is resolved from provider state. Local finalization is transactional across Payment Attempt, execution grant, reservation and evidence.

## Provider/local divergence

PayPal and PostgreSQL cannot share an atomic transaction. PayFlow compensates with durable intent, provider idempotency and reconciliation. `HTTP 2xx` alone is not settlement; provider capture status is interpreted explicitly and pending is distinct from success/failure.

## Payer approval

Order creation does not imply capture. Orders requiring payer action persist the order/approval URL and remain non-final. 2D never stores or automates payer credentials.

## Forged/duplicate webhooks

2D intentionally exposes no unsigned webhook mutation endpoint. Explicit reconciliation is authoritative. Future webhook support must use PayPal-supported authenticity verification, a configured webhook ID, durable provider-event replay protection and the same order/capture/amount/currency bindings.

## OAuth and credential compromise

OAuth is server-side. Tokens are cached only in process memory, refreshed before expiry and never written to evidence. Client secrets and Authorization headers are not persisted. Stale-token/auth failures fail closed. Residual risk: compromise of PayPal credentials permits provider-side actions and requires operational rotation/revocation.

## Malformed provider responses

PayPal OAuth/order structures are schema-validated. Malformed or structurally unusable responses fail closed; after a side-effecting request they are treated as ambiguous where execution may already have occurred.

## Existing 2C threats

Grant forgery, wrong audience/version/key, stale authority, grant replay, escalation bypass and corrupt persisted authority remain protected by the 2C signed-grant and immediate-revalidation design. `AUTHORIZED`/`EXECUTING` reservations continue to consume mandate capacity.

## Evidence and PII

Evidence records safe IDs, status, amount/currency and failure classifications needed to reconstruct the financial timeline. It must never contain Client Secret, OAuth access token, Authorization header or raw credentials. Provider response storage is intentionally minimized rather than persisting whole PayPal payloads.

## Explicit non-claims

2D is Sandbox only. It does not implement live PayPal, hardware-backed keys, immutable audit storage, production principal authentication, LLM mandate parsing, product discovery, final UI, refunds, disputes, subscriptions, multi-provider payments, Milestone 2E or Milestone 3.

## Integrated Milestone 2E review

[ADR 004](ADR-004-integrated-security-boundary.md) documents the integrated trust
boundary, current-authority dispatch checks, fail-closed finalization, rollback-safe
evidence, corruption detection, reconciliation discovery and adversarial matrices.
The dispatch handoff is the revocation cutoff; GET plus retry is not atomic, and
provider idempotency/retention remain external dependencies. Unknown authority is
never released merely because a response or local commit failed.
