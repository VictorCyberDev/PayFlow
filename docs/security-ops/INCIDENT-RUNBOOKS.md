# Incident runbooks

Status: DRAFT operational documentation, 2026-11-02. PayFlow is a developer preview: PayPal Sandbox only, hosted on Vercel with a Neon Postgres database. There are no customers, no measured uptime, no on-call rota, no external audit and no legal review. These runbooks describe what an operator can do **today** with controls that exist in the code. Anything that does not exist is listed in [CIRCUIT-BREAKERS.md](./CIRCUIT-BREAKERS.md) under "NOT IMPLEMENTED".

Related: [UNKNOWN-OPERATIONS.md](./UNKNOWN-OPERATIONS.md), [BACKUP-RESTORE.md](./BACKUP-RESTORE.md), [docs/OPERATIONS-RECONCILIATION.md](../OPERATIONS-RECONCILIATION.md), [docs/DEPLOYMENT-OPERATIONS-M7-M60.md](../DEPLOYMENT-OPERATIONS-M7-M60.md).

## Roles

There is no staffed rota. Until one exists, one named person holds each role per incident (one person may hold several).

| Role                | Does                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| Incident lead (IL)  | Declares severity, owns the timeline, decides restrict/resume, approves any write to production data.  |
| Operator            | Runs the commands below. Holds Vercel project access, Neon project access and the Sandbox admin token. |
| Provider liaison    | Looks at the PayPal Sandbox dashboard / API for provider truth (read-only).                            |
| Communications lead | Writes the status statement. Says only what is measured; never "no impact" without evidence.           |
| Scribe              | Keeps the timestamped log (UTC) and stores evidence exports. Can be the IL for a small incident.       |

## Rules that apply to every runbook

1. **Nothing re-executes automatically and nothing is retried by hand.** An UNKNOWN provider outcome is never retried. It is reconciled by read-only provider lookup. See [UNKNOWN-OPERATIONS.md](./UNKNOWN-OPERATIONS.md).
2. **Never write secrets into the incident log, chat or tickets.** Refer to a credential by `credential_id` (`pfc_...`), never by its token. Placeholders below are written `<LIKE_THIS>`.
3. **Do not edit or delete rows in `evidence_events`, `payment_attempts`, `authorization_reservations` or `execution_grants` to "fix" state.** Fix forward with new evidence. Read-only SQL is fine.
4. **Prefer the narrowest breaker** (one credential, one Authority, one agent) before anything broader. The broad breakers (organization, environment, global) do not exist yet.
5. Timestamps are UTC. Record the exact time each restriction was applied; the revocation linearization point is the `revoked_at` value.

## Severity

| Level | Meaning in this preview                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| SEV-1 | Any possibility that a payment moved that the Authority did not allow, a credential or signing key is compromised, or evidence is altered. |
| SEV-2 | The gateway cannot decide or execute for everyone (outage of `/v1/actions/execute`, database down, all provider calls failing).            |
| SEV-3 | Partial degradation: one endpoint, one agent, slow proofs, console issue, a few UNKNOWN attempts with a healthy provider.                  |

Because only Sandbox money is involved, "economic effect" means a PayPal Sandbox capture. Treat it exactly as if it were real; the procedures are the practice for production.

## Useful read-only queries (reused below)

Run them against the production Neon branch with a read-only mindset (`psql "$DATABASE_URL"` from an operator machine, or the Neon SQL editor). Do not paste the connection string anywhere.

```sql
-- Q1: recent attempts and their states
select id, status, provider, amount_minor, currency, mandate_id, principal_id,
       provider_order_id, provider_capture_id, failure_classification,
       last_reconciled_at, created_at, updated_at
from payment_attempts order by created_at desc limit 50;

-- Q2: attempts whose provider outcome is not settled
select id, status, mandate_id, reservation_id, grant_id, provider_order_id,
       provider_capture_id, last_reconciled_at, updated_at
from payment_attempts
where status in ('ORDER_CREATE_UNKNOWN','CAPTURE_UNKNOWN','CAPTURE_PENDING_PROVIDER','CAPTURE_IN_FLIGHT')
order by updated_at;

-- Q3: reservations that are still holding authority
select id, mandate_id, amount_minor, currency, status, expires_at, updated_at
from authorization_reservations where status in ('AUTHORIZED','EXECUTING') order by updated_at;

-- Q4: credentials for the tenant
select credential_id, agent_id, principal_id, scopes, label, status, issued_at, expires_at, revoked_at, last_used_at
from agent_credentials order by issued_at desc limit 200;   -- never select secret_hash

-- Q5: Authority state
select id, principal_id, authorized_agent_id, spent_minor, cumulative_limit_minor, revoked_at
from mandates order by 1;

-- Q6: evidence tail (hash chain)
select sequence, id, type, occurred_at, previous_hash, hash
from evidence_events order by sequence desc limit 200;
```

