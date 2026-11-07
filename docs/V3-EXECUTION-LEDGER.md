# V3 execution ledger (checkpoint)

Source of truth for resuming the V3 program (ADR-018). Update at every milestone. Statuses: `COMPLETE_REAL`, `COMPLETE_LOCAL`,
`PARTIAL`, `BLOCKED_EXTERNAL`. Nothing here is deployed; Gate A remains owner-gated (`docs/OWNER-ACTIONS.md`).

| Milestone               | Status                                                                          | PR      | Migration | Notes                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------- | ------- | --------- | ---------------------------------------------------------------------------------------------- |
| Phase 0 hardening       | COMPLETE_LOCAL                                                                  | #42     | —         | ceiling test, outage alerts, address-keyed abuse limits, key-separation review, closure ledger |
| M26 Mission Contract v1 | COMPLETE_LOCAL                                                                  | #43     | 030       | versioned contract, widening analysis, agents only propose                                     |
| M27 Planning            | COMPLETE_LOCAL                                                                  | #44     | 031       | honest readiness; no real model planner (needs key)                                            |
| M28 Commitment ledger   | COMPLETE_LOCAL                                                                  | #45     | 032       | single-amount items, exact capacity, independent oracle                                        |
| M29 Authority compiler  | COMPLETE_LOCAL / procurement-pack PARTIAL                                       | #46     | 033       | atomic revocation; SKU/price/tax/fee/cost-centre/invoice not on live path                      |
| M30 Workspace           | PARTIAL (read-only workspace is COMPLETE_LOCAL)                                 | #47     | —         | no create/approve/pause in the UI by design; approvals and controls stay in API/SDK            |
| M31 Connectors          | COMPLETE_LOCAL (framework + sandbox catalogue); live connector BLOCKED_EXTERNAL | this PR | 034       | read-only by construction; no real marketplace without owner credentials                       |
| M32–M50                 | NOT STARTED                                                                     | —       | —         | see ADR-018                                                                                    |

## Next executable actions (in order)

1. **M30 follow-up (deferred, not blocking):** UI actions (create, approve/reject a pending revision, pause/resume/cancel) and an approvals queue.
   Deliberately not in v1: a UI that can approve is a second approval surface. Revisit after M31-M40 when more state needs a human.
2. **M32 product discovery** (next; uses M31) + a real adapter only where authorized access exists (eBay Browse needs developer keys - owner action).
3. Procurement pack on the live path (extend the purchase request with SKU/costCenter/purpose/invoice, compare to the trusted offer).
4. M32–M50 as ADR-018. M40 real PayPal Sandbox needs the owner's Sandbox credentials (never in chat).

## Known external blockers (unchanged)

Gate A deployment (owner), `svc_public_app` removal (owner approval), real-model AgentBench / model planner (provider key + cost approval),
OAuth provider choice, design-partner outreach sends (approved text + sender), any live marketplace credentials.

## Lessons recorded

- Never `git add -A && git commit` after a merge without checking `git status` for `UU`/`AA` and grepping for conflict markers.
- A transaction that holds a pooled connection must not ask the pool for another (`authorizeCapability` takes an `executor`).
- Prettier rewrites source; mutation scripts must read the formatted text first.
- Test clocks are fixed: advance them past rate-limit windows and keep the member token (30 days) alive.
