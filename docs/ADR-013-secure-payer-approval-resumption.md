# ADR-013: Secure payer approval and durable resumption (M4D)

Status: Implementation candidate for independent review. No main merge.

## Boundary and scope

Browser return is a notification, not financial authority. PayPal approval only
satisfies the provider approval step. It cannot revive a revoked mandate or renew
an expired grant, reservation or commerce quote. The existing kernel, signed v1
grant, M4B immutable manifest, M4C conformance and Payment Attempt remain the only
financial lifecycle. No second authorization engine or financial attempt exists.

The host may configure fixed HTTPS return/cancel routes on the Sandbox adapter.
They are copied and frozen at construction, contain no credentials/query/fragment,
and use Orders v2 `payment_source.paypal.experience_context`. They never include
the resume secret. Hosts must keep resume material in a protected local session
and recover it when the browser returns; this repository supplies the service and
trusted authentication interface, not browser login/session storage or a UI.

Official provider references inspected on 2026-10-11:

- <https://developer.paypal.com/whats-an-order/>
- <https://developer.paypal.com/sdk/orders/v2/orders-get/>
- <https://developer.paypal.com/api/orders/v2/schema.json>

These distinguish payer-action links, provider approval, capture and Show Order.
The documented Sandbox navigation origin is `https://www.sandbox.paypal.com`.
The controlled demo presents only a bounded HTTPS URL on that exact origin,
without credentials or fragments. Other origins are unavailable until reviewed;
this is a conservative demo restriction, not a claim covering every PayPal flow.
URL navigation is not evidence of payer approval. Provider URLs remain bounded
by the adapter schema; raw browser URLs cannot become persisted provider URLs.

## Durable resume capability and authentication

Additive migration 007 creates immutable metadata indexed one-to-one by the
existing Payment Attempt. It stores principal/proposal/order snapshots, a unique
SHA-256 digest of a domain-separated 256-bit random secret and a ten-minute
lifetime. Only the secret is returned once; no recovery/renewal API exists. The
migration does not rewrite historical financial/evidence rows. The secret is not
an execution grant and does not change the grant's existing 120-second default
or 300-second maximum lifetime.

`PaymentResumeService.prepare` requires an authenticated human action bound to
the persisted attempt, proposal, agent and PayPal order and checks principal
ownership. It issues only for durable PAYER_ACTION_REQUIRED state without a known
commerce conflict. `resume` looks up the secret digest, checks lifetime and exact
snapshot relationship, then authenticates RESUME_PAYMENT bound to those same
local identifiers plus the digest. M3C HumanConfirmationBoundary still verifies
fresh human identity and an exact frozen action through HumanActionAuthenticator.
Hosts must verify session identity, explicit action, CSRF, origin and audience;
there is no permissive production authenticator or completed browser login here.
Raw authentication assertions and resume secrets never enter evidence.

The accepted browser body is strictly `{resumeSecret, returnedOrderId?}`. Browser
status, approved flags, PayerID, token, amount, currency, merchant, SKU, manifest
and proposal fields are rejected. A host may map a returned token to the optional
comparison-only returnedOrderId; it must not pass other query assertions as facts.
A mismatch rejects before provider retrieval or capture. It never replaces the
persisted order. A capability for B cannot authenticate an exact-action assertion
for A, even when the principal is the same; host action binding is mandatory.

## Provider state, capture and recovery

Resume calls the existing rail on the durable attempt ID, not a browser order ID.
The rail obtains its PostgreSQL session advisory lock, validates durable grant /
reservation / proposal / receipt relationships and GETs the persisted PayPal order.
M4C mandatory amount, currency, reference, manifest, recipient, SKU, quantity,
unit amount and breakdown checks are unchanged. Missing required representation
fails closed; known conflicts retain the existing durable COMMERCE quarantine.

The state model remains compatible: NOT_STARTED, ORDER_CREATING / CREATE_UNKNOWN,
ORDER_CREATED / PAYER_ACTION_REQUIRED, CAPTURE_IN_FLIGHT / CAPTURE_UNKNOWN,
CAPTURE_PENDING_PROVIDER and CAPTURED. APPROVED is a provider observation, not a
new fabricated local authorization state. A browser return leaves state untouched
until authoritative retrieval. CREATED/SAVED/PAYER_ACTION_REQUIRED cannot capture.

For APPROVED with no captures, the existing dispatch transaction locks and checks
current principal, passport, mandate/revocation/fingerprint/capability, receipt and
escalation approval, EXECUTING reservation, CLAIMED grant and their deadlines,
proposal digest, M4C complete durable binding, current merchant revision, quote
freshness and six-hour retry window. Deadlines are checked again at handoff after
evidence serialization. The successful COMMIT remains the revocation cutoff.
Provider approval observed before invalid authority is recorded; capture is not
dispatched, the operation is not successful and uncertain authority is not released.
No automatic proposal, order, grant, quote, reservation or authority renewal occurs.

An already-existing conforming capture follows observation/finalization rules,
not freshness rules for new dispatch. Lost capture response remains CAPTURE_UNKNOWN.
Later GET of the same persisted order can commit the existing completed effect even
after quote/grant expiry or mandate revocation, without a second capture. Invalid
commerce evidence still prevents false success. Direct rail execute/reconcile
entry retains all checks, independently of this authenticated browser service.

## Replay, evidence and limits

The capability can be retried within its bounded lifetime to support refresh and
UNKNOWN recovery; it is not a one-shot financial authority. Existing PostgreSQL
attempt locks, immutable IDs, one-to-one authority claim and stable create/capture
idempotency keys serialize independent workers. CAPTURED resumes observe the
existing final state, with no financial POST. After capability expiry, trusted
worker reconciliation remains available to observe existing effects; browser
material cannot renew authority. GET plus capture is not atomic at PayPal and
provider idempotency remains an external dependency, not exactly-once proof.

Bounded events distinguish PAYPAL_PAYER_ACTION_REQUIRED,
PAYMENT_RESUME_AUTHENTICATED, PAYPAL_APPROVAL_OBSERVED, PAYMENT_CAPTURE_RESUMED and
PAYMENT_RESUME_REJECTED. The latter records verified provider APPROVED with failed
current authority/commerce for rail rejections. Existing COMMERCE_EXECUTION_VERIFIED,
PAYPAL_OPERATION_DISPATCHED and PAYMENT_COMMITTED give the revalidation/financial
record. Evidence contains bounded local IDs and statuses, no callback query,
resume secret, raw assertion, credentials or full provider payload.

Tests use deterministic clocks and mock PayPal only at its adapter boundary.
PostgreSQL 17 tests exercise real migrations, restart through new host instances,
independent connections, cross-attempt products, revocation/expiry, response conflict,
replay and UNKNOWN. Physical delivery, product authenticity, merchant legal identity,
production login and privileged-database tamper resistance remain outside claims.
