# Negotiation rules (V3 M36)

A **negotiation rulebook** is what an agent must stay inside when negotiating with one supplier for one mission. This milestone defines, approves and **checks** the rules. It does not send anything to a supplier, handle counteroffers or accept anything; each of those later steps must pass its move through the check here.

## The rules

| Rule               | Meaning                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `walkAwayMinor`    | The most we would ever pay, landed. A hard ceiling. At most the contract's largest single commitment and what the ledger still has available.                                               |
| `targetTotalMinor` | What we aim for. Never above the walk-away.                                                                                                                                                 |
| Term floors        | Minimum warranty and return window, maximum delivery days (with a stated allowance), acceptable payment terms. **A term that is not stated does not meet a floor.**                         |
| Concessions        | Quantity increase up to a percentage; delivery extension up to a number of days. Nothing else is conceded.                                                                                  |
| Rounds             | Between 1 and 10.                                                                                                                                                                           |
| Disclosure         | The **budget and other suppliers' identities can never be disclosed** (the schema refuses a document that says otherwise). Competing quotes and the deadline only if the document allows.   |
| Acceptance         | `PERSON_ALWAYS` by default. `AGENT_WITHIN_LIMITS` is possible only if the mission itself doesn't require a person to contract **and** the walk-away is within the human-approval threshold. |
| Deadline           | The rules expire, and never outlive the mission.                                                                                                                                            |

## Who does what

- An **agent** with `NEGOTIATE` may propose rules **for itself only**. A **person** may propose for any negotiator holding that grant. Every version waits.
- **Only the owner approves.** Approval re-checks the world at that moment: the supplier is **qualified now** (M33), the limits still fit the mission and the **budget as it is now**, the negotiator still holds the grant, the baseline quote is still current. A proposal for a not-yet-qualified supplier is allowed (with a warning) so preparation can proceed, but it cannot take effect.
- A revision is a new version; the approved one stays in force until the new one is approved. Versions are immutable (the database refuses edits and deletes; a decision is made once).
- Security can **revoke** at any time. Revocation is one way, idempotent, and ends the rulebook for that supplier.

## The check

`check` takes a move (`COUNTER` with our offer, or `ACCEPT` of theirs) and returns `ALLOW`, `REQUIRES_PERSON` (accepting under `PERSON_ALWAYS` is never decided here) or `REFUSE` with every rule broken. It is made against the version in force **right now**, and also refuses when the supplier has since lost its standing or the budget can no longer afford the move. Only the named negotiator may check; with no approved, current, unrevoked rules in a running mission, everything is refused.

## Status

COMPLETE_LOCAL. Migration 039 pending on the public database. 11 tests: the guard is checked at every boundary and against an independent statement of the rules on 1,500 random moves (about half deliberately broken); 22 mutation checks each fail a test (one equivalent: a redundant status check backed by a conditional update and a trigger).
