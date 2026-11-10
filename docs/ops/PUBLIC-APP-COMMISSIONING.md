# Public customer application: commissioning plan (Track A)

Derived from the source on 2026-11-10. It supersedes the environment and migration parts of `PUBLIC-DEPLOY-RUNBOOK.md` (whose verification and rollback sections still apply). Nothing here has been executed against `payflow-public`.

## Architecture decision

Two Vercel projects, on purpose:

- **`payflow`** (Git-connected, auto-deploys `main`): the company site (`build:company`) and the PayPal payer-return function. Already fixed (PR #69). It must stay separate so a company-site deploy can never alter the application's secrets or database.
- **`payflow-public`** (root `hosting/m6`): static console export plus the `/api/host` function that serves `/v1/*`, the embedded `/workspace/` customer app and the cron routes. This project holds the database credential. Merging the two would put an application database secret on the marketing deploy path and make every docs change a financial-system deploy, so they are not merged.

## What the owner must do (one consolidated list; nothing else blocks the app)

1. **Database credential.** In Neon, set a password for `svc_public_rt` (or create `svc_public_rt2` `IN ROLE payflow_runtime`); put the pooled connection string in Vercel `payflow-public` as **DATABASE_URL** (Production, Sensitive). Never an owner or `neon_superuser` role.
2. **Secrets in Vercel `payflow-public`** (Production, Sensitive): `PAYFLOW_M5_BOOTSTRAP_KEY` (random, 32+ chars). `PAYFLOW_M6_DEMO_AGENT=true` must stay: **the whole hosted Gateway, including the customer app, is mounted only when the demo agent is configured** (found by running the compiled host without it: every `/v1/app` route answered 404). It therefore needs a **new** `PAYFLOW_M6_SIGNING_KEY` (never the historical acceptance key). Do **not** set `PAYPAL_ENVIRONMENT`, `PAYPAL_CLIENT_ID` or `PAYPAL_CLIENT_SECRET` on this project: without them the agent has no payment provider and no payment can execute. (An earlier version of this line offered deleting the variable; that was wrong.)
3. **Operator and scheduler** (needed for booking-expiry jobs, email sending and the two crons): `PAYFLOW_GATEWAY_ADMIN_TOKEN` and `CRON_SECRET`, each random 32+ chars.
4. **Project settings:** Root Directory `hosting/m6`; Vercel Authentication **on** until the acceptance in "Verify" passes, then the owner decides about turning it off or attaching a domain.
5. **Approve the migration run** (below), executed by `payflow_migrator`, after a Neon branch snapshot.
6. **Email (optional now):** a Resend API key and a verified sender; without them mail stays queued and the app says so.

`node --import tsx scripts/env-contract.mjs names.txt` lists which **names** are missing (never values). Today, for `payflow-public`, it reports missing: `DATABASE_URL`, `PAYFLOW_M5_BOOTSTRAP_KEY`, and for enabled features `PAYFLOW_M6_SIGNING_KEY`, `CRON_SECRET`. Not required, contrary to older notes: `PAYFLOW_APP_ORIGINS` (it defaults to `PAYFLOW_M5_ORIGIN`, which is set) and `PAYFLOW_GATEWAY_ADMIN_TOKEN` for member routes (it gates operator routes only). The contract is checked against the real parser by `tests/env-contract.test.ts`.

## Database

- Target: Neon project `withered-rice-68056451` (`payflow-public-sandbox`), default branch. Application database only; the merchant environment is separate.
- **Current state (read-only check, 2026-11-10):** exactly migrations **001–023** are applied (every table of 001–023 exists; none from 024 onward). No migrations table exists, so this was established by comparing each file's `CREATE TABLE` names with the live tables.
- **Pending, in order:** 024–027, 029–060. **028 is skipped**: it creates the merchant Verify SDK stores for a separate environment, and nothing in `src/` reads them. `node --import tsx scripts/public-migration-plan.mjs` prints the exact list.
- **Rehearsals done locally:** fresh install of every file except 028 (success, 138 tables); and an **upgrade** rehearsal (001–023, then the pending list in order) in `tests/migration-plan.test.ts`.
- **Preflight:** Neon branch snapshot of the default branch (instant, copy-on-write); confirm `select max(...)`-style sanity by listing tables; confirm the migrator identity is `payflow_migrator`, not the app role.
- **Apply:** each pending file in order with `psql -v ON_ERROR_STOP=1`, as `payflow_migrator`. Then run `db/roles/least-privilege.sql` as the schema owner (it re-grants the runtime role on the new tables and sets default privileges), then `scripts/verify-runtime-role.mjs`.
- **Verify after:** table count; the append-only guards (`update`/`delete` on `mission_*` ledgers refuse); `svc_public_rt` can read and write tenant tables and cannot `create table` or `truncate`; sessions persist across a function cold start.
- **Rollback:** the schema is additive. If the migration fails midway, restore the Neon branch snapshot; if it succeeds but the app misbehaves, use the rollback steps in the runbook (execution controls, public door, previous deployment).
- **`svc_public_app` (neon_superuser):** do not use it. Removal needs the owner's explicit approval, after the app is confirmed to connect as `svc_public_rt` (`pg_stat_activity`). Dependency-safe sequence: confirm no objects are owned by it (`reassign owned`/`drop owned` only after listing them), then drop the role.

## Deploy and verify (after the owner steps)

Deploy `main` to `payflow-public` production, then run the runbook's verify table plus, with a real browser and real HTTP: signup, login, session persistence across navigation and hard refresh, logout, session expiry, mission creation and approval, agent management, finance and Proof views, wrong-tenant denial, a refused over-limit payment, and the cron routes with `CRON_SECRET`. Record the status codes, not just "passed". Distinguish Vercel-protected access from anonymous access.

## Marketing site

`/` serves the company site. Its CTAs "Sign in" (`/app/`) and "Start in Sandbox" (`/sandbox/`) do not reach a working customer sign-in until `payflow-public` is live and a domain or protection decision is made. Until then they must say so (see the CTA audit in this PR series).
