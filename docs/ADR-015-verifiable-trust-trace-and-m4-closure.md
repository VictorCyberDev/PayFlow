# ADR-015: Verifiable operation trace and Milestone 4 closure

Status: Implemented for independent M4F review; approval is external.

## Scope and boundaries

M4F composes M4A–M4E and verifies durable records. It introduces no authorization
engine, new rail, production login, retailer checkout, anchoring or M5 feature.
AI ranks inside a deterministic candidate set. Discovery observations are not
checkout terms. Only an operator mapping and controlled source can supply trusted
terms. The existing Kernel, reservations, signed grants, M4C rail and M4D resume
boundary still decide whether a new provider dispatch is possible.

`OperationTraceService.project` accepts bounded local selectors (proposal, quote
or discovery-selection ID), not expected financial terms. Those IDs only select
persisted records. Trusted hosts must authenticate and route owner reads before
exposing this internal service; it is not a production browser/session endpoint.
`projectM4Demo` obtains its trace through this service and strictly validates a
bounded serializable projection. `OperationTraceSchema` validates format, not the
truth of arbitrary JSON presented by a browser. A caller cannot submit a prebuilt
trace to obtain authoritative verification.

## Why migration 009 is necessary

Inspection established that the M4E database retained grant claims but not grant
signature bytes, selected observations but not the exact ranking candidate set,
and provider IDs/statuses without all independently comparable provider terms.
Evidence saying "verified" cannot replace these missing proofs.

Additive immutable records now preserve **new** operations only:

- Authorization material: exact existing Kernel context and agent snapshot at
  evaluation, associated with its receipt. Replay invokes `authorize`, not a
  duplicate policy implementation. Random receipt ID is normalized for comparison.
- Execution-grant signature material: the unchanged v1 signed token associated
  with its grant. Same Ed25519 claims schema and canonical bytes as execution.
  Tokens are sensitive delegated execution material inside trusted storage and
  never appear in trace/demo projections. Retained trusted public keys are required.
- Ranking material: exact bounded eligible candidate set, query, source-local
  operator mapping snapshots and locally accepted candidate ID/request identity.
- Provider observations: bounded normalized CREATE/GET/CAPTURE representations,
  associated with the existing Payment Attempt, with their fingerprint referenced
  by the existing evidence chain. No payer URL, payer PII, headers or credentials.
- Quote refusals: non-executable complete trusted terms from an actual M4B
  AMOUNT_EXCEEDS_LIMIT rejection. No quote, manifest, proposal or financial authority
  is issued by this record. It makes $84 observed → $184 trusted → denial visible.

New proof fingerprints reuse the existing durable canonical serializer, including
provider breakdown records whose object-key order PostgreSQL may change. Equal
dispatch/revocation timestamps are disambiguated only by the verified existing
evidence sequence; expiry boundaries remain strict.

No old receipt, proposal, reservation, grant, attempt, migration or ledger hash is
rewritten. Existing partial Foundation installations continue operating: writers
check table availability. New proof tables reference existing identities and have
immutable update/delete triggers and bounded documents. They are proof material,
not another evidence ledger or financial state machine.

Authorization proof writes share the original authorization transaction. Signature
proof writes share issuance. Observation recording is integrated at the rail's
provider adapter boundary. Provider objects and existing validation are unchanged.
A storage failure after a provider effect follows the existing UNKNOWN path; it
cannot release uncertainty or authorize another purchase. Malformed observations
are never copied into storage; the original response still reaches existing rail
validation. Missing proof prevents complete verification.

## Verification roles

The read-only trace recomputes:

- Discovery snapshot and selected-record fingerprints, request/candidate digest,
  original ranking-set membership and preliminary offer eligibility.
- Mapping ID/revision/fingerprint and selected controlled-offer fingerprint.
- Quote arithmetic/canonical fingerprint, controlled offer, selection link,
  immutable manifest, binding recipient and proposal metadata/digest relationships.
- Principal/mandate/agent identity continuity and current status facts.
- Receipt integrity/proposal snapshot and existing Kernel replay using recorded
  historical context, including cumulative/quantity consumption and merchant risk.
- Approval, reservation, signed grant/persisted snapshot and attempt relationships.
- Provider-observation fingerprint/evidence reference, order identity, reference,
  recipient, amount/currency, SKU/quantity/unit amount/breakdown, and capture identity.
  M4C `verifyPayPalCommerce` is reused, including allowed omission of zero components.
- Dispatch timestamps against original quote, mandate, reservation and grant
  windows; capture/grant consumption/reservation commitment relationships.
- Existing ledger hashes and represented ordering using `verifyTrustTrace`.

The existing durable canonical function is reused for structural comparisons.
M4E canonical fingerprint formats remain unchanged. New typed proof envelopes use
separate SHA-256 domains. A valid evidence event does not itself prove a valid
manifest, signature or provider operation. Each is recomputed from its own material.
Provider observations are server-recorded REST facts, not externally signed PayPal
attestations. Internal hash integrity is not external immutable anchoring.

## States and financial meaning

Stages report VERIFIED, NOT_APPLICABLE, INCOMPLETE, INVALID or UNKNOWN with bounded
reason codes. INVALID takes precedence. In-flight/create-unknown/capture-unknown/
provider-pending outcomes remain UNKNOWN_FINANCIAL_OUTCOME. Missing mandatory
proof or unfinished operations are INCOMPLETE. A completed M4 capture is VERIFIED
only when mandatory represented relationships verify. PAYER_ACTION_REQUIRED and
provider APPROVED do not mean paid. Historical generic records report LEGACY;
absent M4 commerce does not make them INVALID.

