# Backup and restore

Status: DRAFT, 2026-11-02. Developer preview, Neon Postgres behind a Vercel-hosted Sandbox host.

## Restore status (read this first)

**Two restore rehearsals were recorded on 2026-11-03** (`docs/evidence/ops/restore-rehearsal-2026-11-03.json`, details in `M14-OPERATIONS.md` section 5): a real `pg_dump`/`pg_restore` into an isolated database, and a Neon copy-on-write branch of the accepted database. Both verified table counts, constraint validity and the append-only audit triggers, and the accepted M6/M7 evidence counts were unchanged. **Still not done:** a point-in-time restore of the accepted branch, a measured recovery time or recovery point, and post-restore provider reconciliation. Do not state a recovery time or recovery point to anyone.

Snapshot branches now on the project: `br-super-field-b8baqoz2` (pre-M7), `br-lucky-star-b8a87fk4` (pre-021/022), `br-shy-fire-b86qozvq` (pre-023), and the rehearsal copy `br-morning-pond-b8kh9ukx`. None has been deleted.

## What exists

| Capability                          | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Evidence in repo                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Neon branches and snapshots         | The database is hosted on Neon. Branching (copy-on-write copy of a database at a point in time) and snapshots are Neon platform features, available to operators through the Neon console, CLI, API and the operator's Neon MCP tooling (create/list/restore snapshot, create/finalize branch restore, reset from parent). Point-in-time history retention depends on the Neon plan and is **not** documented in the repository; check the plan in the Neon console and record the value here when known: `retention = <UNKNOWN>`. | The platform capability is not tested by the repository; its availability for this project is asserted only by the snapshot record below. |
| One snapshot branch                 | `br-super-field-b8baqoz2` in Neon project `super-cloud-02637785`, taken before migrations 013 to 020 were applied to the existing **M6 acceptance** database for the M7 live Sandbox run (2026-11-02). It contains the pre-M7 state: M6 evidence (1 captured payment, 79 evidence events, 14 mandates, 1 vaulted wallet) and none of the M7 tables (`agent_credentials`, `organization_agents`, `reconciliation_queue`, and others).                                                                                               | `docs/evidence/live/m7-sandbox-acceptance-2026-11-02.json`, `docs/TAKEOVER-AUDIT-M7-M25.md` section 6                                     |
| Schema from migrations              | `db/migrations/001` to `020` are forward-only SQL. A fresh database can be rebuilt by applying them in order; CI applies them to an empty PostgreSQL 17 (`docs/TAKEOVER-AUDIT-M7-M25.md`). This rebuilds structure, not data.                                                                                                                                                                                                                                                                                                      | CI, migration files                                                                                                                       |
| Deterministic evidence regeneration | `npm run evidence:generate` / `evidence:check` regenerate the committed Break Authority, fault-injection and conformance reports. These are test artefacts, not database backups.                                                                                                                                                                                                                                                                                                                                                  | `docs/evidence/*.json`                                                                                                                    |
| Application backups (logical dumps) | **None configured.** No `pg_dump` job, no export schedule, no off-platform copy.                                                                                                                                                                                                                                                                                                                                                                                                                                                   | none                                                                                                                                      |

## NOT IMPLEMENTED

- Scheduled backups or a documented snapshot schedule (Neon exposes a snapshot schedule feature; none is recorded as configured).
- Off-platform or cross-account copy of the database. Everything depends on one Neon project and its account.
- Restore rehearsal, restore timing, and any recovery-time or recovery-point objective.
- Backup of non-database state: Vercel environment variables (secrets), the PayPal Sandbox app configuration, and the signing key. Losing the signing key does not lose data but makes historical Proofs unverifiable by the hosted endpoints (see INCIDENT-RUNBOOKS.md RB-8).
- Automated post-restore consistency checks. The checks below are manual queries.
- A separation between M6 acceptance evidence and M7+ data (they share one database; THREAT-MODEL-UPDATE.md T10d).

## What a restore can and cannot repair

- The database is a record of authority and evidence. PayPal holds the real provider truth. **A restore moves the database backwards in time but PayPal does not move.** Any capture that happened after the restore point exists at PayPal with no matching local row. That is why post-restore reconciliation against PayPal is mandatory.
- Restoring `br-super-field-b8baqoz2` wholesale would remove migrations 013 to 020 and every credential, agent registration and M7 Authority. It is a rollback to M6 state, not a general recovery point. Do not use it for an M7 incident.
- Evidence is hash-chained; a restore to an earlier consistent point yields a valid shorter chain. A chain that is valid but missing later events is indistinguishable from a legitimate earlier state unless chain heads were recorded elsewhere. Record the latest `evidence_events` hash in the incident log periodically (see step 1 below).

