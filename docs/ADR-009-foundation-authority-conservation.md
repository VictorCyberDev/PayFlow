# ADR-009 — Foundation authority conservation

Status: M3F review candidate. No main merge or Milestone 4 implementation.

Baseline: `0c31cefabd54632a823ce4501fa0e202d501bd1a`.

## Scope and authority roots

“The AI interprets your intention. It does not grant itself permission.”

For the reviewed M3 activation path, authenticated exact human confirmation is
an authority root. Downstream mandate, proposal, reservation, signed grant and
provider dispatch may narrow, consume, expire or revoke that authority; they may
not silently widen it. The conservation statement is conditional on genuine host
human authentication, trusted administrative provisioning, signing-key custody
and the integrity of the PostgreSQL authority store. Legacy operator-provisioned
mandates remain supported; this audit cannot retroactively prove their human
confirmation or turn privileged database administration into untrusted input.

These are bounded executable adversarial tests and a code audit, not a formal
proof of every possible interleaving, language interpretation or provider action.
Purpose text describes intent; the kernel enforces the typed category and
condition, not arbitrary natural-language product specifications or fulfillment.

| Transition                       | Positive authority required                                     | Conservation control                                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interpretation → draft           | None: output remains untrusted                                  | Strict local schema, source provenance, independent review bounds, semantic clarification, no activation API dependency                                        |
| Draft → active mandate           | Host-authenticated HUMAN exact action                           | Durable review, exact fingerprint/terms, challenge, principal/passport/policy epochs, expiry, one-time activation transaction                                  |
| Mandate → proposal authorization | Current mandate/passport, all mandatory kernel checks           | Fingerprint, exact identities, explicit capabilities, currency/amount/category/condition/risk, budget, replay, quantity and merchant restrictions when present |
| Authorization → reservation      | ALLOW, or separately authenticated approved ESCALATE            | Locked mandate, durable replay claim, receipt/proposal snapshots, atomic accounting/evidence                                                                   |
| Reservation → execution grant    | Current authorized reservation and authority                    | Ed25519, exact proposal digest and mandate fingerprint, kid/version/audience/TTL, durable immutable snapshot                                                   |
| Grant → provider operation       | Current authority and exact operation capability                | Atomic claim plus transactional dispatch handoff, frozen request material, Sandbox-only provider, persisted request IDs                                        |
| Provider result → commitment     | Strictly verified external result and consistent local bindings | Attempt/grant/reservation locks, affected-row checks, atomic CAPTURED/CONSUMED/COMMITTED/PAYMENT_COMMITTED                                                     |

## Reproduced defects and minimum repairs

1. **Capability widening.** Diagnostic commit
   `893bb88677e4edd7afb7fc02d140070a7e122545`, CI #151, reproduced
   `M3F CREATE_ORDER-only signed authority cannot enter the combined financial rail`.
   The promise returned `RECOVERED-CAPTURE` instead of capability rejection, while
   724 other tests passed against real PostgreSQL 17. The execution boundary now
   honors the sink's explicit required capability before claim. The PayPal rail
   independently checks fresh attempt creation and every transactional dispatch.
2. **Missing positive replay evidence.** Before the kernel repair, a runtime
   context missing `replaySeen` returned ALLOW. The failing regression expected
   DENY. Missing/null/numeric/string replay results now fail schema-independent
   runtime validation with MALFORMED_INPUT. The durable service still obtains
   replay absence from PostgreSQL and claims the replay key atomically.
3. **Unbounded provider body.** Before transport repair, the adapter accepted an
   oversized JSON order response. Streamed OAuth responses are now limited to
   16,384 bytes; order responses to 262,144 bytes, independent of Content-Length.
   Oversized streams are cancelled. Existing 15-second native-fetch aborts apply
   to body reads. A financial POST parse/size failure remains AMBIGUOUS; it never
   proves no side effect or permits authority release. GET/OAuth failures retain
   their existing non-financial failure classifications.

No migration, second grant lifecycle, separate order/capture attempts, automatic
new grant, fresh recovery key or financial compensation path is introduced.

## CREATE_ORDER is not CAPTURE_PAYMENT