M4 records predating 009 can be internally readable but incomplete for signatures,
ranking material or authorization replay. Nothing fabricates these absent stages.
An orphan quote never acquires discovery provenance by matching SKU, price,
merchant or time. Missing immutable links remain INCOMPLETE. Refused quote terms
are explicitly non-executable and do not masquerade as an authorization receipt.

Current authority is separate from historical verification. Revocation, suspension
or expiry prohibits a new dispatch through the unchanged rail. The meter shows
current authority unavailable and trace evidence can show server-side APPROVED
while capture is withheld. A conforming capture already performed can still be
observed and committed after revocation/expiry. Signature verification at trace
view time does not renew or execute a historical grant.

## Authority Meter and conservation

The meter separates financial authority (mandate limit, requested/authorized amount,
current held reservation, committed/remaining mandate accounting, capability,
status and expiry facts) from commerce binding (observed price with UNTRUSTED
OBSERVATION label, trusted total, merchant/recipient, SKU/variant/condition/quantity
and fingerprints). Committed and remaining amounts use existing mandate accounting.
`freshDispatchBlocked` reports known necessary blockers; false is not authorization.
The trace never dispatches money and cannot replace final rail revalidation.

Authority conservation verifies the actual existing policy evaluation and exact
receipt → reservation → grant → attempt/manifest → provider/capture relationships.
Effective execution lifetime is the intersection of current mandate, agent,
reservation, grant and quote limits; it does not falsely assume every stored TTL
is identical. Discovery/AI selection/controlled resolution never grants money.

## Consistency, bounds and hygiene

Projection uses one PostgreSQL REPEATABLE READ, READ ONLY transaction. No financial
row locks or provider requests are performed. Snapshot reads may report intermediate
states, but cannot combine a committed attempt with stale executable reservation
state. Restart uses new connections and retained public keys; no WeakSet handle,
ranker instance or cached controlled offer supplies proof.

Limits: 40 aggregated verification stages, 128 related evidence summaries,
32 provider observations, 65,536 serialized output bytes; internally, at most
4,096 ledger entries and 2 MiB ledger data. Repeated relationship checks aggregate
without discarding failures. Overflow produces INCOMPLETE/TRACE_LIMIT_EXCEEDED,
never a truncated VERIFIED result. The indexed bounded complete ledger prefix is
necessary for the existing chain verifier without an independently trusted anchor;
large histories require a future safely anchored/paged design, not inferred integrity.
Transaction joins use existing PK/unique indexes; observations have an attempt/time
index. No unbounded transaction-history query is added.

Outputs contain only explicit bounded identifiers, numeric terms, status/reason
codes and evidence hashes/types. They exclude tokens, signatures, private keys,
raw resume secrets/digests, authentication assertions, cookies, CSRF values,
provider headers, URLs/query strings, model responses and provider blobs. Tests
check both prohibited field names and distinctive fixture values.

## Break PayFlow and deterministic acceptance

`BREAK_PAYFLOW_ATTACKS` defines 37 stable IDs. `runBreakPayFlow` validates bounded
measured results from a trusted scenario runner, with actual provider-call counts,
side-effect truth, boundary, result, reason and trace status. It is reporting, not
an independent security engine. PostgreSQL vertical fixtures compose actual
M4 services and mock only the provider adapter/human-authenticator test boundary.
They exercise success, payer approval, revocation, expiry, corruption, restart,
concurrent execution/resume and UNKNOWN recovery. Deterministic explanations use
reason codes, not an LLM.

Lost create can entail another call with the SAME original create request ID under
existing recovery rules; the harness does not pretend that every recovery has zero
provider calls. Lost capture has one remote capture, local CAPTURE_UNKNOWN and
observation of the same capture; reconciliation issues no second capture.

Hidden $95 + $12 shipping = $107 is exercised through the existing complete quote
contract and actual Kernel DENY. The controlled demo issuer retains zero shipping,
tax and fees; M4F adds no shipping engine. Price drift $84 → $184 is additionally
preserved as an actual trusted quote refusal, with no fabricated executable quote.

## Real external acceptance

Current official PayPal [purchase-unit contract](https://developer.paypal.com/api/orders/v2/definitions/purchase_unit),
[create representation](https://developer.paypal.com/sdk/orders/v2/orders-create/)
and [idempotency guidance](https://developer.paypal.com/api/rest/requests/) were
reviewed. Existing request construction, server GET and strict conformance remain.

`RUN_PAYPAL_SANDBOX_SMOKE=true npm run test:paypal:commerce:sandbox` explicitly opts
into real create/GET conformance using environment-only Sandbox credentials and
PAYPAL_EXPECTED_MERCHANT_ID. Synthetic DEMOACCOUNT IDs are rejected. Without an
existing completed PAYPAL_CONFORMANCE_ORDER_ID this checks order representation
and reports capture acceptance PENDING. The smoke does not bypass financial authority
to capture or automate payer credentials. Complete payer/capture through the
ordinary authorized rail, then use the existing-order readonly acceptance phase.
Normal CI makes zero live calls. No valid credentials are available in this session:
PAYPAL SANDBOX CONFORMANCE: PENDING REAL-CREDENTIAL ACCEPTANCE.

CHANNEL3 LIVE DISCOVERY: PENDING. No endpoint, credential, condition mapping or
retailer checkout relationship is invented. Production authentication and external
immutable evidence anchoring are NOT IMPLEMENTED.

## Claim limits

Verification is internal to the trusted host/storage/public-key boundary. DBA
rewriting, malicious host configuration, absent external timestamp/attestation,
provider retry-window limitations and unobserved effects remain limitations.
PayFlow does not claim exactly-once execution, unhackability, fraud-proofing,
merchant legal identity, arbitrary retailer support, authenticity or delivery.
Independent review is required before M4 approval or merge. No M5 work is included.
