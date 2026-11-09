# R0 — financial safety and transaction correctness (2026-11-09)

Status vocabulary as in `V3-FINAL-REPORT.md`. Everything here is `COMPLETE_LOCAL` (code + PostgreSQL + real in-process Gateway); nothing is deployed, nothing ran against a public database or a real provider.

## 1. P0 — a mission-governed payment is bound to its approved order at the Gateway

**Defect.** A mission compiled stored Authorities, and M40 issued purchase orders, but the Gateway never looked at the order: any agent holding a mission Authority could pay anything the Authority's merchant/amount ceilings allowed. M40 reconciliation noticed a mismatch only *after* money moved.

**Fix.** `ExecutingGateway.requestPurchase` now fails closed in both directions:

| Authority | request | result |
| --- | --- | --- |
| compiled from a mission (even a revoked one) | no `missionOrder` | `MISSION_BINDING_REQUIRED`, zero effect |
| not from a mission | `missionOrder` present | `NOT_A_MISSION_AUTHORITY`, zero effect |
| compiled from a mission | `missionOrder` = `po_…` or `cpy_…` | bound as below |

Binding (`src/missions/execution-binding.ts`, migration `053_r0_execution_intents.sql`):

1. The order is **loaded server-side**; the id the agent sends is only a lookup key. Authority, agent and document digest must match the stored order (`ORDER_NOT_FOUND`, `ORDER_AGENT_MISMATCH`, `ORDER_INTEGRITY_FAILURE`).
2. The agent's claimed amount, currency and merchant must equal the order (`ORDER_CLAIMED_TERMS_MISMATCH`).
3. Live state is checked: order lifetime, mission `ACTIVE`, mission version equals the version the Authority was compiled for, Authority link `ACTIVE`, mission not past its deadline, agent still holds `PURCHASE`, acceptance not withdrawn, budget item still `APPROVED`/`COMMITTED`, quote neither expired nor superseded. For contractor payments: contract not terminated, deliverable accepted, milestone budget `COMMITTED`.
4. A durable **execution intent** is inserted. A partial unique index allows one live intent per order, so competing purchases are refused *before* the provider (`ORDER_ALREADY_IN_PROGRESS`).
5. The **trusted checkout quote** (not anything the agent said) is compared with the order *before* any manifest, proposal, reservation, grant or provider call: merchant, currency, SKU, quantity, unit price, shipping, discount, tax+fees, total (`checkQuoteAgainstOrder`). Multi-line, SKU-less or price-less orders are refused (`ORDER_MULTI_LINE_UNSUPPORTED`, `ORDER_SKU_REQUIRED`, `ORDER_UNIT_PRICE_REQUIRED`). Contractor instructions are bound on payee, currency and amount (`checkQuoteAgainstPayment`).
6. **Immediately before dispatch** (after the Trust Kernel reservation and grant) the live checks run again and the intent moves `PENDING → DISPATCHING` by compare-and-set (single use).
7. Afterwards the intent records `COMPLETED`, `NO_EFFECT` (a refusal or a rail that proved no effect — the order is free again) or `UNKNOWN` (held; never auto-retried).

No database lock is held across a network call. Reconciliation (M40/M50) is unchanged and remains the second line of defence.

**Scope limits, stated plainly.**
- The checkout path buys one catalog offer. An order is payable only if it is a single line with a catalog SKU and unit price. Orders from supplier quotes whose lines have no SKU (the earlier M40 fixtures) can be issued but **cannot be paid through the demo rail** — that is the correct refusal, not a regression.
- There is no payout rail. A contractor milestone "payment" pays a catalog item for the named payee on the sandbox rail; it is not a transfer to a person.
- `costCenter` and `invoiceRef` are fixed in the order document and its digest (an altered document fails the digest check); the provider never receives them, so they cannot be compared against the quote.
- tax+fees are compared as a sum with the mission quote's tax+duties+fees. Because total, shipping and discount are bound exactly, that comparison is defence in depth.

