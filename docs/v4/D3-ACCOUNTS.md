# D3 — accounts on the public host

Status: **built and tested; WAITING_APPROVAL on one configuration change.**

## What was already there

`src/network/user-auth.ts` is a complete account system — scrypt password
hashing with a per-hash salt, opaque server-side sessions, CSRF derived from
the session secret, lockout after five wrong passwords, idle and absolute
expiry, and tenant isolation. Migration `054_r1_user_accounts.sql` creates its
tables. `tests/r1-accounts.integration.test.ts` covers it with 14 tests against
real PostgreSQL, and those pass.

None of it was reachable. It only ran inside the gateway, and no Vercel project
deploys the gateway.

## What this adds

`api/account.ts` — the public application's door to it. The security is not
reimplemented here; this is the adapter:

- same-origin only, proxy-aware (`x-forwarded-host`, `host`, then the request URL);
- its own rate ceiling, chosen so signing in, out and back in does not exhaust
  it, because brute force is answered by the account lockout rather than by an
  IP counter;
- `HttpOnly; SameSite=Strict; Secure` session cookie with no `Domain`, and
  `Secure` decided from `x-forwarded-proto` so local http still works;
- CSRF required on sign-out, the one state change this surface makes — and a
  forged sign-out clears the cookie **here** without ending the real session;
- every credential failure answers identically, so no reply reveals whether an
  email is registered;
- infrastructure faults never reach the founder: no stack, no driver name, no
  connection string.

`/account/` is the surface. A name, an email, a password, a workspace name.
No access code, no API key, no tenant id, no invitation — the four things the
old console demanded before it would show anyone anything.

## Verified

| Check                                                         | Result                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| `tests/account-endpoint.integration.test.ts`                  | **10 tests**, real PostgreSQL                                         |
| `tests/r1-accounts.integration.test.ts` (pre-existing)        | 14 tests, still green                                                 |
| Full browser journey, real UI + real endpoint + real database | sign up → signed in → **survives a reload** → sign out → sign back in |
| Cookie, measured in the browser                               | `httpOnly=true`, `sameSite=Strict`, `document.cookie` cannot see it   |
| Forged sign-out                                               | 403, cookie cleared locally, **real session still valid**             |
| Gate A with `/account/` included                              | 49 routes × 6 widths = **294 page checks, 0 failures**                |

Two defects were found by looking rather than by testing: the email and
password fields fell back to the browser's default square box because the CSS
listed input _types_ instead of inputs, and hiding the wordmark on a narrow
phone shrank the home link to 22×22px — under WCAG 2.2's 24×24 minimum, which
the accessibility gate caught.

## The one thing an owner must do

**Set `DATABASE_URL` on the `payflow` Vercel project, production target.**

That is all. Specifically:

- **No migration is required.** The tables exist from `054_r1_user_accounts.sql`.
  Nothing in this work changes the schema.
- **No new grant is required.** `db/roles/least-privilege.sql` already gives
  `payflow_runtime` `SELECT, INSERT, UPDATE, DELETE` on every table in `public`,
  which covers `user_accounts`, `user_sessions`, `user_memberships`,
  `organizations`, `principals` and `organization_members`.
- The value should be a login role **in the `payflow_runtime` group**, never a
  superuser and never the migrator.

The `payflow` project currently has `DATABASE_URL` on **preview and development
only** — there is no production entry, which is why accounts cannot work live
today. (`payflow-public` does have one, but that project builds from
`hosting/m6`, whose rewrite means no root-level function is reachable on it.)

Until that is set, `/account/` says _"Accounts are not switched on for this
site yet"_ and points the visitor at the things that do work. A test asserts
that behaviour, so the unconfigured path is not an accident.

## What this unblocks, and what it does not

Business memory, durable plans, a real decision inbox and the returning-founder
journey all need an account to hang off. This is their prerequisite, not those
features. None of them is built.

Nothing reachable from `/account/` can spend money. There is no payment code on
this host at all.
