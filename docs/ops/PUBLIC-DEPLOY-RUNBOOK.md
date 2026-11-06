# Public deployment: verification and rollback

Status: 2026-11-06. Written before the first deployment. Nothing here has been executed against a live public host.

## Preconditions (all must hold before deploying)

1. `docs/OWNER-ACTIONS.md` steps 1 to 5 are done: `svc_public_app` removed, `scripts/verify-runtime-role.mjs` printed `RUNTIME ROLE VERIFIED`, secrets set Production-only and Sensitive.
2. `node --import tsx scripts/public-readiness.mjs --envs <names.json>` prints `"ready": true` (the file lists variable **names, targets and types** from Vercel, never values).
3. The source to deploy is `main` at a SHA whose CI is green. Never a feature branch, never `cd5c427`, never the acceptance project.

A deployment without the secrets is refused by design: the host answers `503 {"status":"UNAVAILABLE"}` and logs the fixed token `M6_HOST_CONFIGURATION_INVALID` when its configuration is invalid. That is the fail-closed behaviour, not something to ship.

## Deploy once

A single **production** deployment of `main` to the existing project `payflow-public` (project root `hosting/m6`, no Git connection, so nothing else deploys it). Target must be `production` so Production-scoped secrets apply.

## Verify (in this order; stop at the first failure)

| #   | Check                                                                                                                                              | Command / evidence                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The canonical alias answers 200 anonymously, with no Vercel login                                                                                  | `node --import tsx scripts/public-acceptance.mjs https://payflow-public.vercel.app`                                                                                                   |
| 2   | The ten public routes (`/ /product /developers /docs /sandbox /verify /security /research /pricing /status`)                                       | same script; `/developers` follows a same-origin redirect to `/docs/`                                                                                                                 |
| 3   | Every admin, credential, member, key and ops route refuses an anonymous caller                                                                     | same script (15 routes)                                                                                                                                                               |
| 4   | `/v1/keys/` lists public keys only                                                                                                                 | same script                                                                                                                                                                           |
| 5   | The stranger journey: sandbox start, scoped credential, sample Authority, ALLOW, DENY (`$0 moved`), Proof, offline verify, tampered Proof rejected | same script (spawns `scripts/stranger-journey.mjs`)                                                                                                                                   |
| 6   | The app really connects as `svc_public_rt`                                                                                                         | Neon: `select usename, count(*) from pg_stat_activity where datname='neondb' group by 1` shows `svc_public_rt` and **no** owner session from the app                                  |
| 7   | Responsive and keyboard acceptance on the deployed site at 320, 375, 430, 768, 1024, 1440                                                          | `A11Y_ORIGIN=https://payflow-public.vercel.app node scripts/a11y-acceptance.mjs`                                                                                                      |
| 8   | The scheduler credential works for the tick and nothing else                                                                                       | `curl -H "Authorization: Bearer $CRON_SECRET" .../v1/admin/ops/reconcile/tick/` returns 200 `via: SCHEDULER`; the same secret on any other admin route is refused                     |
| 9   | Repeated scheduled ticks are idempotent                                                                                                            | call it twice; the second reports `enrolled: 0`, `examined: 0` (or no due work)                                                                                                       |
| 10  | The alert channel (only if `PAYFLOW_ALERT_WEBHOOK_URL` is set)                                                                                     | operator `POST /v1/admin/ops/alerts/test/`: `delivery.delivered` is 1 and the message arrives at the channel. **If no webhook is set, record "not configured"**; never "commissioned" |
| 11  | The acceptance environment is still private                                                                                                        | `payflow-m6-acceptance` hosts return 302                                                                                                                                              |

Record the result, the deployment id and the canonical URL in `docs/evidence/public/`. Record failures too.

## Roll back

Choose the smallest action that stops the harm, in this order:

1. **Stop new executions without redeploying** (instant, reversible, `$0` effect): as the Neon owner,
   `insert into execution_controls (scope, disabled, reason) values ('GLOBAL', true, 'incident') on conflict (scope) do update set disabled = true;`
   Lift with `update execution_controls set disabled = false where scope = 'GLOBAL';`. Proof and reads keep working.
2. **Close the public door:** unset `PAYFLOW_PUBLIC_SANDBOX` and redeploy (no new sandbox tenants), or switch Vercel Authentication **on** for `payflow-public` (the whole site becomes private at once).
3. **Return to a previous deployment:** Vercel → Deployments → the last known-good deployment → Promote (or `request_rollback`). The first deployment has no predecessor; use steps 1 and 2 instead.
4. **Compromised secret:** rotate it in Vercel (new value, Production-only, Sensitive) and redeploy. Signing key: set a **new** `PAYFLOW_M6_SIGNING_KEY` **and a new** `PAYFLOW_M6_SIGNING_KID`; the old public key stays published so earlier Proof still verifies; to withdraw it entirely use the key registry's revoke (see `docs/security-ops/M14-OPERATIONS.md`). Database password: `ALTER ROLE svc_public_rt PASSWORD …` in Neon, then update `DATABASE_URL` and redeploy.
5. **Database:** the schema never changes on deploy. If data is damaged, restore from a Neon branch snapshot taken beforehand (`docs/security-ops/BACKUP-RESTORE.md`). Take one before the first public deployment.

## What this deployment can never do

It has no PayPal variable, so it cannot move real money; its database contains no accepted M6/M7 evidence; its credentials are different from the acceptance environment's; and its `sbx_` tenants can only reach the simulated rail (tested, fail-closed).
