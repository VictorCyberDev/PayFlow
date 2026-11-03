# Security engineering review (M14)

Status: DRAFT, 2026-11-02, branch `claude/eloquent-einstein-dw0mxk`. This is an internal code and configuration review by the session's coding agent. It is **not** an independent audit, penetration test, certification or attestation. It reads the code that exists; it does not test a deployment. Related: [THREAT-MODEL-UPDATE.md](./THREAT-MODEL-UPDATE.md), [docs/COMPANY-LAUNCH-SECURITY-REVIEW.md](../COMPANY-LAUNCH-SECURITY-REVIEW.md), [docs/SECURITY-ASSURANCE-READINESS.md](../SECURITY-ASSURANCE-READINESS.md).

Severity scale (internal, relative to a developer preview that moves Sandbox money only): **High** can defeat a core control or loses evidence; **Medium** weakens defence in depth or operations; **Low** hygiene.

## Dependency audit (real output)

Command run on 2026-11-02 from the repository root:

```
$ npm audit --omit=dev --audit-level=high
found 0 vulnerabilities
exit code 0
```

`npm audit --omit=dev --json` metadata: info 0, low 0, moderate 0, high 0, critical 0, total 0; dependencies: prod 4, dev 367, optional 77, total 370. The same command in `apps/console` also printed `found 0 vulnerabilities`. Production dependencies are `jose`, `postgres`, `zod` (plus transitive). CI runs the same root command (`.github/workflows/ci.yml`).

Limits: this is a snapshot of the npm advisory database at one time. It does not examine dev dependencies (`--omit=dev`), the Python SDK, GitHub Actions, the Vercel runtime, or application logic. See F-14.

## Summary of findings

| ID   | Severity | Area                      | Finding                                                                                          |
| ---- | -------- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| F-01 | High     | DB permissions / evidence | One all-powerful database role; no immutability trigger on `evidence_events`; no RLS             |
| F-02 | High     | Rate limiting             | No rate limiting on the hosted `/v1/*` gateway or the admin routes                               |
| F-03 | High     | Reconciliation ops        | No scheduler; `reconciliation_queue` and `reconciliation_observations` unused; no alerting       |
| F-04 | Medium   | Key lifecycle             | One signing key, no key ring, no rotation procedure in code; historical Proofs break on rotation |
| F-05 | Medium   | Secret management         | Signing key, DB URL, admin token, bootstrap key and PayPal secret share one Vercel environment   |
| F-06 | Medium   | Auth                      | Single static admin token; no rotation, expiry, role split or audit rows                         |
| F-07 | Medium   | Credential lifecycle      | No evidence rows for issue/revoke; `last_used_at` is the only usage trail; no cap per agent      |
| F-08 | Medium   | Provider boundary         | `PayPalExecutionRail.reconcile` is not observation-only (same-ID resubmission within 6 hours)    |
| F-09 | Medium   | Logs / observability      | Audit/health/correlation helpers exist but are not wired; gateway events are dropped             |
| F-10 | Medium   | Hosted gateway            | Sample Authority endpoint can be called repeatedly, each call creating a new $100 Authority      |
| F-11 | Medium   | Tenant isolation          | Single-tenant hosted composition; application-level isolation only                               |
| F-12 | Medium   | Auth / approval           | Enterprise approval evidence is not authenticated end to end (known blocker)                     |
| F-13 | Medium   | Circuit breakers          | No organization, environment or global execution disable (being added elsewhere)                 |
| F-14 | Low      | Dependency security       | No automated dependency update or SBOM; dev dependencies and Python SDK not audited here         |
| F-15 | Low      | Signature handling        | `localeCompare` canonicalizers in historical paths are a cross-implementation hazard             |
| F-16 | Low      | Shared database           | M6 acceptance evidence shares a database with M7 data; snapshot predates 013 to 020              |

Positive findings are listed per area below so the review is not only a list of gaps.

## Area review

### Secret management

Exists: secrets come from environment variables; the secret scan (`scripts/secret-scan.mjs`, `npm run secret:scan`, run in CI) greps tracked files for private-key PEMs, provider token patterns and `NAME=value` assignments; credential secrets are never stored (SHA-256 digest only) and shown once; the admin token is compared by digest and never logged; configuration errors log only fixed tokens (`M6_HOST_CONFIGURATION_INVALID`). Wallet instruments and setup tokens are AES-256-GCM encrypted with keys derived from `PAYFLOW_M5_BOOTSTRAP_KEY`.

Gaps: F-05. The secret scan covers tracked files only (not history, not Vercel, not chat). Secret classes are inventoried in `docs/SECURITY-ASSURANCE-READINESS.md`, but no rotation calendar, owner or access list exists.

### Dependency security

