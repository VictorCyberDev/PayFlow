# Counteroffers (V3 M38)

How a negotiation moves: our counters go out, the supplier answers with new quotes, and the rules decide what is possible next.

## Rules added to the message path

- **Rounds are counted by PayFlow.** A counter must carry exactly the next round (one more than the live counters before it), counted from the messages on file at draft, at approval and at send. A sender cannot dodge the round limit by always declaring "round 1". A rejected or failed counter frees its round; a pending or sent one holds it. Two drafts at once cannot take the same round (counted again under a lock).
- **Our offers never go backwards.** A counter below our previous live counter is refused (`OFFER_BELOW_PREVIOUS_OFFER`). Equal is fine.
- Both are in addition to the M36 rules (walk-away, floors, concessions, disclosure) and the M37 checks (person-approved, registered contact).

## The timeline

One order for everything said: our counters and the supplier's quotes (a supplier's reply is recorded as a new quote that supersedes the old). Ordering uses a sequence assigned when each row is written, **not timestamps**, because two writes can tie in time and a tie would make "did we answer their last quote?" undecidable.

## The recommendation (no model, no network)

| Situation                                                                               | Recommendation                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No usable supplier quote (none, incomplete, expired/replaced, other currency)           | `NEED_BASELINE`                                                                                                                                                                                     |
| Our counter is out and they have not answered                                           | `WAIT`                                                                                                                                                                                              |
| Their offer is at or below what we already offered, or meets the target and every floor | `REVIEW_FOR_ACCEPTANCE` (a person decides; acceptance is the next milestone)                                                                                                                        |
| Otherwise, rounds left                                                                  | `COUNTER`: open at the target; then previous offer + half the gap to their latest total (at least 1 minor unit, never above the walk-away, never below what we offered), asking for the term floors |
| No rounds left                                                                          | `REVIEW_FOR_ACCEPTANCE` if they are within the walk-away, else `WALK_AWAY`                                                                                                                          |
| We are at the walk-away and they are still above, or they repeated an offer above it    | `WALK_AWAY`                                                                                                                                                                                         |
| No concession is possible inside the rules                                              | `ESCALATE`                                                                                                                                                                                          |

A recommended `COUNTER` is always drafted-able as is: the property tests check it never exceeds the walk-away, never undercuts our last offer, and carries the right round. It still needs a person's approval; nothing is sent by asking.

## Status

COMPLETE_LOCAL. Migration 041 (a shared ordering sequence on quotes and messages) pending on the public database. 9 tests: the recommender is checked in scenarios, a concession simulation and a 1,000-case property check, then end to end by acting on each recommendation; 12 mutation checks each fail a test. A real bug found on the way: ordering by timestamp ties (fixed with the sequence), and a stalled-supplier check that looked only at current quotes.
