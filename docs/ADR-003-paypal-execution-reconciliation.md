# ADR-003: PayPal execution correctness and reconciliation

## Decision

Milestone 2D places PayPal Sandbox strictly behind PayFlow's trusted execution lifecycle. PayPal is an execution provider, never an authorization authority. The Trust Kernel, durable reservation, signed execution grant, immediate revalidation and one-time authority claim remain upstream.

We use PayPal REST Orders v2 with `intent=CAPTURE`: OAuth `POST /v1/oauth2/token`, create order `POST /v2/checkout/orders`, show order `GET /v2/checkout/orders/{id}`, and capture `POST /v2/checkout/orders/{id}/capture`. 2D rejects non-sandbox configuration.

## Distributed transaction model

PostgreSQL and PayPal cannot participate in one atomic transaction. PayFlow compensates with durable local intent, stable provider idempotency identifiers, explicit UNKNOWN states, provider-state retrieval, and reconciliation. A network error after a capture request is not proof of failure.

Each execution grant/reservation maps to one durable Payment Attempt. Separate create-order and capture request IDs are persisted before their respective side effects and reused for retries of the same logical operation. Provider order and capture IDs are unique and bound to the attempt.

## State model

`NOT_STARTED -> ORDER_CREATING -> ORDER_CREATED -> PAYER_ACTION_REQUIRED | CAPTURE_IN_FLIGHT -> CAPTURED`

Ambiguous order creation enters `ORDER_CREATE_UNKNOWN`. Ambiguous capture enters `CAPTURE_UNKNOWN`. Provider-pending capture enters `CAPTURE_PENDING_PROVIDER`. Definitive failures enter `FAILED`; UNKNOWN is never collapsed into FAILED.

While capture is UNKNOWN or pending, the reservation remains `EXECUTING` and the execution grant remains `CLAIMED`. Authority is quarantined and is not returned to the mandate budget.

## Reconciliation

Recovery of `ORDER_CREATE_UNKNOWN` (also a crash leaving `ORDER_CREATING`) reconstructs the original create body from the authoritative Payment Attempt: integer amount, currency and proposal ID as PayPal `reference_id`. The local `merchant_reference` remains the grant's merchant ID; it is not the PayPal purchase-unit reference. Recovery reuses the already persisted `create_order_request_id`, never creates another attempt, validates the returned purchase-unit bindings and persists the recovered order. Payer approval remains `PAYER_ACTION_REQUIRED`. Further ambiguity remains UNKNOWN with grant `CLAIMED` and reservation `EXECUTING`.

For `CAPTURE_UNKNOWN`, reconciliation first calls Show Order and strictly checks order ID, the single purchase-unit reference/amount/currency, capture cardinality, any previously known capture ID, and capture money. An existing capture is reconciled without another capture request. Automatic retry is permitted only when the validated order is `APPROVED`, has no captures or payer-action URL, and remains within the conservative retry window. The retry uses exactly the persisted `capture_request_id`. The returned order ID, reference, capture ID, amount, currency and statuses are checked again; only a `COMPLETED` capture in a `COMPLETED` order can finalize. Pending remains pending; unresolved or repeated ambiguous retries keep authority quarantined. Provider GET failure never authorizes retry.

Reconciliation uses a PostgreSQL session advisory lock on the attempt to serialize cooperating workers across processes. This is not a transaction: each provider request runs outside any PostgreSQL transaction. The reserved connection runs short local transactions before and after the provider operation. Finalization locks the Payment Attempt, execution grant and reservation in that order, rereads exact IDs/financial bindings and requires `CLAIMED`/`EXECUTING`. It revalidates the provider result against the locked attempt and verifies one affected row for each transition. Attempt `CAPTURED`, grant `CONSUMED`, reservation `COMMITTED`, and both reconciliation/`PAYMENT_COMMITTED` evidence events commit together. Any missing row, corrupt binding/state or suppressed transition rolls everything back. An already finalized concurrent reconciliation can return `CAPTURED` only after verifying consistent terminal state; it emits no second commitment event.

PayPal's [Orders idempotency retention](https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/advanced/) is finite (six hours by default). Automatic create/capture retries are conservatively limited to less than six hours from the original attempt's `created_at`; retries do not extend this window. Outside it, existing captures can still be reconciled by GET, but an unresolved attempt requires operator investigation rather than a fresh provider key. This conservative bound can also hold older payer-approved orders for review. A malformed/substituted provider result fails closed without releasing authority.

## Payer approval

Order creation is not payment success. If PayPal requires payer action, PayFlow persists the order and approval URL and returns/quarantines as `PAYER_ACTION_REQUIRED`. 2D does not automate payer login or store payer passwords.

## Money and bindings

PayFlow uses integer minor units. Conversion to PayPal decimal strings is explicit and currency-precision aware; binary floating point is not used. Capture amount and currency must match the authoritative execution grant/payment attempt exactly. Order/capture substitution is prevented by durable unique IDs and attempt bindings.

## OAuth and secrets

OAuth is server-side only. Access tokens are cached in memory until shortly before expiry and concurrent refreshes are coalesced. Client secrets, access tokens and Authorization headers are never written to evidence. `.env.example` contains placeholders only.

## Webhooks

Webhook mutation is intentionally deferred. 2D prioritizes explicit provider reconciliation. No unsigned placeholder webhook endpoint is accepted. A later milestone may add PayPal-supported authenticity verification, provider-event replay protection and the same amount/currency/order/capture binding checks.

## Residual risks

A compromised PayPal credential can act at the provider and must be handled operationally by secret rotation and PayPal controls. PostgreSQL remains a privileged trust boundary. Provider/local divergence can remain unresolved during prolonged PayPal unavailability; PayFlow intentionally fails closed and keeps authority quarantined. Provider state can change after GET; safety still depends on PayPal honoring the same idempotency key within its retention period. Session locks serialize cooperating reconcilers, not arbitrary privileged database writers or external PayPal actors. Loss of the database session releases the lock; another worker must repeat provider reconciliation. This is not a claim of perfect exactly-once distributed execution.