See the audit above. Gaps: F-14. In `.github/workflows/ci.yml` only `actions/upload-artifact` is pinned to a commit SHA; `actions/checkout@v4` and `actions/setup-node@v4` use movable tags (add to F-14).

### Input validation

Exists: strict zod schemas (`.strict()`) reject unknown fields, so extra Authority fields are refused (`REQUEST_MALFORMED`, zero effect); the bearer token must match `^Bearer pf_(sbx|live)_(pfc_[a-f0-9]{24})\.([A-Za-z0-9_-]{43})$` before any database access; body size is capped (16 KiB hosted gateway, 8 KiB console POSTs, 64 KiB MCP); path parameters are regex constrained (`[A-Za-z0-9._:-]{1,128}`, `pfc_[a-f0-9]{24}`); money is integer minor units with currency checks in SQL (`CHECK(currency ~ '^[A-Z]{3}$')`, `amount_minor > 0`); the credential TTL is bounded; SQL uses tagged-template parameters (postgres.js), not string concatenation; error messages exposed to callers are stable codes (`/^[A-Z0-9_]{3,96}$/`), with other errors becoming `INTERNAL_ERROR` or `REQUEST_REFUSED`.

Gaps: none that is high severity found in the inspected paths. Not reviewed line by line: every protocol adapter (MCP, A2A), the full console.

### Signature handling

Exists: execution grants are Ed25519, verified over canonical bytes with audience, issue/expiry window, `kid` lookup and key-type check (`ED25519_VERIFICATION_KEY_REQUIRED`) at the Execution Boundary; the persisted grant row must equal the claims field by field (`MALFORMED_PERSISTED_GRANT`), so a valid signature alone cannot change what executes; token length is capped (8192 characters); failures append `EXECUTION_GRANT_VERIFICATION_FAILED` evidence with only a token digest. Portable Proof verification runs in a separate package with no database or network imports (enforced by a test, `docs/TAKEOVER-AUDIT-M7-M25.md` section 7). Historical verification checks authenticity, not freshness.

Gaps: F-04 (key lifecycle), F-15 (canonicalization hazard).

### Authentication

Exists: bearer credential authentication per request against the database (revocation is immediate); fixed-length digest comparison with `timingSafeEqual`, including when the row is absent; uniform failure class; expiry and agent lifecycle checks; admin authentication separate from agent authentication; owner console sessions with CSRF/origin checks.

Gaps: F-02, F-06, F-12. Bearer tokens have no binding to a caller.

### Tenant isolation

Exists: composite keys `(organization_id, agent_id, environment)`; credentials, lifecycle and admin operations are tenant/environment scoped; credential binds one agent and principal; Authority must match both; cross-tenant IDs behave as absent; tests for these in `tests/m7-network.integration.test.ts`.

Gaps: F-11. No row-level security; one database role.

### Rate limiting (honest statement)

**Rate limiting is not implemented on the hosted gateway.** `src/network/hosted-gateway.ts` has no limiter. `src/network/reliability.ts` defines `RateLimitStore` and `enforceRateLimit`, but no store implementation exists and nothing calls them from the hosted path. `src/protocols/mcp-http.ts` and `a2a-http.ts` take an injectable `rateLimit` and ship an in-memory `localProtocolRateLimit` that is explicitly single-process; the hosted composition does not mount those adapters. The console limits a demo session to 30 requests per window and caps concurrent demo sessions at 128 (`src/console-session-durable.ts`); that protects the console, not `/v1/*`. Whether Vercel firewall rules are configured is not visible in the repository. Finding F-02.

### Replay

Exists: atomic nonce claim in `replay_keys`; one-time grants under row lock; provider request IDs persisted; verifier replay keys. Evidence: Sandbox live run (`REPLAY_DETECTED`, no second capture) and `tests/m7-gateway-execution.integration.test.ts` (5 concurrent requests, one capture).

Gaps: no documented retention or cleanup for `replay_keys`; replay protection beyond a single nonce namespace per `(mandate, agent)` is by design.

### Key lifecycle

See F-04 and INCIDENT-RUNBOOKS.md RB-8. `docs/COMPANY-LAUNCH-SECURITY-REVIEW.md` records that key and issuer-trust metadata exists in the network layer, but the hosted path uses one key.

### Credential lifecycle

Exists: issue (admin only, TTL 60 seconds to 90 days, 1 to 5 scopes, label up to 128 characters), list (never returns the digest), revoke (idempotent, tenant scoped), expiry, agent suspension override. Gaps: F-07.

### Provider boundaries

