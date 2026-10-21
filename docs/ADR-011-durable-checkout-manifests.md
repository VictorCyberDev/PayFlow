# ADR-011: Durable controlled quotes and immutable commerce manifests (M4B)

Status: Accepted implementation decision; independent milestone review pending.

## Boundary and scope

The AI interprets your intention. It does not grant itself permission.

M4A's source-instance controlled offer provenance and operator merchant binding
are the inputs to `DurableCheckoutService`. Parsing, an offer fingerprint, a copied
handle or a foreign source instance cannot issue a quote. Trusted host composition
supplies the source; request/model/discovery JSON must never configure it. The
service has no network calls, financial authorization, reservations, activation,
grant issuance, payment-attempt creation or PayPal operations.

The host must authenticate and authorize access to owned workflows. A mandate ID
is a lookup key, not authentication. Quote/manifest ownership is taken from locked,
validated durable mandate/passport/principal state, never from commerce input.
This milestone does not implement a web login/session or confirmation endpoint.

## Complete quote

`payflow.checkout-quote.v1` explicitly represents source, binding revision and
M4A binding fingerprint, controlled offer fingerprint, family, exact offer/SKU,
fixed variant, condition, catalog revision, quantity, currency, provenance and
canonical ISO timestamps. Every charge component is required, including zeros.

`subtotal = unitAmount × quantity`

`total = subtotal + tax + shipping + customerFee − customerDiscount`

BigInt validation detects multiplication/addition overflow before conversion to
safe integer minor units. PostgreSQL numeric check expressions independently
constrain arithmetic. Total must be positive; negative components, excessive
discounts, unsafe integers, unsupported currencies and hidden fields reject.
The controlled demo issuer sets tax, shipping, discount and fee explicitly to zero.
This is not a general shipping, tax or fee engine. Catalog availability narrows
quoted quantity; it never increases human quantity authority.

Lifetime is at most five minutes, shortened to mandate/passport expiry. Time is
injected for deterministic tests. Expiry is checked after relevant row locks and
again after transactional evidence writes, immediately before returning to COMMIT.
An observed expiration gets a durable one-time expiration marker; a later clock
rollback cannot revive it. Expiry noticed at the final boundary rolls back sealing
or linkage and records expiry in a separate transaction. Issuance itself rolls
back if its newly created quote expires before commit. There is no claim of an
atomic wall-clock instant shared with PostgreSQL; trusted clocks are a host
assumption. No arbitrary sleeps are used to test expiry.

## Manifest and fingerprints

`payflow.checkout-manifest.v1` retains every quote term, exact quote identity and
expiry, expected Sandbox recipient, environment and durable owner snapshot.
SHA-256 is computed over `payflow:checkout-manifest:v1\n` followed by the explicitly
ordered canonical JSON projection. Variant/owner ordering is fixed, identifiers
are case-sensitive, money is integer, timestamps canonical, and display text is
excluded. A separately domain-separated quote fingerprint also exists. Neither
changes any M4A fingerprint format.

The manifest includes **both** merchant-binding fingerprint and revision, plus
offer fingerprint, recipient expectation, exact SKU/variant/condition/quantity
and all payable components. These fingerprints bind local records; they do not
prove external truth, legal merchant identity, actual inventory, physical product
authenticity, fulfillment, PayPal recipient agreement or PayPal item agreement.

## Persistence and revision continuity

Additive migration 006 creates immutable binding revision history, monotonic
current-binding pointers, quotes with durable authority ownership, expiration
markers, manifests and one-to-one manifest/proposal links. Composite foreign keys
bind quote ownership to a real mandate/principal/agent relationship and quote
binding to its exact revision/fingerprint. Existing Foundation proposals receive
no fabricated commerce identity; grants and payment attempts are unchanged.

UPDATE/DELETE triggers protect immutable commerce rows and commerce-linked
proposals. Read paths revalidate strict schemas, redundant financial/identity
columns, JSON document hashes, M4A fingerprints, manifest reconstruction and
proposal digest. These are corruption detection and application/database-role
controls, not tamper-proof protection against administrators who can rewrite
constraints, records and evidence together. Apply migrations once in sorted order
using the repository's existing installation mechanism.

