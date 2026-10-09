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

Reconciliation starts from the persisted PayPal order ID and uses Show Order. If PayPal proves the expected capture is `COMPLETED`, PayFlow validates amount/currency and atomically persists the capture, marks the Payment Attempt `CAPTURED`, grant `CONSUMED`, reservation `COMMITTED`, and appends evidence. It does not send a second capture.

If PayPal shows a non-final capture, PayFlow remains pending. If provider state cannot resolve ambiguity, PayFlow remains UNKNOWN. Create-order ambiguity differs because there may be no order ID locally; safe retry must reuse the same persisted create request ID.

## Payer approval

Order creation is not payment success. If PayPal requires payer action, PayFlow persists the order and approval URL and returns/quarantines as `PAYER_ACTION_REQUIRED`. 2D does not automate payer login or store payer passwords.

## Money and bindings

PayFlow uses integer minor units. Conversion to PayPal decimal strings is explicit and currency-precision aware; binary floating point is not used. Capture amount and currency must match the authoritative execution grant/payment attempt exactly. Order/capture substitution is prevented by durable unique IDs and attempt bindings.

## OAuth and secrets

OAuth is server-side only. Access tokens are cached in memory until shortly before expiry and concurrent refreshes are coalesced. Client secrets, access tokens and Authorization headers are never written to evidence. `.env.example` contains placeholders only.

## Webhooks

Webhook mutation is intentionally deferred. 2D prioritizes explicit provider reconciliation. No unsigned placeholder webhook endpoint is accepted. A later milestone may add PayPal-supported authenticity verification, provider-event replay protection and the same amount/currency/order/capture binding checks.

## Residual risks

A compromised PayPal credential can act at the provider and must be handled operationally by secret rotation and PayPal controls. PostgreSQL remains a privileged trust boundary. Provider/local divergence can remain unresolved during prolonged PayPal unavailability; PayFlow intentionally fails closed and keeps authority quarantined.
