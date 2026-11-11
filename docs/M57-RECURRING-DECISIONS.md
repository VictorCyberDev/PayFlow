# M57 — the owner's answer, pause and resume

Status: IMPLEMENTED, WIRED (member routes + customer screen), DB_ACCEPTED (migration 066, PostgreSQL integration tests, 24 tests across M56/M57, 2 mutants killed). **Not** PROVIDER_ACCEPTED and not HOSTED_ACCEPTED.

Companion: the original slice is described inside `src/missions/recurring.ts`. This document covers what was added to finish M57's own list.

## The gap it closes

The recurring slice checked each due slot against the mission as it then was and recorded one of six outcomes. `DUE_FOR_OWNER` said "your decision is needed" — and **there was nothing to decide with.** The outcome sat in an append-only table, the screen printed it, and no route, service method or control existed to answer it. Separately, `stop` turned a schedule off and nothing turned it back on, although ADR-018's M57 list names "Cancellation. Pause and resume."

## What was added

| Piece                                                      | What it does                                                                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `recurring_decisions` (migration `066`)                    | One answer per due check, append-only, `UNIQUE (check_id)`                                                             |
| `RecurringService.decide`                                  | `APPROVED` / `DECLINED` on a check that actually came due                                                              |
| `RecurringService.resume`                                  | Starts checking again **from now**                                                                                     |
| `AutomationService.resumeSchedule`                         | Rolls `next_slot` forward by whole periods until it is in the future                                                   |
| `POST /v1/admin/org/recurring-checks/:id/approve\|decline` | permission `mission:approve`                                                                                           |
| `POST /v1/admin/org/missions/:id/recurring/:sid/resume`    | permission `mission:control`                                                                                           |
| The Recurring items screen                                 | **Yes, renew it** / **No, skip it** per due item; **Start it again** on a stopped schedule; a count of what is waiting |

## What a decision is, and is not

**Approving a renewal is not a payment, and not an authorization to make one.** It records what the owner wants, so the item stops asking and the intent is on the record. The renewal still goes the normal approved path, where the real amount is checked against the contract in force at that moment.

That is why `recurring_decisions` **holds no amount**. The amount that matters is the one on the eventual purchase, not the one guessed at setup — writing an amount here would invite someone to treat this row as the authorization, which it is not. The test asserts the mission's exposure is unchanged across an approval, so the claim is checked rather than merely stated.

It follows that the contract's `humanApprovalAboveMinor` is deliberately **not** consulted here. An approval threshold belongs where money actually moves. Consulting it here would imply this row gates spending.

## Why resume rolls the slot forward

`setScheduleActive(true)` alone leaves `next_slot` where it was when the schedule was paused. `tick` caps catch-up at three slots, so there is no flood — but those three jobs would be for slots **already in the past**, and for a renewal check that means telling someone a subscription was "due" three weeks ago. So resuming advances the slot by whole periods until it is in the future: the cadence keeps its own day and time, and the paused interval is not replayed.

Mutation-checked: with the roll-forward removed, the test fails with the resumed slot in the past.

## What it refuses

| Attempt                                          | Refusal                                              |
| ------------------------------------------------ | ---------------------------------------------------- |
| Answer a check that was skipped, not due         | `NOT_DUE`                                            |
| Answer the same check twice, in either direction | `ALREADY_DECIDED` (the unique key, not a convention) |
| Answer once the mission is paused or ended       | `MISSION_NOT_ACTIVE`, and nothing is recorded        |
| Answer, or resume, as another organization       | `404`, indistinguishable from not existing           |
| Resume onto a mission that is not active         | `MISSION_NOT_ACTIVE`                                 |
| Edit or delete a decision                        | `recurring_decisions is append-only`                 |

Before the email on an account is confirmed, every one of these POSTs is denied by the Gateway's deny-by-default list, which already covered `stop` and now covers `resume` and both answers without a change: an unconfirmed account may look around, not approve.

## Still not done in M57, and why

- **Provider-sourced price-change detection.** The amount is fixed when the recurrence is set up. Detecting that a supplier's price moved needs a commissioned provider to ask, which is blocker B-5. What _is_ re-checked at every slot, against the mission as it then is: the currency, the single-purchase limit and the budget actually left.
- Invoicing, supplier replenishment and scheduled obligations as distinct flows. The check-and-answer loop is the shared machinery they would each sit on.

## Evidence

`tests/m57-recurring.integration.test.ts`, real HTTP + real Gateway + PostgreSQL. Run together with `m57-recurring.test.ts` and `m56-automation.integration.test.ts`: **3 files, 24 tests, exit 0** — M56 included deliberately, because `resumeSchedule` touches the scheduler every other recurring feature uses.

New tests:

1. a due renewal takes the owner's answer, and saying yes still buys nothing (exposure unchanged)
2. one answer per due renewal, and only a renewal that actually came due can be answered (plus the append-only guards)
3. an answer does not stand on a mission that is no longer active, and another organization cannot answer at all
4. resuming a paused schedule starts from now, not from the gap it slept through
5. a schedule cannot be resumed onto a mission that is not active, nor by another organization

| Mutant                                  | Result                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `resumeSchedule`'s roll-forward removed | **killed** — the resumed slot landed in the past                                      |
| `decide`'s mission-active guard removed | **killed** — a decision on a paused mission was accepted (200 where 409 was required) |

A note on method: the first attempt at the roll-forward mutant **did not apply** — prettier had reformatted the line, so the pattern missed and the test passed against unmutated code. A mutation run that reports a pass without proving the mutant was applied proves nothing, so both mutants are now applied under an assertion that fails loudly if the text does not match.