These are distinct, non-implying capabilities. The current PayPal rail is a
combined capture-capable payment lifecycle. **Fresh entry requires explicit
CAPTURE_PAYMENT** in passport, mandate, proposal and consequently the receipt
snapshot, reservation binding and signed grant. Order creation is an intermediate
implementation step inside that authorized payment lifecycle. CREATE_ORDER
remains a valid domain capability but has no independent order-only PayPal rail.
A future useful order-only lifecycle requires a separate deliberate design.

Fresh rejection occurs before claim, attempt creation and provider dispatch.
The grant remains ISSUED and the reservation AUTHORIZED: no budget or quantity
is committed. Existing authorized reservation release/expiry rules still apply.
Direct entry with an already claimed order-only grant creates no attempt and
conservatively retains the claimed authority; it cannot manufacture release.

Historical order-only attempts are not rewritten. Reconciliation may GET and
strictly validate existing provider state. A definitively completed capture can
be truthfully finalized once, even after revocation or under historical authority
that would fail the new entry rule. Reconciliation evidence records requested
and required capabilities plus observationOnly to expose that mismatch. It must
not issue another capture, create another order, regrant or release uncertainty.
If no capture is visible and a capture would be required, or no order ID exists
and create recovery would require POST, dispatch fails with
PAYMENT_CAPABILITY_REQUIRED and authority remains quarantined. Retry of an
original logical operation is allowed only with original CAPTURE_PAYMENT
and existing current-authority, retention and idempotency checks.

## Positive ALLOW and accounting conservation

ALLOW requires validated mandate/passport/proposal structures, current time,
correct identities/fingerprint, explicit requested capability in both authority
sets, bounded supported money, known risk and explicit replay absence. Optional
legacy quantity/merchant constraints retain their documented compatibility
semantics; M3 activated mandates always have their enforced quantity and merchant
scope. No denial rule's absence can substitute for a missing replay result.
ESCALATE is not executable until separately approved and revalidated.

For a bounded mandate:

`budget = available + activeReserved + committed`

`quantityLimit = availableQuantity + activeReservedQuantity + committedQuantity`

AUTHORIZED and EXECUTING reservations consume available authority. UNKNOWN
attempts keep EXECUTING reservations: quarantine is a subset of activeReserved,
not an additional resource to count twice. Released/expired/proven-unexecuted
failed reservations restore capacity once. Committed consumption never restores
capacity. Accounting validates snapshots and relationships before summing;
inconsistent states fail closed rather than getting normalized into authority.

`authority-conservation.test.ts` uses xorshift seed `0x504159`, 128 bounded
samples, real domain structures, kernel decisions and canonical identities.
Mutations cover money/currency, quantity/missing quantity, merchant/case, category,
condition/missing condition, agent/mandate/fingerprint, capability escalation,
unsafe integers, exhausted money/quantity and replay. Separate mutations prove
upstream changes invalidate the existing fingerprint and downstream changes
invalidate the proposal digest. Array sets are sorted where already specified;
case-sensitive merchant identity is not broadened by case folding.

## Transactions, races and fault boundaries

Authorization locks current authority and claims replay/reserves/accounting/
evidence within one transaction. Confirmation locks durable review and current
principal/passport/policy authority before one-time activation. Claim and dispatch
are separate short transactions; no PostgreSQL transaction spans a PayPal request.
Reconciliation uses a session advisory lock across those transactions to serialize
workers for one attempt. Finalization locks attempt, grant and reservation and
checks exact bindings/states plus affected rows before commitment evidence.

The existing paths do not impose one universal lock order across every service;
reservation-first and mandate-first paths can encounter PostgreSQL deadlocks.
A serialization/deadlock error aborts its transaction and does not authorize an
operation. No catch converts a database abort into ALLOW or provider dispatch.
In-flight unclassified failures quarantine authority. This audit does not claim
deadlocks or infrastructure failures are impossible, or add automatic financial
transaction retries. Fault injection uses test spies/triggers only, never a
production fault switch.

Concrete tests cover two-pool authorization/confirmation/quantity/execution,
revocation vs handoff, expiry while waiting on evidence, suppressed affected rows,
reservation/evidence and activation rollback, signing persistence failure,
provider response loss, finalization rollback, restart/replay and simultaneous
reconciliation. New tests race release against capture, and inject release-evidence
failure after transition, proving rollback retains budget and quantity across
connections and repeated delivery cannot restore capacity twice.

## PayPal state-machine oracle and distributed boundary