Exists: PayPal is not an authorization authority; capture amount/currency/payee must equal the persisted attempt; unique constraints on provider order and capture IDs; UNKNOWN never becomes failure; sandbox-only (`PAYPAL_ENVIRONMENT === "sandbox"` is required for the hosted provider, `src/console-hosted.ts`); CSP limits `connect-src` to PayPal API origins and `self` (`vercel.json`). Gaps: F-08.

### Database permissions

Exists: migrations are forward-only SQL; constraints encode invariants (status checks, UNIQUE grant/reservation per attempt, scope subset check, `(status='REVOKED') = (revoked_at IS NOT NULL)`); immutability triggers on commerce binding, quote, expiration and manifest tables (migration 006); `mandates` are re-verified against their stored fingerprint on every read (`getMandate`). Gaps: F-01, F-11, F-16.

### Logs

Exists: stable reason codes and request IDs (`x-payflow-request-id`) on every gateway response; evidence events for grant failures, dispatch, reconciliation; logs avoid secrets by design (fixed-token `console.error`). Gaps: F-09.

## Findings with fixes

**F-01 High: database role and evidence immutability.** All services connect with one `DATABASE_URL`. `evidence_events` is hash-chained (tamper-evident) but nothing in the database stops `UPDATE`/`DELETE`; anyone with the URL can rewrite rows and recompute hashes. Fix: create separate roles (application: no `UPDATE`/`DELETE` on `evidence_events`, `execution_grant_signatures`; migration role; read-only operator role); add `BEFORE UPDATE OR DELETE` triggers raising an exception on `evidence_events`, as migration 006 does for commerce tables; publish periodic signed chain-head checkpoints outside the database.

**F-02 High: no rate limiting.** `/v1/actions/execute`, `/v1/proofs/*` and `/v1/admin/*` accept unlimited requests. Each authenticated request does a database read and a write (`last_used_at`). Fix: implement `RateLimitStore` on Postgres (or a shared store) with atomic window counters, call `enforceRateLimit` in `hosted-gateway.ts` before authentication (keyed by IP hash) and after (keyed by `credential_id`), stricter bucket for `/v1/admin/*`, and `429` with a stable reason; also configure Vercel firewall rules and record them in the repository docs. Add a test that a burst is refused.

**F-03 High: reconciliation has no scheduler or alerting.** `reconcileOutstanding()` runs only when an owner calls `POST /api/demo-agent/reconcile`. `reconciliation_queue` / `reconciliation_observations` exist but no code writes them; `ReconciliationOperationsCenter` has no Postgres repository. UNKNOWN attempts can sit with authority quarantined indefinitely. Fix: a scheduled job (Vercel cron or external) calling a lookup-only reconcile; Postgres-backed repository filling the queue; alert when any attempt is UNKNOWN for longer than N minutes; add the `reconcile:request` route to `/v1` with scope enforcement.

**F-04 Medium: single signing key.** Hosted grants and portable Proofs use one Ed25519 key (`PAYFLOW_M6_SIGNING_KEY`, `kid` from `PAYFLOW_M6_SIGNING_KID`); `StaticPublicKeyRing` has one entry and `GET /v1/keys` publishes one. Rotation replaces the key, so Proofs under the old `kid` stop verifying on the hosted endpoints. There is no key status (active/retired/compromised). Fix: a key ring of retained public keys with status and validity interval, separate keys for grants and Proofs, publish all non-compromised public keys, add a rotation test that verifies an old Proof after rotation.

**F-05 Medium: co-located secrets.** One Vercel environment holds every secret class; compromise of the project exposes all. Fix: scope secrets per environment and per function, use the platform secret manager's access logging, keep the signing key in a KMS-backed signer (Vercel exposes KMS signing-key tooling; evaluate it) so the private key never reaches the application, and document an owner and rotation interval for each secret.

**F-06 Medium: admin token.** One static bearer secret; no expiry, rotation procedure, per-operator identity or audit record. Fix: per-operator admin credentials with expiry and role (issue vs revoke), write an `evidence_events` row for each admin action including the actor, and throttle failures (F-02).

**F-07 Medium: credential lifecycle evidence.** Issue and revoke are not recorded in `evidence_events`; only the credential row changes. There is no limit on active credentials per agent and no per-request usage log. Fix: append `CREDENTIAL_ISSUED` / `CREDENTIAL_REVOKED` evidence (credential ID, actor, never the secret); cap active credentials per agent; consider an append-only usage table sampled for successful calls.

**F-08 Medium: reconcile is not observation-only.** `PayPalExecutionRail.reconcile` may resubmit create-order or capture with the stored request IDs within six hours of `created_at` when Show Order proves the safe precondition. This is a deliberate, idempotent design with a durable Authority recheck, but it conflicts with the simple statement "reconciliation is read-only". Fix: add an explicit `observeOnly` mode used by operator tooling and incident response, keep resubmission an explicit separate step, and make the docs say which is which (UNKNOWN-OPERATIONS.md does).

