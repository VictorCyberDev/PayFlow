# Program checkpoint — 2026-11-09 (Complete Startup Build mandate)

This is a durable checkpoint, **not** a completion report. The mandate (product transformation, M51–M90, M1–M90 audit) is far larger than one session; what follows is exactly what was verified, what changed, what is not started, and the next executable steps.

## Stage A — reverified state (read-only)

| Item                                                         | Observed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `main`                                                       | `883bf52f3430efba5e4cb83f4d918e70393e3737` (PR #60 R0, PR #61 R1a/R1b/R2-email/R3-drafting merged; exact-head CI green on both)                                                                                                                                                                                                                                                                                                                                                            |
| Open work                                                    | PR #62 (this branch `claude/r5-hosting-topology`)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Vercel `payflow-public` (`prj_BDxFuhwF0AcvRJaGWehd3eZSIYWm`) | **zero deployments**, no domains; env has only plain non-secret names (`PAYFLOW_M5_ORIGIN`, `_DEMO`, `_M6_DEMO_AGENT`, `PAYFLOW_PUBLIC_SANDBOX`, principal/agent ids, `PAYFLOW_M6_SIGNING_KID`). **No** `DATABASE_URL`, signing key, bootstrap key, PayPal, Channel3, Groq or Resend variable is configured on this project. The mandate says those exist "in Vercel"; they are not on this project (they were on the separate acceptance project, whose secrets must not be copied here). |
| Neon `withered-rice-68056451` / `br-steep-glade-bdsyx5v5`    | roles: `payflow_readonly`, `payflow_migrator`, `payflow_runtime` (no login), `neondb_owner`, **`svc_public_app` (password login, still present; privileges not changed — owner decision)**, `svc_public_rt` (no login: no password configured). Public DB has no `mission_*` tables (migrations 030–054 unapplied).                                                                                                                                                                        |
| Hosting contract                                             | `hosting/m6/vercel.json`: static export + `api/host` function; `trailingSlash: true`                                                                                                                                                                                                                                                                                                                                                                                                       |

## Defects found and repaired this session (PR #62)

1. `/workspace` (customer app) was **not routed** by the hosting contract and its files were read from disk → would 404 or fail on Vercel. Fixed: embedded module + rewrites + own CSP; guarded by `embed:app:check` and a topology test.
2. All `/v1/admin/*` routes, including member routes used by the customer app, returned 404 **when no operator token is configured** → a public deployment without an operator secret would have had a dead app. Fixed; operator access stays impossible without a token.
3. The customer app used a second visual system contradicting locked BRAND-001. Fixed (`DESIGN-DECISION-001`), screenshot-reviewed; not user-tested.

## Not started (so no one infers otherwise)

- **M51–M90**: nothing implemented (workspace discovery/booking, services marketplace, Founder Launch, durable automation, recurring operations, templates, second/third rail, financial action schema, FX, delegation graph, quorum, agent governance, policy packs, ERP/AP, reconciliation center, Break-Authority 1000+, privacy, assurance, standards, public mark, partner kit, embedded Authority, abuse intelligence, schema/verifier/conformance/profile, multi-region, key transparency, federation, external issuers, M2M authority).
- **Customer screens**: approvals center, sourcing/suppliers/quotes/comparison, negotiations, purchases, orders, disputes, contractors, finance, Proof, notifications, settings, help; account verification/recovery.
- **Research workstream** (Rams/Norman/Neumeier/Chesky/Saarinen/Nielsen/IDEO, segments, journeys, usability plans): not done. No interviews or usability sessions have happened; none may be claimed.
- **Providers**: no commerce or talent adapter; Resend and Groq adapters exist but have never touched the real services; no payout rail.
- **AI orchestration** beyond the wizard suggestion box.
- **M1–M90 integration audit**: not begun beyond the R0 regressions and the M26–M50 suites that run in CI.
- **Public deployment, hosted acceptance, support channels, billing, analytics**: none.

## Owner-gated (isolated; engineering continues around them)

`svc_public_app` removal (explicit approval; do not use or restore); a password for `svc_public_rt` and a runtime `DATABASE_URL` set via a secret-safe mechanism; a production signing key + bootstrap key; applying migrations 030–054 through the authorized release process; deployment authorization; Resend key + verified domain; Groq key + cost approval; commerce/talent/payout provider credentials and eligibility.

## Next executable steps (in order)

1. Merge PR #62 after exact-head `verify`, `console`, `console-e2e` are green (local full run `/tmp/full-run-8.log` is a convenience, not the gate).
2. R1 screens, backend already exists: approvals center (missions pending, acceptance escalations, ledger items awaiting approval), then sourcing/quotes/comparison, negotiations, purchases/orders/disputes, contractors, finance, Proof.
3. Notification model + outbox (R4) so approvals and UNKNOWN outcomes reach people.
4. Research outputs that need no participants (competitive review, segment hypotheses, usability test plan), labelled internal.
5. M51 workspace discovery on the existing connector framework, only against a source that has real evidence.

## Test/runtime state at checkpoint

PostgreSQL 16 local (`service postgresql start` after any restart; it stops between sessions). Test DB `postgres://payflow:payflow_test@localhost:5432/payflow_test`. One vitest process at a time. Chromium at `/opt/pw-browsers/chromium`; Playwright from `apps/console/node_modules`.
