# Acceptance ledger — what this session executed and observed

Only runs this session actually executed and read a terminal result for. Nothing here is inherited from a document. Per-slice merge history stays in `docs/V3-EXECUTION-LEDGER.md`; per-milestone status stays in `docs/M1-M90-AUDIT-MATRIX.md`.

All of it is pinned to `main` = `5cb1461d08fc82de13c7583f0d74cb954cd24f4e`.

## A-1 · Full suite against PostgreSQL — the real gate

```
TEST_DATABASE_URL=postgres://payflow:payflow_test@localhost:5432/payflow_test npm test
```

|          |                                                                        |
| -------- | ---------------------------------------------------------------------- |
| Result   | **166 files passed, 6 skipped; 2750 tests passed, 31 skipped; exit 0** |
| Duration | 609.83s                                                                |

**`main` is genuinely green against a real database.** The 31 skipped tests are the live-provider suites (`paypal.sandbox`, `paypal-commerce.sandbox`, `groq.smoke`); they skip themselves without credentials rather than passing vacuously, which is the honest behaviour.

### The trap this run exposed

The same command **without** `TEST_DATABASE_URL` reports `1380 passed`, **`1401 skipped`**, and **exit 0**. A green `npm test` therefore proves roughly half of what it appears to. Any future claim of acceptance must cite the run _with_ the database. Recorded here because the variable is easy to omit and the failure mode is silent.

## A-2 · Customer app in a real browser — reproduction of the PR #84 failure

```
TEST_DATABASE_URL=... REQUIRE_BROWSER=1 npx vitest run tests/r1-customer-app.browser.test.ts
```

|                                     |                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Result on `main`                    | **19 passed, 1 skipped; exit 0**                                                                                                           |
| The test that failed in PR #84's CI | `the Launch board derives each area from real records, says who acts next, and treats empty records as not started` — **passed in 1009ms** |

In PR #84's CI the same test timed out after 30s waiting for the `Launch board` `h1`. On `main` it passes in about a second. **The failure does not exist on `main`.** See `RELEASE-STATE.md` for what follows for #84.

## A-3 · PR #85's journey, run against current `main`

PR #85's entire diff is one new file, so it can be verified directly on `main` rather than taken on CI's word.

```
npx vitest run tests/journey-b-negotiation.integration.test.ts   # file taken from origin/claude/focused-brown-dv9991
```

|        |                               |
| ------ | ----------------------------- |
| Result | **4 passed; exit 0** (3113ms) |

| Invariant proven                                                           | Observed                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| An agent cannot act on rules it proposed until a person puts them in force | refusal `NO_RULES_IN_FORCE:WAITING_FOR_A_PERSON`, then `ALLOW` only after a person approves |
| Delegation never widens permission                                         | a move above the approved walk-away refused `ABOVE_WALK_AWAY`                               |
| Revocation is respected immediately                                        | the move allowed a moment earlier refused `NO_RULES_IN_FORCE:REVOKED`                       |
| Tenants cannot cross boundaries                                            | another organization's agent refused 401/403/404; its person cannot approve or revoke       |

This independently confirms #85's green CI. The borrowed file was then removed from this branch so that it does not duplicate #85's own deliverable.

## A-4 · Live infrastructure, read-only

| Probe                                                                 | Result                                                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Neon `withered-rice-68056451` tables in `public`                      | **73**                                                                                    |
| `missions` (migration `030`)                                          | **absent**                                                                                |
| `mission_plans` / `user_accounts` / `automation_jobs` / `launch_runs` | absent                                                                                    |
| `svc_public_app`                                                      | LOGIN, member of **`neon_superuser`**                                                     |
| `svc_public_rt`                                                       | LOGIN, member of `payflow_runtime`                                                        |
| Vercel projects                                                       | `payflow`, `payflow-public`, `payflow-m5-acceptance`, `payflow-m6-acceptance` all present |

**The finding that matters:** `missions` is created by `030_m26_missions.sql`, and it is absent. The public database stops _before the V3 product begins_. Every milestone from M26 onward — the whole Missions and Spend Desk product — has no database behind it in the public sandbox. This is a sharper statement than "migrations 024–064 are unapplied" and it is why no milestone can honestly be marked `HOSTED_ACCEPTED` today, whatever its local evidence.

## What this ledger does not claim

- No hosted acceptance. Nothing is deployed to `payflow-public`.
- No provider acceptance. No live credential was present, and none was requested.
- No journey A–H suite was executed as a set; A-2 and A-3 are two journeys, not the programme.
- The M1–M90 matrix was **not** re-derived from executed evidence. It remains as `docs/M1-M90-AUDIT-MATRIX.md` has it: sourced, and honestly partial.

