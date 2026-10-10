# ADR-008 — Adversarial end-to-end trust boundary hardening

Status: Milestone 3D adversarial hardening; exact-head PostgreSQL CI verification required.

Baseline: `cd643b453b09c6a7478151bc7e0a5848c4153284`.

## Threat matrix established before production changes

The attacker controls source, model output, request bodies, proposals, ordering,
replays and timing. Authentication internals, signing keys and database superuser
access are not legitimate attacker capabilities. Corruption tests additionally
exercise the application's documented fail-closed state validation.

| Transition                     | Attacker input                                   | Trusted input / invariant                      | Existing enforcement                                                        | Attack / expected failure                                         | Executable coverage                       |
| ------------------------------ | ------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| A: source → Groq               | Text, fake roles/tools                           | Static instruction; source is data             | Separate roles, JSON encoding, bounded request                              | Injection cannot modify instruction or trusted bounds             | intent-model tests                        |
| B: response → interpretation   | JSON, duplicates, authority fields               | Exact strict contract                          | Bounded transport, duplicate/prototype parser, strict Zod                   | Malformed/authority-shaped data rejected                          | intent-model, intent tests                |
| C: interpretation → compiler   | EXPLICIT claims, proposed values                 | Source spans and independently supplied bounds | Discriminants, exact quotes, money conversion, semantic checks              | Inference, unsupported/widened authority cannot compile safely    | intent, intent-model tests                |
| D: compiler → draft            | Candidate constraints                            | Draft is never authority                       | Immutable canonical draft and fingerprint; explicit activation requirements | Fingerprint cannot authenticate; altered terms invalidate binding | intent tests                              |
| E: draft → review              | Interpretation, intended IDs                     | Sealed human context, trusted intake/policy    | Recompile; passport/principal/policy locks and snapshot                     | Cross-owner or unsupported review rejected                        | activation integration tests              |
| F: review → confirmation       | IDs, hashes, challenge, assertions               | External human authentication for exact action | Opaque frozen contexts; strict request and action binding                   | Fake/serialized/cross-boundary/expired proof rejected             | activation unit/integration tests         |
| G: confirmation → mandate      | Replays, stale browser state                     | Current authority and exact durable terms      | Locked review, epochs, hashes, fresh time, guarded atomic inserts/evidence  | Replay/stale state/rollback creates no authority                  | activation integration tests              |
| H: mandate → proposal          | All proposal fields                              | Fingerprinted current mandate and agent        | Strict schemas, relational/document validation                              | Substituted bindings or malformed state fail closed               | persistence, kernel tests                 |
| I: proposal → authorization    | Price, condition, capability, quantity, merchant | Deterministic current policy                   | Kernel checks and durable replay claim                                      | Invalid/widened proposal DENY before provider                     | kernel, durable authorization tests       |
| J: authorization → reservation | Concurrent proposals, timing                     | Budget/quantity cannot overspend               | Mandate lock, receipt snapshot, durable reservations/accounting             | Exactly bounded reservations; UNKNOWN consumes authority          | durable authorization, activation tests   |
| K: reservation → grant         | IDs, mutated proposal, stale authority           | Exact live receipt/mandate/reservation         | Revalidation, snapshots, Ed25519 signing                                    | Mutation, released/expired authority cannot issue grant           | execution-grant integration tests         |
| L: grant → dispatch            | Token mutation/replay, revocation                | Signed digest plus current durable authority   | Signature/audience/kid/TTL; atomic claim; short dispatch transaction        | No provider effect before authorized handoff                      | execution-grant, PayPal integration tests |
| M: provider → financial state  | Wrong/malformed/ambiguous response               | Verified order/capture and local state         | Strict binding/amount/status validation; atomic finalization/evidence       | Uncertainty quarantines; no false commitment                      | PayPal unit/integration tests             |
| N: recovery → final state      | Retry ordering, crashes, stale workers           | Original durable IDs and provider truth        | Advisory serialization; GET before safe capture retry; same persisted keys  | No new logical operation; uncertainty retains authority           | PayPal integration tests                  |

