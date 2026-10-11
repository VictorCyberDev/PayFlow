# ADR-014: Untrusted discovery, bounded ranking and controlled promotion

Status: Implemented for independent M4E review. Approval is external.

## Boundary and threat

Discovery providers and ranking models can lie, inject instructions, invent IDs,
misrepresent conditions, or return conflicting merchant/price/variant claims.
They have no financial authority. `CommerceDiscoveryEngine` performs preliminary
commerce filtering; it does not replace the existing Trust Kernel. M1–M4D grant,
reservation, PayPal, UNKNOWN and payer-resume rules remain unchanged.

The path is untrusted provider response → bounded offer normalization → deterministic
eligibility → request-scoped eligible candidates → ranker → strict local membership
validation → operator mapping → freshly source-issued ControlledOffer → M4B quote /
manifest / ordinary proposal → existing authorization and M4C/M4D execution.

## Offer schema and bounds

Every offer retains its own provider-local identity, optional family identity,
merchant claim, title/snippet, category/condition/variant/SKU claims, observed
price/currency, available quantity, HTTPS references, observation timestamp and
bounded provenance. Missing facts become explicit null/UNKNOWN, never evidence.
No product-family condition, merchant, price or availability propagates to offers.

| Boundary                                 | Limit                                    | Purpose                                      |
| ---------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| Providers per request                    | 4                                        | Bound fan-out and response work              |
| Offers per provider / normalized offers  | 20 / at most 20                          | Bound work before Zod                        |
| Provider response                        | 65,536 bytes                             | Bound wire JSON before parsing               |
| Object response traversal                | 2,000 nodes, depth 5, 20 keys per object | Bound decoded adapter objects before schemas |
| Aggregate title/snippet/merchant display | 16,384 bytes per provider                | Bound descriptive input                      |
| Aggregate provenance                     | 4,096 bytes per provider                 | Avoid arbitrary feed blobs                   |
| URLs/references                          | 40 per provider; at most two per offer   | Bound references; never fetch them           |
| Candidates / ranking input               | 20 / 65,536 bytes                        | Bound model input                            |
| Ranking response / explanation           | 2,048 bytes / 512 characters             | Bound parsing and output                     |
| Provider or ranking call                 | 2 seconds, AbortSignal                   | Fail safely; no automatic fallback           |
| Observation freshness                    | less than 5 minutes, not future-dated    | Avoid stale preliminary selection            |
| Persisted selection document             | 16,384 bytes                             | Bound durable provenance                     |

Identifiers are ASCII and at most 96 characters; equality values are never
truncated. Titles/merchant display are 160, snippets 512, condition claims 64,
category/each of three variant claims 32, SKU 64, provenance 200, HTTPS URL 2,048
characters. Price uses existing positive safe integer money schema and supported
currency enumeration. Quantity is a safe integer; availability is bounded to
100,000 and requested quantity to 1,000. URLs reject embedded credentials.

String adapter responses are byte-checked before JSON parsing. Already-decoded
objects undergo a conservative traversal budget (six bytes per string byte plus
structure overhead), which can reject a response smaller than the wire cap.
Future network adapters must cap bytes while reading, before decoding; the engine
cannot undo memory allocated by an adapter. Aggregate overflow rejects that
entire provider response. Otherwise malformed individual offers are discarded;
valid siblings retain their own facts. All copies of duplicate provider-local
offer IDs are discarded. Other providers remain isolated. Deterministic host
provider/result order caps candidates; input byte overflow excludes later
candidates without widening membership. There is no global mutable candidate pool.

## Conditions and preliminary eligibility

Only exact `NEW`, `USED`, `REFURBISHED`, `OPEN_BOX`, `UNKNOWN` tokens are normalized
by this adapter contract. Missing, `brand new`, `like new`, `mint`, `renewed` and
`excellent` become UNKNOWN. Model translation never establishes NEW.

Eligibility checks observation age, exact allowed condition/category/currency,
observed unit price times requested quantity against the mandate single-payment
limit, reported availability, mandate quantity limit, required variant and
independently configured checkout/merchant scope. These observations are not
inventory proof or financial authorization. UNKNOWN cannot satisfy NEW-only
selection. Executable mode requires a configured relationship. Recommendation
mode may expose unmapped offers as DISCOVERY_ONLY under an ANY merchant scope;
it issues no quote and persists no executable selection.

## Ranking contract and request isolation

Each invocation has a fresh random UUID. Candidate ID is SHA-256 of request UUID,
separator and the domain-separated normalized observation fingerprint. Identical
observations in different requests have different candidate IDs. Only eligible,
frozen candidates are supplied with an explicit UNTRUSTED_DISCOVERY marker and
bounded preference text. The deterministic fake ranker selects the lowest observed
price; this is a configured implementation, not a fallback after model failure.

Ranker output is strictly `{candidateId, explanation?}`. Extra amount, merchant,
SKU, condition or authorization fields are rejected. JSON bytes and flat object
fields are bounded; membership must exactly match this invocation. Invented,
ineligible, cross-request and executable-mode discovery-only IDs fail before any
controlled offer loading, quote, manifest, proposal, authorization, grant or
provider call. Timeout/malformed responses fail without fallback.

