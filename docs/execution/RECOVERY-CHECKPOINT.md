# Recovery checkpoint

Written so that an interruption costs the next session discovery, not work. The machine-readable process state is `ACTIVE-RUNS.json`.

```
CURRENT_MAIN_SHA          5cb1461d08fc82de13c7583f0d74cb954cd24f4e
CURRENT_WORKING_BRANCH    claude/payflow-v3-m1-m90-6rh3ha (pushed; 6 commits ahead of main)
OPEN_PR_NUMBERS           85 (green on exact head, verified locally, merge-ready), 84 (needs a docs rebase, not a
                          code fix), 32 and 17 (both draft, both stale)
DELIVERED_THIS_SESSION    the execution registry; M55 plan executor; M55 plan screen; M57 answer + pause/resume;
                          M58 template defect found and fixed; M59 usage and billing
LAST_VERIFIED_ACCEPTANCE  per slice, in ACCEPTANCE-LEDGER.md A-1..A-10. Every slice has its own suite green and at
                          least one killed mutant.
RUNNING_PROCESSES         see ACTIVE-RUNS.json
FAILED_TESTS              none outstanding
PENDING_DEPLOYMENTS       none (nothing is deployed to payflow-public)
UNFINISHED_MILESTONES     M60 acceptance; M61-M64, M66; M65 FX and M70 ERP wiring; M71 payment/refund UNKNOWN;
                          M72-M90. See docs/M1-M90-AUDIT-MATRIX.md.
BLOCKED_TASKS             the five in EXTERNAL-BLOCKERS.md, each proven
NEXT_EXECUTABLE_TASK      M60 (execute journeys A-H as runs and record them), then M65 FX / M70 export wiring where
                          money is shown, then M61-M64.
```

## Environment facts that cost time to rediscover

- `TEST_DATABASE_URL` — not `DATABASE_URL` — gates every integration suite. Without it `npm test` skips ~1400 tests and still exits 0. **A green `npm test` is not acceptance.**
- PostgreSQL 16 is installed but the `payflow` role does **not** survive a new container, and the server stops when the worker restarts. Recreate and restart:
  ```
  service postgresql start
  su postgres -c "psql -c \"create role payflow login password 'payflow_test' superuser;\""
  su postgres -c "psql -c 'create database payflow_test owner payflow;'"
  ```
- One vitest process at a time; a second corrupts the shared test database.
- **Never run `npm run embed:app` while a suite is running.** The browser tests read the embedded asset, so regenerating it mid-run invalidates the result. This cost two full-suite runs before it was understood; both reported a single unrelated browser failure that did not reproduce on a clean run.
- Browser tests need `apps/console/node_modules/playwright-core` (`npm ci` in `apps/console`). The browser is already at `/opt/pw-browsers/chromium`, which the test prefers, so no `playwright install`.
- `npm run lint` takes about two minutes. Budget for it; it is not hung.
- **Mutation discipline:** apply every mutant under an assertion that the pattern matched. Prettier reformats code after it is written, so a pattern written from memory silently misses and the suite then reports a pass against unmutated source. That happened once in this session and is recorded in A-8.

## Exact resumption command

```
cd /home/user/PayFlow && service postgresql start && git fetch origin && git log --oneline -3
```

Then read `ACTIVE-RUNS.json`, re-observe any run still marked `RUNNING`, and continue at `NEXT_EXECUTABLE_TASK`.
