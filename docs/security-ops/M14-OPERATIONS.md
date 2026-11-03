# M14 operations: reconciliation, alerts, key lifecycle, database roles

Status: 2026-11-03. Implemented and tested locally against PostgreSQL. **The code is not deployed.** The preview that was
deployed on 2026-11-03 (commit cd5c427) predates it. Migration 023 and the three database roles **are applied to the accepted
database** (`docs/evidence/ops/db-commissioning-2026-11-03.json`).
Nothing here is an uptime, recovery-time, certification or audit claim.

## 1. Scheduled UNKNOWN reconciliation (observation only)

Code: `src/network/unknown-reconciler.ts`. Table: `reconciliation_lookups` (migration 023).

```text
unsettled attempt ─▶ LOOKUP_PENDING ─▶ read-only provider GET ─▶ PROVIDER_CAPTURED   (resolved)
                                                              ├▶ PROVIDER_FAILED     (resolved)
                                                              ├▶ STILL_UNKNOWN       (retry, exponential backoff)
                          no provider order id ─▶ NO_PROVIDER_REF  (nothing to look up; ages; alerts)
```

What it does: enrols attempts in `ORDER_CREATE_UNKNOWN`, `CAPTURE_UNKNOWN`, `CAPTURE_PENDING_PROVIDER`,
`ORDER_CREATING`, `CAPTURE_PENDING`, `CAPTURE_IN_FLIGHT`; claims due rows with `FOR UPDATE SKIP LOCKED` plus a lease so two
workers never look up the same attempt at once; asks the provider for the order; records what the provider said, when to
look again, and how many lookups failed.

What it cannot do, by construction and by test:

- It is typed to `Pick<PaymentProvider, "getOrder">`. It has no handle on `createOrder`, `captureOrder`, the rail, a grant or a
  reservation. A test asserts its source names none of them and that provider call counters do not move across ticks.
- It never writes `payment_attempts`. A provider-confirmed capture is recorded as `PROVIDER_CAPTURED` in the queue; completing the
  attempt itself still belongs to the M6-accepted resume path. So a lookup can never create a duplicate effect.
- A lost order creation (no provider order id) is **not** recreated. It stays `NO_PROVIDER_REF`, ages, and raises `UNKNOWN_TOO_OLD`.
- Provider errors are stored as an error class name only (never a message), so a leaked token or URL cannot reach the table.

Running it:

- `POST` or `GET /v1/admin/ops/reconcile/tick` with the platform operator token. A tick is safe to repeat.
- `node scripts/reconcile-loop.mjs [seconds]` for a host with a persistent process.
- The scheduler **trigger** is external: Vercel Cron, a GitHub Actions schedule, or any cron. **None is configured on any deployment
  yet.** (Vercel Hobby limits cron to once a day; a finer cadence needs a different plan or an external scheduler.)

Metrics (`GET /v1/admin/ops/reconciliation`): backlog, oldest unresolved age, age buckets (<5m, <1h, <24h, >24h),
still-unknown, no-provider-ref, lookup failure rate (null until a lookup runs), resolution rate.

Known limit: `PayPalExecutionRail.reconcile` (M6) may still resubmit create/capture with the original request id inside its
six-hour window when the owner-authenticated nudge is used. That documented behaviour is unchanged. The scheduler does not use it.

## 2. Alerts

Code: `src/network/alerts.ts`. Table: `operational_alerts`. One OPEN alert per dedupe key; repeats increment `occurrences`.

| Severity | Code                        | Fires when                                                              | Auto-resolves |
| -------- | --------------------------- | ----------------------------------------------------------------------- | ------------- |
| P0       | `DUPLICATE_ECONOMIC_EFFECT` | more than one `CAPTURED` attempt for one proposal                       | never         |
| P0       | `CUMULATIVE_LIMIT_EXCEEDED` | captured money for an Authority exceeds its cumulative limit            | never         |
| P1       | `UNKNOWN_TOO_OLD`           | unresolved queue row older than the threshold (default 3600 s)          | yes           |
| P1       | `RECONCILIATION_BACKLOG`    | unresolved rows above the threshold (default 25)                        | yes           |
| P1       | `REPEATED_PROVIDER_FAILURE` | 3 or more consecutive lookup errors on one attempt                      | yes           |
| P2       | `EXECUTION_PAUSED`          | an `execution_controls` pause is in force (expected during an incident) | yes           |

