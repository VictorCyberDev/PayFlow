# M55 slice — launch runs

Status: IMPLEMENTED, WIRED (member routes), DB_ACCEPTED (migration 064, PostgreSQL integration tests), UI_ACCEPTED for the read-out only (browser test with stubbed responses, axe). Not PROVIDER_ACCEPTED: the only sources are fictional sandbox fixtures. Nothing is deployed.

## What it is

A **launch run** is a durable, ordered list of up to 8 **read-only discovery steps** (workspace search, services search) for one active mission. A member starts it (`POST /v1/admin/org/missions/:id/launch-runs {steps:[{area, request}]}`, permission `mission:plan`), the automation worker executes it, and it ends **READY** with a short summary per step (how many results, how many meet the mission's needs). `GET .../launch-runs` lists the latest runs; `POST /v1/admin/org/launch-runs/:id/cancel` (permission `mission:control`) stops one.

## What it guarantees

- **It only looks.** Each step calls the existing search service, which stores observations and reserves, books, buys, hires, pays and contacts no one. Tests assert the ledger and the bookings are unchanged.
- **Durable and resumable.** Work lives in PostgreSQL (`launch_runs`, `launch_run_steps`). The job is an automation job with effect NONE, so a lost worker is retried by the existing framework; a re-run **skips finished steps** and redoes only the interrupted one. A retried workspace search uses a deterministic idempotency key, so it replays rather than searching twice.
- **Honest outcomes.** A search the mission does not allow (unapproved provider type, wrong currency, price above the commitment, unknown source) is recorded as `REFUSED` with the reason, and the run continues. A source that is down is a refusal from the search service, not a crash.
- **One open run per mission** (partial unique index). Cancelling stops the run **between steps**: the step in hand finishes, the next never starts. Finished runs and steps are immutable; a step's request never changes; nothing is deleted.
- **Not a decision-maker.** What to do with the results (propose a booking, request a quote, shortlist someone) stays a separate, human-approved action on its own screen. UNKNOWN effects are not involved because nothing here has an external effect.

## What it is not (so no one infers otherwise)

- It is **not** the full M55 mission: nothing is bought, booked, hired or paid by a run, and nothing sequences those actions across areas, retries them, or reacts to their outcomes. The Launch board still only reports.
- A run cannot be started from a screen yet; the board shows the latest run and lets a member cancel it. Starting is via the API (or an agent with the right capability on the same routes, which are member-only today).
- No notification is sent when a run is ready.
- Steps are workspaces and services only. Talent, commerce and contractor discovery are not included.
- The automation worker only runs when `GET/POST /v1/admin/ops/automation/run` is called (the scheduler or an operator). Nothing is deployed, so nothing runs anywhere.
