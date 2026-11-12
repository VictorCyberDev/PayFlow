# M55 slice — plan runs (the plan executor)

Status: IMPLEMENTED, WIRED (member routes + automation handler + customer screen), DB_ACCEPTED (migration 065, PostgreSQL integration tests, 8 tests, 2 mutants killed), UI_ACCEPTED for the read-out and the start/cancel controls. **Not** PROVIDER_ACCEPTED and not HOSTED_ACCEPTED: no specialist is connected, and nothing is deployed.

Companion slice: `docs/M55-LAUNCH-RUNS.md` (read-only discovery). This one is the other half.

## The gap it closes

M27 already held the graph and M56 already held the durable worker. Nothing joined them:

| Already there                                                                                                                                                              | Where                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Dependency-aware tasks, nine-state machine, HARD/CONDITIONAL edges, approval gates, readiness (`EXECUTABLE` / `PREPARED_HANDOFF` / `UNAVAILABLE`), append-only task events | migration `031`, `src/missions/plan-service.ts` |
| `reconcile`: recomputes `BLOCKED` / `AWAITING_APPROVAL` / `READY` from the graph, and invalidates tasks whose granted capabilities or approved provider types changed      | `PlanService.reconcile`                         |
| Authorized transitions `claim` / `complete` / `fail` / `handoff`, each gated on caller kind, assignment **and** a live capability check against the contract in force      | `PlanService`                                   |
| Durable queue with leases, `SKIP LOCKED`, effect `NONE` re-queued and effect `EXTERNAL` left `UNKNOWN` for a person                                                        | `src/automation/automation-service.ts`          |

What was missing was anything that **drove** them. The only executor was the launch run: a flat list of at most 8 read-only searches over 2 areas, which never touched a task, an edge or a gate. A plan run is the bridge.

## What it is

A **plan run** walks the mission's ACTIVE plan to a fixpoint. A member starts it (`POST /v1/admin/org/missions/:id/plan-runs`, permission `mission:plan`), the automation worker advances it, and it ends either **COMPLETE** (every task reached a final state) or **WAITING_ON_PEOPLE** with a **worklist**: one line per thing a person must now do. `GET .../plan-runs` lists runs; `POST /v1/admin/org/plan-runs/:id/cancel` (permission `mission:control`) stops one. On the Launch board the card shows the worklist and carries real **start** and **cancel** controls.

Per task, per pass:

| Graph says                                             | The run does                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `AWAITING_APPROVAL`                                    | records `WAITING_FOR_APPROVAL`. **It does not approve.**                            |
| `BLOCKED`                                              | records `BLOCKED` with the unmet dependency                                         |
| `READY`, no agent assigned, or readiness `UNAVAILABLE` | records `LEFT_FOR_MEMBER` with the reason; a member skips or changes the plan       |
| `READY`, no specialist connected                       | claims as the assigned agent, then **hands off** with a note naming what is missing |
| `READY`, a specialist connected                        | claims, dispatches, then completes with evidence, hands off, or records the failure |
| `IN_PROGRESS` under this run's key                     | resumes it; `claim` treats the repeat as idempotent                                 |

A pass that changes nothing ends the run. `MAX_PASSES` (24) bounds a pathological graph regardless.

## What it guarantees

- **It creates no authority.** Every transition goes through the same `PlanService` call an agent makes, **as the assigned agent**, so the capability check against the contract in force runs on each one. The run cannot do anything the agent could not have done by hand. Verified by mutation: removing the run's own approval gate does **not** let it act — `claim` refuses, because the task is not `READY`. The boundary is defended twice.
- **It never performs a consequential action.** It has no payment, booking, hiring or messaging path at all. Tests assert `mission_ledger_items`, `mission_purchase_orders` and `mission_messages` are unchanged across a run.
- **It stops at every gate a person owns.** It never approves, skips or invalidates anything. A paused mission stops it: it records `REFUSED` with `MISSION_NOT_ACTIVE` and advances nothing.
- **It will not act on a plan it was not started for.** The run stores its plan version; if the active plan is replaced mid-run it finishes `FAILED` and says so, rather than touching the new plan's tasks. Verified by mutation.
- **Durable, resumable, idempotent.** Effect `NONE`, because every action is bookkeeping or a read. A stable run key per (run, task) means a re-queued run resumes instead of double-acting. A second and third worker pass over a finished run change it byte for byte not at all.
- **One open run per mission** (partial unique index). Finished runs never change; the action log is append-only; nothing is deleted.
- **Tenant-isolated.** Another organization can neither list nor cancel a run; it reads as not found.