**Tests** (`tests/r0-order-binding.integration.test.ts`, 14 tests; every refusal asserts provider call count, budget stage, reservation count and intent state):
bypass without order; order on a non-mission Authority; revoked mission cannot become generic; wrong amount/currency/merchant; unknown/malformed order; wrong agent credential; SKU, quantity, unit price, shipping, discount mismatches; expired order; superseded quote; paused→resumed mission; stale mission version; budget item released; replayed nonce; same nonce for another order; six concurrent requests → one capture; tampered document; intent immutability; deterministic two-claimant race on the partial unique index; revoke between claim and dispatch (`beforeDispatch`); and an end-to-end DB failpoint that revokes the mission's Authority link *after* the reservation and *before* the provider call.
Hand-run mutations that each fail a test: removing the quote guard, the missing-order refusal, the live re-check, the single-use compare-and-set, and the `beforeDispatch` stop.

Callers updated: M29 (Authority compiler), M40, M41–M45 via `settledPurchase`, M50. M40/M50 "mismatching payment" tests became two-line tests (refused at the Gateway; reconciliation still holds the budget if a payment for one order is offered for another).

## 2. P0 — M49 offer acceptance is one transaction

**Defect.** `answer(ACCEPTED)` committed each milestone through separate ledger calls, then inserted the contract and flipped the offer in a second transaction whose `UPDATE … WHERE status='SENT'` result was ignored. A concurrent DECLINE or a failure at milestone *n* left committed budget with no accepted offer, or a contract for a declined offer.

**Fix.** `TalentOfferService.accept` runs in one `sql.begin`: lock the offer row; verify `SENT`, expiry, scope in force and required checks under the lock; create every milestone item with `LedgerService.createItemInTx` (new, transaction-aware, nothing touches the pool); insert the contract; move the offer `SENT → ACCEPTED` and require exactly one row. Any refusal rolls everything back. A concurrent ACCEPT that loses the lock is a replay. Audit entries are written after commit.

**Tests** (`tests/m49-talent-offers.integration.test.ts`): five concurrent ACCEPTs → one contract, two items; six ACCEPT/DECLINE rounds ending in exactly one terminal state with ledger and contract consistent; DB failpoints on the contract insert and on the offer update roll everything back and a retry completes once; the existing "budget cannot hold it" test now also asserts no milestone item survives.

## 3. P1 — M39 acceptance, M34 link, other split writes

- **M39.** Approving the budget item and inserting the acceptance are one transaction (`transitionInTx`); a lost negotiation race rolls the approval back (it used to leave the item `APPROVED`). Tests: failpoint on the acceptance insert; six concurrent accepts → one acceptance, one `APPROVED` item.
- **M34.** After any unique conflict the link row is read and verified (same item, mission, amount, currency, creation key); otherwise `LINK_INTEGRITY_FAILURE` (409). Deterministic failpoint tests (a trigger plays the racing caller) cover the benign and the hostile winner; the soak test stays as extra evidence.
- **M43 dispute resolution.** Ledger refund and dispute resolution are one transaction under a lock on the dispute. Before, a crash between them left a refund applied and the dispute `OPEN`, and the retry's own pre-check then refused the (already applied) refund — a stuck dispute.
- **M50 termination.** Cancelling milestone budgets and recording the termination are one transaction.

## 4. Audited and left as is (recoverable, not severe)

| Flow | Why it is acceptable |
| --- | --- |
| M40/M50 reconciliation (ledger steps, then the reconciliation record) | each step has a fixed idempotency key and reflects a true state (`RESERVED`, `IN_FLIGHT`, …); re-running recomputes from the current stage and completes; the record is `ON CONFLICT DO NOTHING` |
| M39 withdraw (ledger `CANCELLED`, then acceptance `WITHDRAWN`) | fixed key; retry completes; no money moves |
| M34 quote→ledger item creation then link | item is `QUOTED` (consumes no budget); link verified on every replay (above) |
| Audit entries | best-effort by design; never part of a financial decision |

Not yet audited in depth (R0 continues): M45 portfolio roll-ups (read-only), outbox/notification delivery (no outbox exists yet — R4), order status writes (verified events only).

## 5. Gate

The R0 gate is satisfied **locally** by the tests above. It is not satisfied in any public environment: migrations 030–053 are applied on no public database, and Missions execution paths must not be exposed publicly until the owner-gated items in `docs/OWNER-ACTIONS.md` (privileged Neon role, runtime password) are resolved.
