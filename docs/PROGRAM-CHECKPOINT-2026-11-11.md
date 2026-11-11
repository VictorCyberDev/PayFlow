# Program checkpoint — 2026-11-11 (execution recovery, Tracks A and B)

Durable checkpoint, **not** a completion report. It supersedes `docs/PROGRAM-CHECKPOINT-2026-11-10.md` where they differ. Merge SHAs and the CI evidence for each: `docs/V3-EXECUTION-LEDGER.md`. Account email and sign-in policy: `docs/ops/ACCOUNT-EMAIL-AND-AUTH-POLICY.md`. Public commissioning: `docs/ops/PUBLIC-APP-COMMISSIONING.md`.

## State

- `main` is `c85f7b2` (PR #83; the checkpoint itself was merged as #82). Every merge since #71 was pinned with `expectedHeadSha` to a head whose `verify`, `console` and `console-e2e` were all green. (For #71–#73 the pin parameter was not honoured by the tool; each head was read back and matched before merging. The ledger says so.)
- Migrations 060–064 exist in the repository and are applied to no public database. The public Neon database (`payflow-public-sandbox`) holds migrations 001–023: verified read-only on 2026-11-11 against a catalog fingerprint (`docs/ops/schema-fingerprint-023.json`, 697 objects; functions compared ignoring comments and whitespace).
- **Nothing is deployed to `payflow-public`.** The marketing site (`payflow`) is deployed; its "Sign in" goes to an honest `/preview/` page (verified on the deployment of `e855608`).

## Built since the previous checkpoint (all local, none live)

Account lifecycle, complete: email verification and password reset with a durable email outbox (B1, hardened: atomic token+message, send leases, crash recovery, expiry, fail-closed limiter, unverified-account policy); sign-ins list/revoke/everywhere (B2); organization invitations and organization switching (B3); member list, role change, remove, leave with the last owner protected (B4); download your data and close your account (B5); two-step sign-in with an authenticator app, recovery codes, sealed secrets (B6). Also: Resend sender wired from the protected environment, compiled-app acceptance run (`scripts/b1-b2-acceptance.mjs`, 24 checks with a SIGKILL crash), schema fingerprint tooling, environment contract and migration plan.

Also: **M55 launch runs** (migration 064, `docs/M55-LAUNCH-RUNS.md`): a durable, resumable, read-only discovery run (workspace and services searches) executed by the automation worker; it books and buys nothing. And a **cross-domain journey on the compiled host** (`scripts/customer-journey-acceptance.mjs`, 12 checks, evidence `docs/evidence/customer-journey-acceptance.json`): account, mission, approval, a launch run that survives a SIGKILL of the host, a booking proposed from the run's own search, approval (budget held), ledger, CSV export, audit trail. Sources are fictional sandbox fixtures; no email sender; no payment provider.

## Findings that change the plan

- **The whole hosted Gateway, including the customer app, exists only when `PAYFLOW_M6_DEMO_AGENT=true` with a `PAYFLOW_M6_SIGNING_KEY`.** Earlier guidance to delete that variable was wrong and is corrected. Leave the PayPal variables unset: the agent then has no payment provider and no payment can execute.
- The reset request used to hang when a database write failed; `payflow_readonly` could read recovery links and password digests; auth limits failed open. All fixed in #75.
- The mutation checks found tests that proved nothing (an HTTP race that never exercised a lock; a `sed` that silently did not apply). Both were corrected; a mutant that "passes" is treated as a gap.

## Not done (so no one infers otherwise)

- **No real email has ever been sent.** The Resend path is proven only against a local stand-in. Delivery is unproven until the owner supplies a key and a verified sender.
- **No live provider of any kind**, as before. Channel3, Groq planning, PayPal Sandbox checks, talent/workspace/services adapters: not built.
- **Not built:** the rest of M55 (consequential actions sequenced across areas, outcomes reacted to, start-a-run from a screen); M57 beyond check-and-ask; M59 billing/usage/support; M60 acceptance; M61–M64, M66; M72–M90 as scoped in ADR-018; wiring M65 FX and M70 ERP; payment/refund UNKNOWN in M71.
- **The M1–M90 audit is not complete** (matrix sourced and partial; journeys A–H not executed as runs; quality gates, security/performance audits and the reviewer report not produced).
- No product or customer research; no public deployment. WebAuthn/passkeys, QR codes, "remember this device", organization-level MFA requirement, operator recovery for a lost factor: not built.

## Owner-gated (set aside; engineering continues around them)

Removal of Neon role `svc_public_app` (needs explicit approval; not to be used or restored); a password for `svc_public_rt` and a runtime `DATABASE_URL`; `PAYFLOW_M5_BOOTSTRAP_KEY`, a **new** `PAYFLOW_M6_SIGNING_KEY`, `CRON_SECRET`, `PAYFLOW_GATEWAY_ADMIN_TOKEN` on `payflow-public` through the Vercel dashboard; Root Directory `hosting/m6`; a Neon snapshot, then applying migrations 024–064 (028 skipped) through the authorized release process; Resend key, verified sender, `PAYFLOW_EMAIL_FROM_VERIFIED=true`; Vercel SSO and domain decisions; any live provider credential. Rotating `PAYFLOW_M5_BOOTSTRAP_KEY` after people enrol in two-step sign-in makes their stored secrets unopenable.

## Next executable steps

1. Re-run the M1–M90 audit with executed evidence, journey by journey (A–H), starting with the account lifecycle that now exists.
2. Extend the M55 executor from discovery to the consequential steps (each stays human-approved; UNKNOWN never retried), then M57/M58 on top of it.
3. M59 metering and support surface; M65 FX and M70 export wired where money is shown.
4. Provider adapters behind the existing channel/connector contracts, sandbox-only, each with a contract test and an honest UNKNOWN path.
5. Keep merging only on exact-head green `verify`, `console`, `console-e2e`.

## Runtime notes

PostgreSQL 16 local; it stops when the worker restarts: run `service postgresql start`, and if the test database's `public` schema was lost to a killed run, `create schema public`. Test DB `postgres://payflow:payflow_test@localhost:5432/payflow_test`, given inline on the command. One vitest process at a time. A long step needs `run_in_background`; the launcher's "completed" notice is not the run finishing. Prettier reformats code, so apply patches to formatted text and run `prettier --write` after `eslint --fix`. Each push restarts about 20 minutes of CI.
