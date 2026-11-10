# V3 execution ledger (checkpoint)

Source of truth for resuming the V3 program (ADR-018). Update at every milestone. Statuses: `COMPLETE_REAL`, `COMPLETE_LOCAL`,
`PARTIAL`, `BLOCKED_EXTERNAL`. Nothing here is deployed; Gate A remains owner-gated (`docs/OWNER-ACTIONS.md`).

| Milestone                           | Status                                                                                                                                  | PR  | Migration | Notes                                                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 0 hardening                   | COMPLETE_LOCAL                                                                                                                          | #42 | —         | ceiling test, outage alerts, address-keyed abuse limits, key-separation review, closure ledger                                                          |
| M26 Mission Contract v1             | COMPLETE_LOCAL                                                                                                                          | #43 | 030       | versioned contract, widening analysis, agents only propose                                                                                              |
| M27 Planning                        | COMPLETE_LOCAL                                                                                                                          | #44 | 031       | honest readiness; no real model planner (needs key)                                                                                                     |
| M28 Commitment ledger               | COMPLETE_LOCAL                                                                                                                          | #45 | 032       | single-amount items, exact capacity, independent oracle                                                                                                 |
| M29 Authority compiler              | COMPLETE_LOCAL / procurement-pack PARTIAL                                                                                               | #46 | 033       | atomic revocation; SKU/price/tax/fee/cost-centre/invoice not on live path                                                                               |
| M30 Workspace                       | PARTIAL (read-only workspace is COMPLETE_LOCAL)                                                                                         | #47 | —         | no create/approve/pause in the UI by design; approvals and controls stay in API/SDK                                                                     |
| M31 Connectors                      | COMPLETE_LOCAL (framework + sandbox catalogue); live connector BLOCKED_EXTERNAL                                                         | #48 | 034       | read-only by construction; no real marketplace without owner credentials                                                                                |
| M32 Discovery                       | COMPLETE_LOCAL (sandbox catalogue); real data BLOCKED_EXTERNAL                                                                          | #50 | 035       | immutable observations, deterministic checks, unknown never met                                                                                         |
| M33 Qualification                   | COMPLETE_LOCAL                                                                                                                          | #50 | 036       | person-only verification; open is never met; PayFlow does not screen                                                                                    |
| M34 Quotes/landed cost              | COMPLETE_LOCAL                                                                                                                          | #50 | 037       | total claimed only when nothing unknown; QUOTED holds no budget                                                                                         |
| M35 Sourcing optimizer              | COMPLETE_LOCAL                                                                                                                          | #51 | 038       | exhaustive search proven against a brute-force oracle; recommends, never commits                                                                        |
| M36 Negotiation rules               | COMPLETE_LOCAL                                                                                                                          | #51 | 039       | owner-approved, re-validated, immutable; guard for M37/M38/M39                                                                                          |
| M37 Communication                   | COMPLETE_LOCAL (sandbox channel); live channel BLOCKED_EXTERNAL                                                                         | #52 | 040       | person-approved, re-checked at send, unknown delivery never retried, replies untrusted                                                                  |
| M38 Counteroffers                   | COMPLETE_LOCAL                                                                                                                          | #52 | 041       | rounds counted by PayFlow, offers never go back, deterministic recommender                                                                              |
| M39 Acceptance                      | COMPLETE_LOCAL                                                                                                                          | #53 | 042       | walk-away never exceeded; agent accepts only within approved rules, else escalates; commits budget, pays no one                                         |
| M40 Procurement→payment             | COMPLETE_LOCAL (reconciliation from PayFlow's own trace); live gateway PO enforcement PARTIAL; real PayPal Sandbox BLOCKED_EXTERNAL     | #53 | 043       | PO is an instruction not a payment; budget follows the trace, mismatch holds as UNKNOWN, foreign payments cannot move it                                |
| M41 Orders                          | COMPLETE_LOCAL                                                                                                                          | #54 | 044       | only a reconciled-settled purchase becomes an order; status moves only on a person's evidenced event, claims shown beside it                            |
| M42 Fulfillment                     | COMPLETE_LOCAL                                                                                                                          | #55 | 045       | receipts are a person's counts; outcome computed from PO lines and receipts; shipments from agents are claims                                           |
| M43 Refunds/disputes                | COMPLETE_LOCAL (records a refund that provably happened); PayPal refund execution BLOCKED_EXTERNAL                                      | #55 | 046       | ground must be supported by computed fulfillment; person resolves; refund needs Proof/provider confirmation, once, never above claim                    |
| M44 Obligations                     | COMPLETE_LOCAL                                                                                                                          | #56 | 047       | dates from verified facts only; once per order and kind; urgency computed, never stored; reminders move no money                                        |
| M45 Multi-vendor portfolio          | COMPLETE_LOCAL (computed read model)                                                                                                    | #56 | —         | integer-bps shares; concentration only with >1 supplier; close-out blockers named per supplier                                                          |
| M46 Talent scope                    | COMPLETE_LOCAL                                                                                                                          | #57 | 048       | owner-approved immutable versions; checked against the mission twice; no protected-attribute criteria (best-effort screen, not legal compliance)        |
| M47 Talent marketplace              | COMPLETE_LOCAL (fictional sandbox source); live marketplaces BLOCKED_EXTERNAL                                                           | #57 | 049       | sources only observe; output strictly parsed, bounded, stored as claims; sandbox refused in PRODUCTION                                                  |
| M48 Shortlisting                    | COMPLETE_LOCAL                                                                                                                          | #57 | 050       | deterministic checks (unknown never met); years of experience never ranked; person adopts; contacts no one                                              |
| M49 Offers/contracts                | COMPLETE_LOCAL; PayFlow is not a party and sends nothing                                                                                | #58 | 051       | checks are a person's findings; approval needs required checks passed; person sends and records the answer; acceptance commits milestones in the ledger |
| M50 Deliverables/contractor payment | COMPLETE_LOCAL (sandbox rail, reconciled from PayFlow's trace); real contractor payout, payee onboarding and tax forms BLOCKED_EXTERNAL | #58 | 052       | person accepts deliverables with evidence; instruction is not a payment; a mismatch holds the budget; termination releases unpaid milestones            |

## Next executable actions (in order)

1. **M30 follow-up (deferred, not blocking):** UI actions (create, approve/reject a pending revision, pause/resume/cancel) and an approvals queue.
   Deliberately not in v1: a UI that can approve is a second approval surface. Revisit after M31-M40 when more state needs a human.
2. **M51 is out of scope for this mandate** (ADR-018 stops at M50). Only M51 readiness is reported.
3. Procurement pack on the live path (extend the purchase request with SKU/costCenter/purpose/invoice, compare to the trusted offer).
4. M26–M50 are built locally per ADR-018. Anything touching a real PayPal Sandbox, a live marketplace or a live channel needs the owner's credentials (never in chat).

## Known external blockers (unchanged)

Gate A deployment (owner), `svc_public_app` removal (owner approval), real-model AgentBench / model planner (provider key + cost approval),
OAuth provider choice, design-partner outreach sends (approved text + sender), any live marketplace credentials.

## Lessons recorded

- Never `git add -A && git commit` after a merge without checking `git status` for `UU`/`AA` and grepping for conflict markers.
- A transaction that holds a pooled connection must not ask the pool for another (`authorizeCapability` takes an `executor`).
- Prettier rewrites source; mutation scripts must read the formatted text first.
- Test clocks are fixed: advance them past rate-limit windows and keep the member token (30 days) alive.

## Recovery program — R0 (2026-11-09)

Dated addendum; earlier entries are not rewritten. Detail and evidence levels: `docs/R0-FINANCIAL-SAFETY.md`, baseline: `docs/RECOVERY-BASELINE-2026-11-09.md`.

- Branch `claude/r0-purchase-order-binding`, PR #60 against `main` (`eec9c68`). The historical branch `claude/eloquent-einstein-dw0mxk` was left untouched by owner decision.
- Delivered (IMPLEMENTED + TARGETED_TEST_PASSED + local FULL_REGRESSION_PASSED on `848a907`): Gateway order binding with durable single-use execution intents and dispatch-time quote/digest pins (migration 053); atomic M49 acceptance, M39 approve+accept, M43 refund+resolve, M50 termination; M34 link verification.
- Not delivered / external: no deployment; migration 053 on no public database; no payout rail (contractor payments are a catalog-purchase simulator); credentialed provider sandbox tests skipped.
- GitHub CI result on the merged head and the resulting `main` SHA are appended below when known.
- **R0 merged:** PR #60 squash-merged into `main` as `138f51c0bd335249998afd139138939794ed48d8`. GitHub CI on the exact PR head `b543830`: `verify` success (12:29–12:49Z), `console` success, `console-e2e` success. `CI_VERIFIED` for R0; still not deployed.

## Program continuation — M51–M71 slices (2026-11-09)

Dated addendum. Evidence levels and honest not-done lists: `docs/M51-M53-STATUS.md`, `docs/M54-M71-STATUS.md`; the partial M1–M90 matrix: `docs/M1-M90-AUDIT-MATRIX.md`.

- **PR #61** (accounts and sessions) merged as `883bf52`. **PR #62** (hosting topology, customer app brand, M51–M53 workspace discovery and booking intents) squash-merged into `main` as `16d26b4`, pinned to head `f47fb17` where `verify` (22:07–22:28Z), `console` and `console-e2e` were all green.
- **PR #63** (M54, M56/M57 slices, M58 templates, M65 FX, M67 quorum, M68 pure part, M69 packs, M70 export, M71 Needs checking, record actions) squash-merged as `52d87f8`, pinned to head `2201ac5`: `verify` (22:53–23:07Z), `console`, `console-e2e` green. An earlier head of the same PR failed CI on a repository check that was not run locally (`scripts/public-readiness.mjs`, then full `npm run lint`); both were fixed and the local pre-push routine now runs every CI step with its exit code.
- Migrations added this stretch: 055 workspace discovery, 056 bookings, 057 automation, 058 quorum. None is applied to any public database.
- Full local regression on PostgreSQL at the last local head: 151 files passed, 2668 tests passed, 3 files and 4 tests skipped (no credentials).
- Not delivered: no live provider, no public deployment, no notification delivery, no product-research outputs, and the milestones listed as not done in the status docs.
- **PR #64** (M68 readiness on the Agents screen, partial M1–M90 matrix, this ledger) squash-merged as `a3cfed6`, pinned to head `c86594f`: `verify` (23:12–23:32Z), `console`, `console-e2e` green.
- **PR #65** (Launch board slice, contractor and dispute decisions, orders in Needs checking) squash-merged as `d3e358e`, pinned to head `cfbfc60`: `verify` (23:34–23:50Z), `console`, `console-e2e` green.
- **PR #66** (M57 recurring renewal checks, migration 059, and a test-harness drain for an intermittent teardown error) squash-merged as `2c70ca9`, pinned to head `5b7554a`: `verify` (23:58–00:15Z), `console`, `console-e2e` green.