Evaluation runs on every tick. Alert details accept identifiers and counts only; a key that looks like a secret is refused.

**What is not built:** external delivery (e-mail, chat, pager). `undelivered()` and `markDelivered()` are the hand-off for a channel;
**no channel is configured**, so today a person has to read `GET /v1/admin/ops/alerts`. Detection for a signature-integrity failure
and a replay spike is not built either: those P0/P1 categories in the mandate are covered only by the rows above.

## 3. Proof-signing key lifecycle

Code: `src/network/signing-keys.ts`. Table: `proof_signing_keys` (public keys only; a CHECK refuses a JWK carrying `d`).

Rotation procedure:

1. Generate a new Ed25519 key. Put it in the host's secret store as `PAYFLOW_M6_SIGNING_KEY` **and set a new** `PAYFLOW_M6_SIGNING_KID`.
2. Redeploy. On first use the registry marks the new key ACTIVE and the previous one RETIRED. `/v1/keys` publishes both.
3. Historical Proof signed by the retired key keeps verifying; new Proof is signed by the new key.

Rollback: redeploy with the previous key and kid. It becomes ACTIVE again, the newer one RETIRED.

Compromise: `SigningKeyRegistry.revoke(keyId)`. The key leaves `/v1/keys`, proofs signed by it stop verifying (deliberately), and a
process that still holds that private key refuses to sign (`KEY_REVOKED`, a 5xx; no Proof is produced).

Defect found and fixed while testing: rotating the key **without** changing its id would have published the old public key while
signing with the new one, so every new Proof would fail verification. The registry now refuses it
(`KEY_ID_REUSED_WITH_DIFFERENT_KEY`) and `/v1/keys` fails closed with `SIGNING_KEY_UNAVAILABLE` rather than hanging.

Not built: an operator command that performs rotation (it is a redeploy), and key-wrap/HSM storage. The private key lives in an
environment variable.

## 4. Database roles

`db/roles/least-privilege.sql` (re-runnable after every migration). NOLOGIN group roles, so no password is in the repository:

| Role               | Purpose            | Can                                                       | Cannot                                                                                     |
| ------------------ | ------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `payflow_migrator` | migration job only | DDL                                                       | (not used by the app)                                                                      |
| `payflow_runtime`  | the running app    | SELECT/INSERT/UPDATE/DELETE; append to audit and evidence | create/alter/drop/truncate, update or delete the audit log, create roles, disable triggers |
| `payflow_readonly` | status, Verify, BI | SELECT on every column except `secret_hash`               | any write; reading credential or member secret digests                                     |

The test suite runs the **entire hosted gateway on the runtime role alone** (paid purchase, portable Proof, member, tick) and probes
each refusal. Applied to the accepted Neon database on 2026-11-03 after a snapshot, with evidence counts unchanged, and verified there by a privilege
matrix and by refused statements under `SET ROLE` (runtime `DROP TABLE` refused; read-only `UPDATE` refused). **Not done:** there is no login
role, so the deployed application still connects as the schema owner. A `payflow_runtime` login needs a password, which must not pass through
this session; the owner creates it (`CREATE ROLE … LOGIN PASSWORD … IN ROLE payflow_runtime`) and swaps `DATABASE_URL`. Until then the
strict reading of "the app does not run with admin privileges" is not met in any deployment.

## 5. Restore rehearsal

Record: `docs/evidence/ops/restore-rehearsal-2026-11-03.json`. Two rehearsals:

1. `scripts/restore-rehearsal.mjs`: real `pg_dump`/`pg_restore` into a throw-away database; compared 73 tables' row counts, constraint
   validity, the append-only triggers, and that the restored audit log still refuses UPDATE. Passed.
2. A Neon copy-on-write branch of the accepted database, with migration 023 applied to the branch only. Evidence counts (2 captured
   payments, 120 evidence events, 16 mandates) unchanged; the accepted branch itself was only read and still has 69 tables.

Not rehearsed: a point-in-time restore of the accepted branch, a measured recovery time, provider reconciliation after a restore.
The rehearsal branch `br-morning-pond-b8kh9ukx` is left in place; deleting a branch is the owner's call.
