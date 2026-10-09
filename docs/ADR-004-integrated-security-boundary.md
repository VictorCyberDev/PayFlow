# ADR 004: Integrated authorization and payment boundary (Milestone 2E)

## Review findings and decision

The review of M1 through 2D found concrete defects in normal execution that the
2D reconciliation repair did not cover: independent Payment Attempt/grant/
reservation finalization, release after an unclassified sink or local commit
failure, insufficient current-authority checks on recovery dispatch, mutable
proposal references in receipts, incomplete durable shadow-column checks,
executing-reservation release through general transition APIs, and evidence
identity sequence gaps after rollback. M1's mock-only service also retained
mutable authorization objects and had no concurrent execution claim/budget hold.

Normal PayPal execution now uses the same serialized recovery/finalization path
as reconciliation. This preserves the existing architecture and Sandbox adapter.
The external entry point is `ExecutionBoundary.execute(signedToken, now)`.
`PayPalExecutionRail` is a trusted internal sink/recovery component, not an agent
API. Principal identities passed to approval/revocation services must come from
an authenticated server session; this repository is a domain library, not an
Internet-facing authentication server. No LLM participates in authorization.

## Complete trust boundary

Principal -> Agent Passport -> Mandate -> Proposal -> deterministic Trust Kernel
-> immutable authorization receipt/proposal snapshot -> replay claims and
reservation -> principal approval for ESCALATE -> Ed25519 execution grant ->
current durable-state revalidation -> atomic grant claim/reservation EXECUTING ->
durable Payment Attempt and persisted provider request IDs -> Sandbox PayPal ->
strict provider verification -> atomic attempt/grant/reservation/evidence commit.

Receipt snapshots detect mutation before grant issuance or human approval. Grant
snapshots detect mutation of immutable persisted claims, including lifetime.
Relational shadow fields are checked against documents. Accounting refuses inconsistent
reservation/receipt/grant bindings and impossible claimed/committed lifecycle pairs. The financial rail admits
only CREATE_ORDER/CAPTURE_PAYMENT and checks principal, agent, mandate, proposal,
receipt, reservation, grant, capability, logical merchant, amount and currency.
Provider verification checks order ID, one purchase-unit reference, money,
currency, status, one capture and previously observed capture ID. The adapter
pins the Sandbox URL and server-managed OAuth credentials. A logical merchant ID
is not a verified PayPal payee account: multi-merchant payee routing is outside
this implementation and must not be inferred from `reference_id`.

## Locks, dispatch and revocation

Lock order is attempt (where present) -> grant -> reservation -> mandate ->
proposal -> passport -> approval. Issuance starts at reservation; authorization
starts at mandate. Initial proposal lookup only finds the mandate; authorization
rereads and locks that proposal after locking its mandate. Evidence is appended
last, under a global transaction advisory lock. General transitions cannot
manually execute/finalize a reservation associated with an execution grant.

A session advisory lock serializes a Payment Attempt across provider requests.
OAuth and order HTTP requests have a 15-second deadline and no internal retry loop.
Short local transactions validate and commit a dispatch intent, then commit or
roll back before any network request. No PostgreSQL transaction spans PayPal.
Dispatch samples fresh clock/monotonic elapsed time after provider waits and
authority locks; the reconciliation entry timestamp cannot keep expired authority
valid. Dispatch rechecks passport suspension/revocation/expiration, mandate revocation/
expiration/fingerprint, grant and reservation expiration, capabilities, bindings,
and approval state. Expiration is exclusive, including the exact boundary.

The authorized dispatch commit is the local handoff boundary. Revocation that
wins the corresponding authority row lock before that commit prevents dispatch.
Revocation after handoff cannot recall an already dispatched request; even a
revocation immediately before bytes leave the process can lose this race.
Suspension during create prevents a subsequent capture dispatch. Recovery may
GET and finalize an already completed capture after revocation/expiration, but
may not dispatch another operation using revoked/expired authority. Completed
PayPal effects cannot be undone by local revocation.

## Crash/restart matrix