---

## RB-1 SEV-1: potential unauthorized economic effect

Trigger: a capture exists that no Authority permits, an amount/merchant/agent differs from what the owner expects, a Proof does not verify, or a credential/key compromise is suspected to have been used.

Who: IL declares; Operator executes; Provider liaison inspects PayPal; Scribe logs.

1. **Declare SEV-1.** Open the log with UTC time, who declared, and the trigger. Stop discussing in public channels.
2. **Restrict execution, narrowest first.** Decide at this point, do not wait for root cause.
   - If one credential is suspect: go to step 3 immediately (credential revoke, RB-4).
   - If one Authority is suspect: revoke it. The owner does this in the console (`POST /api/activation/revoke`, body `{"action":"REVOKE_AUTHORITY","mandateId":"<MANDATE_ID>"}`, owner session + CSRF), which calls `PostgresTrustRepository.revokeMandate` and sets `mandates.revoked_at`. An operator with database access may instead run, as a deliberate and logged action:
     `update mandates set revoked_at = now() where id = '<MANDATE_ID>' and revoked_at is null;`
     Revocation takes effect at the next durable revalidation: the gateway returns `DENY AUTHORITY_REVOKED`, `effectCount 0`. A grant already issued is rechecked at the Execution Boundary.
   - If an agent is suspect: set `organization_agents.lifecycle` to `SUSPENDED` (or `REVOKED`). There is no admin HTTP route for this; use the control-plane adapter (`transitionAgentLifecycle` in `src/network/postgres-adapters.ts`) or, as a logged emergency action, `update organization_agents set lifecycle='SUSPENDED', updated_at=now() where organization_id='<ORG>' and agent_id='<AGENT>' and environment='SANDBOX';`. `CredentialStore.authenticate` then rejects every credential for that agent with `ACCESS_INACTIVE`.
   - If the scope is unknown or wide: disable the admin surface by removing `PAYFLOW_GATEWAY_ADMIN_TOKEN` from the Vercel project environment and redeploy, and/or remove the Sandbox wallet connection so the gateway answers `PAYMENT_RAIL_NOT_CONNECTED` (see CIRCUIT-BREAKERS.md). **There is no global "stop all execution" switch yet.** State this to the IL: the broadest available stop is to pause the deployment (Vercel project pause) or disconnect the rail.
3. **Preserve evidence before anything else changes.**
   - Export Q1, Q2, Q3, Q4 (without `secret_hash`), Q5, Q6 to files; store them with the incident log. Compute and record the SHA-256 of each export.
   - Create a Neon snapshot or branch of the production database now (see BACKUP-RESTORE.md). Name it with the incident ID.
   - Save Vercel runtime logs for the window (Vercel dashboard, Logs, or `vercel logs`). Logs carry request IDs (`x-payflow-request-id`) and correlation IDs (`corr_...`).
   - Do **not** run migrations, redeploy with schema changes, or clean up rows.
4. **Identify impacted Authorities.** From Q1 list attempts in the window. For each, record `mandate_id`, `principal_id`, `amount_minor`, `currency`, `status`. Join credentials by `agent_id`:
   `select a.id, a.mandate_id, a.principal_id, a.amount_minor, a.status, m.authorized_agent_id, m.spent_minor, m.cumulative_limit_minor from payment_attempts a join mandates m on m.id = a.mandate_id where a.created_at >= '<WINDOW_START>' order by a.created_at;`
   Flag any attempt where `amount_minor` exceeds `mandates.document->>'maxSingleTransactionMinor'`, where `spent_minor` exceeds `cumulative_limit_minor`, or whose merchant differs from the Authority merchant scope.
