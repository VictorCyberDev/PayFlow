# Recovery checkpoint

Written so that an interruption costs the next session discovery, not work. Updated as state changes; the machine-readable process state is `ACTIVE-RUNS.json`.

```
CURRENT_MAIN_SHA          5cb1461d08fc82de13c7583f0d74cb954cd24f4e
CURRENT_WORKING_BRANCH    claude/payflow-v3-m1-m90-6rh3ha (from main, equal at session start)
OPEN_PR_NUMBERS           85 (green on exact head), 84 (console-e2e red), 32 (draft/stale), 17 (draft/stale)
LAST_VERIFIED_ACCEPTANCE  npm test without a database on 5cb1461: 1380 passed / 1401 skipped, exit 0.
                          The run WITH TEST_DATABASE_URL is the real gate and was still running at the time of writing.
RUNNING_PROCESSES         see ACTIVE-RUNS.json
CI_RUN_IDS                43025766351 (PR #85, all green), 43021599690 (PR #84, console-e2e failed)
FAILED_TESTS              tests/r1-customer-app.browser.test.ts:1391 — 30s timeout waiting for the
                          `Launch board` h1 (level 1). Observed on PR #84's head 2496c32. NOT yet
                          reproduced on main; reproducing it is the next step.
PENDING_DEPLOYMENTS       none (nothing is deployed to payflow-public)
ACTIVE_SUBAGENTS          none
COMPLETED_MILESTONES      see docs/M1-M90-AUDIT-MATRIX.md — authoritative and honest that it is partial
UNFINISHED_MILESTONES     same matrix; the large ones are M55 orchestration, M59 billing/usage/support,
                          M60 acceptance, M61–M64, M66, M72–M90
BLOCKED_TASKS             the five in EXTERNAL-BLOCKERS.md
APPROVAL_REQUESTS         none raised by this session
NEXT_EXECUTABLE_TASK      1. Reproduce the Launch board browser failure on main and fix it or prove it
                             order-dependent. 2. Land PR #85. 3. M55 plan-graph executor.
```

## Environment facts that cost time to rediscover

- `TEST_DATABASE_URL` — not `DATABASE_URL` — gates every integration suite. Without it `npm test` silently skips 1401 tests and still exits 0. **A green `npm test` is not acceptance.**
- PostgreSQL 16 is installed but the `payflow` role does **not** survive a new container. Recreate it:
  ```
  service postgresql start
  su postgres -c "psql -c \"create role payflow login password 'payflow_test' superuser;\""
  su postgres -c "psql -c 'create database payflow_test owner payflow;'"
  ```
- One vitest process at a time; a second corrupts the shared test database.
- Browser tests need `apps/console/node_modules/playwright-core` (`npm ci` in `apps/console`). The browser itself is already at `/opt/pw-browsers/chromium`, which `tests/r1-customer-app.browser.test.ts` already prefers, so no `playwright install` is needed or wanted.
- Run a browser test with `TEST_DATABASE_URL=... REQUIRE_BROWSER=1 npx vitest run <file>` from the repository root.

## Exact resumption command

```
cd /home/user/PayFlow && service postgresql start && git fetch origin && git log --oneline -3
```

Then read `ACTIVE-RUNS.json`, re-observe any run still marked `RUNNING`, and continue at `NEXT_EXECUTABLE_TASK`.
