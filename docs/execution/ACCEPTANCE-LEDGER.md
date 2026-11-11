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