| Window                                              | Control and executable coverage                                                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: authorization before reservation/evidence commit | One transaction; existing forced-reservation-failure rollback test plus rollback-safe ledger test.                                                 |
| B: reservation before grant issued                  | Issuance transaction and uniqueness; corrupt/mutated authority issuance tests leave reservation without a grant or provider effect.                |
| C: claim before provider                            | Claim evidence, CLAIMED/EXECUTING state, unique grant/reservation attempt; crash-boundary fixture resumes the same grant, not a new authorization. |
| D: create succeeds, response lost                   | Existing restart test reuses persisted create request ID and counts one logical order.                                                             |
| E: capture succeeds, response lost                  | GET discovers capture; existing and full-boundary tests count exactly one financial effect and no recapture.                                       |
| F: provider succeeds before finalization            | Lost-response and injected finalization-failure tests converge through GET.                                                                        |
| G: finalization fails halfway                       | Injected PAYMENT_COMMITTED failure and suppressed grant transition roll back all local transitions/evidence.                                       |
| H: commit before caller response                    | Repeated reconciliation and concurrent full-boundary test recognize completed state and one logical commitment.                                    |

Crash tests inject equivalent persisted boundaries/errors; they do not prove all
operating-system kill/storage failure behavior or arbitrary process schedules.

## Recovery, quarantine and idempotency

Unknown/creating/in-flight/pending states retain CLAIMED/EXECUTING authority and
continue consuming the budget. Executing reservations cannot be released, failed
or expired by general reservation APIs. Only an explicitly proven no-side-effect
`ExecutionRejectedError` can release a generic sink's authority; unclassified
errors and errors after provider success quarantine it. PayPal recovery is more
conservative and quarantines provider rejection until investigated.

Create recovery reconstructs the request from durable state and reuses the exact
persisted create key. Capture recovery always GETs first. A verified existing
capture is reconciled without another capture call. Only an APPROVED, fully
bound order without capture/payer action can dispatch the same capture key.
Repeated ambiguity remains unknown. Key values must retain their deterministic
original attempt binding; recovery never replaces them or creates another grant.

GET and retry are not atomic at PayPal. The deterministic race test changes
provider state after the GET snapshot and retries the same key; idempotent
provider simulation records exactly one financial effect. Delayed visibility
also depends on the provider honoring the original key. This is a provider
idempotency dependency, not an exactly-once distributed guarantee.

The conservative retry window is strictly less than six hours from the original
attempt, never extended by recovery. Tests include the last millisecond inside,
the exact boundary, outside, a future origin and malformed time. Current grant
expiration can prohibit dispatch much sooner. Outside safe retention, unknown
outcomes remain quarantined for investigation; do not invent a new key.

`reconciliationCandidates()` lists unresolved attempts deterministically;
`claimedGrantsWithoutAttempts()` identifies the pre-attempt crash window. These
are trusted operational APIs, not an automatic scheduler or unbounded retry loop.
Investigate expired/revoked unresolved operations, mismatched provider responses,
corrupted bindings/lifecycle/ledger, missing objects and expired retention. Preserve
evidence and provider IDs; never normalize corrupt financial state into success.

## Finalization and evidence

Under locks, successful finalization checks exact IDs/bindings/provider money and
state, then verifies affected rows: attempt CAPTURED, grant CONSUMED, reservation
COMMITTED. PAYMENT_COMMITTED is in that same transaction. A failure rolls back
all changes. The generic ledger API also locks/checks the finalized financial
rows and refuses missing, substituted or duplicate PAYMENT_COMMITTED events. Repeated/concurrent reconciliation cannot append a second logical
commitment. Original ALLOW/ESCALATE receipts are never rewritten by approval.

Migration 004 freezes receipt proposal/document and immutable grant snapshots,
adds a durable mandate revocation timestamp, and removes nontransactional identity
allocation from evidence sequence numbers. Appends allocate the explicit next
sequence under the existing advisory lock and verify the existing chain first.
Rollback consumes no number. Historical evidence is not rehashed or silently
repaired. Legacy snapshots are backfilled from migration-time state; they cannot
prove that old documents had never changed. Legacy terminal FAILED/CANCELLED PayPal attempts require investigation before
new authority accounting: old failure labels are not proof of no financial effect.
No automated rewrite of their financial history is performed. Previously broken evidence requires
investigation; the migration deliberately does not rewrite history.

