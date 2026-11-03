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
- **Evidence environment protected:** Vercel Authentication was found OFF on `payflow-m6-acceptance` and is now ON for that whole project.

## Steps only the owner can take (each needs a secret to pass through a tool call, or changes who can reach the service)

1. **Provision the sandbox principal.** With the _owner_ connection string of the new Neon project (copy it from the Neon console; do not paste it into chat):
   `DATABASE_URL=… PAYFLOW_M5_PRINCIPAL_ID=public-sandbox-owner PAYFLOW_M5_AGENT_ID=public-sandbox-agent node --import tsx hosting/operator/provision-m5.ts`
   (tested against a fully migrated empty database: it provisions one principal, one passport and one policy, and is idempotent).
2. **Create the runtime login.** In that Neon project: `CREATE ROLE svc_public_app LOGIN PASSWORD '<from your secret store>' IN ROLE payflow_runtime;` and use _its_ connection string
   as `DATABASE_URL` on Vercel, so the running app never holds schema-owner rights.
3. **Create a new Vercel project** (not the acceptance one, not a branch of `payflow`) with root directory `hosting/m6`, and set its Production environment in the dashboard.
   Names only: `DATABASE_URL`, `PAYFLOW_GATEWAY_ADMIN_TOKEN` (platform operator, 32+ chars), `PAYFLOW_M6_SIGNING_KEY` (new Ed25519 PKCS8 PEM, **not** the acceptance key),
   `PAYFLOW_M6_SIGNING_KID` (unique, not `m6-hosted`), `PAYFLOW_M6_DEMO_AGENT=true`, `PAYFLOW_M5_DEMO=true`, `PAYFLOW_M5_PRINCIPAL_ID`, `PAYFLOW_M5_AGENT_ID`,
   `PAYFLOW_M5_BOOTSTRAP_KEY`, `PAYFLOW_M5_ORIGIN` (the public origin), `PAYFLOW_PUBLIC_SANDBOX=true`. Leave **every PayPal variable unset**: with no rail the real path refuses and only
   the simulated sandbox runs.
4. **Make that one project public:** Vercel Authentication off for it (and only it).
5. **Set the canonical origin** in `apps/console/lib/site.ts` to the public origin, in the commit that goes live.
6. **Schedule the reconciler** (`GET /v1/admin/ops/reconcile/tick` with the operator token) and **publish a real security contact** (below).
7. **Run the acceptance** against the public origin: `node --import tsx scripts/stranger-journey.mjs <origin>` and `node scripts/a11y-acceptance.mjs`, and record the result in `docs/GATE-EVALUATION.md`.

## Security contact

`SECURITY.md` and `/.well-known/security.txt` still carry a placeholder because I do not know a monitored address and will not invent
one or publish your personal address without your say-so. Give me an address that someone actually reads and I will put it in
`SECURITY.md`, `security.txt` and the Security page. Until then the page says so plainly.