**F-09 Medium: observability is mostly absent.** `auditEvent`, `safeCorrelationId` and `readiness` in `src/network/reliability.ts` are not used outside that file, and there is no health endpoint. In the committed code the hosted gateway does not pass `onEvent` to `ExecutingGateway`. (At the time of writing the working tree has an uncommitted change by another workstream that passes an `onEvent` handler to record `GOVERNED_ACTION` usage for metering; that is billing telemetry, not security logging, so security events such as `gateway.replay_blocked` and `gateway.unknown` are still not logged or alerted.) Fix: wire a structured logger and the event hook for security events, add `/healthz` with `readiness()` over database and provider checks, add alerts (F-03), and add log redaction tests.

**F-10 Medium: sample Authority provisioning.** `POST /v1/admin/sandbox/authority` creates a new random-ID $100 mandate on every call with no cap and no evidence row. Fix: refuse when an unexpired sample Authority already exists for the agent, record an evidence event, and compile out of any non-Sandbox build (`environment` guard in code, not only configuration).

**F-11 Medium: tenancy is application-level and single-tenant in practice.** Fix: add row-level security keyed on a session setting for tenant tables, or one schema per tenant; add a live two-tenant test before any second tenant is onboarded.

**F-12 Medium: approvals.** `evaluateApprovalEvidence` trusts pre-authenticated records. Fix: signed approval ingestion bound to the action digest and role, with revocation (see `docs/COMPANY-LAUNCH-SECURITY-REVIEW.md` blocker 1). Not exercised in the hosted Sandbox flow.

**F-13 Medium: breakers.** No organization suspend, environment restrict or global execution disable (CIRCUIT-BREAKERS.md). Another engineer is adding some; verify before relying on them. Fix: a single durable execution-mode record checked in the same transaction as dispatch, with an evidence row for each change.

**F-14 Low: dependency hygiene.** No Dependabot/Renovate, CodeQL or SBOM configuration in the repository; most GitHub Actions use movable `@v4` tags. `--omit=dev` skips 367 dev packages. Fix: enable automated update PRs and secret/code scanning on the repository, produce an SBOM in CI, run `npm audit` without `--omit=dev` as informational, and audit the Python SDK separately.

**F-15 Low: canonicalization.** `localeCompare` is used in historical canonicalizers (`execution-grant.ts`, `evidence.ts`, `canonical.ts`, `persistence.ts`, `trust-trace.ts`); deterministic for ASCII keys but locale-dependent in principle. Deliberately left unchanged to avoid breaking signed history (`docs/TAKEOVER-AUDIT-M7-M25.md` section 7). Fix: new Proof versions use code-point order (portable proof already does); add a cross-implementation test vector set before any change.

**F-16 Low/Medium: shared database.** See THREAT-MODEL-UPDATE.md T10d. Fix: separate M6 acceptance evidence into an immutable export (and a read-only branch) and run M7+ on its own database; record the restore consequences in BACKUP-RESTORE.md.

## Not reviewed

Browser bundle and CSP behaviour beyond the headers in `vercel.json`; every MCP/A2A code path; PayPal Sandbox account configuration; Vercel and Neon account security (SSO, MFA, member roles); supply chain of the build; backups. No dynamic testing was performed.

## Update after the first draft (source, tested, not deployed)

| Finding                                | Status now                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-02 No rate limiting                  | Fixed in source: PostgreSQL fixed-window limits on `/v1` and admin routes (429, `Retry-After`, zero effect). Not deployed. Limits are per credential or forwarded address and can be spread by an attacker with many of either                                                                           |
| F-06 Single admin token, no audit rows | Mostly: members with seven server-enforced roles (migration 023), every member action and every refused attempt in the append-only audit table, the operator token limited to bootstrapping an OWNER and platform operations. Still no member-token rotation procedure beyond revoke-and-reissue, no SSO |
| F-07 No evidence rows for issue/revoke | Fixed in source: `CREDENTIAL_ISSUED` / `CREDENTIAL_REVOKED` audit rows. Still no cap per agent                                                                                                                                                                                                           |
| F-09 Metering vs logs                  | `GOVERNED_ACTION` metering is billing telemetry, not security logging; both now exist separately                                                                                                                                                                                                         |
| F-01 / F-03 / F-04 / F-05              | Unchanged: one DB role, no `evidence_events` trigger, UNKNOWN reconciliation not scheduled, one signing key, one environment for all secrets                                                                                                                                                             |

New finding: the append-only audit table blocks `TRUNCATE organizations CASCADE`. That is intended; tests use `tests/helpers/reset.ts`, and any production data reset must suspend the guard deliberately.
