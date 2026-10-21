# ADR-010 — Controlled commerce contracts (M4A)

Status: M4A review candidate. No checkout/payment integration or main merge.

Baseline: `e62a45a777abafc8653039ccf9f2732f749a87ce`.

## Scope and trust boundary

“The AI interprets your intention. It does not grant itself permission.”

M4A represents commerce identity and a locally provisioned checkout relationship.
It never answers whether a payment may execute. That remains exclusively with
the existing deterministic Trust Foundation. No financial modules are modified.

`PayFlow Demo Merchant — Sandbox` has exact logical ID `payflow.demo.merchant`.
It is fictional/demo commerce, not Amazon, Best Buy, Walmart or a Channel3
retailer. Its catalog uses generic PayFlow demo keyboards rather than implying
a purchase from an external retailer or branded manufacturer's store.

## Operator-provisioned merchant binding

`MerchantBindingSchema` binds a version, exact demo merchant and checkout-source
identifiers, positive revision, literal Sandbox environment, expected PayPal
merchant account ID, and active boolean. It contains no credentials.

The host constructs `FakeControlledCommerceSource` only with trusted operator
configuration. Its constructor MUST NOT be exposed to request bodies, models,
discovery adapters or agent tools. Parsing is shape validation, not operator
authentication. Like other host composition roots, privileged code can construct
configuration; these contracts cannot authenticate a malicious host/operator.

No expected recipient is embedded in the shipped demo catalog. Tests supply
explicitly synthetic account identifiers. A real expected ID must eventually
come from trusted Sandbox account setup, never display text or discovery claims.

Bindings are immutable snapshots. `withMerchantBinding` requires a strictly
greater revision and constructs a new source. Old offers remain bound to their
old source; passing an old offer to the new source does not acquire its recipient.
Initial provisioning cannot detect reuse of an older revision across restarts:
durable revision history is deliberately deferred. A host must preserve its
operator configuration revision discipline until that history exists.

Disabled bindings return DISCOVERY_ONLY with MERCHANT_BINDING_INACTIVE. This is
checkout-support configuration, not mandate revocation or a financial release.

## Product family, exact offer and availability

A family describes one keyboard model/category. It is not an offer selector.
Only an exact offer ID resolves a controlled offer. Each catalog revision rejects
duplicate family IDs, offer IDs and SKUs, undeclared family references and
inconsistent revisions. The SKU identifies a single variant/condition in that
revision; catalog administration must not repurpose it across revisions.

The small catalog has NEW brown/black and red/grey variants and a USED comparison
offer. Structured variants use bounded switch/finish enums and ANSI layout. This
is not a universal variant ontology. Display titles are not identity selectors.

Commerce conditions are NEW, USED, REFURBISHED, OPEN_BOX and UNKNOWN. They do not
change the Foundation condition schema. LIKE_NEW, RENEWED, PRE_OWNED, lowercase
and confusable spellings are rejected, never interpreted as NEW.

Money reuses the Foundation `{currency, minor}` shape, narrows currency to the
existing intent-supported set, and requires positive safe integer minor units.
This is a complete UNIT catalog price observation, not a complete checkout total:
tax, shipping, discounts and other checkout charges are not represented yet.

`availableQuantity` is nonnegative commerce data, including zero. It is not
authorized quantity, a reservation, an inventory guarantee or a spending limit.
The NEW and USED offers can both have a supported checkout relationship; deciding
NEW-only eligibility belongs to later filtering and existing financial policy.

## No promotion by parsing

`DiscoveryOfferSchema` requires UNTRUSTED_DISCOVERY and rejects authority-bearing
extra fields. External merchant claims stay untrusted even if their IDs/display
names impersonate the demo merchant. There is no conversion to a trusted binding.

Checkout support is derived only for an immutable offer issued by the SAME
controlled source instance. Membership uses a private WeakSet; parsed objects,
copies, external observations and other instances' handles are DISCOVERY_ONLY.
The TypeScript brand helps typed callers but is not the runtime enforcement.
Handles are process-local, not durable authorization tokens; restart support
requires loading trusted configuration again, not deserializing a trusted handle.

SUPPORTED_CHECKOUT means only that the source has an active local relationship
capable of later checkout work. It is neither ALLOW nor financial authorization.
The fake source supplies catalog lookups, not quotes, manifests or payments.

## Canonical identities and limits

Controlled offer fingerprints use SHA-256 with `payflow:commerce-offer:v1\n`.
Merchant binding fingerprints use `payflow:merchant-binding:v1\n`. Each uses a
fixed ordered projection, avoiding locale-dependent sorting. Historical
Foundation canonicalization/hashes are unchanged.

Offer identity includes source, family, offer, merchant, SKU, structured variant,
condition, unit money, available quantity and catalog revision. Title is excluded
as display-only. Binding identity includes recipient, revision and active state.
The offer hash alone does NOT bind recipient; a support result exposes BOTH
identities. Future checkout binding must carry the relevant binding revision.

Fingerprints identify validated local field sets and detect substitution when
compared against an independently retained expected fingerprint. An attacker
recomputing a hash does not gain trust. They do not prove merchant legal identity,
provider truth, product authenticity, physical inventory or fulfillment.

IDs are exact case-sensitive ASCII, at most 96 characters. SKUs are at most 64
characters with `PF-` uppercase segment syntax. Display strings are at most 160
UTF-16 code units. Catalogs contain at most 5 families and 20 offers; fake discovery
returns at most 20 observations. Availability is bounded to 100,000 units. Variant
keys are fixed and values are enums. Collection prechecks run before per-element
source parsing; fingerprint functions validate before serialization/hash work.
No arbitrary maps, remote HTTP, JSON text parser, pagination or automatic retries
are introduced. Transport byte/depth/freshness bounds belong to later adapters.

No Unicode normalization equivalence is claimed. Confusable identifiers fail
ASCII validation; display text, including malicious instructions, remains inert.

## Verification and explicit non-goals

Adversarial tests cover substitution, strict schemas, bounds, duplicate catalog
identities, immutable snapshots, source-instance isolation, binding revisions,
disabled support and availability/authority separation. A dependency-closure test
ensures commerce reaches only its own modules and the shared domain schemas, not
authorization, activation, signing, persistence, evidence writes or PayPal.

M4A does NOT prove PayPal recipient agreement.
M4A does NOT authorize or execute payments.
M4A does NOT prove fulfillment or product authenticity.

No migrations, durable quotes, checkout manifests, proposal/grant/attempt changes,
PayPal item/payee changes, payer resume, discovery integration, AI ranking,
financial policy changes, Trust Trace extensions or UI are included. M4B must
establish complete durable quotes and immutable manifests before any financial
integration. All live provider tests remain explicitly opt-in; M4A needs none.