5. **Inspect the provider (read-only).** For each flagged attempt take `provider_order_id` and `provider_capture_id`. Compare with PayPal Sandbox: dashboard transaction search, or `GET /v2/checkout/orders/{provider_order_id}`. Never call create/capture/refund from the incident workstation. Record: order status, capture status, amount, currency, payee merchant ID.
6. **Reconcile.** For any attempt in `CAPTURE_UNKNOWN`, `ORDER_CREATE_UNKNOWN` or `CAPTURE_PENDING_PROVIDER`, follow UNKNOWN-OPERATIONS.md. Reconciliation uses Show Order only and finalizes the _existing_ attempt; it never captures again.
7. **Decide whether the Proof still holds.** Fetch `GET /v1/proofs/{proposalId}` and the portable proof `GET /v1/proofs/{proposalId}/portable` with a credential holding `proof:read` (the portable route answers `409 PROOF_NOT_ISSUABLE` until the outcome is verified, for example while UNKNOWN); verify with the separate verifier package/CLI (`packages/verifier`, no database needed). A proof that fails verification, or an `evidence_events` chain where `previous_hash` does not equal the prior row's `hash`, escalates this to a suspected tamper: keep the snapshot, stop writing, and go to RB-8 if signing material may be exposed.
8. **Revoke credentials.** For every credential tied to an implicated agent run RB-4 (revoke, then verify fail-closed). If the admin token itself is suspect, rotate `PAYFLOW_GATEWAY_ADMIN_TOKEN` (new random value of at least 32 characters; the hosted config rejects shorter) and redeploy.
9. **Communicate.** Communications lead drafts: what is known (with the evidence source), what is not, what was restricted and when, what users should do, when the next update is. Sandbox-only facts must be labelled Sandbox. Do not promise timelines the team cannot meet. If a design partner's data is involved, notify them through the contact route they used. No legal or regulatory notification procedure has been reviewed by counsel; ask counsel before sending any such notice.
10. **Root-cause and close.** Write: timeline, trigger, which invariant failed (authority conservation, one-time grant, replay, tenant isolation, merchant binding, signature), the fix commit SHA, a regression test, and what evidence closes it. Resume only when the IL signs off and the restriction in step 2 is lifted explicitly (a revoked Authority stays revoked; issue a new one).

Decision points: (a) restrict before or after identifying scope? Always before. (b) Proof fails verification? Treat as tamper, snapshot, escalate to RB-8. (c) Provider shows an effect PayFlow has no record of? Do not retry; open a reconciliation note and treat as divergence.

---

## RB-2 SEV-2: major economic service degradation

Trigger: `POST /v1/actions/execute` returns errors/timeouts for most requests, database unreachable, all provider calls failing, hosted deployment down.

Who: IL, Operator.

1. Declare SEV-2. Check Vercel deployment status and the Neon project status page/console.
2. Confirm blast radius with harmless reads: `GET /v1/keys` (public keys, no credential, no database access in the handler) and an authenticated `GET /v1/proofs/<KNOWN_PROPOSAL_ID>` with a Sandbox credential holding `proof:read` (this touches the database). If `/v1/keys` works but the proof read fails with `500 INTERNAL_ERROR`, suspect the database. If both work and execute fails, suspect the provider (RB-5).
3. Database suspected: Neon console shows endpoint state. If the endpoint is suspended, start it from the Neon console; note cold-start latency is not a failure.
4. Deployment suspected: Vercel, Deployments, compare with the last READY deployment. Roll back only to a deployment whose schema expectations match the current database (migrations 013 to 020 are additive; code before them will not know the tables but does not break existing ones). Do not roll back across a migration that dropped something; none exist today.
5. While degraded, the system **fails closed**: no ALLOW without durable state, so degradation means "no execution", not "unsafe execution". Confirm this by checking Q1 for any attempt created during the outage and Q3 for reservations left in `EXECUTING`. Any attempt in an UNKNOWN state goes to RB-6.
6. Tell users plainly that agents will receive errors and `effectCount` may be `null` on an unexpected error (meaning unknown, never "zero"); the response carries `doNotRetry` for unresolved cases.
7. After recovery run Q2 and Q3; reconcile everything left in flight before declaring recovery. Close with a short post-incident note.

---

## RB-3 SEV-3: partial degradation

Trigger: slow proof reads, one agent's requests failing, console views failing, a small number of UNKNOWN attempts with a healthy provider.

1. Declare SEV-3, assign one Operator.
2. Identify the failing path from Vercel runtime logs by `x-payflow-request-id`. Reasons are stable codes (`ACCESS_INACTIVE`, `ACCESS_EXPIRED`, `REPLAY_DETECTED`, `PAYMENT_RAIL_NOT_CONNECTED`, `AUTHORITY_REVOKED`, `REQUEST_MALFORMED`), so most "failures" are correct refusals. Check the credential (Q4), agent lifecycle and the Authority (Q5) before suspecting the platform.
3. `PAYMENT_RAIL_NOT_CONNECTED` means the owner's vaulted Sandbox wallet is not connected; the owner reconnects it in the console. It is not a platform fault.
4. If attempts are stuck (Q2 non-empty), follow UNKNOWN-OPERATIONS.md.
5. Record the cause and whether a code change is needed. Escalate to SEV-2 if more than one tenant/agent is affected or the database is involved.

