# Owner actions that genuinely require the owner

Status: **re-measured 2026-11-11** (section 0 below carries today's readings; the header table and sections 1-6 are from 2026-11-06 and are corrected where section 0 says so). Gate A (public developer preview) is **not commissioned**. The code is merged and verified; the public project is
prepared and empty. These are the only steps left, and each one needs a secret, a destructive-tool approval, or a decision.
**No step asks you to paste a credential into chat, and none of them passes a secret through this assistant.**

Live state when this was written (re-verified, not assumed):

| Item                                       | State                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `main`                                     | ~~`325d9af9a478f68c6f488933c765fac3c38a998a`~~ — stale; see section 0 for today's SHA                                                                        |
| `payflow-public` (Vercel)                  | no Git connection, **no deployment**; 7 non-secret variables; **none of the 5 required secrets** (see below)                                                 |
| `payflow-m6-acceptance` (Vercel)           | Vercel Authentication ON; anonymous requests get 302. Never the public sandbox                                                                               |
| Neon `withered-rice-68056451`              | `payflow-public-sandbox`. At migrations `001`-`023`: 73 tables, 9 functions, **no account or mission schema** (section 0)                                    |
| `svc_public_rt` (runtime login)            | `LOGIN`, not superuser, no CREATEDB/CREATEROLE/BYPASSRLS, member of `payflow_runtime`; **password not set** (login attempt: "required password")             |
| `svc_public_app` (**privileged, exposed**) | `LOGIN`, `neon_superuser`, CREATEDB, CREATEROLE, BYPASSRLS. Cannot connect to `neondb`; **can still connect to `postgres` and `template1`**. Must be removed |

## 0. What changed since this page was written (re-measured 2026-11-11)

Everything in this section was **measured today**, read-only, against the live Vercel projects and the live
Neon database. Where it contradicts the rest of this page, this section is right and the older text is marked.

**Repository.** `main` is now `4852a2c (plus PR #80)` (this page previously said `9c810b1b`). The customer
application no longer needs the M6 demonstration agent to run (PR #80): `PAYFLOW_M6_SIGNING_KEY` is the host's
own key and is what mounts the Gateway, and `PAYFLOW_M6_DEMO_AGENT` is now only financial mode.

**Pending migrations are no longer five — they are 38.** This page said `024`–`027` and `029`. The public
database is still at `001`–`023`, and the repository now holds `024`–`062`. `028` is the merchant's own
database and is **skipped**, so **38 migrations** must be applied before the first deploy.

Measured on `payflow-public-sandbox` (`withered-rice-68056451`), database `neondb`, today: **73 tables, 9
functions, and none of `user_accounts`, `user_sessions`, `missions`, `email_outbox` or
`organization_invitations`.** So even with every secret set, a customer could not sign up: the account and
mission schema does not exist there yet. This is a migration approval, not a code gap.

**The exposed privileged role is still there.** Section 1 below is **not done**. Measured today:

| Role             | LOGIN | member of         | CREATEDB | CREATEROLE | BYPASSRLS |
| ---------------- | ----- | ----------------- | -------- | ---------- | --------- |
| `svc_public_app` | yes   | `neon_superuser`  | yes      | yes        | yes       |
| `svc_public_rt`  | yes   | `payflow_runtime` | no       | no         | no        |

The runtime role is correctly least-privileged. The compromised one is unchanged and still needs your word
(section 1). Nothing in this session touched either role.

**Vercel `payflow-public`:** still **no deployment**, no domains. Seven non-secret variables are set and
**all five required secrets are still absent** — confirmed by
`node --import tsx scripts/public-readiness.mjs --envs <names.json>`, which reports 27 checks with one
failure naming exactly `DATABASE_URL`, `PAYFLOW_M5_BOOTSTRAP_KEY`, `PAYFLOW_M6_SIGNING_KEY`, `CRON_SECRET`
and `PAYFLOW_GATEWAY_ADMIN_TOKEN`.

Two settings on that project need a decision from you:

- **`PAYFLOW_M6_DEMO_AGENT=true` is set and should be deleted.** Since PR #80 it only arms the M6
  demonstration Shopping Agent; it is not needed to serve the customer application, and without it every
  economic request is refused `PAYMENT_RAIL_NOT_CONNECTED` before a provider is reached. Deleting it is the
  safer default. (An earlier version of the commissioning page said it "must stay". That was true of the old
  code and is no longer true.)
- **Vercel Authentication is currently OFF.** Section 6 of this page used to end "Do not turn Vercel
  Authentication on for `payflow-public`"; `docs/ops/PUBLIC-APP-COMMISSIONING.md` step 4 says to turn it
  **on** until the acceptance passes. They contradicted each other. The commissioning page is right: the
  first deployment should be private, acceptance run against it, and only then a decision about opening it.
  That line in section 6 is struck.

**The marketing site is public and was always reachable.** `https://payflow-one-kappa.vercel.app/` returns
**200** anonymously on every public route. It is an added project domain, which the project's
`ssoProtection: all_except_custom_domains` does not gate; the auto-generated `*-start-up16.vercel.app`
domains return **302** to Vercel SSO and must never be given to a customer.
`https://payflow-public.vercel.app/` returns **404 DEPLOYMENT_NOT_FOUND`**. Until PR #80 the live site's
canonical tag, `og:image` and every sitemap entry pointed at that 404 origin; they now point at the origin
that serves.

### 0.1 The one approval that unblocks the database (new)

Applying the 38 migrations to a database with real state is the destructive step that needs your explicit
word. The runbook is `docs/ops/PUBLIC-DEPLOY-RUNBOOK.md` step 3. In order:

1. Take a Neon **snapshot** (or branch) of `payflow-public-sandbox` / `main` and confirm it exists.
2. Apply `024`–`062`, **skipping `028`**, in filename order, as `payflow_migrator` — never as
   `svc_public_rt` and never as an owner or `neon_superuser` login.
3. Re-run `db/roles/least-privilege.sql`.
4. Re-run the fingerprint check so the result is compared with the repository, not assumed.
5. Only then set the secrets (section 4) and deploy.

Rollback is the snapshot from step 1: restore it, and the database returns to `001`–`023`.

If you want me to run step 2, the sentence is "approve applying migrations 024-062 (skipping 028) to
payflow-public-sandbox". Without it I will not write to that database.

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

~~Do not turn Vercel Authentication on for `payflow-public`~~ — **struck 2026-11-11.** It contradicted
`docs/ops/PUBLIC-APP-COMMISSIONING.md` step 4, which is the one to follow: commission the first deployment
**privately** (Vercel Authentication **on**), run the acceptance against it, and only then decide about
opening it. The project's Vercel Authentication is currently **off**, so this is a setting to change before
the first deploy, not after. Do not touch `payflow-m6-acceptance`.
