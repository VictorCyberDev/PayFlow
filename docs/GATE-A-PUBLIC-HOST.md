# Gate A public host: topology and the steps only the owner can take

Status: 2026-11-03. Written after inspecting the Vercel team. Nothing in this file has been executed.

## What exists today (observed)

| Project                 | Purpose                                         | Protection                                                                         | Database                                                            |
| ----------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `payflow`               | production alias `payflow-one-kappa.vercel.app` | Vercel Authentication on every `*.vercel.app` host (`all_except_custom_domains`)   | not inspected (env values are never read)                           |
| `payflow-m6-acceptance` | M6/M7 acceptance and the 2026-11-03 RC preview  | Vercel Authentication **was OFF** (anonymous 200) until 2026-11-03; now ON (`all`) | the **accepted evidence database** (Neon `br-noisy-brook-b89epb6e`) |

Consequence, measured: `https://payflow-one-kappa.vercel.app/` returns 404 to an anonymous client, and so do `/verify/`, `/status/`,
`/.well-known/security.txt`, `/sitemap.xml` and `/robots.txt`. The canonical URL in the site metadata therefore points at a host a
stranger cannot reach. The production alias also serves the M6 build (main at `3b1b263`), not this work.

## Topology (recommended)

```text
ACCEPTED EVIDENCE   payflow-m6-acceptance  ── protected ── Neon: accepted branch (M6/M7 evidence). Never public.
PUBLIC GATE A       payflow                ── public    ── NEW isolated Neon project/database, sandbox data only,
                                                            SIMULATED rail only, PAYFLOW_PUBLIC_SANDBOX=true
```

Why: the self-serve sandbox creates tenants for strangers. It must not share a database with accepted payment evidence. The public
project routes `sbx_` organisations only to the simulated provider (`src/simulated-rail.ts`, fail-closed), holds no PayPal secret, and
needs no wallet. Real organisations can never reach the simulated provider.

## Done on 2026-11-03 (no secrets involved)

- **Isolated database created:** Neon project `withered-rice-68056451` (branch `br-steep-glade-bdsyx5v5`, PostgreSQL 17), separate from the accepted
  evidence project. Migrations `001`–`023` and the three NOLOGIN roles are applied; its schema fingerprint equals the accepted database's. It holds no data.
- **Public Vercel project created, empty:** `payflow-public` (`prj_BDxFuhwF0AcvRJaGWehd3eZSIYWm`), root `hosting/m6`, Node 22, **no Git connection** (nothing deploys by itself), **no deployment**,
  Vercel Authentication off (nothing is reachable because nothing is deployed). Non-secret variables already set (Production only, Sensitive): `PAYFLOW_M5_DEMO`, `PAYFLOW_M6_DEMO_AGENT`,
  `PAYFLOW_PUBLIC_SANDBOX`, `PAYFLOW_M5_PRINCIPAL_ID=public-sandbox-owner`, `PAYFLOW_M5_AGENT_ID=public-sandbox-agent`, `PAYFLOW_M6_SIGNING_KID=public-2026-11`, `PAYFLOW_M5_ORIGIN=https://payflow-public.vercel.app`
  (correct that last value if the real origin differs). No PayPal variable exists on it.
- **Evidence environment protected:** Vercel Authentication was found OFF on `payflow-m6-acceptance` and is now ON for that whole project.

## Done on 2026-11-03 (second pass; no secret was written by me)

- **Runtime identity:** `svc_public_rt` exists on `withered-rice-68056451` as a plain `LOGIN` role in `payflow_runtime` (not superuser, no CREATEDB / CREATEROLE / BYPASSRLS) and has **no password yet**.
  Verified on the real database as `payflow_runtime`: reads and writes work; `CREATE TABLE`, `ALTER TABLE`, `TRUNCATE` of the append-only audit log and `GRANT payflow_migrator` are all refused.
  The database now admits only its owner and `payflow_runtime` (`CONNECT` revoked from `PUBLIC` and `neon_superuser`).
- **Sandbox principal provisioned:** one principal, one agent passport (valid to 2027-02-01), one activation policy. No accepted history was copied.
- **Scheduler, alert channel, canonical URL, acceptance scripts:** merged in this pass. `CRON_SECRET` can call only `GET /v1/admin/ops/reconcile/tick` and `GET /v1/admin/ops/automation/run` (registered handlers only); `PAYFLOW_ALERT_WEBHOOK_URL` delivers P0/P1/P2 alerts;
  `POST /v1/admin/ops/alerts/test` proves the channel with a labelled synthetic alert. `/developers` redirects to `/docs/`.
- **A mistake, and why my first mitigation was not enough:** to make a login I called Neon's role API, which returned a generated password into a session and gave that role
  `neon_superuser`, CREATEDB, CREATEROLE and BYPASSRLS. I revoked its `CONNECT` on the application database; an independent inspection on 2026-11-06 showed it can still connect to the
  `postgres` and `template1` system databases. It is a privileged, exposed credential and must be **removed**, not contained. The procedure, and the dependency check showing a clean removal, are in
  `docs/OWNER-ACTIONS.md`. Never create roles through that API again.

## What remains

Everything left is in **`docs/OWNER-ACTIONS.md`** (removal of the privileged role, the private password for `svc_public_rt`, the Production-only Sensitive Vercel secrets, a security contact, and the word "deploy").
Deployment, live acceptance and rollback are in **`docs/ops/PUBLIC-DEPLOY-RUNBOOK.md`**. Deployment readiness is checked offline by `scripts/public-readiness.mjs`; the runtime login is checked by `scripts/verify-runtime-role.mjs`,
which the owner runs with their own `DATABASE_URL` and which prints only pass/fail.

Secrets are set by the owner in Neon and Vercel. They are not requested in chat and they do not pass through this assistant. An earlier suggestion to let them appear in a session transcript and rotate afterwards was wrong and is withdrawn.

## Security contact

`SECURITY.md` and `/.well-known/security.txt` still carry a placeholder because I do not know a monitored address and will not invent
one or publish your personal address without your say-so. Give me an address that someone actually reads and I will put it in
`SECURITY.md`, `security.txt` and the Security page. Until then the page says so plainly.
