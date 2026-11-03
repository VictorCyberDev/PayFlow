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
  Vercel Authentication off (nothing is reachable because nothing is deployed). Non-secret variables already set (Production and Preview): `PAYFLOW_M5_DEMO`, `PAYFLOW_M6_DEMO_AGENT`,
  `PAYFLOW_PUBLIC_SANDBOX`, `PAYFLOW_M5_PRINCIPAL_ID=public-sandbox-owner`, `PAYFLOW_M5_AGENT_ID=public-sandbox-agent`, `PAYFLOW_M6_SIGNING_KID=public-2026-11`, `PAYFLOW_M5_ORIGIN=https://payflow-public.vercel.app`
  (correct that last value if the real origin differs). No PayPal variable exists on it.
- **Evidence environment protected:** Vercel Authentication was found OFF on `payflow-m6-acceptance` and is now ON for that whole project.

## Done on 2026-11-03 (second pass; no secret was written by me)

- **Runtime identity:** `svc_public_rt` exists on `withered-rice-68056451` as a plain `LOGIN` role in `payflow_runtime` (not superuser, no CREATEDB / CREATEROLE / BYPASSRLS) and has **no password yet**.
  Verified on the real database as `payflow_runtime`: reads and writes work; `CREATE TABLE`, `ALTER TABLE`, `TRUNCATE` of the append-only audit log and `GRANT payflow_migrator` are all refused.
  The database now admits only its owner and `payflow_runtime` (`CONNECT` revoked from `PUBLIC` and `neon_superuser`).
- **Sandbox principal provisioned:** one principal, one agent passport (valid to 2027-02-01), one activation policy. No accepted history was copied.
- **Scheduler, alert channel, canonical URL, acceptance scripts:** merged in this pass. `CRON_SECRET` can call only `GET /v1/admin/ops/reconcile/tick`; `PAYFLOW_ALERT_WEBHOOK_URL` delivers P0/P1/P2 alerts;
  `POST /v1/admin/ops/alerts/test` proves the channel with a labelled synthetic alert. `/developers` redirects to `/docs/`.
- **A mistake to fix:** to make a login I called Neon's role API, which returned a generated password into this session and gave that role `neon_superuser`. I could not alter or drop it
  (the owner is refused), so I made it harmless by revoking its `CONNECT`; it cannot open a session on the application database. **Delete the role `svc_public_app` in the Neon console.**

## Why I stopped (the one boundary)

Putting a database password, an operator token, a signing key and a scheduler secret into Vercel means those values pass through a tool call in this session. The environment's safety layer refused to let me
generate and print one, and your standing rule is never to print credentials. I did not work around that. Everything that needs no secret is done.

## The minimal owner steps

1. **Neon console → project `payflow-public-sandbox` → Roles → `svc_public_rt` → Reset password.** Copy the connection string for database `neondb`. (Also delete `svc_public_app`.)
2. **Vercel → project `payflow-public` → Environment Variables** (Production and Preview, tick _Sensitive_):
   - `DATABASE_URL` = the `svc_public_rt` connection string from step 1;
   - `PAYFLOW_GATEWAY_ADMIN_TOKEN`, `PAYFLOW_M5_BOOTSTRAP_KEY`, `CRON_SECRET` = three different random strings of 32+ characters (`openssl rand -base64 48 | tr -dc A-Za-z0-9 | cut -c1-48`);
   - `PAYFLOW_M6_SIGNING_KEY` = a new Ed25519 key (`openssl genpkey -algorithm ed25519`, paste the whole PEM). **Not** the acceptance key;
   - optional `PAYFLOW_ALERT_WEBHOOK_URL` = an https Slack/Discord/other incoming-webhook URL. Without it, alerts are persisted and visible but not delivered.
3. **Say "go".** I then deploy `main` once to `payflow-public`, run `scripts/public-acceptance.mjs <url>` and `A11Y_ORIGIN=<url> node scripts/a11y-acceptance.mjs`, exercise the scheduler and the synthetic alert,
   prove the app is connecting as `svc_public_rt`, record the result, and flip Gate A.
4. **A real, monitored security contact address**, which I will place in `SECURITY.md`, `security.txt` and the Security page.

Do not turn Vercel Authentication on for `payflow-public`, and do not touch `payflow-m6-acceptance` (Authentication stays on).

## Security contact

`SECURITY.md` and `/.well-known/security.txt` still carry a placeholder because I do not know a monitored address and will not invent
one or publish your personal address without your say-so. Give me an address that someone actually reads and I will put it in
`SECURITY.md`, `security.txt` and the Security page. Until then the page says so plainly.
