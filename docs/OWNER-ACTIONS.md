# Owner actions that genuinely require the owner

Status: 2026-11-06. Gate A (public developer preview) is **not commissioned**. The code is merged and verified; the public project is
prepared and empty. These are the only steps left, and each one needs a secret, a destructive-tool approval, or a decision.
**No step asks you to paste a credential into chat, and none of them passes a secret through this assistant.**

Live state when this was written (re-verified, not assumed):

| Item                                       | State                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `main`                                     | `325d9af9a478f68c6f488933c765fac3c38a998a`                                                                                                                   |
| `payflow-public` (Vercel)                  | no Git connection, **no deployment**; 7 non-secret variables; **none of the 5 required secrets** (see below)                                                 |
| `payflow-m6-acceptance` (Vercel)           | Vercel Authentication ON; anonymous requests get 302. Never the public sandbox                                                                               |
| Neon `withered-rice-68056451`              | schema = accepted schema; sandbox principal provisioned; no accepted history                                                                                 |
| `svc_public_rt` (runtime login)            | `LOGIN`, not superuser, no CREATEDB/CREATEROLE/BYPASSRLS, member of `payflow_runtime`; **password not set** (login attempt: "required password")             |
| `svc_public_app` (**privileged, exposed**) | `LOGIN`, `neon_superuser`, CREATEDB, CREATEROLE, BYPASSRLS. Cannot connect to `neondb`; **can still connect to `postgres` and `template1`**. Must be removed |

## 1. Remove the privileged role `svc_public_app` (needs your approval)

Its password appeared in a tool result in an earlier session, so treat it as compromised. Revoking `CONNECT` on `neondb` was a mitigation, not a fix:
the role still holds `neon_superuser` and can log in to the two system databases. Do not rely on the mitigation, do not restore its access, do not use it.

**Dependencies were checked (read-only catalog queries, 2026-11-06): the role owns no table or schema, holds no grants or default privileges, has no
dependents, and its only membership is `neon_superuser`.** No `REASSIGN OWNED` / `DROP OWNED` is needed, and no application object references it.

Either way of removing it works; pick one:

- **A. You do it:** Neon console → project `payflow-public-sandbox` → branch `main` → Roles → `svc_public_app` → Delete.
- **B. You approve me:** reply "approve deleting svc_public_app" and I delete it with Neon's role-deletion control. I will not do it without that sentence.

Verify afterwards (I will run these and report only the results):

```sql
select count(*) from pg_roles where rolname = 'svc_public_app';   -- expect 0
select count(*) from pg_shdepend d join pg_roles r on r.oid = d.refobjid where r.rolname = 'svc_public_app'; -- expect 0
```

If deletion is refused, the refusal names the dependency; the fallback is the Neon support / organization-owner route, not recreating anything.
**Do not create roles with Neon's role-creation API again**: it grants `neon_superuser` and returns the password. Create roles in SQL.

## 2. Set the private password for `svc_public_rt`

`svc_public_rt` already has `LOGIN` and the right memberships. Nothing needs altering except its password.

In the Neon SQL editor (project `payflow-public-sandbox`, database `neondb`), as the owner, type a password you generate yourself:

```sql
ALTER ROLE svc_public_rt PASSWORD '<a long random value you generate; never paste it into chat>';
```

Then build the connection string yourself: `postgresql://svc_public_rt:<that password>@<pooled host from the Neon console>/neondb?sslmode=require`.

## 3. Prove the login is least-privilege (you run it; it prints pass/fail only)

On your own machine, with the string from step 2 in **your** shell:

```bash
DATABASE_URL='<the svc_public_rt string>' node scripts/verify-runtime-role.mjs
```

It connects, reads and (rolled-back) writes tenant data, and confirms it **cannot** create, alter, drop, truncate the audit log, rewrite evidence, create roles, gain migration rights or disable triggers. It prints `RUNTIME ROLE VERIFIED` or lists what failed, and never prints the string or the password.
(Tested: it passes the runtime role and fails the read-only role and a superuser.)

## 4. Set the Vercel secrets (Production only)

Vercel → project `payflow-public` → Settings → Environment Variables. For each: **Environment = Production only**, **Sensitive = on**.
Do **not** tick Preview or Development: a production credential must never reach an unreviewed preview. (If a Preview is ever needed, it gets its own database and its own credentials.)

| Name                          | What it is                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | the `svc_public_rt` string from step 2. Never the owner's string                                   |
| `PAYFLOW_GATEWAY_ADMIN_TOKEN` | platform-operator secret, 32+ random characters; distinct from every other value                   |
| `PAYFLOW_M5_BOOTSTRAP_KEY`    | 32+ random characters; distinct                                                                    |
| `CRON_SECRET`                 | 32+ random characters; distinct. Vercel Cron sends it automatically                                |
| `PAYFLOW_M6_SIGNING_KEY`      | a **new** Ed25519 key: `openssl genpkey -algorithm ed25519`, the whole PEM. Not the acceptance key |
| `PAYFLOW_ALERT_WEBHOOK_URL`   | optional: an https incoming-webhook URL you control. **Until set, no alert channel is configured** |

Generate random values locally, for example `openssl rand -base64 48 | tr -dc A-Za-z0-9 | cut -c1-48`, and store them in your own secret manager.
The 7 non-secret variables are already set. Leave every `PAYPAL_*` variable absent: with no rail the real path refuses and only the simulated sandbox runs.

## 5. A real, monitored security contact

Give me an address that someone actually reads (a dedicated alias is best). I will put it in `SECURITY.md`, `security.txt` and the Security page. I will not invent one or use your account address unasked.

## 6. Say "deploy"

I then check the variables (names, scopes and types only, never values) with `node --import tsx scripts/public-readiness.mjs --envs <names.json>`, deploy `main` once to `payflow-public` as a **production** deployment, and run the live acceptance
described in `docs/ops/PUBLIC-DEPLOY-RUNBOOK.md`. Until a deployment exists I will not claim the public site is live, the alert channel is commissioned, or Gate A is closed.

Do not turn Vercel Authentication on for `payflow-public`, and do not touch `payflow-m6-acceptance`.
