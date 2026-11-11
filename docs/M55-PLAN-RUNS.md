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
