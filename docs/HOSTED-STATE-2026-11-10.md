# Hosted state, verified by requesting the URLs (2026-11-10)

Source of truth for "is it live". Observed through the Vercel and Neon tools and by HTTP requests; not inferred from build logs.

## What was observed

- Team `start-up16`. Project `payflow` (Git-connected, auto-deploys `main`) has READY production deployments, latest at the time of observation from `3896ea6`. Project `payflow-public` has **zero deployments**, no domains, and only plain non-secret environment names.
- **`GET /`, `GET /workspace/` and `GET /v1/app/me` on the latest READY `payflow` deployment all returned HTTP 404** (`x-vercel-error: NOT_FOUND`). "READY" did not mean reachable.
- Cause, from source: the repository root `vercel.json` publishes `public/`, which held only `payer-return.css` and `payer-return.js`, and routes only `/paypal/*` to a function. It is the M5 PayPal payer-return deployment. The complete topology (static console export, `/api/host` function, embedded customer app, `/workspace` rewrites) is `hosting/m6/vercel.json`, intended for `payflow-public`, which was never deployed.
- Neon project `withered-rice-68056451` (`payflow-public-sandbox`) is the public sandbox database. Its schema does not contain migrations 030–059 (checked in an earlier session; not re-applied).

## What this changes

The root `vercel.json` now builds with `npm run build:company` (which stages the console's static export, the company homepage, into `public/`, keeping the PayPal payer-return assets) and installs the console's own dependencies. Verified locally: the build exits 0, `public/index.html` exists, and the payer-return files and `/paypal/*` rewrites are untouched. `tests/root-deployment.test.ts` pins this. After merge, the live URL must be requested again to confirm `/` returns 200; that result is recorded below once observed.

**This is the company site, not the product.** Signup, login, missions and the customer app are still not publicly reachable.

## What is blocked, and by what

| Blocked operation                                                         | Why                                                                                                                                                                                                                                                        | Checked                             | Finished in code                                                   | Needed from the owner                                                                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Deploy the real topology (`hosting/m6`) to `payflow-public`               | the host refuses to start without `DATABASE_URL`, `PAYFLOW_M5_BOOTSTRAP_KEY`, `PAYFLOW_M6_SIGNING_KEY`, `PAYFLOW_GATEWAY_ADMIN_TOKEN`, `PAYFLOW_APP_ORIGINS`; none is set, and placing a secret through an agent session would expose it in the transcript | project env names (values not read) | topology, embed, readiness check, topology test                    | set those as secrets in the Vercel dashboard; set the project Root Directory to `hosting/m6`; connect Git or approve a CLI deploy |
| Apply migrations 030–059 to the public database                           | standing rule: migrations to the public database only through the authorized release process                                                                                                                                                               | schema state                        | all migrations, fresh-install and upgrade tests locally            | explicit approval to run them with the migrator role                                                                              |
| Least-privilege runtime                                                   | role `svc_public_rt` has no password; `svc_public_app` (neon_superuser) must not be used                                                                                                                                                                   | role list                           | n/a                                                                | set a password for `svc_public_rt` via a protected channel; approve removal of `svc_public_app`                                   |
| Hosted browser acceptance of signup, login, missions, wrong-tenant denial | needs the deployment above                                                                                                                                                                                                                                 | n/a                                 | the same journey runs locally against a real server and PostgreSQL | none beyond the above                                                                                                             |

A missing environment entry is not proof that a provider account does not exist. PayPal, Channel3, Groq and Resend entries were **not** examined for `payflow-public`; they are not set there.

## Not done in this pass

Everything else in the M51–M90 completion mandate: provider commissioning, the Founder Launch executor, M57 replenishment, M59 billing and support, M61–M90 integration, and the executed M1–M90 audit. Their status is as in `docs/PROGRAM-CHECKPOINT-2026-11-10.md` and `docs/M1-M90-AUDIT-MATRIX.md`.
