# Program checkpoint — 2026-11-10 (Complete Startup Build mandate, continuation)

Durable checkpoint, **not** a completion report. It supersedes `docs/PROGRAM-CHECKPOINT-2026-11-09.md` where they differ. Evidence levels and per-milestone detail: `docs/M51-M53-STATUS.md`, `docs/M54-M71-STATUS.md`, `docs/M1-M90-AUDIT-MATRIX.md`, `docs/V3-EXECUTION-LEDGER.md`.

## State

- `main` contains everything merged through PR #65 (`d3e358e`). Each merge was pinned to a head whose `verify`, `console` and `console-e2e` were all green. PR #66 (M57 recurring checks and a test-harness fix) was open with `console` and `console-e2e` green and `verify` running when this was written.
- Full local regression on PostgreSQL at the last measured head: 153 files, 2680 tests passed; 3 files and 4 tests skipped for lack of credentials.
- Migrations 055–059 exist in the repository. **None is applied to any public database.**

## Built since the previous checkpoint (all local, none live)

M51–M53 workspace discovery, comparison and booking intents; M54 services search; M56 durable automation with UNKNOWN-for-effectful-jobs; M57 a recurring renewal check slice; M58 prefill templates; M67 approval quorum (policy routes, gate, Settings screen); M68 agent readiness; M69 safety packs; M70 CSV export; M71 Needs checking; a Launch board (M55 slice); customer screens for approvals, workspaces and bookings, services, finance, quotes, negotiations (decide), orders (open a dispute), disputes (settle, withdraw), contractors (decide a deliverable), obligations, Proof, recurring items, notifications, settings and help.

## Defects found and fixed this stretch

The 60-per-minute `/v1/admin` budget was shared by everyone from one address; booking expiry depended on someone looking; three booking defects (hold not released on expiry, null evidence crashing the ledger, decline replay); a desk with a 30-day minimum shown as fitting a week; several screens rendering `[object HTMLElement]`; an intermittent test-harness teardown race. CI also caught two checks that were not run locally (`scripts/public-readiness.mjs`, full `npm run lint`); the local pre-push routine now runs every CI step and reads its exit code.

## Not done (so no one infers otherwise)

- **No live provider of any kind.** Every source is a fictional sandbox fixture. No real availability, price, booking, quote, supplier, contractor or payment exists in this system.
- **Not built:** M55 orchestration; M57 beyond check-and-ask; M59 billing, usage, support; M60 acceptance; M61–M64, M66; M72–M90 as scoped in ADR-018 (earlier scaffolds from the legacy program were not re-audited); M65 FX is a pure module no route calls; quote acceptance screen; account verification and recovery; notification delivery (email or push); AI orchestration beyond the wizard suggestion box.
- **The mandated M1–M90 audit is not complete:** the matrix is sourced and partial; the eight evidence fields per row, journeys A–H as executed runs, the nine quality gates, the security and performance audits and the 50-question reviewer report were not produced.
- **No product or customer research.** No interviews or usability sessions have happened and none are claimed.
- **No public deployment.**

## Owner-gated (set aside; engineering continues around them)

Removal of Neon role `svc_public_app` (needs explicit approval; not to be used or restored); a password for `svc_public_rt` and a runtime `DATABASE_URL` set by a secret-safe mechanism; a production signing key and bootstrap key; applying migrations 030–059 through the authorized release process; provider credentials for any live source (commerce, talent, workspace, services, email); a Resend sender domain; a real design partner, merchant or PSP for any external validation.

## Next executable steps

1. Merge PR #66 only on an exact-head green `verify`, `console`, `console-e2e`.
2. Quote acceptance screen; account verification and recovery.
3. Notification outbox so approvals and UNKNOWN outcomes reach people (needs an owner-provided sender).
4. Re-audit legacy M26–M55 (V3 M61–M90) rows with executed evidence, then produce the per-row evidence fields.
5. Research outputs that need no participants (competitive review, segment hypotheses, usability test plan), labelled internal.

## Runtime notes

PostgreSQL 16 local (`service postgresql start` after any restart). Test DB `postgres://payflow:payflow_test@localhost:5432/payflow_test`, given inline on the command (an exported variable silently skips DB tests). One vitest process at a time. A long run needs `run_in_background` and a check that the process is alive; the "completed" notice for the launcher shell is not the run finishing.