---

## RB-4 Compromised developer credential

Trigger: a bearer token `pf_sbx_pfc_<24 hex>.<secret>` leaked (repository, log, screenshot, chat), or unexpected `last_used_at`.

Who: Operator (holds the Sandbox admin token).

1. Identify the credential ID, not the secret. The ID is the `pfc_` + 24 hex portion. If only the secret leaked, find the credential via Q4 (`label`, `agent_id`, `last_used_at`). Or list with the admin route:
   `curl -sS -H "Authorization: Bearer $PAYFLOW_ADMIN_TOKEN" https://<HOST>/v1/admin/credentials`
2. **Revoke:**
   `curl -sS -X POST -H "Authorization: Bearer $PAYFLOW_ADMIN_TOKEN" https://<HOST>/v1/admin/credentials/<CREDENTIAL_ID>/revoke`
   Expected: `200 {"result":"REVOKED"}`. `404 {"result":"NOT_FOUND"}` means wrong ID or wrong tenant/environment (the call is scoped to the admin token's organization and environment). Revoke is idempotent; `revoked_at` keeps its first value. If the admin route is disabled (no `PAYFLOW_GATEWAY_ADMIN_TOKEN`), use SQL as a logged action:
   `update agent_credentials set status='REVOKED', revoked_at=coalesce(revoked_at, now()) where credential_id='<CREDENTIAL_ID>';`
3. **Verify fail-closed.** Using the leaked token (in a safe shell, history disabled), call any gateway route, for example `GET /v1/proofs/<ANY_ID>` or `POST /v1/actions/execute` with a throwaway nonce. Expected: `401`, reason `ACCESS_INACTIVE` (a wrong scope is `403 ACCESS_SCOPE_DENIED`), `effectCount 0`. Confirm in SQL: `status='REVOKED'`, `revoked_at` is set, `last_used_at` does not advance after your revoke time.
4. **Assess use.** Compare `last_used_at` with the revoke time. Run the RB-1 impacted-Authority query for the credential's `agent_id`. If any request was accepted, treat as SEV-1.
5. **Replace.** Issue a new credential for the agent (`POST /v1/admin/credentials`, body: `agentId`, `scopes` (subset of `authority:read`, `action:request`, `verify:read`, `proof:read`, `reconcile:request`), `ttlSeconds` 60 to 7776000, `label`). The token is shown once; deliver over a private channel, never in a ticket.
6. **If the agent itself is malicious or compromised**, also suspend it (`organization_agents.lifecycle = 'SUSPENDED'`) so any other credential for it fails too, and revoke its Authority (`mandates.revoked_at`).
7. Remove the secret from where it leaked (rewrite or delete the message, rotate if it was committed; history rewriting is not a substitute for revocation).

---

## RB-5 PayPal / provider outage

Trigger: PayPal Sandbox API errors or timeouts; developer status page shows an incident.

1. Declare SEV-2 if all executions fail, SEV-3 if intermittent.
2. **Do not retry blindly.** A timeout or ambiguous 5xx after transmission becomes `CAPTURE_UNKNOWN` by design; an error before transmission is a definitive failure with the reservation released. Check Q2 for the count of unknown attempts.
3. Optionally reduce load: tell test users to pause; there is no automatic provider circuit breaker (see CIRCUIT-BREAKERS.md). To refuse new work during a long outage, disconnect the rail so the gateway returns `PAYMENT_RAIL_NOT_CONNECTED` with zero effect.
4. When PayPal recovers, run reconciliation for every attempt in Q2 (UNKNOWN-OPERATIONS.md). Order: oldest first.
5. Do not mark any attempt FAILED by hand. Only provider evidence (Show Order) moves an attempt out of UNKNOWN.
6. Communicate that provider outages cause refusal or delay, never silent duplicate charges, and that outcomes in doubt are reconciled by lookup.

---

## RB-6 UNKNOWN payment backlog

Trigger: Q2 returns rows older than a few minutes, or `reconciliation` has not been run after an outage.

1. Count and age: `select status, count(*), min(updated_at) from payment_attempts where status in ('ORDER_CREATE_UNKNOWN','CAPTURE_UNKNOWN','CAPTURE_PENDING_PROVIDER') group by status;`
2. The affected Authority stays quarantined while its attempt is UNKNOWN (reservation `EXECUTING`, grant `CLAIMED`). No new purchase can reuse that authority.
3. Run the owner-authenticated reconcile nudge (console session): `POST /api/demo-agent/reconcile` with body `{}`. It calls `reconcileOutstanding()`, which loops `reconciliationCandidates()` and calls `PayPalExecutionRail.reconcile(attemptId)` per attempt; each failure stays quarantined for the next pass. **No scheduled worker calls this today** (see NOT IMPLEMENTED in CIRCUIT-BREAKERS.md); the backlog only clears when someone triggers it.
4. Per attempt, follow the field-by-field procedure in UNKNOWN-OPERATIONS.md. Escalate any attempt older than 24 hours, or any with conflicting provider evidence, to the IL.
5. After the pass re-run the count; record the before/after in the log.

---

## RB-7 Database restore

See [BACKUP-RESTORE.md](./BACKUP-RESTORE.md) for the full procedure and the evidence requirement. Summary for an incident:

1. IL decides restore is necessary and why (corruption, bad migration, malicious change). Restore is a last resort; it can roll back evidence and reservations that already moved real provider state.
2. **Never restore over production first.** Create a new Neon branch from a point in time or from a snapshot, and inspect it.
3. Before pointing traffic at restored data, reconcile: every `payment_attempts` row in the restored database must be compared with PayPal, and any provider effect that is newer than the restore point must be recorded (new evidence) without re-executing.
4. Switch `DATABASE_URL` in Vercel to the restored branch's connection string only after the checks in BACKUP-RESTORE.md pass. Keep the old branch.
5. No restore has been rehearsed. The first real restore will be a first attempt; budget time accordingly and say so in communications.

---

## RB-8 Signing key rotation or compromise

Facts from the code: the hosted composition has **one** Ed25519 key, supplied as `PAYFLOW_M6_SIGNING_KEY` (PEM) with id `PAYFLOW_M6_SIGNING_KID` (default `m6-hosted`). It signs execution grants and portable Proofs. The hosted public key ring (`StaticPublicKeyRing`) is built from that single key, and `GET /v1/keys` publishes only that key. There is no multi-key ring, no scheduled rotation and no key-status/revocation list in the hosted path. See SECURITY-ENGINEERING-REVIEW.md finding F-04.

Planned rotation (no compromise):

1. Generate a new Ed25519 key offline: `openssl genpkey -algorithm ed25519 -out new-key.pem` (store in the secret manager; do not commit; the repository secret scan must stay clean).
2. Choose a new `kid` (for example `m6-hosted-2`). Do **not** reuse the old `kid`.
3. Wait until no grant is outstanding: grants live at most 300 seconds (`MAX_EXECUTION_GRANT_TTL_MS`), default 120 seconds. Check Q3 shows no reservation in `AUTHORIZED` or `EXECUTING` that relies on the old key.
4. Set the new `PAYFLOW_M6_SIGNING_KEY` and `PAYFLOW_M6_SIGNING_KID` in Vercel and redeploy.
5. **Known gap:** after the swap, the hosted verifier knows only the new key, so _historical_ Proofs and grants signed under the old `kid` can no longer be verified by the hosted endpoints. Archive the old **public** key and `kid` with the incident/change record and give it to anyone verifying old Proofs with the offline verifier. Closing this gap needs code (a key ring of retained public keys); it is listed as NOT IMPLEMENTED.
6. Verify: issue a Sandbox purchase, fetch the portable proof, verify offline with the new key from `GET /v1/keys`.

Suspected compromise of the private key:

1. Declare SEV-1 (RB-1). An attacker with the key can mint grants that the Execution Boundary will accept as authentic, **but** a grant must still match a persisted `execution_grants` row (`status = ISSUED`, identical claims, reservation `AUTHORIZED`) before anything executes, so a forged token alone does not move money. Forged **Proofs** are a separate risk: they would verify against the published key.
2. Rotate immediately using steps 1 to 4 (accept the historical-verification gap).
3. Treat every Proof signed since the earliest possible exposure as unverified until compared with `evidence_events` and PayPal.
4. Rotate anything stored beside it: `DATABASE_URL`, `PAYFLOW_M5_BOOTSTRAP_KEY` (which derives the session and wallet-encryption keys; rotating it invalidates sessions and the encrypted vaulted wallet must be re-connected, so plan for that), `PAYFLOW_GATEWAY_ADMIN_TOKEN`, PayPal client secret.
5. Record the exposure window, the old `kid` and public key, the new `kid`, and the fix SHA.

---

## After every incident

- Scribe publishes the log; IL writes the post-incident note (invariant, cause, fix SHA, regression test, evidence).
- File gaps found here into SECURITY-ENGINEERING-REVIEW.md as findings.
- These runbooks have **not** been exercised in a drill. Run a tabletop for RB-1 and RB-4 first and record the result.