The test oracle enumerates the existing NOT_STARTED, ORDER_CREATING,
ORDER_CREATE_UNKNOWN, ORDER_CREATED, PAYER_ACTION_REQUIRED, CAPTURE_PENDING,
CAPTURE_IN_FLIGHT, CAPTURE_UNKNOWN, CAPTURE_PENDING_PROVIDER, CAPTURED,
FAILED and CANCELLED states. It rejects unlisted edges, backward resurrection,
unknown states and direct NOT_STARTED → CAPTURED skipping. It models observation
of an existing completed capture and idempotent terminal observation separately
from fresh dispatch. A real PostgreSQL lost-capture/restart trace is checked
against the oracle, including provider side-effect count exactly one.

This is an oracle for documented transitions, not a replacement production state
machine or a claim that all corruption is recoverable. FAILED/CANCELLED return
without new dispatch, but inconsistent financial accounting still fails closed
for investigation. Existing corruption tests cover impossible grant/reservation/
attempt combinations and wrong provider identities/money/status/reference.

The dispatch transaction commit is the revocation linearization point. Authority
changes winning the relevant lock before handoff prevent that operation. After
handoff that specific operation may proceed even before bytes leave the process;
subsequent independent operations require current authority. PostgreSQL and PayPal
cannot share an atomic transaction. GET and retry are not atomic. Recovery relies
on the identical persisted provider request IDs and finite provider retention;
at/outside the conservative six-hour retry boundary, unresolved authority stays
quarantined. No perfect exactly-once distributed execution is claimed.

## Grant rotation, versions and canonical identities

PublicKeyResolver is the trusted deployment verification-key policy boundary.
StaticPublicKeyRing has no automatic expiry/revocation: the host must remove a
revoked/retired key or supply a resolver enforcing its overlap policy. PostgreSQL
rotation tests use the real execution boundary and signed grants to test current
key, previous key before overlap end, exact overlap expiry, revoked/unknown keys,
wrong key identity and replay after rotation. Signing remains Ed25519 only; kid,
audience and v1 envelope are exact and the grant's own TTL remains independent.
No HSM/KMS or deployed key rotation service is claimed.

Mandate version is an authority revision bound in its fingerprint, not an
execution-format negotiation. Grant, intent and model contracts reject unsupported
format versions. The additive migration suite preserves historical fingerprints,
receipt/grant snapshots, evidence and NULL legacy quantity semantics. No old
migration is rewritten. Canonical mandate/proposal hashes retain their historical
formats. Hashes do not all have explicit domain prefixes; typed object shapes,
separate binding fields and exact comparisons provide current domain context.
The provider request-ID format separates create/capture. A future incompatible
hash format must introduce a versioned domain and migration compatibility rather
than changing old fingerprints in place. Arbitrary Unicode metadata is exact
content, not normalized natural-language authority; normalization/case folding
must not silently widen identifiers. Equivalent supported ASCII property order
and set order are tested; no universal cross-locale Unicode equivalence is claimed.

## Independent evidence verification

`verifyTrustTrace()` is read-only, imports no authority/execution service and
accepts a complete durable ledger from sequence 1. It independently validates
strict event shape, bounded records/payloads, unique event IDs, contiguous sequence,
previous hashes and the existing canonical SHA-256 hashes. It checks represented
review/confirmation identity and exact draft/review hashes, one activation per
review, reservation → issued grant → claim → attempt bindings, recognized dispatch
states, unique capture-resolution identity, one grant per reservation, one attempt
per grant and one logical commitment. Rehashed missing,
duplicate, substituted or conflicting represented relationships fail verification.
Actual committed PostgreSQL full-system evidence exercises this path.

Only relationships present in event data can be verified. For example, the ledger
does not carry every full mandate/proposal/signature/provider response, so this
verifier does not cryptographically verify their source authenticity, claim all
legacy history contains human confirmation, or prove missing dispatch observations
are impossible. Unknown diagnostic event types receive chain validation only.
Database state transitions remain enforced by the transactional application, not
by this verifier. Privileged administrators can rewrite and recompute a chain.
An independently trusted head anchor detects valid-tail truncation; without one,
it cannot be detected. There is no external immutable anchor or sealing service.

