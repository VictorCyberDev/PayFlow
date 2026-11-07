# Offer acceptance and escalation (V3 M39)

**Accepting a quote** means: rely on this supplier quote at its landed total. In PayFlow that commits the quote's budget item (`QUOTED` → `APPROVED` in the ledger, subject to its capacity checks) and concludes the negotiation. It is recorded immutably with every check that held at that moment and who decided.

> It does **not** tell the supplier, and it does **not** pay anyone. Telling the supplier is a message a person approves (M37). Paying is the next milestone, under the Trust Kernel.

## The checklist (pure, named, deterministic)

Hard checks that **nobody can override**: the mission is running; this quote was not already accepted and the negotiation has not already concluded; the quote is current; the total is complete (nothing unknown); the currency is the mission's; the supplier is **qualified now**; the total is within the contract's largest commitment and what the ledger can still take; approved negotiation rules are in force (if a negotiation exists); and the total is **within the walk-away**. The walk-away is the owner's own ceiling in the approved rules: to go above it, revise and approve new rules first.

One soft check: **term floors**. A person may accept a quote that misses a floor by giving a reason (kept with the acceptance). An agent never can.

## Who may accept

- **The owner** (`mission:approve`): whenever every hard check holds.
- **An agent** (needs the `CONTRACT` grant): only when the mission lets an agent contract (`requireApprovalToContract` false), the approved rules say `AGENT_WITHIN_LIMITS`, it is the named negotiator, the total is within the human-approval threshold, and nothing soft failed. Otherwise its accept becomes an **escalation** (`outcome: ESCALATED`) for a person; if a hard check fails there is nothing to escalate, and it is refused.

## Escalations

Raised by agents (`NEGOTIATE`), one open request per subject: an **acceptance request** (carrying a snapshot of the checks) or a **walk-away request**. The owner resolves: `ACCEPT` (accepts the quote with all checks re-run, or ends the negotiation for a walk-away), `DECLINE`, or `DISMISS`. A resolved escalation never changes.

## Withdrawing

The owner can withdraw an acceptance before anything is built on it: the budget item is cancelled (budget released) and the negotiation reopens so a different quote can be accepted. The same quote is never accepted twice.

## Order of effects, and what a crash leaves

The ledger step is idempotent and runs first; the acceptance row (unique per quote) is written second. If the process stops in between, the budget item is `APPROVED` with no acceptance record; retrying the accept converges, and a person can cancel the item in the ledger if no retry comes. The two cannot be one database transaction because the ledger is its own service.

## Status

COMPLETE_LOCAL. Migration 042 pending on the public database. 10 tests: the checklist is checked per code and against an independent statement of the hard rules on 1,500 cases (a third built to exercise the agent branch), then end to end; 15 mutation checks each fail a test.