## A-5 · M55 plan runs — the executor built and accepted this session

New work, not an audit of existing work. The gap stated in `DEPENDENCIES.json` was closed: M27's dependency graph and M56's durable worker are now joined by an executor. See `docs/M55-PLAN-RUNS.md`.

```
TEST_DATABASE_URL=... npx vitest run tests/m55-plan-run.integration.test.ts
```

|        |                               |
| ------ | ----------------------------- |
| Result | **8 passed; exit 0** (4226ms) |

| What is proven                                                                                                   |                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A run drives the template planner's real four-task graph, hands off what nothing can do, and produces a worklist | and `mission_ledger_items`, `mission_purchase_orders`, `mission_messages` are unchanged               |
| Confirming a handoff unblocks the layer behind it                                                                | `source-offers` goes `BLOCKED` → `READY` → `HANDED_OFF`, with `NO_CONNECTOR_COMMISSIONED` in the note |
| The executor reports a task awaiting approval and never approves it                                              | `approvedBy` stays `null` across repeated worker passes                                               |
| A paused mission stops it                                                                                        | records `REFUSED` / `MISSION_NOT_ACTIVE`, advances nothing                                            |
| A replaced plan stops it                                                                                         | finishes `FAILED`, touches none of the new plan's tasks                                               |
| Repeat passes change nothing; one open run per mission                                                           | third pass byte-identical; a second run is refused `RUN_ALREADY_OPEN`                                 |
| Cancellation advances nothing; a finished run cannot be cancelled                                                |                                                                                                       |
| Another organization can neither see nor cancel a run                                                            | 404 both ways                                                                                         |

### Mutation check — because a test that cannot fail proves nothing

| Mutant                                                                                | Outcome                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The run's own approval gate removed, so it tries to claim an `AWAITING_APPROVAL` task | **killed.** And the finding is better than the test: the task was _still_ not acted on, because `PlanService.claim` refuses anything not `READY`. The authority boundary is enforced at the authorized-transition layer, not only in the executor. |
| The plan-version guard removed, so the run would act on a plan it was not started for | **killed** — `WAITING_ON_PEOPLE` where `FAILED` was required.                                                                                                                                                                                      |

### The honest limit of this slice

No specialist is connected, so **every** task the run reaches today becomes a handoff. That is the state of the product, not a shortcoming of the executor: with no provider commissioned there is no automated work to do. `PlanSpecialist` is the registration point, and a registered specialist still cannot bypass the capability check in `claim`.

## A-6 · Migration 065 and the database guarantees, verified without the service

All 65 migrations applied in order into an empty database (`ON_ERROR_STOP=1` on every file): **clean, and both new tables present**. Then each guarantee was attacked with raw SQL and required to fail with its own message:

| Attack                                     | Result                                        |
| ------------------------------------------ | --------------------------------------------- |
| A second open run for the same mission     | `duplicate key ... "plan_runs_one_open"`      |
| `UPDATE` the action log                    | `plan run actions are append-only`            |
| `UPDATE` a finished run                    | `a finished plan run cannot change`           |
| `DELETE` a run                             | `plan runs are never deleted`                 |
| `finished_at` on a non-terminal state      | `violates check constraint "plan_runs_check"` |
| A new open run after the previous finished | accepted                                      |

This matters because it separates the two layers: the service's `RUN_ALREADY_OPEN` is a courtesy, and the partial unique index is the guarantee. A bug in the former cannot defeat the latter.

## A-7 · The M55 screens in a real browser

```
TEST_DATABASE_URL=... REQUIRE_BROWSER=1 npx vitest run tests/r1-customer-app.browser.test.ts
```

|        |                                  |
| ------ | -------------------------------- |
| Result | **19 passed, 1 skipped; exit 0** |

Chromium against the real Gateway on PostgreSQL. What the Launch board test now also asserts:

- the plan-run card renders its empty state, with a working **Work through the plan** control and the notice that it never approves anything;
- `#/missions/:id/plan` renders an approval-gated task (`Waiting for your approval`, `An agent can do this`) and a blocked one (`Waiting on something else`, `Prepared for you or a provider`);
- the controls are really there: one **Approve this step**, two **Skip it**, and an **Evidence: supplier-list** field on the task that records evidence;
- no `undefined` / `[object` / `NaN` leaks into the page, and **axe is clean**.

### Two defects this found that the unit suite could not