Limits: 100,000 events per complete verification, 100 flat payload fields and
65,536 canonical payload characters per event. Larger investigations require an
explicit future checkpoint/pagination verification design, not silent truncation.
The existing append path checks its entire ledger and remains an operational
scalability limitation; this milestone does not redesign it.

## Authentication, privacy and merchant limits

HumanConfirmationBoundary is not a deployed login system. The web host must
provide a secure HUMAN session, no body-supplied principal identity, exact
origin/audience/action binding and explicit reviewed-term confirmation; CSRF and
origin checks, clickjacking protection, secure cookies where applicable, rotation,
expiry and sensitive-action reauthentication remain host responsibilities. Private
context registration prevents caller-created/cloned objects from authenticating.
An agent/model cannot be the human verifier or confirm its own mandate.

Logical merchant allowlists and quantity accounting are enforced in proposals,
receipts, grants and current revalidation. They do not prove PayPal payee routing,
merchant fulfillment identity, SKU or delivered quantity. M4 needs stable discovery
merchant/product IDs, authoritative price/currency/condition/quantity and, before
claiming payee verification, an implemented provider/payee binding. No imaginary
PayPal routing mechanism is added here.

Provider inputs contain only the minimum source/structured payment context.
No private signing keys, authentication proofs, provider credentials or OAuth
bearer tokens are written to evidence through the reviewed paths. Groq transport
and parsing retain their bounded call/token/input/output/time/depth limits and
zero automatic retries. Live-provider smoke flags remain exact true opt-in;
normal CI requires no Groq/PayPal/Channel3 secrets or live requests. Raw user source
can itself contain sensitive information; storage/provider retention and access
controls remain operational requirements. Secret-pattern scanning is a useful
check, not proof arbitrary unknown secrets can always be recognized.

## M4 entry contract

All discovery providers, product metadata and AI candidate selection are untrusted.
They cannot create or widen authority. A candidate must become an ordinary typed
PayFlow proposal and pass the same mandate → deterministic authorization →
reservation → signed grant → current dispatch revalidation → provider verification
→ evidence path. Discovery receives no authentication authority, signing keys,
mandate mutation access or PayPal credentials. Price, logical merchant, condition,
quantity and currency must be revalidated from authoritative execution-time data
where technically possible; unavailable provenance must not be described as
verified routing or fulfillment. Discovery cannot bypass the human-confirmed
bounds, infer CAPTURE_PAYMENT from CREATE_ORDER, or resolve ambiguity by inventing
a new authority/key. No Channel3, discovery orchestration or M4 code is included.

## Dependency audit

Production dependencies are PostgreSQL's client and Zod; crypto and HTTP use Node
built-ins. The production-only high-severity audit is a required gate. No force
upgrade or dependency change is included in M3F.

The complete development audit at review time reported these toolchain advisories:

| Package             | Reported severity     | Reachability in this repository                                                                                                    | Remediation assessment                                                                             |
| ------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| vitest              | critical              | Test runner; UI/API server is not started by CI or production                                                                      | Reported complete fix requires a major runner upgrade; defer a separately validated tooling change |
| @vitest/coverage-v8 | critical (transitive) | Coverage-only dependency of the test runner                                                                                        | Upgrade together with compatible Vitest, not independently                                         |
| tinypool            | critical              | Test worker option gadgets require attacker-controlled/polluted worker configuration; model/caller payloads are not worker options | Reported fix via major Vitest upgrade; do not apply an untested override                           |
| vite                | high                  | Development server/Windows path issues; normal CI uses headless tests and production uses compiled TypeScript                      | Major compatible toolchain upgrade is separate work                                                |
| @vitest/mocker      | moderate              | Redirect mock path handling; repository-controlled tests, not a deployed financial API                                             | Upgrade with compatible Vitest                                                                     |
| vite-node           | moderate (transitive) | Test execution only                                                                                                                | Upgrade with compatible Vitest                                                                     |
| esbuild             | moderate              | Affected Vite transitive dev-server path; no esbuild development server is exposed                                                 | No blind dependency override inside the old Vite toolchain                                         |

These findings are not a claim that development dependencies are harmless. Never
expose test/dev servers to untrusted networks or execute unreviewed repository
code with provider/signing/deployment secrets. CI intentionally has no such
provider secrets. No advisory above is a production-runtime dependency in the
reviewed build. A targeted toolchain update must retain all security assertions
and be verified separately rather than using audit --force to obtain a prettier
number.
