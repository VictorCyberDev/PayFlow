# Gate A public host: topology and the steps only the owner can take

Status: 2026-11-03. Written after inspecting the Vercel team. Nothing in this file has been executed.

## What exists today (observed)

| Project                 | Purpose                                         | Protection                                                                       | Database                                                            |
| ----------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `payflow`               | production alias `payflow-one-kappa.vercel.app` | Vercel Authentication on every `*.vercel.app` host (`all_except_custom_domains`) | not inspected (env values are never read)                           |
| `payflow-m6-acceptance` | M6/M7 acceptance and the 2026-11-03 RC preview  | Vercel Authentication                                                            | the **accepted evidence database** (Neon `br-noisy-brook-b89epb6e`) |

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

## Steps only the owner can take (they involve secrets or public exposure)

I did not do these: each one needs a secret value to pass through a tool call (which would put it in the session transcript), or
changes who can reach the service.

1. **Create the isolated database.** A new, empty Neon project (not a branch of the accepted one: a branch inherits its data).
   Apply `db/migrations/001` to `023` in order, then `db/roles/least-privilege.sql`; create a login in `payflow_runtime` for the app.
2. **Set the project's environment** in the Vercel dashboard (Production). Names only; values come from your secret store:
   `DATABASE_URL` (runtime-role login), `PAYFLOW_GATEWAY_ADMIN_TOKEN` (platform operator, 32+ chars), `PAYFLOW_M6_SIGNING_KEY`
   (new Ed25519 PKCS8 PEM, **not** the acceptance key), `PAYFLOW_M6_SIGNING_KID` (unique), `PAYFLOW_M6_DEMO_AGENT=true`,
   `PAYFLOW_M5_DEMO=true` with the M5 principal/agent/bootstrap/origin variables the host already requires, and
   `PAYFLOW_PUBLIC_SANDBOX=true`. Leave **all PayPal variables unset**: with no rail the real path refuses and only the simulated
   sandbox runs.
3. **Make the deployment reachable.** Either turn off Vercel Authentication for Production on this project, or attach a custom domain
   (the current setting already exempts custom domains). Do not do this for `payflow-m6-acceptance`.
4. **Set the canonical origin.** Edit `apps/console/lib/site.ts` to the public origin in the same commit that goes live.
5. **Bootstrap an owner** with `POST /v1/admin/members` and the operator token, and schedule `POST /v1/admin/ops/reconcile/tick`
   (see `docs/security-ops/M14-OPERATIONS.md`).
6. **Publish a real security contact** (see below).

## Security contact

`SECURITY.md` and `/.well-known/security.txt` still carry a placeholder because I do not know a monitored address and will not invent
one or publish your personal address without your say-so. Give me an address that someone actually reads and I will put it in
`SECURITY.md`, `security.txt` and the Security page. Until then the page says so plainly.

## After it is live

Run, against the public origin: the browser acceptance at 320/375/430/768/1024/1440 px, `POST /v1/sandbox/start` followed by an ALLOW,
a DENY and an offline-verified Proof, and record the result in `docs/GATE-EVALUATION.md`. Until that is recorded, Gate A stays open.
