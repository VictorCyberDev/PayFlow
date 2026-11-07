# Mission Authority Compiler (V3 M29)

A Mission Contract decides nothing. When an owner approves a version, each agent holding `PURCHASE` gets **stored Authorities** (the
existing `mandates`) compiled from it, and the one Trust Kernel decides every purchase against them. There is no second policy engine.

## Attenuation: a compiled Authority is never broader than the contract

| Field                                  | Rule                                                                                                                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who                                    | only an agent the contract granted `PURCHASE` and that is active in the organization. Research and negotiation agents hold **no** Authority                                                                 |
| Merchants                              | only an explicit `ONLY` list compiles. `ANY` and `NONE_ALLOWED` do not (reported as `MERCHANTS_NOT_ENUMERABLE`)                                                                                             |
| Category                               | an Authority has one category, so one is compiled per (agent, category); none declared → `NO_SPENDING_CATEGORY`                                                                                             |
| Max single transaction                 | `min(maximum commitment, allocation)`                                                                                                                                                                       |
| Cumulative limit                       | the **allocation**: an even split of the budget across (purchasing agents × categories), less what earlier Authorities for the same pair already used. Allocations of one mission sum to at most its budget |
| Human-approval / autonomous thresholds | `humanApprovalAbove` becomes the autonomous threshold; the Kernel itself escalates above it                                                                                                                 |
| Quantity                               | `maxItemQuantity` if the contract sets it, else the mandate maximum (1000) so the budget is the binding limit. Raising or removing it is a widening                                                         |
| Deadline                               | the contract's                                                                                                                                                                                              |

## Revocation is atomic; compilation is not

Pausing, revoking, cancelling, completing, expiring or superseding a mission revokes its Authorities **in the same transaction** as the
state change (`revokeCompiledInTx`). A test makes the revocation impossible and shows the mission is then **not** paused: there is no
state in which a mission is stopped while its spending power remains. Compilation happens after commit and is idempotent; if it fails
the agent has **no** Authority. Resuming compiles fresh Authorities (never un-revokes), and the allocation is reduced by what the old
ones consumed, so pausing cannot launder spend.

## Verified against the real Gateway

The purchasing agent completes a real governed purchase inside its compiled Authority; a research or negotiation agent cannot, even when
it presents the buyer's Authority id (`ACCESS_AGENT_MISMATCH`, $0); a smaller maximum commitment is refused by the Gateway; a revoked
Authority is refused (`AUTHORITY_REVOKED`, $0). A seeded property test compiles eight random contracts and checks every bound.

## Procurement pack: what is and is not wired (PARTIAL)

`src/network/procurement.ts` evaluates a richer pack against a `FinancialAction` that the live purchase request does not yet carry.
Compiled **into the Authority itself** (so the Kernel enforces them today): vendors (as the merchant scope), currency, maximum amount,
cumulative budget, quantity, expiry, and the human-escalation threshold. **Not enforced on the live path:** SKU allow-list, unit-price
tolerance, tax and fee caps, cost center, purpose match, invoice-reference prefix, supplier-substitution rule and recurrence counts.
They need the purchase request to carry those fields and the trusted offer to be compared before the Kernel decides. That is a change
to the central decision path and is deliberately not made here; it is the first item of the next work on procurement (M34/M40).

## Roles and API

Read: `GET /v1/admin/org/missions/{id}/authorities` (every role). There is no endpoint to request an Authority: it exists only as a
consequence of an owner approving a mission version.

## A defect found by the tests

An Authority without a `quantityLimit` is treated by the Kernel as already exhausted (`QUANTITY_EXHAUSTED`). The contract therefore gained
an optional `maxItemQuantity`, and the compiler always sets a quantity.

Status: **COMPLETE_LOCAL** for compilation, attenuation and revocation; procurement-pack fields above are **PARTIAL**.