Errors in evidence use bounded reason codes instead of exception text. OAuth
credentials/tokens, authorization headers, private keys and full provider bodies
are not persisted. Tests use synthetic sentinels for redaction. Environment
examples contain placeholders. The hash chain detects accidental/application
corruption; it is not tamper-proof against a privileged database administrator
who can rewrite the whole chain and snapshots. Protect database access and keys.

## Residual limits

Sandbox-only behavior, deterministic provider simulation and PostgreSQL CI are
not proof of all live provider behavior. No live PayPal is supported. Provider
retention, eventual visibility and correct provider idempotency remain external
dependencies. No local transaction can atomically commit an external effect.
Clock inputs are trusted server inputs, not agent-controlled parameters; deployment
must use synchronized clocks. Session locks serialize cooperative workers, not an
arbitrary hostile SQL writer. Investigation is required when outcome or security
state cannot be proven. No Milestone 3 or natural-language mandate layer is added.

## Final invariant proof inventory

These are bounded claims about the trusted runtime, cooperating PostgreSQL workers
and the provider idempotency contract described above, not claims against a
compromised host/provider/database administrator.

| Question                                                         | Control and concrete executable test                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spend more than authorized?                                      | Mandate-serialized accounting, safe integers, active holds; M2B concurrent cumulative-budget tests and 2E corrupt-accounting/M1 concurrent-budget tests.                                                                                                   |
| Substitute merchant/money/capability?                            | Signed claims, frozen receipt/proposal/grant bindings and strict provider verification; 2E signed-payload, post-approval mutation and normal-execution provider-substitution matrices. Logical merchant is bound; PayPal payee routing is not implemented. |
| Spend using a stale/revoked grant?                               | Current authority revalidation at claim and each dispatch; existing 2C stale-authority tests and 2E revocation stages, after-GET races and post-create suspension.                                                                                         |
| Two workers spend one reservation twice?                         | Atomic one-time claim, unique attempt and session serialization; two-instance full-boundary test and existing concurrent grant/reconciliation tests count one effect/commit.                                                                               |
| Lost responses cause duplicate capture?                          | Persisted key, GET before retry, bounded retention; provider DID/DID NOT capture tests, delayed visibility and GET-to-retry race count one effect.                                                                                                         |
| Malformed provider response create false success?                | Full order/reference/money/currency/status/capture validation; normal-execution and recovery substitution matrices retain quarantined authority.                                                                                                           |
| Corrupt PostgreSQL state become authorization?                   | Schema relationships/uniqueness, shadow/snapshot checks, accounting consistency and claim evidence; missing-attempt-field, grant corruption, receipt mutation and impossible lifecycle tests.                                                              |
| UNKNOWN release authority?                                       | Executing holds survive expiry/release/failure APIs and unclassified sink errors; 2E reservation transition, repeated ambiguity and corrupt-accounting tests.                                                                                              |
| PAYMENT_COMMITTED without durable transitions?                   | Locked finalization, affected-row verification and same-transaction evidence; suppressed grant transition and injected finalization crash tests prove rollback and one subsequent commitment.                                                              |
| Secrets enter evidence/log/database through payment diagnostics? | Whitelisted evidence fields, bounded reason codes, no raw response/exception persistence; synthetic HTTP and unclassified-sink redaction tests plus existing no-token evidence test. IDs remain necessary forensic data.                                   |
| Network while critical PostgreSQL transaction held?              | Explicit dispatch commit and short finalization transactions; existing provider-boundary test inspects PostgreSQL activity on each create/GET/capture.                                                                                                     |

Human approval tests additionally cover concurrent duplicate submission, wrong
principal/proposal, revoked/expired approval after claim, and altered financial
fields after approval. Approval remains receipt-specific and does not rewrite its
historical ESCALATE decision. The authorization/reservation revocation race test
observes the blocked PostgreSQL revoker before releasing the authorization
transaction, then proves grant issuance is denied.