Candidate gaps to investigate: mutable provider inputs across asynchronous waits,
canonicalization omissions, activation failure logging, quantity restoration and
state corruption, and activated-mandate behavior through all execution boundaries.
No production change is justified until a reproducing test proves a defect.

## Confirmed defect and minimum repair

A reproducing unit regression against 3C showed that the public activation service
copied `rawBinding.reviewId` into rejection evidence **before** requiring an
opaque authenticated context. An unauthenticated caller could therefore persist
an arbitrary credential-bearing string as a review ID. This was an audit/privacy
defect, not a financial authorization bypass. The regression failed with the
synthetic marker in the evidence append arguments before the production repair.

The service now records only a fixed sanitized rejection code until authentication,
durable review lookup and principal/agent ownership checks succeed. Any included
review ID comes from that verified durable row. Raw authentication assertions,
exception text and client IDs are not logged. The same regression now passes;
a real PostgreSQL counterpart checks persisted evidence. No schema, financial
semantics, model instruction or execution architecture changed.

## Executable verification strategy

`tests/trust-boundary.test.ts` adds 80 adversarial cases: 21 source-role/tool/policy
injections through the real Groq adapter with mocked HTTP; 11 financial widening
cases against independent bounds; 12 authority-bearing model field attacks;
11 malformed/duplicate/prototype JSON cases; seven invalid decimal values;
quantity and exact merchant identifier attacks; 128 deterministic generated
budget/quantity/merchant combinations; field-by-field canonical mandate/proposal
mutations; transitive model isolation; and the logging regression.

`tests/trust-boundary.integration.test.ts` joins the existing migrations and real
PostgreSQL integration command. It drives the actual interpretation/compiler,
authenticated review, confirmation, activation, authorization, reservation,
Ed25519 grant, execution boundary, PayPal rail and evidence chain. Its fake provider
counts remote create calls and financial capture side effects separately. Two
independent PostgreSQL pools exercise concurrent confirmations and quantity
limits 1, 2 and 5. Exactly permitted reservations proceed to financial effects;
losers must specifically receive QUANTITY_EXHAUSTED.

The full-chain control commits one payment. Single-field price, condition,
merchant and quantity attacks deny without a reservation. Cross-review
substitutions fail; 13 proposal mutations are exercised independently before grant
issuance and after issuance; eight mandate mutations and three post-grant
revocations prevent provider dispatch. Parallel execution can commit only once.
Lost capture responses consume quantity until restart GET reconciliation discovers
the single completed capture, including after revocation. Reconciliation does not
call capture again. Released, failed or expired unexecuted reservations restore
quantity; UNKNOWN cannot be released or expired. Corrupted reservation quantity
fails closed. An injected evidence-write exception rolls back mandate creation,
confirmation consumption and accepted-confirmation evidence without leaking the
exception marker.

Existing tests remain necessary evidence: `intent-activation` tests systematically
mutate canonical reviewed terms, stale epochs, ownership and expiry; grant suites
attack signatures, audience, keys, lifetime, claims, replay and durable snapshots;
PayPal integration tests cover crash windows, repeated ambiguity, persisted create
and capture keys, retention boundaries, GET→retry races, malformed provider
responses, zero-row/rollback finalization, corrupt evidence and concurrent
reconciliation. Their deterministic handoff races prove pre-handoff revocation
wins with zero dispatch, while post-handoff revocation cannot recall only the
specific frozen operation. All suites run again in CI; none are removed or weakened.

### Scenario A and clarification

The short demo sentence alone does not establish every required term: a dollar
symbol does not identify USD, and expiry/category/capabilities are not specified.
A new test therefore requires clarification rather than inventing permission.
The end-to-end success scenario uses the explicitly clarified source with exact
USD, category, quantity, merchant, condition, capabilities and ISO expiry, then a
separately authenticated human confirms it. No compiler rule is weakened to make
a natural-language demo silently activate.

## Final security questions and concrete controls

