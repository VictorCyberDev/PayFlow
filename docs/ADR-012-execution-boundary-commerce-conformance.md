# ADR-012: Execution-boundary commerce conformance (M4C)

Status: Implementation candidate for independent review. No main merge.

## Threat and boundary

A financially valid grant must not silently execute a different immutable checkout.
Reserved `payflow.commerce.` metadata requires durable commerce conformance; there
is no generic-payment fallback. Historical proposals with no metadata and no
commerce link retain Foundation semantics, including installations before 006.
The existing kernel remains the only financial authorization engine. The AI and
commerce source do not gain signing, reservation or execution authority.

`Authority(B) ⊆ Authority(A)` remains conditional on trusted host composition,
signing keys, operator provisioning and PostgreSQL integrity. Privileged database
administrators can rewrite protections and are outside the security claim.

## Transitive signed binding

The unchanged Ed25519 v1 execution grant signs `proposalDigest`. `canonicalProposal`
includes every metadata key/value, quantity, amount, merchant, capability, category
and condition. The reserved metadata binds manifest ID/version/fingerprint. M4B
`getProposal` independently reloads the one-to-one link, quote, offer snapshot and
binding; verifies redundant columns, hashes/fingerprints, owner and complete
manifest reconstruction; and compares the stored proposal digest. M4C reuses that
validation and additionally checks exact grant owner/fingerprint/capability and
SKU/variant/condition/price/quantity against the saved controlled offer.
Neither caller data nor an in-memory manifest can replace this durable reload.
No grant v2, second policy engine, migration or historical rewrite is introduced.

## Dispatch and direct-call protection

`ExecutionBoundary` checks commerce before the atomic authority claim. The PayPal
rail independently checks it in attempt authority validation and every dispatch,
including direct `execute` and `reconcile` entry. A direct rail call must prove the
existing durable claim and its evidence; unsigned caller claims cannot manufacture
one. The adapter is a trusted host transport dependency, not an authenticated
public financial endpoint. Hosts must never expose raw OAuth/adapter methods to
untrusted callers, as already required by Foundation composition.

The existing dispatch transaction is the revocation linearization point. It locks
and checks current principal, mandate, passport, capability, reservation and grant;
locks the current merchant head; checks active exact binding revision/fingerprint
and quote expiry/expiration marker; and commits attempt status/idempotency and
bounded evidence before any financial POST. Quote and authority deadlines are
checked again after evidence serialization. After COMMIT the exact validated
operation may proceed; no distributed wall-clock or recall guarantee is claimed.
Request terms come from the immutable snapshot returned by that transaction.

## PayPal request and recipient guarantee

Official current reference inspected on 2026-10-11:

- <https://developer.paypal.com/api/orders/v2/schema.json>
- <https://developer.paypal.com/api/orders/v2/orders-create>
- <https://developer.paypal.com/api/orders/v2/orders-get>
- <https://developer.paypal.com/api/orders/v2/orders-capture>

The Sandbox adapter sends one `purchase_units` entry with proposal `reference_id`,
manifest `custom_id`, exact currency/total and breakdown `item_total`, `tax_total`,
`shipping`, `discount`. It sends one PHYSICAL_GOODS item with exact SKU, quantity,
unit amount, deterministic name and description. Condition and variant have no
independent Orders v2 fields: they remain signed local terms, with supplemental
exact description comparison. Product family, offer and catalog revision remain
locally verified identities. Display text alone never establishes identity.
The controlled demo has zero customer fee; a nonzero fee is rejected rather than
inventing a PayPal field. This is not a tax/shipping/fee engine.

The request explicitly sets `payee.merchant_id` from the operator-bound manifest.
Logical merchant equality is not PayPal account equality. A returned purchase-unit
`payee.merchant_id` is required and compared case-sensitively. Missing evidence is
UNAVAILABLE (COMMERCE_RECIPIENT_UNAVAILABLE), disagreement is CONFLICT, and an exact
provider-reported account match is VERIFIED. Configuration alone is never called
provider verification. There is no live account-topology attestation in CI; actual
Sandbox credentials must belong to/configure the supported demo merchant, and
provider rejection or missing evidence stops progression. No arbitrary retailers,
legal identity, physical fulfillment or inventory guarantee is claimed.

## Provider response and recovery

The adapter retains bounded item, breakdown, custom ID and payee data. Existing
response size limits and financial POST ambiguity handling remain unchanged.
Create requests ask for `return=representation`; a missing required representation
fails closed, preserving UNKNOWN authority. The existing rail always performs
Show Order before considering capture. Orders must match ID/reference/status,
exact amount/currency, manifest custom ID, recipient, one exact item and breakdown.
Capture uses only the persisted attempt order ID and stable capture request ID.
Returned capture amount/currency/identity/status are checked; related order ID is
compared when exposed. Required commerce data missing from a capture representation
also fails closed. This conservative contract may require operator investigation
if PayPal omits fields; it never interprets omission as success.

Known mismatches write a bounded COMMERCE_PROVIDER_MISMATCH event and a durable
`failure_classification` marker in the existing attempt. Provider order ID, when
safe, is preserved in evidence even if the response conflicts before association.
Subsequent reconciliation cannot POST or commit through that marker. Grant remains
CLAIMED and reservation EXECUTING; no retry with another checkout/order is allowed.
No terminal financial failure or authority release is fabricated.

Observation of an already completed provider capture validates the original
immutable relationship without requiring current quote/binding freshness; existing
Foundation rules allow truthful finalization after expiry/revocation. Any new
create/capture retry still requires current authority, current binding, unexpired
quote, original identities/keys and the existing six-hour retry window. Missing or
corrupt durable terms stop recovery; they never justify replacement commerce.
GET and retry are not atomic at PayPal; distributed exactly-once is not claimed.

## Evidence, validation and limits

COMMERCE_EXECUTION_VERIFIED records bounded attempt/manifest/digest/binding IDs.
COMMERCE_PROVIDER_ORDER_VERIFIED records exact recipient verification status.
Mismatch events store a stable sanitized reason and bounded provider ID, never raw
payloads, OAuth tokens, client secrets, authentication assertions or headers.
Existing evidence-chain hashing and atomic finalization remain in use.

Tests exercise the actual signed execution boundary, corrupt persisted terms,
current authority and binding changes, provider substitution, lost capture,
restart before dispatch/after create, direct rail calls and two independent
PostgreSQL pools. Existing Foundation/M4A/M4B regressions remain required. No
normal test requires credentials or makes live provider calls.