## Procedure

Use only when the IL has decided a restore is needed (INCIDENT-RUNBOOKS.md RB-7). Never overwrite production first; restore into a new isolated branch and verify it.

1. **Freeze and record.** Apply the narrow breaker that stops new dispatch (CIRCUIT-BREAKERS.md). Record: latest `select sequence, hash from evidence_events order by sequence desc limit 1;`, counts of `payment_attempts` by status, and the time. Create a fresh Neon snapshot or branch of the current (possibly damaged) database before touching anything; name it with the incident ID.
2. **Choose the restore point.** Prefer a Neon point-in-time restore to a timestamp before the damage; otherwise the most recent snapshot. State why. Note the time delta between restore point and now: that is the window that needs provider reconciliation.
3. **Restore to a new branch**, not over production. In the Neon console (or CLI/API): create a branch from the snapshot or timestamp. Do not promote it.
4. **Connect read-only and verify the schema.**
   - Tables present for the expected migration level: `select to_regclass('agent_credentials'), to_regclass('organization_agents'), to_regclass('reconciliation_queue');` (non-null only if the restore point is after migration 013 or 020).
   - If migrations are missing for the code you will deploy, apply the missing forward-only migrations in order to the restored branch (never edit old ones).
5. **Verify integrity (manual, until automated).**
   - Evidence chain: for the restored `evidence_events`, check `sequence` is gap-free from 1 (or from the first retained row), each `previous_hash` equals the prior row's `hash`, and `hash` values are unique. Use the repository's ledger verification where available (`ledger.verify()` in `src/demo.ts` shows the pattern); record the result.
   - Relationships: every `payment_attempts.reservation_id` exists in `authorization_reservations`; every `authorization_reservations.mandate_id` exists in `mandates`; `execution_grants` for each attempt exist; no reservation is `AUTHORIZED` with an expired `expires_at` that a stale grant could still use (grant TTL is at most 300 seconds, so any grant older than that is already unusable).
   - Mandates: `getMandate` re-checks the fingerprint on read; run a read of each active mandate to confirm none is rejected.
   - Credentials: list `agent_credentials`; **any credential revoked after the restore point is active again in the restored data.** Re-apply every revocation recorded in the incident log (RB-4 step 2) before traffic returns, and revoke any credential suspected compromised.
   - Authorities: re-apply `mandates.revoked_at` for any Authority revoked after the restore point, from the incident log.
6. **Reconcile with the provider before traffic.** For every `payment_attempts` row not in `CAPTURED`/`FAILED`/`CANCELLED`, follow UNKNOWN-OPERATIONS.md. Then search PayPal Sandbox for captures in the restore-to-now window that have no local row; record each as a divergence in the incident log. Do **not** re-execute and do not create attempts to match them.
7. **Cut over.** Only after steps 4 to 6 pass, set `DATABASE_URL` in the Vercel project to the restored branch's connection string and redeploy. Keep the pre-restore branch for forensics. Do not log the connection string.
8. **Post-restore checks.** Run a read of an existing Proof (`GET /v1/proofs/{id}`), verify its portable form offline, and a denied request (expected zero effect). Do not run a live purchase until the IL signs off.
9. **Record** timing for each step (this is the first measured data for recovery time), problems found, and update this page.

## Evidence requirement for restore capability

Restore capability may be described to anyone only after a rehearsal is recorded in a dated file under `docs/evidence/` (for example `docs/evidence/live/restore-rehearsal-<date>.json`) containing at least:

- who ran it, date, source (snapshot ID or timestamp), target branch ID, exact commit SHA of the code used;
- start and end time of each step in the procedure above, so recovery time is a measured number;
- the integrity query results (evidence chain result, relationship checks, row counts before and after);
- the credential/Authority revocation re-application check;
- the provider reconciliation result for the window;
- confirmation that production was not overwritten, and that no secret appears in the record.

Until that file exists, the accurate statement is: "Neon snapshots and branches exist as platform features and one pre-migration snapshot was taken; no restore has been tested."

## Do not

- Do not delete `br-super-field-b8baqoz2` until the owner decides M6 acceptance evidence is archived elsewhere.
- Do not test restore on production, and do not promote a restored branch as a test.
- Do not restore over a database whose unresolved UNKNOWN attempts have not been recorded; their provider state is the only copy of the truth.