| Question                                                               | Answer                                        | Control and executable evidence                                                                               |
| ---------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Can model output create a trusted mandate?                             | No                                            | Strict interpretation contract, separate opaque human activation; model dependency graph and activation tests |
| Can model output authenticate a human?                                 | No                                            | Host verifier and private context registry; forged-context tests                                              |
| Can a fingerprint authenticate a human?                                | No                                            | Exact action-bound authentication independent of hashes; activation tests                                     |
| Can an agent confirm its authority?                                    | No, assuming the host enforces HUMAN identity | HumanActionAuthenticator contract, principal/agent bindings; forged actor/context tests                       |
| Can confirmed:true activate?                                           | No                                            | Strict request and sealed context; unit and PostgreSQL rejection tests                                        |
| Can stale reviews activate after policy/revocation changes?            | No                                            | Locked current authority and security epochs; stale-review/race tests                                         |
| Can confirmation replay create another mandate?                        | No                                            | Locked one-time lifecycle; eight concurrent confirmations, existing restart replay tests                      |
| Can quantity reservations exceed the mandate?                          | No                                            | Mandate lock and durable quantity sum; generated bounds and two-pool limits 1/2/5 tests                       |
| Can a prohibited merchant pass the kernel?                             | No                                            | Exact canonical identifier allowlist; generated/unit and full-chain merchant denial                           |
| Can quantity/merchant mutate after authorization without invalidation? | No                                            | Receipt snapshot, digest, current commerce checks; 13 proposal mutations at two downstream boundaries         |
| Can proposal mutation survive grant binding?                           | No                                            | Ed25519 signed canonical digest plus durable receipt; mutation and grant suites                               |
| Can expired/replayed/forged grants reach PayPal?                       | No                                            | Signature/kid/audience/TTL/atomic claim; grant integration suites and parallel full-chain execution           |
| Can pre-handoff revocation prevent the provider effect?                | Yes                                           | Current locked authority before dispatch commit; forced PostgreSQL handoff races count zero dispatch          |
| Can ambiguity silently become success?                                 | No                                            | Strict provider evidence and atomic fail-closed finalization; PayPal fault matrix                             |
| Can UNKNOWN release authority?                                         | No                                            | Quarantine and guarded reservation transitions; new UNKNOWN quantity test and PayPal corruption tests         |
| Can Groq reach signing keys/PayPal credentials?                        | No through the reviewed dependency/API path   | Narrow source-only provider interface, transitive import allowlist, transport request minimization tests      |

## Residual risks and operational limits

These are executable bounded tests, not a formal proof for every interleaving or
arbitrary language. Semantic checks cannot establish arbitrary natural-language
faithfulness; human review and independently trusted bounds remain required.
The deployment must supply genuine human session authentication, exact-action
binding, CSRF protection, active identity checks and authentication secrets; this
milestone does not build a browser identity platform. The model is not given those
capabilities. Arbitrary user-entered source may contain sensitive data; review
storage and external-provider retention need operational access/retention policy.

Logical merchant identifiers and quantity accounting do not prove PayPal payee
routing or fulfillment quantity. Privileged database administrators are outside
the evidence tamper-resistance guarantee. PostgreSQL and PayPal do not share an
atomic transaction. The committed dispatch handoff is the formal revocation
linearization point, not proof bytes have left the process. GET and capture retry
are not atomic; safety depends on the same original persisted provider idempotency
key within the bounded retention window. Unresolved operations outside that
window stay quarantined for investigation. No perfect exactly-once claim is made.
No new autonomous scheduler, webhook endpoint, live payment rail, product
discovery, final UI or model authority is introduced.

Normal CI makes no live Groq or PayPal calls and requires no credentials. Optional
smokes remain explicitly opt-in. Local PostgreSQL is unavailable in this workspace;
full exact-head CI with the existing ECR PostgreSQL 17 service is mandatory before
independent review. Test counts, coverage and exact CI identifiers belong in the
verification report for the final commit, not predictions in this ADR.