| Defect                                                                                                                                                                                                                                                                                                                                | How it surfaced                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| The plan-run card linked to `#/missions/:id/plan`, a route that did not exist; the router fell through to the home page in silence. Behind it: the application had **no plan screen at all** — `/plans` was never fetched, so M27's tasks were invisible to a customer and a run could say "approve this" with nowhere to approve it. | Following my own link              |
| The plan screen's `<dl>` used `<span>` placeholders for conditional rows. A `<dl>` permits only `dt`, `dd`, `div`, so axe reported `definition-list` twice. Fixed with falsy placeholders, which `h` drops.                                                                                                                           | Rendering the page and running axe |

The unit suite was green through both. That is the argument for the browser gate, stated as evidence rather than as a principle.

## A-8 · M57 — the owner's answer, pause and resume

```
TEST_DATABASE_URL=... npx vitest run tests/m57-recurring.integration.test.ts tests/m57-recurring.test.ts tests/m56-automation.integration.test.ts
```

**3 files, 24 tests, exit 0.** M56 was run alongside deliberately, because `resumeSchedule` touches the scheduler every recurring feature uses.

`DUE_FOR_OWNER` had been a dead end: the check said "your decision is needed" and no route, method or control existed to answer it. It now takes one answer, by unique key. Approving records intent and buys nothing — the test asserts the mission's exposure is unchanged across an approval, so the claim is checked and not merely written down. `resume` rolls the slot forward so a schedule paused for ten days does not come back reporting renewals that were due in the past.

| Mutant                                  | Result                                       |
| --------------------------------------- | -------------------------------------------- |
| `resumeSchedule`'s roll-forward removed | **killed** — resumed slot landed in the past |
| `decide`'s mission-active guard removed | **killed** — 200 where 409 was required      |

**A method failure worth recording:** the first attempt at the roll-forward mutant **did not apply**. Prettier had reformatted the line, the pattern missed, and the suite reported a pass against unmutated code. A mutation run that cannot prove the mutant was applied proves nothing. Both mutants are now applied under an assertion that fails loudly on a miss, and that is how the kills above were obtained.

## A-9 · M58 — the five templates, each driven to a working mission

```
TEST_DATABASE_URL=... npx vitest run tests/m58-templates.integration.test.ts
```

**7 tests, exit 0** (five per-template, the drift guard, one end-to-end run). Run together with `m27-mission-planning` and `m55-plan-run`, which the planner change could have disturbed: both unchanged.

### The defect it found

`templatePlan` branched only on commerce/direct-supplier and talent. Three of the five templates approve neither:

| Template                    | Providers               | Plan produced                             |
| --------------------------- | ----------------------- | ----------------------------------------- |
| Find a place to work        | `WORKSPACE_PROVIDER`    | `clarify-requirements` → `owner-decision` |
| Get a logo and brand basics | `PROFESSIONAL_SERVICES` | `clarify-requirements` → `owner-decision` |
| Set up bookkeeping          | `PROFESSIONAL_SERVICES` | `clarify-requirements` → `owner-decision` |

Each went straight from "write the requirements" to a task titled _"Owner reviews the shortlist and decides what to commit to"_ — with nothing in the plan planned to produce a shortlist. Nothing failed and nothing warned; the plan was missing its middle. PayFlow already had the discovery for both families (M51, M54); the planner simply never planned it.

| Mutant                               | Result                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Both new discovery branches disabled | **killed** — and precisely: exactly `workspace`, `brand` and `bookkeeping` fail, each reporting `planned no discovery at all: clarify-requirements,owner-decision` |

That mutant is the proof the defect was real rather than a tidiness complaint.

## A-10 · M59 — usage and billing

```
TEST_DATABASE_URL=... npx vitest run tests/m59-usage.integration.test.ts
```

**5 tests, exit 0.**

### The gap

`usage_events` has existed since migration `013`, the Gateway writes to it, and `buildUsageInvoice` existed to aggregate it. A customer could see none of it: `grep -c usage app-ui/app.js` returned **0**. The product metered its customers and showed them nothing.

### The thing this had to get right

A usage screen is the one place in a product where you can imply a debt that does not exist. `docs/PRICING-METERING.md` is explicit that the coefficients in the code are placeholders, "not a published price sheet". So the preview is built on the DEVELOPER plan, every coefficient zero, and the response states in words that the organization is not on a paid plan and no price has been agreed. There is also no plan assignment per organization anywhere in the schema, so choosing a paid plan would have meant inventing commercial state the business has not agreed.

Rows are inserted straight into `usage_events` — the table the Gateway writes — rather than stubbed in front of it, so the query under test is the query that runs.

| Mutant                                            | Result                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Organization scoping removed from the usage query | **killed** — `expected 104 to be 5`: the other tenant's 99 events leaked into this organization's total |

### Not done, and named

Support correspondence. The help screen is a glossary and the usage screen links to it, but there is no way to send a message to a human, because no email has ever been delivered (blocker B-1). An outbox row is not a sent message and is not described as one.