Titles, snippets and merchant text are data. No LLM adapter or prompt assembly is
implemented here. A future adapter must delimit untrusted data and validate the
same structured result locally. Prompt engineering is not the enforcement boundary.

## Operator mapping and trusted price

Mappings are immutable trusted host configuration with mapping ID, positive
revision, provider namespace, provider-local offer ID, pinned family, Demo Merchant
claim, controlled offer ID, exact SKU/variant/condition. Duplicate source keys fail
configuration. Only explicitly named PayFlow Demo Merchant observations can map.
Matching title, price, SKU-looking text or merchant display alone never promotes.
Arbitrary external retailers cannot be mapped through this API to impersonate a
Demo Merchant purchase.

Pre-ranking `inspect` consults configuration without loading controlled offers.
After membership validation, `resolve` independently obtains a branded handle
from the configured controlled source and verifies support and pinned identity.
The mapping fingerprint supplied during ranking must still equal the promotion
mapping fingerprint, defending inconsistent host composition/configuration races.
The selection pins mapping ID/revision/fingerprint; a later configuration revision
cannot reinterpret it, even if the source key remains the same. Mapping histories
are preserved in selection snapshots, not a mutable database mapping registry.
A new mapping requires a new discovery/selection operation.

Promotion never copies an observation into a ControlledOffer. On quote resumption,
the controlled handle is independently loaded again. The current trusted price
may differ from the old observation while the pinned identity remains the same.
The M4B quote receives only that handle, mandate ID and quantity. Provider/model
price and merchant claims never enter quote construction.

Tests demonstrate observed $84 → trusted $89, and (with sufficient authority)
observed $84 → actual persisted quote/proposal/authorization $184. Under the
under-$100 mandate, existing M4B rejects $184 before persisting a quote or proposal;
M4E does not weaken that earlier check to reach the Kernel. The existing Kernel
also rejects trusted $184 and complete $95 + $12 shipping = $107 terms under that
mandate. Shipping is tested through the existing complete quote contract and
Kernel; the controlled demo issuer still charges explicit zero tax/shipping/fees.
M4E implements no tax/shipping engine or alternate quote issuer.

## Persistence, restart and corruption

Additive migration 008 stores immutable selected provenance and a unique
selection-to-quote link. It does not modify old financial records. The selection
contains request/candidate IDs, normalized offer snapshot, normalized fingerprint,
principal/mandate/fingerprint, quantity, selected time, promotion status,
mapping ID/revision/fingerprint and exact controlled offer snapshot/fingerprint.
AI explanation is neither persisted nor used as authority.

Schema parsing establishes fixed canonical property order, including nested
merchant, variant and money fields. Fingerprints use SHA-256 with separate domains
`payflow:discovery-observation:v1\n`, `payflow:discovery-mapping:v1\n` and
`payflow:discovery-selection:v1\n`. Full selected provenance is hashed, not only
the provider-local ID. On reload the application reparses strictly, checks the
selection hash, observation/control fingerprints, candidate-to-request digest,
redundant owner/request/time columns, current authority, freshness and exact
mapping. Existing quote links also verify immutable quote owner, quantity and
controlled/mapping fingerprints. Corruption fails before new quote issuance.

Restart reloads the persisted observation; it never refetches discovery to
reinterpret it. Provider refresh creates a new observation and cannot change
historical price, currency, merchant, condition, availability, SKU or variant.
Independent PostgreSQL workers serialize quote resolution using a session advisory
lock on selection ID; they return the same linked quote. Separate concurrent
requests remain separate immutable selections with distinct request/candidate IDs.
No Payment Attempt, reservation or grant is created by selection/quote resolution.

Quote issuance uses the existing M4B transaction; provenance linking follows it.
A crash between those commits can leave an unlinked quote. A retry may issue a
replacement quote; an orphan quote has no manifest, proposal, authorization or
provider effect. This is not a claim of exactly-once quote issuance. Financial
one-time claims and idempotency remain the existing Foundation's responsibility.

The host must route owner actions correctly as with M4B. Selection UUIDs and
candidate hashes do not implement production authentication or confer payment
authority. Database administrators can defeat application triggers/hashes;
PayFlow does not claim DBA tamper-proofing.

## Evidence, providers and limitations

COMMERCE_DISCOVERY_SELECTED and COMMERCE_DISCOVERY_RESOLVED contain bounded local
IDs/fingerprints only. No model response, provider blob, query string, credential
or raw auth assertion is stored in evidence. Existing evidence-chain verification
is retained.

Channel3 remains pending live integration. Its official [developer page](https://trychannel3.com/developers/)
describes search/lookup offers and lists checkout as coming soon. This review did
not establish a complete documented offer-level condition/normalization contract
or obtain an event credential. No Channel3 adapter, undocumented condition mapping,
credential, checkout relationship or live-smoke claim is invented. A future bounded
adapter can implement the provider interface; it will still supply untrusted
observations only. Normal CI uses fake discovery/ranking and mock PayPal only at
the existing provider boundary, with zero live AI/discovery/PayPal calls.

No arbitrary retailer checkout, physical availability/fulfillment/authenticity
proof, production authentication, real AI provider integration or M4F UI is added.
