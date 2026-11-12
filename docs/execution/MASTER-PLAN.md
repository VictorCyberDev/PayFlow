# Master plan — execution layer

This directory is the **process layer**: what is running, what is blocked, how to resume. It deliberately does **not** fork the two records that already exist and are authoritative:

- **Requirement status per milestone:** `docs/M1-M90-AUDIT-MATRIX.md` (sourced, and honest that it is partial).
- **Merge and CI evidence per slice:** `docs/V3-EXECUTION-LEDGER.md`.
- **Narrative state and what is _not_ done:** `docs/PROGRAM-CHECKPOINT-2026-11-11.md`.

Duplicating those here would create a second source that drifts. Where this directory and those disagree, those win on requirement status, and this wins on process state.

## Files

| File                     | What it holds                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ACTIVE-RUNS.json`       | Every process this session started or observed, with the exact SHA it belongs to. Never advanced to a terminal state by inference. |
| `EXTERNAL-BLOCKERS.md`   | The five proven external blockers, each with what was attempted and the exact dependency.                                          |
| `RECOVERY-CHECKPOINT.md` | One-step resumption state if this session is interrupted.                                                                          |
| `RELEASE-STATE.md`       | What is merged, what is deployed, and the distance between them.                                                                   |

## Operating rules this session holds itself to

1. **A started process is not a finished one.** CI that is `queued`/`in_progress` is recorded as such, and the dependent step waits while independent work continues.
2. **Acceptance is pinned to a SHA.** A green check on an earlier head is evidence for that head only. Before accepting, the head is read back and compared.
3. **One vitest process at a time** in this environment; a second corrupts the shared test database.
4. **The unit run is not the gate.** `npm test` without `TEST_DATABASE_URL` skips 1401 tests. Only the run with the database is acceptance evidence.
5. **A blocker closes one path, not the program.** Each external blocker leaves its internal contract and negative tests executable; that is where work goes.

## Verified facts this session established directly from source

- `main` and `claude/payflow-v3-m1-m90-6rh3ha` are both `5cb1461d08fc82de13c7583f0d74cb954cd24f4e`. The checkpoint's "main is `5658f8a`" is stale by two merges (#83, #80).
- Repository carries migrations `001`–`064`; the public database holds `001`–`023`.
- `npm test` with no database: 105 files passed, 67 skipped; 1380 tests passed, **1401 skipped**; exit 0.
- Open PRs are #85 (green on exact head, test-only), #84 (`console-e2e` red), #32 and #17 (both draft, both stale by many commits).
- **M55 is no longer only a gap: the executor was built and accepted in this session.** Migration `065`, `src/missions/plan-run-service.ts`, `src/network/plan-run-routes.ts`, the `PLAN_RUN` automation handler, a plan-run card with real start and cancel controls on the Launch board, and `tests/m55-plan-run.integration.test.ts` (8 tests, PostgreSQL + real HTTP, 2 mutants killed). `docs/M55-PLAN-RUNS.md` states what it guarantees and what it is not. What remains is per-domain specialists, each needing a commissioned provider, and a deployment.
- The M27 plan layer already carries a dependency graph (`mission_task_deps`, HARD/CONDITIONAL), a nine-state task machine, approval fields, append-only task events and optimistic `row_version`. The M55 launch-run slice does **not** use any of it: it runs a flat list of at most eight read-only searches over two areas. **That is the M55 gap** — not a missing graph, but a missing bridge to the graph that exists.