## What it is not (so no one infers otherwise)

- **No specialist is connected, so today every task it reaches becomes a handoff.** That is the honest state of the product, not a limitation of the executor: with no provider commissioned there is no automated work to do. `PlanSpecialist` is the registration point, and a specialist still cannot bypass `claim`.
- A handoff is **not** progress through the graph on its own. `HANDED_OFF` is not terminal, so a HARD dependent stays `BLOCKED` until a person **confirms** the handoff, which is what makes the second layer move. The tests walk exactly that path.
- It does not notify anyone when a run finishes.
- The worker only runs when `/v1/admin/ops/automation/run` is called. Nothing is deployed, so nothing runs anywhere.
- An agent cannot start a run; the routes are member-only.

## The screen

The run writes down what is waiting for a person. Before this slice there was nowhere to act on it: the customer application never fetched `/plans`, so M27's tasks were invisible to a customer and a run could say "approve this" with no approval control anywhere. Two screens now close that:

- **On the Launch board**, a plan-run card: the run's state in words, the worklist, and real **start** and **cancel** controls. Not an API-only feature.
- **`#/missions/:id/plan`**, the plan itself: every task with what it is for, how it can be done (`An agent can do this` / `Prepared for you or a provider` / `No honest way to do this`), what it is waiting on, and what the run said when it handed the task over. Each task carries the member actions that already existed on the Gateway and had no UI: **approve**, **I have done this** (confirm-handoff) and **skip**. A task that records evidence asks for a reference per required kind, because the API refuses the confirmation otherwise.

No new authority: every button is an existing authorized member action on `/v1/admin/org/tasks/:id/:op`, and none of them moves money.

## Evidence

`tests/m55-plan-run.integration.test.ts` — 8 tests, real HTTP, real Gateway, PostgreSQL, the deterministic template planner's real four-task graph:

1. a run drives the graph, hands off what nothing can do, and says who acts next (and nothing financial moves)
2. confirming a handoff lets the next run advance the layer behind it
3. the run reports a task awaiting approval and never approves it; a person still has to
4. a paused mission stops the executor: it refuses rather than acting, and says so
5. replacing the plan under a running run stops it instead of acting on a plan nobody started it for
6. a second worker pass changes nothing, and only one run may be open per mission
7. cancelling before the worker runs advances nothing; a finished run cannot be cancelled
8. another organization can neither see nor cancel this run

Mutation-checked, because a test that cannot fail proves nothing:

| Mutant                                                                            | Result                                                                                  |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| the run's approval gate removed, so it tries to claim an `AWAITING_APPROVAL` task | **killed** — and the task was still not acted on: `claim` refused it. Defence in depth. |
| the plan-version guard removed, so the run acts on a replaced plan                | **killed** — the run reported `WAITING_ON_PEOPLE` instead of `FAILED`                   |

### Database guarantees, verified directly against PostgreSQL

Independent of the service: all 65 migrations applied from scratch into an empty database, then each guarantee was
attacked with raw SQL and had to fail with its own message.

| Attack                                            | Result                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| A second open run for the same mission            | `duplicate key value violates unique constraint "plan_runs_one_open"` |
| `UPDATE` a row in the action log                  | `plan run actions are append-only`                                    |
| `UPDATE` a run that has finished                  | `a finished plan run cannot change`                                   |
| `DELETE` a run                                    | `plan runs are never deleted`                                         |
| `finished_at` set on a non-terminal state         | `violates check constraint "plan_runs_check"`                         |
| A new open run once the previous one has finished | accepted, as intended                                                 |

The partial unique index is what makes "one open run per mission" a fact rather than a convention: the service's own
`RUN_ALREADY_OPEN` refusal is the friendly form of that constraint, not a substitute for it.

### Two defects the real browser found, that no unit test would have

1. **A dead link.** The plan-run card pointed at `#/missions/:id/plan` and no such route existed; the router would have fallen through to the home page in silence. Following my own link is what exposed it — and behind it, that the application had no plan screen at all.
2. **Invalid markup, caught by axe.** The plan screen's `<dl>` used `<span>` as a placeholder for conditional rows. A `<dl>` permits only `dt`, `dd` and `div`, so axe reported `definition-list` violations. The `h` helper drops falsy children, so `false` is the correct placeholder; there are now no `h("span")` placeholders anywhere in the file.

Both are recorded because they are the kind of thing that survives a green unit suite: the first needed the link to be followed, the second needed the page to be rendered and audited.