A newer operator binding cannot overwrite an older revision. Sealed historical
manifests retain their original recipient expectation and remain readable after
configuration changes. Fresh sealing/linking requires the current active revision;
a disabled or superseded binding fails closed. Catalog replacement cannot mutate
saved quote/offer snapshots. Historical catalog observations are not a claim that
inventory remains available forever; final execution conformance is later work.

## Proposal linkage and authority conservation

The compiler constructs an ordinary `TransactionProposal`: total amount, currency,
logical merchant, condition, quantity, KEYBOARD category and CAPTURE_PAYMENT come
from the sealed manifest/trusted controlled relationship. Principal/agent/mandate
bindings come from durable authority. Server-generated proposal ID, nonce and time
are not supplied by commerce callers.

The reserved `payflow.commerce.` namespace contains exactly:

- `payflow.commerce.manifestId`
- `payflow.commerce.manifestVersion`
- `payflow.commerce.manifestFingerprint`

Generic `saveProposal` rejects every reserved namespace collision rather than
overwriting it. The trusted compiler inserts proposal and exact durable link in
one transaction; a deferred database trigger rejects fabricated/inconsistent
reserved linkage. Linked proposal records cannot subsequently be patched.
`getProposal` independently checks the complete durable relationship.

The existing proposal digest already includes metadata. Thus future ordinary
grant issuance can transitively bind the manifest without reinterpreting v1 grants
or changing their format. M4B does not issue grants to establish checkout authority.
The compiler checks current identity/status/expiry/capability and projection bounds
(currency, category, condition, merchant, per-operation amount and explicit quantity).
It is **not** a second kernel: cumulative availability, replay, risk, approvals,
autonomy and the ALLOW/DENY/ESCALATE decision remain with ordinary durable authorization.

Any changed term, even a decreased price, needs a new quote, manifest and proposal;
no signed object is patched. No automatic re-quote or replacement payment is
introduced, especially not in response to UNKNOWN provider state. Existing payment
quarantine, idempotency and reconciliation remain authoritative.

## Concurrency, recovery and evidence

Writes lock mandate → passport → principal → current merchant head → quote.
Provisioning locks a merchant-specific advisory key and its current head. Unique
quote-to-manifest and manifest-to-proposal relationships plus quote row locks give
concurrent workers one coherent identity. No reservation or provider side effect
is created during this lifecycle. Transactions include bounded structured existing
ledger events: COMMERCE_QUOTE_ISSUED, CHECKOUT_MANIFEST_SEALED,
CHECKOUT_MANIFEST_PROPOSAL_LINKED, COMMERCE_QUOTE_EXPIRED and
COMMERCE_BINDING_REJECTED. Rejection evidence contains only a sanitized code;
unauthenticated lookup IDs are not assigned trusted ownership.

Restart reloads verified durable snapshots and relationships, not a regenerated
M4A WeakSet handle. Deserialized source data cannot regain issuance provenance.
Read-only recovery can inspect historical manifests after expiry/config changes;
fresh linking still revalidates current state. Evidence supports future quote →
manifest → proposal trace verification, but M4B does not extend the Trust Trace UI
or independent commerce trace verifier.

## Validation and limitations

Normal CI uses deterministic controlled sources and real PostgreSQL concurrency,
corruption, upgrade, rollback and restart tests. No credentials or external calls
are required. Strict schemas bound identifiers, fixed nested attributes, quantity
and money. No raw JSON parser is introduced; duplicate-key rejection remains a
future transport-adapter responsibility before objects reach these schemas.

M4B does not execute payments, verify provider recipient/items, manage payer
approval, integrate Channel3, rank with AI, support arbitrary retailers or prove
fulfillment. Later authorized milestones must add independent execution-boundary
commerce conformance before claiming a manifest-bound purchase. Persisted trusted
configuration must be provisioned only by the operator, not by an untrusted route.
