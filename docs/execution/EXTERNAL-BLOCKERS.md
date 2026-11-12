# External blockers — proven, one by one

Each entry is a requirement that cannot be finished by engineering in this repository alone. "Proven" means this session (or a cited earlier one) tried the executable part and reached the boundary, rather than assuming one. Anything that turns out to be executable after all belongs in the backlog, not here.

Authoritative companions: `docs/OWNER-ACTIONS.md` (what the owner does), `docs/ops/PUBLIC-APP-COMMISSIONING.md` (the hosting steps), `docs/PROGRAM-CHECKPOINT-2026-11-11.md` (the state these were found in).

## B-1 · No live email has ever been sent

- **What is unfinished:** delivery of any real message (verification, reset, invitation).
- **Why:** Resend needs an API key and a verified sender domain. Neither is in this environment.
- **Attempted:** the whole path is built and proven against a local stand-in, including the durable outbox, send leases, crash recovery and the fail-closed limiter (B1, hardened in #75).
- **What remains executable without the owner:** nothing further on delivery. The contract tests already cover idempotency and the uncertain-delivery path.
- **Exact dependency:** a Resend API key, a verified sender, and `PAYFLOW_EMAIL_FROM_VERIFIED=true` on the protected environment.
- **Recovery path:** set the three, then run the B1/B2 acceptance script against the protected deployment and record the message id.

## B-2 · Nothing is deployed to `payflow-public`

- **What is unfinished:** a hosted customer application; therefore every HOSTED_ACCEPTED and EXTERNAL_VALIDATED cell in the matrix.
- **Why:** the Vercel project needs secrets and a Root Directory that only the owner can set.
- **Attempted:** the deployment contract is derived from the code and checked offline on every CI run (`scripts/public-readiness.mjs`), so the checklist cannot drift from the code.
- **What remains executable without the owner:** all of it except the deploy itself — the topology contract test (`tests/r5-hosting-topology.integration.test.ts`) already runs the real function handler and the real static export.
- **Exact dependency:** Root Directory `hosting/m6`; `PAYFLOW_M5_BOOTSTRAP_KEY`, a **new** `PAYFLOW_M6_SIGNING_KEY`, `CRON_SECRET`, `PAYFLOW_GATEWAY_ADMIN_TOKEN`, a runtime `DATABASE_URL`; `PAYFLOW_M6_DEMO_AGENT=true` (the hosted Gateway and the customer app exist only when it is set).
- **Recovery path:** owner sets them, deploy to the protected environment, then run the journey acceptance against that origin.

## B-3 · The public database holds migrations 001–023; the repository has 064

- **What is unfinished:** every feature whose tables are not in the public database.
- **Verified directly on 2026-11-11** against Neon project `withered-rice-68056451` (`payflow-public-sandbox`), read-only:

  | Probe                        | Result     |
  | ---------------------------- | ---------- |
  | tables in `public`           | **73**     |
  | `missions` (migration `030`) | **absent** |
  | `mission_plans` (`031`)      | absent     |
  | `user_accounts` (`054`)      | absent     |
  | `automation_jobs` (`057`)    | absent     |
  | `launch_runs` (`064`)        | absent     |

  There is no migration-ledger table in the database at all; migration level is established by catalog fingerprint, which is why the probe above is by object presence.

- **The finding this sharpens:** the gap is not a tail of recent features. `missions` is created by `030_m26_missions.sql`, so the public database stops _before the V3 product begins_. **The entire Missions/Spend Desk product — every milestone from M26 onward — has no database behind it in the public sandbox.** The 73 tables that are there are the M1–M25 Authority and payments core.
- **Why it is blocked:** applying 024–064 to a live database is a destructive-class operation that needs a snapshot first and explicit authorization.
- **Attempted:** `scripts/migration-rehearsal.mjs` rehearses fresh-install and upgrade and validates the grants (0 upgrade-only objects, 12/12 invariants); every integration suite in CI builds 001→064 from scratch on PostgreSQL.
- **What remains executable without the owner:** the rehearsal, which already passes.
- **Exact dependency:** a Neon snapshot, then applying 024–064 (028 skipped) through the authorized release process.
- **Recovery path:** snapshot, apply in order, re-fingerprint, compare against the repository, then start the app against it.

## B-4 · The privileged Neon role `svc_public_app` still exists

- **What is unfinished:** least-privilege at runtime.
- **Verified directly on 2026-11-11** (read-only, `pg_roles` / `pg_auth_members`):

  | Role               | LOGIN    | SUPERUSER | Member of            |
  | ------------------ | -------- | --------- | -------------------- |
  | `svc_public_app`   | **true** | false     | **`neon_superuser`** |
  | `svc_public_rt`    | true     | false     | `payflow_runtime`    |
  | `payflow_readonly` | false    | false     | —                    |

- **Where that leaves it:** the intended restricted runtime role `svc_public_rt` **already exists and is already scoped correctly** to `payflow_runtime`. The remaining work is not to build it but to stop the privileged role being available: `svc_public_app` can still log in and is still a member of `neon_superuser`.
- **Why it is blocked:** removing a role is irreversible and explicitly owner-gated.
- **What remains executable without the owner:** nothing on the live role. It must not be used as a runtime credential in the meantime.
- **Exact dependency:** explicit approval to remove `svc_public_app`, and a password for `svc_public_rt`.
- **Recovery path:** set the `svc_public_rt` password, point the runtime at it, verify the app starts, then remove the privileged role.

## B-5 · No live provider of any kind

- **What is unfinished:** PROVIDER_ACCEPTED for PayPal Sandbox, Channel3 discovery, Groq planning, and every talent/workspace/services adapter.
- **Why:** no provider credential is present in this environment.
- **Attempted:** the adapter contracts, the refusal taxonomy and the UNKNOWN path exist and are tested against fictional sandbox sources; `tests/paypal.sandbox.test.ts`, `tests/paypal-commerce.sandbox.test.ts` and `tests/groq.smoke.test.ts` skip themselves without credentials rather than passing vacuously.
- **What remains executable without the owner:** contract tests per adapter, which is where the honest work is.
- **Exact dependency:** per provider, a sandbox credential scoped to a sandbox.
- **Recovery path:** set the credential, run that provider's sandbox suite, record the provider-side identifier as the evidence.

## Standing rule

A blocker is not a licence to stop. Each of the five leaves the internal contract, its negative tests and its honest refusal path fully executable, and those are where this session's engineering goes.
