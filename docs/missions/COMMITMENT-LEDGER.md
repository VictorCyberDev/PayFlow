# Project budget and commitment ledger (V3 M28)

The question is not "how much has been paid" but "how much of the mission ceiling is spoken for". A founder may owe money before
it is paid; an agent may hold a reservation that has not settled; a payment may be of unknown outcome. The ceiling must never look
more available than it is. Money is integer minor units in the mission's currency; nothing is ever converted.

## The accounting model (one place: `src/missions/ledger.ts`)

One **item** is one obligation. It has exactly **one amount at a time** and moves through stages, so an obligation that goes
committed → reserved → settled is counted once.

| Consumes budget                                                                         | Does not                                                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `APPROVED`, `COMMITTED`, `RESERVED`, `IN_FLIGHT`, `SETTLED` (net of refunds), `UNKNOWN` | `ESTIMATED`, `QUOTED` (guesses and offers), `CANCELLED`, `RELEASED`, `FAILED` (known zero effect), `REFUNDED` (fully returned) |

`UNKNOWN` keeps consuming budget until evidence resolves it, and only resolves to `SETTLED` or `RELEASED` (both need Proof or a
provider confirmation). An obligation that is only owner-reported or unverified still consumes budget, but is reported separately
(`unverifiedExposureMinor`) and is never labelled enforced or settled.

Legal moves are exactly: `ESTIMATED→QUOTED|CANCELLED`, `QUOTED→QUOTED|APPROVED|CANCELLED`, `APPROVED→QUOTED|COMMITTED|RESERVED|CANCELLED`,
`COMMITTED→RESERVED|CANCELLED`, `RESERVED→IN_FLIGHT|CANCELLED`, `IN_FLIGHT→SETTLED|UNKNOWN|FAILED`, `UNKNOWN→SETTLED|RELEASED`,
`SETTLED→REFUNDED` (partial refunds keep `SETTLED`). A test pins the table. An externally recorded obligation may also go
`COMMITTED→SETTLED` on the owner's word (it never passed through a PayFlow reservation); anything PayFlow enforces may not.

## Enforced under the mission's row lock

- **Capacity:** the sum of exposures never exceeds the ceiling of the contract in force; a commitment that would is `409 CAPACITY_EXCEEDED`.
  Twelve concurrent 20,000 approvals against a 150,000 ceiling yield exactly seven.
- **Per-commitment:** nothing at `APPROVED` or later exceeds the contract's maximum commitment.
- **Who:** an agent may only create/re-quote `ESTIMATED`/`QUOTED` items it owns (and needs SEARCH, COMPARE or NEGOTIATE). Approval,
  commitment, reservation, payment and settlement are member or system facts; an agent's word is never evidence that money moved.
- **Evidence:** `SETTLED`/`REFUNDED`/`FAILED`/`RELEASED` need Proof or a provider confirmation; `RESERVED`/`IN_FLIGHT`/`UNKNOWN` need an
  Authority receipt or better. Verification only improves (PayFlow-enforced, provider-confirmed) and never downgrades.
- **Mission state:** nothing new may be approved, committed, reserved or started while the mission is not `ACTIVE`; settling,
  cancelling, refunding and resolving `UNKNOWN` always remain possible, because the money truth continues after a pause.
- **Amounts** are frozen once approved; a re-quote withdraws the approval, frees the capacity and needs a new approval.
- **Idempotency:** every create and every transition carries a key; a repeat is a replay, never a second effect or a second refund.
- **Narrowed ceiling:** if a revision lowers the ceiling below existing exposure, the ledger shows `overCommittedMinor`, available
  capacity is 0, and no new commitment is allowed; existing ones are not erased.

## Independent oracle

`tests/m28-…` recomputes exposure from the raw append-only `mission_ledger_entries` (the event log) and compares it with the
service after every phase of a seeded randomised concurrent run, so a bug in the item-state bookkeeping cannot hide itself.

## Roles

`mission:ledger` (write): OWNER, FINANCE_ADMIN. Read: every role. Agents see the capacity picture and only their own items.

## Not in M28

Connecting the Gateway so that real Authority receipts and Proofs create the `RESERVED`/`IN_FLIGHT`/`SETTLED` entries (M29/M40);
per-agent allocation caps (M29 compiles them from delegation); display (M30). Until then those moves are made by an authorized
member or system caller supplying the evidence. Status: **COMPLETE_LOCAL**.
